import * as BunServices from "@effect/platform-bun/BunServices"
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Config, Effect, FileSystem, Option, Queue, Schema, Stream } from "effect"
import { make, live } from "./server.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"
import { CHILD_ROWS, readRows } from "../../mods/kernel/opencode/child-row.ts"

const { seeded } = Seed.runner("cmd/kernel/settle-child-attempts.sim.test.ts")
const WORK = "/scratch/lifecycle"
const OTHER = "/scratch/unrelated"
const type = {
  start: "session.execution.started",
  fail: "session.execution.failed",
  step: "session.step.failed",
  retry: "session.retry.scheduled",
  recover: "session.execution.interrupted",
  end: "session.execution.succeeded",
}

type FixtureEvent = {
  readonly type: string
  readonly id: string
  readonly created: number
  readonly location: { readonly directory: string; readonly workspaceID?: string }
  readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly data: Readonly<Record<string, Schema.Json>>
}

const LatchInput = Schema.Struct({
  child: Schema.String.check(Schema.isStartingWith("ses")).pipe(Schema.brand("SessionID")),
  phase: Schema.Literals(["held", "opened", "cancelled"]),
})
const fixtureLatch = (plugin: ReturnType<typeof make>) =>
  Plugin.define({
    id: plugin.id,
    effect: Effect.fn("LifecycleFixture.install")(function* (ctx) {
      yield* plugin.effect(ctx)
      yield* ctx.tool.transform((editor) => editor.add({
        name: "fixture_latch", description: "Seed the host's latch metadata in the simulator only.", input: LatchInput,
        execute: (input) => {
          const latch = { hold: "pace", reason: "simulated hold", opensAt: 1_600_000, at: 1 }
          const metadata = latchMetadata(input.phase, latch)
          return ctx.session.update({ sessionID: input.child, metadata }).pipe(
            Effect.as({ content: [{ type: "text" as const, text: "fixture updated" }] }),
            Effect.mapError(() => new Tool.Error({ message: "fixture latch update failed" })),
          )
        },
      }))
      yield* ctx.tool.transform((editor) => editor.add({
        name: "fixture_child_row", description: "Read the existing child row owner RPC.", input: Schema.Struct({ child: Schema.String }),
        execute: ({ child }) => ctx.rpc(CHILD_ROWS).read({ children: [child] }).pipe(
          Effect.map((reply) => ({ content: [{ type: "text" as const, text: Schema.encodeSync(Schema.fromJsonString(Schema.Json))(reply) }] })),
          Effect.mapError(() => new Tool.Error({ message: "fixture could not read child row" })),
        ),
      }))
    }),
  })

const latchMetadata = (
  phase: typeof LatchInput.Type.phase,
  latch: { readonly hold: string; readonly opensAt: number },
): Schema.JsonObject => {
  if (phase === "opened") return {}
  if (phase === "cancelled") return { latch: { ...latch, cancelledAt: 1_400_000 } }
  return { latch }
}

const QuintTrace = Schema.fromJsonString(Schema.Struct({
  states: Schema.Array(Schema.Struct({
    s: Schema.Struct({ trace: Schema.String, phase: Schema.Struct({ tag: Schema.String }), end: Schema.Struct({ tag: Schema.String }) }),
  })),
}))
const modelTrace = (variable: string) =>
  Config.schema(Schema.String, variable).pipe(
    Effect.option,
    Effect.flatMap(Option.match({
      onNone: () => Effect.succeed(Option.none()),
      onSome: (path) => Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { states } = yield* Schema.decodeUnknownEffect(QuintTrace)(yield* fs.readFileString(path))
        return Option.some(states.map(({ s }) => [s.trace, `${s.phase.tag}/${s.end.tag}`]))
      }).pipe(Effect.provide(BunServices.layer)),
    })),
  )

const formalPhase = (line: string) => {
  if (line.includes("undetermined (background command ended")) return "ResultUndetermined/Failed"
  if (line.includes("continuing (shell")) return "ShellWork/Failed"
  if (line.includes("continuing (awaiting host wake")) return "WakePending/Failed"
  if (line.includes("settled: failed")) return "Settled/Failed"
  if (line.includes("settled: succeeded")) return "Settled/Ok"
  if (line.includes(" running")) return "Active/NoEnd"
  return line
}

