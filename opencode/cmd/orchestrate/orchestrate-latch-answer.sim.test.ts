// @reads all
// @reads-reason computed read at mods/kernel/filestore/files.ts: const info = yield* Effect.tryPromise({ try: () => stat(path), catch: unreadable })
// A held subagent call made from a kernel cell answers the cell's handle that it is latched, with its opening, on the
// simulated host (sim/world.ts), each test at 20 seeds, in virtual time, with no provider request (batch 2026-11-26g:
// on the running server a held follow-up's cell answer read `{"state":"done","phase":"Settled"}`).
//
// The path is the real server's: the root's `kernel` tool runs a cell whose `tools.subagent` goes through the kernel
// plugin's tool bridge to the host's subagent tool and the orchestrate and wakes plugins, and the cell's handle is
// shaped by the worker's own code (mods/kernel/worker/subagent-handle.ts). Only the worker process is stood in: its
// cell runs that handle code in process. The host's execution events carry the durable envelope the real server
// gives them (the sim's do not), so the child-lifecycle owner records each round's ordered settlement as it does there.
import { POOL_STATUS } from "@dotfiles/opencode-pool/status"
import { runSubagent, subagentHandleOf } from "@dotfiles/opencode-kernel/worker/subagent-handle"
import type { Json } from "@dotfiles/opencode-kernel/frame"
import * as FileStoreFiles from "@dotfiles/opencode-kernel/filestore/files"
import * as OpenCodeCellTimes from "@dotfiles/opencode-kernel/opencode/cell-times"
import * as OpenCodeSessions from "@dotfiles/opencode-kernel/opencode/sessions"
import * as OpenCodeSnapshots from "@dotfiles/opencode-kernel/opencode/snapshots"
import { Workers } from "@dotfiles/opencode-kernel/service"
import type { CallFailed } from "@dotfiles/opencode-kernel/tools"
import { Plugin, Tool } from "@opencode/plugin/effect"
import { DateTime, Effect, FiberSet, Layer, Option, Schema, Stream } from "effect"
import { make } from "../kernel/server.ts"
import * as Plugins from "../../sim/plugins.ts"
import { simulationRunner } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = simulationRunner("cmd/orchestrate/orchestrate-latch-answer.sim.test.ts")

const WORK = "/scratch/project"
/** The orchestrate plugin's fixed clock: a Wednesday morning, so only the pace holds. */
const PIN = "2026-11-04T15:00:00Z"
/** How long after the hold begins the pool opens. */
const OPEN_MS = 60_000

const START = "Start the export worker."
const CONTINUE = "Continue the export worker."
const FRESH = "Start the import worker."
const READ = "Read the export worker."
const ROUND_ONE = "Brief one: check the CSV export."
const ROUND_TWO = "Brief two: now check the JSON export."
const IMPORT = "Import brief: check the CSV import."
const ONE_DONE = "Round one passed."
const TWO_DONE = "Round two passed."
const IMPORT_DONE = "The import check passed."
/** What the stand-in worker prints before the handle a cell resolved to. */
const HANDLE = "HANDLE="

/** A line that opens a message in a request's text. */
const OPENS = /^(user|synthetic|assistant|tool|compaction|error)[ :]/
const lastOf = (text: string) => {
  const all = text.split("\n")
  return all.slice(Math.max(0, all.findLastIndex((line) => OPENS.test(line)))).join("\n")
}

/** A cell's source: the one handle call it makes, as JSON the stand-in worker runs. */
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const cell = (id: string, source: Json, description: string) => World.call(id, "kernel", { code: encodeJson(source), description })

/** The model: the root runs one cell per prompt; a worker answers the brief it was last given. */
const model = (state: { child: string; calls: number }): World.Script => (request) => {
  if (request.kind === "title") return World.say("export check")
  const last = lastOf(request.text)
  if (last.includes(ROUND_TWO)) return World.say(TWO_DONE)
  if (last.includes(IMPORT)) return World.say(IMPORT_DONE)
  if (last.includes(ROUND_ONE)) return World.say(ONE_DONE)
  if (!last.startsWith("user")) return World.say("Noted.")
  state.calls += 1
  const id = `call_${state.calls}`
  if (last.includes(START)) return cell(id, { subagent: { agent: "worker", description: "Export worker", prompt: ROUND_ONE } }, "Start the export worker")
  if (last.includes(CONTINUE))
    return cell(id, { subagent: { sessionID: state.child, agent: "worker", description: "Export worker", prompt: ROUND_TWO } }, "Continue the export worker")
  if (last.includes(FRESH)) return cell(id, { subagent: { agent: "worker", description: "Import worker", prompt: IMPORT } }, "Start the import worker")
  if (last.includes(READ)) return cell(id, { read: state.child }, "Read the export worker")
  return World.say("?")
}

