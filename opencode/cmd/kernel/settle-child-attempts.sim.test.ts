import { Plugin, Tool } from "@opencode/plugin/effect"
import { Effect, Queue, Schema, Stream } from "effect"
import { make, live } from "./server.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

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
          const latch = { hold: "pace", opensAt: 1_600_000, recheckAt: 1_500_000 }
          const metadata = latchMetadata(input.phase, latch)
          return ctx.session.update({ sessionID: input.child, metadata }).pipe(
            Effect.as({ content: [{ type: "text" as const, text: "fixture updated" }] }),
            Effect.mapError(() => new Tool.Error({ message: "fixture latch update failed" })),
          )
        },
      }))
    }),
  })

const latchMetadata = (
  phase: typeof LatchInput.Type.phase,
  latch: { readonly hold: string; readonly opensAt: number; readonly recheckAt: number },
): Schema.JsonObject => {
  if (phase === "opened") return {}
  if (phase === "cancelled") return { latch: { ...latch, cancelledAt: 1_400_000 } }
  return { latch }
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
    const held = yield* world.session(WORK, { parentID: root, agent: "worker" })
    yield* latch(held, "held")
    expect((yield* readChild(held)).output).toContain(`${held} latched (pace; recheck`)
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
    yield* emit(type.start, 1, {}, WORK, withShell)
    yield* shell("shell.created", { info: { id: shellID, status: "running", metadata: { sessionID: withShell }, time: { started: world.now() } } })
    yield* emit(type.step, 2, { error: { type: "provider.content-filter" } }, WORK, withShell)
    yield* emit(type.fail, 3, { error: { type: "provider.content-filter" } }, WORK, withShell)
    expect((yield* readChild(withShell)).output).toContain(`${withShell} continuing (shell still running)`)
    yield* shell("shell.exited", { id: shellID })
    expect((yield* readChild(withShell)).output).toContain(`${withShell} continuing (awaiting host wake)`)
    yield* emit(type.start, 4, {}, WORK, withShell)
    yield* emit(type.end, 5, {}, WORK, withShell)
    expect((yield* readChild(withShell)).output).toContain(`${withShell} settled: succeeded`)
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
    expect((yield* read()).output).toContain("unknown")
    yield* emit(type.fail, 19, { error: { type: "provider.content-filter" } }, OTHER)
    expect((yield* read()).output).toContain("unknown")
    yield* emit(type.start, 20)
    expect((yield* read()).output).toContain("running")
  }),
)