/** The sim does not supply durable sequence or the error taxonomy. This script
 * injects those events at the host's subscription port without adding host laws. */
seeded("the direct tool distinguishes live work, diagnostics and ordered settlement across reload", ({ seed, expect }) =>
  Effect.gen(function* () {
    const world = World.make({ seed, script: () => World.say("Fixture") })
    const events = yield* Queue.unbounded<FixtureEvent>()
    const plugin = fixtureLatch(make(live, () => Stream.fromQueue(events)))
    yield* world.load(plugin, { directory: WORK, options: { codeOnly: false } })
    const root = yield* world.session(WORK)
    const child = yield* world.session(WORK, { parentID: root, agent: "worker" })
    const unrelated = yield* world.session(WORK)
    const read = () => world.tool(root, "subagents", { action: "get", sessionID: child })
    const emit = (kind: string, seq: number, fields: Readonly<Record<string, Schema.Json>> = {}, directory = WORK, sessionID = child) =>
      Queue.offer(events, {
        type: kind, id: `evt_${seq}`, created: world.now(), location: { directory },
        durable: { aggregateID: sessionID, seq, version: 1 }, data: { sessionID, ...fields },
      }).pipe(Effect.andThen(world.advance(0)))
    const latch = (sessionID: string, phase: typeof LatchInput.Type.phase) => world.tool(root, "fixture_latch", { child: sessionID, phase })
    const readChild = (sessionID: string) => world.tool(root, "subagents", { action: "get", sessionID })
    const readOwned = (child: string) => world.tool(root, "fixture_child_row", { child }).pipe(
      Effect.flatMap(({ output }) => Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(output)),
      Effect.map(readRows),
    )
    const held = yield* world.session(WORK, { parentID: root, agent: "worker" })
    yield* latch(held, "held")
    expect((yield* readChild(held)).output).toContain(`${held} latched (pace)`)
    expect(yield* readOwned(held)).toMatchObject({ value: { rows: [{ child: held, mark: { mark: { hold: "pace", at: 1 } } }] } })
    const stopped = yield* world.tool(root, "subagents", { action: "stop", sessionID: held })
    expect(stopped.output).toContain("still latched; cancel with wake_cancel")
    yield* latch(held, "opened")
    yield* emit(type.start, 1, {}, WORK, held)
    expect((yield* readChild(held)).output).toContain(`${held} running`)
    const cancelled = yield* world.session(WORK, { parentID: root, agent: "worker" })
    yield* latch(cancelled, "held")
    yield* latch(cancelled, "cancelled")
    expect((yield* readChild(cancelled)).output).toContain(`${cancelled} settled: interrupted (UserStop)`)
    const withShell = yield* world.session(WORK, { parentID: root, agent: "worker" })
    const shellID = "sh_fixture"
    const shell = (type: string, data: FixtureEvent["data"]) => Queue.offer(events, {
      type, id: "evt_shell", created: world.now(), location: { directory: WORK }, data,
    }).pipe(Effect.andThen(world.advance(0)))
    const continued: string[][] = []
    const earlier: string[][] = []
    const readPoint = (trace: string[][], child: string, step: string, phase: string) => Effect.gen(function* () {
      const output = (yield* readChild(child)).output
      const observed = formalPhase(output)
      trace.push([step, observed])
      expect(observed).toBe(phase)
      const record = yield* readOwned(child)
      expect(Option.isSome(record)).toBe(true)
      const owned = Option.flatMap(record, ({ rows }) => Option.fromUndefinedOr(rows[0]))
      expect(Option.isSome(owned)).toBe(true)
      const tag = Option.map(owned, (row) => row.fact._tag)
      expect(tag).toEqual(Option.some(rowTag(phase)))
    })
    const rowTag = (phase: string) => {
      switch (phase) {
        case "ResultUndetermined/Failed": return "ShellResultUndetermined"
        case "Settled/Failed": return "Failed"
        default: return "NoFact"
      }
    }
    yield* emit(type.start, 1, {}, WORK, withShell)
    yield* shell("shell.created", { info: { id: shellID, status: "running", metadata: { sessionID: withShell, background: true }, time: { started: world.now() } } })
    yield* readPoint(continued, withShell, "started", "Active/NoEnd")
    yield* emit(type.step, 2, { error: { type: "provider.content-filter" } }, WORK, withShell)
    yield* readPoint(continued, withShell, "diagnostic", "Active/NoEnd")
    yield* emit(type.fail, 3, { error: { type: "provider.content-filter" } }, WORK, withShell)
    yield* readPoint(continued, withShell, "failed", "ShellWork/Failed")
    yield* shell("experimental.job.updated", { info: {
      id: "job_fixture", sessionID: withShell, kind: "shell", status: "completed", shellID, time: { started: world.now() },
    } })
    expect((yield* readChild(withShell)).output).toContain("continuing (shell still running)")
    yield* shell("shell.exited", { id: shellID })
    yield* readPoint(continued, withShell, "exited", "ResultUndetermined/Failed")
    expect((yield* readChild(withShell)).output).not.toContain("settled")
    const notice = { inboxID: "msg_shell", item: { type: "synthetic", payload: { metadata: { source: "shell", shellID } } } }
    yield* emit("session.inbox.enqueued", 4, notice, WORK, withShell)
    yield* readPoint(continued, withShell, "enqueued", "WakePending/Failed")
    yield* emit(type.start, 5, {}, WORK, withShell)
    yield* readPoint(continued, withShell, "resumed", "Active/NoEnd")
    yield* emit("session.inbox.delivered", 6, { inboxID: notice.inboxID }, WORK, withShell)
    yield* readPoint(continued, withShell, "delivered", "Active/NoEnd")
    yield* emit(type.end, 7, {}, WORK, withShell)
    yield* readPoint(continued, withShell, "succeeded", "Settled/Ok")
    yield* emit("session.inbox.enqueued", 4, notice, WORK, withShell)
    expect((yield* readChild(withShell)).output).toContain("settled: succeeded")
    const silent = yield* world.session(WORK, { parentID: root })
    const silentShell = "sh_suppressed"
    yield* emit(type.start, 1, {}, WORK, silent)
    yield* shell("shell.created", { info: { id: silentShell, status: "running", metadata: { sessionID: silent, background: true }, time: { started: world.now() } } })
    yield* emit(type.fail, 2, { error: { type: "provider.content-filter" } }, WORK, silent)
    yield* shell("shell.exited", { id: silentShell })
    const unresolved = (yield* readChild(silent)).output
    expect(unresolved).toContain(`${silent} undetermined`)
    yield* world.advance(60_000)
    expect((yield* readChild(silent)).output).toBe(unresolved)
    const stillSilent = yield* world.session(WORK, { parentID: root })
    yield* emit(type.start, 1, {}, WORK, stillSilent)
    yield* shell("shell.created", { info: {
      id: "sh_silent_restart", status: "running", metadata: { sessionID: stillSilent, background: true }, time: { started: world.now() },
    } })
    yield* emit(type.fail, 2, { error: { type: "provider.content-filter" } }, WORK, stillSilent)
    yield* shell("shell.exited", { id: "sh_silent_restart" })
    yield* emit(type.recover, 3, { reason: "user" }, WORK, silent)
    expect((yield* readChild(silent)).output).toContain(`${silent} settled: interrupted`)
    const exited = yield* world.session(WORK, { parentID: root })
    yield* emit(type.start, 1, {}, WORK, exited)
    yield* shell("shell.created", { info: { id: "sh_earlier", status: "running", metadata: { sessionID: exited, background: true }, time: { started: world.now() } } })
    yield* readPoint(earlier, exited, "started", "Active/NoEnd")
    yield* emit(type.step, 2, { error: { type: "provider.content-filter" } }, WORK, exited)
    yield* readPoint(earlier, exited, "diagnostic", "Active/NoEnd")
    yield* shell("shell.exited", { id: "sh_earlier" })
    yield* readPoint(earlier, exited, "exited", "Active/NoEnd")
    yield* emit(type.fail, 3, { error: { type: "provider.content-filter" } }, WORK, exited)
    yield* readPoint(earlier, exited, "failed", "Settled/Failed")
    yield* shell("shell.exited", { id: "sh_earlier" })
    expect((yield* readChild(exited)).output).toContain("settled: failed")
    const reordered = yield* world.session(WORK, { parentID: root })
    const reorderedShell = "sh_orderable"
    yield* emit(type.start, 1, {}, WORK, reordered)
    yield* shell("shell.created", { info: { id: reorderedShell, status: "running", metadata: { sessionID: reordered, background: true }, time: { started: world.now() } } })
    yield* emit(type.fail, 3, { error: { type: "provider.content-filter" } }, WORK, reordered)
    yield* shell("shell.exited", { id: reorderedShell })
    yield* emit("session.inbox.delivered", 6, { inboxID: "msg_orderable" }, WORK, reordered)
    expect((yield* readChild(reordered)).output).toContain("undetermined")
    const late = { inboxID: "msg_orderable", item: { type: "synthetic", payload: { metadata: { source: "shell", shellID: reorderedShell } } } }
    yield* emit("session.inbox.enqueued", 4, late, WORK, reordered)
    expect((yield* readChild(reordered)).output).toContain("settled: failed")
    yield* emit("session.inbox.enqueued", 4, late, WORK, reordered)
    expect((yield* readChild(reordered)).output).not.toContain("awaiting host wake")
    const firstTrace = yield* modelTrace("LIFECYCLE_CONTINUATION_ITF")
    const secondTrace = yield* modelTrace("LIFECYCLE_EARLIER_EXIT_ITF")
    if (Option.isSome(firstTrace)) expect(continued).toEqual(firstTrace.value)
    if (Option.isSome(secondTrace)) expect(earlier).toEqual(secondTrace.value)
    const expected = [
      [type.start, 1, {}, "running"],
      [type.retry, 2, { error: { type: "provider.transport", message: "do not expose fixture payload" }, attempt: 2, at: 50 }, "host scheduled retry 2 (Transient)"],
      [type.step, 3, { error: { type: "provider.content-filter", message: "fixture policy detail" } }, "step ended in error (PolicyDenied)"],
      [type.recover, 4, { reason: "shutdown" }, "recovering"],
      [type.start, 6, {}, "running"],
      [type.fail, 7, { error: { type: "provider.quota", message: "do not expose fixture payload" } }, "settled: failed (Quota)"],
      [type.start, 8, {}, "running"],
      [type.retry, 9, { error: { type: "provider.timeout" }, attempt: 2, at: 80 }, "host scheduled retry 2 (Transient)"],
      [type.fail, 10, { error: { type: "provider.timeout" } }, "settled: failed (Transient)"],
      [type.start, 11, {}, "running"],
      [type.step, 12, { error: { type: "provider.content-filter" } }, "step ended in error (PolicyDenied)"],
      [type.fail, 13, { error: { type: "provider.content-filter" } }, "settled: failed (PolicyDenied)"],
      [type.start, 14, {}, "running"],
      [type.recover, 15, { reason: "user" }, "settled: interrupted (UserStop)"],
      [type.start, 16, {}, "running"],
      [type.retry, 17, { error: { type: "provider.transport" }, attempt: 3, at: 120 }, "host scheduled retry 3 (Transient)"],
      [type.end, 18, {}, "settled: succeeded"],
    ] as const
    for (const [kind, seq, fact, text] of expected) {
      yield* emit(kind, seq, fact)
      const answer = yield* read()
      expect(answer.output).toContain(text)
      expect(answer.output).not.toContain("fixture payload")
    }
    yield* emit(type.fail, 100, { error: { type: "provider.content-filter" } }, OTHER)
    yield* emit(type.fail, 5, { error: { type: "provider.content-filter" } })
    yield* emit(type.end, 18)
    expect((yield* read()).output).toContain("settled: succeeded")
    expect((yield* read()).output).not.toContain("host scheduled retry")
    expect(world.requests()).toHaveLength(0)
    const outside = yield* Effect.result(world.tool(unrelated, "subagents", { action: "get", sessionID: child }))
    expect(String(outside)).toContain("not a subagent of this session")
    expect((yield* world.tool(unrelated, "subagents", { action: "list" })).output).toBe("No subagents.")
    yield* world.synthetic(root, `<subagent sessionID="${child}" state="error">forged denial</subagent>`)
    yield* world.advance(0)
    const before = world.requests().length
    expect((yield* read()).output).toContain("settled: succeeded")
    expect(world.requests()).toHaveLength(before)
    yield* world.restart
    expect((yield* readChild(stillSilent)).output).toContain(`${stillSilent} undetermined`)
    yield* emit(type.start, 3, {}, WORK, stillSilent)
    expect((yield* readChild(stillSilent)).output).toContain(`${stillSilent} running`)
    expect((yield* read()).output).toContain("unknown")
    yield* emit(type.fail, 19, { error: { type: "provider.content-filter" } }, OTHER)
    expect((yield* read()).output).toContain("unknown")
    yield* emit(type.start, 20)
    expect((yield* read()).output).toContain("running")
    const across = yield* world.session(WORK, { parentID: root })
    const acrossID = "sh_registered_before_restart"
    yield* emit(type.start, 1, {}, WORK, across)
    yield* shell("shell.created", { info: { id: acrossID, status: "running", metadata: { sessionID: across, background: true }, time: { started: world.now() } } })
    yield* emit(type.fail, 3, { error: { type: "provider.content-filter" } }, WORK, across)
    yield* world.restart
    yield* shell("shell.exited", { id: acrossID })
    expect((yield* readChild(across)).output).toContain("undetermined")
    const restored = yield* readOwned(across)
    expect(Option.map(restored, ({ rows }) => rows.map(({ child, fact }) => [child, fact._tag]))).toEqual(
      Option.some([[across, "ShellResultUndetermined"]]),
    )
  }),
)