const CellSource = Schema.fromJsonString(Schema.Union([
  Schema.Struct({ subagent: Schema.Record(Schema.String, Schema.Json) }),
  Schema.Struct({ read: Schema.String }),
]))
const decodeSource = Schema.decodeUnknownSync(CellSource)

/** The worker stood in: a cell runs the worker's own handle code on the kernel's tool bridge, and prints the handle. */
const handleWorkers = Layer.sync(Workers, () => {
  const alive = new Set<string>()
  return Workers.of({
    alive: (session) => Effect.sync(() => alive.has(session)),
    start: (session) => Effect.sync(() => void alive.add(session)),
    evaluate: (_session, { source, call }) =>
      Effect.scoped(Effect.gen(function* () {
        // The worker's handle code calls its tools as promises, as in the worker process.
        const promised = yield* FiberSet.makeRuntimePromise<never, Json, CallFailed>()
        const bridge = (name: string, input: Json) => promised(call(name, input))
        const asked = decodeSource(source)
        const handle = yield* Effect.promise(() => {
          if ("read" in asked) return subagentHandleOf(asked.read, bridge)
          return runSubagent(asked.subagent, bridge)
        })
        const output = `${HANDLE}${encodeJson(Schema.decodeUnknownSync(Schema.Json)({ ...handle }))}`
        return { ok: true, output, display: output, truncated: false, bindings: [], attached: [] }
      })),
    snapshot: () => Effect.succeed({ bindings: [], omitted: [] }),
    restore: () => Effect.succeed([]),
    stop: (session) => Effect.sync(() => void alive.delete(session)),
  })
})

const EXECUTIONS = new Set(["session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])
const HostEvent = Schema.Struct({ type: Schema.String, data: Schema.Struct({ sessionID: Schema.optionalKey(Schema.String) }) })
const readEvent = Schema.decodeUnknownOption(HostEvent)

/**
 * The host's events as the real server sends them: an execution's event carries its session's durable coordinates
 * and the time of the busy or idle mark it set, as `session.get` reads it back.
 */
const durable = (world: World.World, seq: { next: number }) => (ctx: Plugin.Context): Stream.Stream<unknown, unknown> =>
  ctx.event.subscribe().pipe(Stream.map((raw) => {
    const event = readEvent(raw)
    if (Option.isNone(event) || !EXECUTIONS.has(event.value.type)) return raw
    const sessionID = event.value.data.sessionID ?? ""
    const session = world.sessions.get(sessionID)
    let mark = Option.flatMap(Option.fromUndefinedOr(session), ({ idle }) => idle)
    if (event.value.type === "session.execution.started") mark = Option.flatMap(Option.fromUndefinedOr(session), ({ busy }) => busy)
    seq.next += 1
    return { ...Object(raw), created: Option.getOrElse(mark, () => world.now()), durable: { aggregateID: sessionID, seq: seq.next, version: 1 } }
  }))

const kernel = (world: World.World, seq: { next: number }) =>
  make(
    (ctx) =>
      Layer.mergeAll(
        handleWorkers,
        OpenCodeSnapshots.layer(ctx.storage),
        OpenCodeSessions.fromContext(ctx),
        FileStoreFiles.layer,
        OpenCodeCellTimes.layer(ctx.storage),
        OpenCodeCellTimes.noticesFromContext(ctx),
      ),
    durable(world, seq),
  )

/** The tools a cell reaches while the kernel is the agent's runtime, as the fork lists them. */
const CELL_TOOLS = [
  { name: "subagent", description: "Spawns an agent in a child session to work on the specified task.", input: {} },
  { name: "subagents", description: "Reads or stops this session's subagents.", input: {} },
]

/**
 * The kernel as the agent's runtime (the fork's `options.runtime`, which the sim does not model): a cell's call runs
 * the host's tool through its `execute.before` and `execute.after` hooks, as a model's call does, and answers the
 * result the hooks left.
 */
const cellRuntime = (world: World.World) =>
  Plugin.define({
    id: "fixture.cell-runtime",
    effect: (ctx) =>
      Effect.gen(function* () {
        const results = new Map<string, Tool.Result>()
        const key = (sessionID: string, tool: string) => `${sessionID}:${tool}`
        yield* ctx.tool.hook("execute.after", (event) =>
          Effect.sync(() => {
            if (event.status === "completed") results.set(key(event.sessionID, event.tool), event.result)
          }))
        yield* ctx.tool.transform((editor) =>
          editor.update("kernel", (tool) => {
            const execute = tool.execute
            tool.execute = (input, context) =>
              execute(input, {
                ...context,
                runtime: {
                  tools: CELL_TOOLS,
                  call: (name, input) =>
                    Schema.decodeUnknownEffect(Schema.Json)(input).pipe(
                      Effect.flatMap((json) => world.tool(context.sessionID, name, json)),
                      Effect.mapError((error) => new Tool.Error({ message: String(error) })),
                      Effect.flatMap((answer) =>
                        Option.match(Option.filter(Option.fromUndefinedOr(results.get(key(context.sessionID, name))), () => !answer.error), {
                          onNone: () => Effect.fail(new Tool.Error({ message: answer.output })),
                          onSome: Effect.succeed,
                        })),
                    ),
                },
              })
          }),
        )
      }),
  })

/** The stand-in pool: held until `openAt` (world time). */
const POOL = { ...POOL_STATUS, methods: { pace: POOL_STATUS.methods.pace, started: POOL_STATUS.methods.started } }
const pool = (gate: { openAt: number }, now: () => number) =>
  Plugin.define({
    id: "fixture.pool",
    effect: (ctx) =>
      ctx.rpc
        .register(POOL, {
          pace: () =>
            Effect.sync(() => {
              const at = now()
              if (at >= gate.openAt) return { ok: true, measured: true, reason: "scripted room" }
              return { ok: false, measured: true, reason: "scripted 5h window is full", retryAt: Date.parse(PIN) + (gate.openAt - at) }
            }),
          started: () => Effect.succeed({}),
        })
        .pipe(Effect.orDie, Effect.asVoid),
  })

/** The handle a cell printed, as the root read it. */
const Handle = Schema.Struct({
  sessionID: Schema.String,
  state: Schema.String,
  note: Schema.String,
  observation: Schema.optionalKey(Schema.Struct({
    phase: Schema.Struct({ _tag: Schema.String, opensAt: Schema.optionalKey(Schema.Number) }),
  })),
})
const decodeHandle = Schema.decodeUnknownSync(Schema.fromJsonString(Handle))
const handleIn = (output: string) => decodeHandle(output.slice(output.indexOf(HANDLE) + HANDLE.length).split("\n")[0]!)

const boot = (seed: number) =>
  Effect.gen(function* () {
    const state = { child: "", calls: 0 }
    const world = World.make({ seed, start: Date.parse(PIN), script: model(state) })
    const gate = { openAt: 0 }
    const seq = { next: 0 }
    yield* world.load(Plugins.orchestrate({ lines: [] }), { directory: WORK, options: { now: PIN } })
    yield* world.load(Plugins.wake(world), { directory: WORK, options: { backstop: "off" } })
    yield* world.load(pool(gate, () => world.now()), { directory: WORK })
    yield* world.load(kernel(world, seq), { directory: WORK, options: { codeOnly: false } })
    yield* world.load(cellRuntime(world), { directory: WORK })
    const root = yield* world.session(WORK)
    const childrenOf = () => [...world.sessions.values()].filter((session) => session.parentID._tag === "Some" && session.parentID.value === root)
    const said = (sessionID: string, text: string) => world.messages(sessionID).filter((message) => message.type === "assistant" && message.text.includes(text)).length
    const rounds = (sessionID: string, brief: string) => world.messages(sessionID).filter((message) => message.type === "user" && message.text.includes(brief))
    /** The handles the root's cells printed, in order. */
    const handles = () => world.messages(root).flatMap((message) => {
      if (message.type !== "tool" || !message.output.includes(HANDLE)) return []
      return [handleIn(message.output)]
    })
    /** The root's wakes that carry a child's report. */
    const wakes = (text: string) => world.messages(root).filter((message) => message.type === "synthetic" && message.text.includes(text)).length
    yield* world.prompt(root, START)
    yield* world.until(() => handles().length === 1 && childrenOf().some((child) => said(child.id, ONE_DONE) === 1), 60_000)
    state.child = childrenOf()[0]!.id
    yield* world.until(() => wakes(ONE_DONE) === 1 && world.sessions.get(root)?.running !== true, 60_000)
    // The pool is spent from here: it opens a minute on.
    gate.openAt = world.now() + OPEN_MS
    return { world, root, state, gate, childrenOf, said, rounds, handles, wakes }
  })

/**
 * A latched handle: running, its observation the latch with its opening (the machine field), within the minute the
 * pool named, and its note says latched and names that opening (the text).
 */
const expectLatched = (expect: typeof import("bun:test").expect, handle: typeof Handle.Type, child: string, named: { readonly asked: number; readonly answered: number }) => {
  expect(handle.sessionID).toBe(child)
  expect(handle.state).toBe("running")
  expect(handle.observation?.phase._tag).toBe("Latched")
  const opensAt = handle.observation?.phase.opensAt ?? 0
  // The pool names its opening on the orchestrate plugin's fixed clock when it is asked; the latch keeps it, past the
  // start's own margin of a few seconds.
  expect(opensAt).toBeGreaterThanOrEqual(named.answered)
  expect(opensAt).toBeLessThanOrEqual(named.asked + 10_000)
  expect(handle.note).toContain(`The subagent is latched (sessionID: ${child}`)
  expect(handle.note).toContain(DateTime.formatIso(DateTime.makeUnsafe(Math.ceil(opensAt / 1000) * 1000)).replace(".000Z", "Z"))
}

seeded("a held follow-up from a cell answers latched with its opening, stays latched on a read, and settles once when its round ends", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, root, state, gate, said, rounds, handles, wakes } = yield* boot(seed)
    const named = () => Date.parse(PIN) + gate.openAt - world.now()
    const asked = named()
    yield* world.prompt(root, CONTINUE)
    yield* world.until(() => handles().length === 2, 30_000)
    const opensAt = { asked, answered: named() }
    expectLatched(expect, handles()[1]!, state.child, opensAt)
    // A read while it waits still finds the latch: the first round's end is not this round's.
    yield* world.prompt(root, READ)
    yield* world.until(() => handles().length === 3, 30_000)
    expect(handles()[2]!.state).toBe("running")
    expect(handles()[2]!.observation?.phase._tag).toBe("Latched")
    expect(rounds(state.child, ROUND_TWO)).toEqual([])
    // At the opening the round starts by itself once; its end wakes the root once, and a read then finds it settled.
    yield* world.until(() => wakes(TWO_DONE) === 1, OPEN_MS * 4)
    expect(rounds(state.child, ROUND_TWO).length).toBe(1)
    expect(rounds(state.child, ROUND_TWO)[0]!.created).toBeGreaterThanOrEqual(gate.openAt)
    yield* world.until(() => world.sessions.get(root)?.running !== true, 30_000)
    yield* world.prompt(root, READ)
    yield* world.until(() => handles().length === 4, 30_000)
    expect(handles()[3]!.state).toBe("done")
    yield* world.until(() => false, 120_000).pipe(Effect.ignore)
    expect(said(state.child, TWO_DONE)).toBe(1)
    expect(wakes(TWO_DONE)).toBe(1)
  }),
)

seeded("a held fresh start from a cell answers latched with its opening", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, root, gate, childrenOf, said, handles, wakes } = yield* boot(seed)
    const named = () => Date.parse(PIN) + gate.openAt - world.now()
    const asked = named()
    yield* world.prompt(root, FRESH)
    yield* world.until(() => handles().length === 2, 30_000)
    const opensAt = { asked, answered: named() }
    const importer = childrenOf().find((child) => child.id === handles()[1]!.sessionID)!.id
    expectLatched(expect, handles()[1]!, importer, opensAt)
    yield* world.until(() => wakes(IMPORT_DONE) === 1, OPEN_MS * 4)
    yield* world.until(() => false, 120_000).pipe(Effect.ignore)
    expect(said(importer, IMPORT_DONE)).toBe(1)
    expect(wakes(IMPORT_DONE)).toBe(1)
  }),
)