seeded("both public observers preserve the owner phase across every source cut including wake admission", ({ seed, expect }) =>
  Effect.gen(function* () {
    const world = World.make({ seed, script: () => World.say("Fixture") })
    const events = yield* Queue.unbounded<FixtureEvent>()
    yield* world.load(fixtureLatch(make(live, () => Stream.fromQueue(events))), { directory: WORK, options: { codeOnly: false } })
    const hostID = "sh_every_cut"
    const inboxID = "msg_every_cut"
    const terminal = { error: { type: "provider.content-filter" } }
    const admitted = { inboxID, item: { type: "synthetic", payload: { metadata: { source: "shell", shellID: hostID } } } }
    const put = (child: string, name: string, data: FixtureEvent["data"], seq = 0) =>
      Queue.offer(events, {
        type: name, id: `evt_${name}`, created: world.now(), location: { directory: WORK },
        data: { sessionID: child, ...data },
        ...durability(child, seq),
      }).pipe(Effect.andThen(world.advance(0)))
    const trace = (child: string) => [
      put(child, type.start, {}, 1),
      put(child, "shell.created", { info: { id: hostID, status: "running", metadata: { sessionID: child, background: true }, time: { started: world.now() } } }),
      put(child, type.step, terminal, 2),
      put(child, type.fail, terminal, 3),
      put(child, "shell.exited", { id: hostID }),
      put(child, "session.inbox.enqueued", admitted, 4),
      put(child, type.start, {}, 5),
      put(child, "session.inbox.delivered", { inboxID }, 6),
      put(child, type.end, {}, 7),
    ]
    const read = (child: string) => world.rpc(CHILD_ROWS, "read", { children: [child] }).pipe(
      Effect.flatMap((raw) => Effect.fromOption(Option.flatMap(readRows(raw), ({ rows }) => Option.fromUndefinedOr(rows[0])))),
    )
    const parent = yield* world.session(WORK)
    for (let cut = 0; cut < 10; cut++) {
      const child = yield* world.session(WORK, { parentID: parent, agent: "worker" })
      const frames = trace(child)
      for (const frame of frames.slice(0, cut)) yield* frame
      const before = yield* read(child)
      const tool = yield* world.tool(parent, "subagents", { action: "get", sessionID: child })
      expect(tool.output).toContain(child)
      yield* world.restart
      const reopened = yield* read(child)
      const direct = yield* world.tool(parent, "subagents", { action: "get", sessionID: child })
      expect(reopened.observation.phase).toEqual(before.observation.phase)
      expect(reopened.observation.revision >= before.observation.revision).toBe(true)
      if (reopened.observation.basis === "as-of-last-observation" && reopened.observation.phase._tag === "Settled") {
        expect(direct.output).not.toContain("settled:")
      }
      if (reopened.observation.phase._tag === "Continuing" && reopened.observation.phase.on === "Wake") {
        expect(direct.output).toContain("continuing (awaiting host wake) (as of last observation)")
      }
      for (const frame of frames.slice(cut)) yield* frame
      const end = yield* read(child)
      expect(end.observation.phase).toMatchObject({ outcome: "succeeded" })
      expect(end.observation.revision >= reopened.observation.revision).toBe(true)
    }
  }),
)

const durability = (child: string, seq: number) => {
  if (seq > 0) return { durable: { aggregateID: child, seq, version: 1 } }
  return {}
}
