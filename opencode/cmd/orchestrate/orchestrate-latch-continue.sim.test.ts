// @reads all
// @reads-reason computed read at mods/kernel/filestore/files.ts: const info = yield* Effect.tryPromise({ try: () => stat(path), catch: unreadable })
// A continued round the pool's pace holds latches on its child, as a new start
// does, on the simulated host (sim/world.ts), each test at 20 seeds, in virtual
// time, with no provider request: the orchestrate and wakes plugins are their
// composition roots on the world (sim/plugins.ts), and the pool is the test's
// stand-in, whose `pace` holds every ask until the opening and whose `started`
// moves its line on by `LINE_MS` for each new agent it is told of (a launch at
// an opening pushes later askers past the line, as on 2026-11-26 at 19:52Z).
import type { CallLine } from "@dotfiles/opencode-orchestrate/call-line"
import { POOL_STATUS } from "@dotfiles/opencode-pool/status"
import { Plugin } from "@opencode/plugin/effect"
import { Effect, Option, Schema } from "effect"
import { live, make } from "../kernel/server.ts"
import * as Plugins from "../../sim/plugins.ts"
import { simulationRunner } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = simulationRunner("cmd/orchestrate/orchestrate-latch-continue.sim.test.ts")

const WORK = "/scratch/project"
/** The orchestrate plugin's fixed clock: a Wednesday morning, so only the pace holds. */
const PIN = "2026-11-04T15:00:00Z"
/** How long after the hold begins the pool opens. */
const OPEN_MS = 60_000
/** How far ahead a hold names its opening at most: a continued round asked early is decided again, and latches again, before the opening. */
const HINT_MS = 20_000
/** How far one new agent the pool is told of moves its line on. */
const LINE_MS = 30_000

const START = "Start the export worker."
const CONTINUE = "Continue the export worker."
const FRESH = "Start the import worker."
const ROUND_ONE = "Brief one: check the CSV export."
const ROUND_TWO = "Brief two: now check the JSON export."
const IMPORT = "Import brief: check the CSV import."
const ONE_DONE = "Round one passed."
const TWO_DONE = "Round two passed."
const IMPORT_DONE = "The import check passed."
const AUDIT = "Start the audit worker."
const AUDIT_BRIEF = "Audit brief: check the logs."
const AUDIT_DONE = "The audit passed."

/** A line that opens a message in a request's text. */
const OPENS = /^(user|synthetic|assistant|tool|compaction|error)[ :]/
/** The last message's text: from the last line that opens a message. */
const lastOf = (text: string) => {
  const all = text.split("\n")
  return all.slice(Math.max(0, all.findLastIndex((line) => OPENS.test(line)))).join("\n")
}

/** The model: the root asks as its last prompt says; a worker answers the brief it was last given. */
const model = (state: { child: string; calls: number }): World.Script => (request) => {
  if (request.kind === "title") return World.say("export check")
  const last = lastOf(request.text)
  if (last.includes(ROUND_TWO)) return World.say(TWO_DONE)
  if (last.includes(IMPORT)) return World.say(IMPORT_DONE)
  if (last.includes(AUDIT_BRIEF)) return World.say(AUDIT_DONE)
  if (last.includes(ROUND_ONE)) return World.say(ONE_DONE)
  if (!last.startsWith("user")) return World.say("Noted.")
  state.calls += 1
  const id = `call_${state.calls}`
  if (last.includes(START)) return World.call(id, "subagent", { agent: "worker", description: "Export worker", prompt: ROUND_ONE })
  if (last.includes(CONTINUE)) return World.call(id, "subagent", { sessionID: state.child, agent: "worker", description: "Export worker", prompt: ROUND_TWO })
  if (last.includes(FRESH)) return World.call(id, "subagent", { agent: "worker", description: "Import worker", prompt: IMPORT })
  if (last.includes(AUDIT)) return World.call(id, "subagent", { agent: "worker", description: "Audit worker", prompt: AUDIT_BRIEF })
  return World.say("?")
}

/** The stand-in pool: held until `openAt` (world time), and for `LINE_MS` after each new agent it is told of. */
const POOL = { ...POOL_STATUS, methods: { pace: POOL_STATUS.methods.pace, started: POOL_STATUS.methods.started } }
const pool = (gate: { openAt: number; asked: number }, now: () => number) =>
  Plugin.define({
    id: "fixture.pool",
    effect: (ctx) =>
      ctx.rpc
        .register(POOL, {
          pace: () =>
            Effect.sync(() => {
              gate.asked += 1
              const at = now()
              if (at >= gate.openAt) return { ok: true, measured: true, reason: "scripted room" }
              // The hold names its time on the orchestrate plugin's fixed clock, as the latch test's pool does.
              const opens = Math.min(gate.openAt, at + HINT_MS)
              return { ok: false, measured: true, reason: "scripted 5h window is full", retryAt: Date.parse(PIN) + (opens - at) }
            }),
          started: () =>
            Effect.sync(() => {
              gate.openAt = Math.max(gate.openAt, now() + LINE_MS)
            }).pipe(Effect.as({})),
        })
        .pipe(Effect.orDie, Effect.asVoid),
  })

/** A subagent call's result after the first: what the later calls answered. */
const isAnswer = (message: World.Message): message is Extract<World.Message, { readonly type: "tool" }> =>
  message.type === "tool" && message.callID !== "call_1"

/** A call line's child session, when it names one. */
const WithChild = Schema.Struct({ child: Schema.String })
const childOf = (line: CallLine) => Option.map(Schema.decodeUnknownOption(WithChild)(line), (named) => named.child)

/** Words that tell the root to start the work again by hand: a refusal's, or a failed latch's. */
const START_AGAIN = /start it again after then|Call subagent again/

/** One world: the root's first round of the export worker run and heard, the pool open. */
const boot = (seed: number) =>
  Effect.gen(function* () {
    const state = { child: "", calls: 0 }
    const world = World.make({ seed, start: Date.parse(PIN), script: model(state) })
    const calls: Array<CallLine> = []
    const gate = { openAt: 0, asked: 0 }
    yield* world.load(Plugins.orchestrate({ lines: calls }), { directory: WORK, options: { now: PIN } })
    yield* world.load(Plugins.wake(world), { directory: WORK, options: { backstop: "off" } })
    yield* world.load(pool(gate, () => world.now()), { directory: WORK })
    yield* world.load(make(live), { directory: WORK, options: { codeOnly: false } })
    const root = yield* world.session(WORK)
    const childrenOf = () => [...world.sessions.values()].filter((session) => session.parentID._tag === "Some" && session.parentID.value === root)
    const said = (sessionID: string, text: string) => world.messages(sessionID).filter((message) => message.type === "assistant" && message.text.includes(text)).length
    const rounds = (sessionID: string, brief: string) => world.messages(sessionID).filter((message) => message.type === "user" && message.text.includes(brief))
    /** The root's subagent call results after the first, as the model read them. */
    const answers = () => world.messages(root).filter(isAnswer).map((message) => message.output)
    yield* world.prompt(root, START)
    yield* world.until(() => childrenOf().some((child) => said(child.id, ONE_DONE) === 1), 60_000)
    state.child = childrenOf()[0]!.id
    // The pool is spent from here: it opens a minute on.
    gate.openAt = world.now() + OPEN_MS
    return { world, root, state, gate, calls, childrenOf, said, rounds, answers }
  })

seeded("a held continued round latches on its child and, at the opening, starts by itself once with its prompt; a retry by hand finds the latch", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, root, state, gate, said, rounds, answers } = yield* boot(seed)
    yield* world.prompt(root, CONTINUE)
    yield* world.until(() => answers().length === 1, 30_000)
    const [latched] = answers()
    expect(latched).toContain(`The subagent is latched (sessionID: ${state.child}`)
    expect(latched).toContain("It starts by itself in the background when the latch opens, about")
    expect(latched).not.toContain("no latch could be kept")
    // The caller retries by hand while it waits: the retry finds the latch and starts nothing.
    yield* world.prompt(root, CONTINUE)
    yield* world.until(() => answers().length === 2, 30_000)
    expect(answers()[1]).toContain(`subagent ${state.child} is latched and has not started`)
    expect(rounds(state.child, ROUND_TWO)).toEqual([])
    yield* world.until(() => said(state.child, TWO_DONE) === 1, OPEN_MS * 4)
    yield* world.until(() => world.messages(root).some((message) => message.type === "synthetic" && message.text.includes(TWO_DONE)), 30_000)
    // Once, at the opening, with the prompt it was given.
    const round = rounds(state.child, ROUND_TWO)
    expect(round.length).toBe(1)
    expect(round[0]!.created).toBeGreaterThanOrEqual(gate.openAt)
    yield* world.until(() => false, 120_000).pipe(Effect.ignore)
    expect(rounds(state.child, ROUND_TWO).length).toBe(1)
    expect(said(state.child, TWO_DONE)).toBe(1)
  }),
)

seeded("a continued round latched before a server restart starts once after it", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, root, state, said, rounds, answers } = yield* boot(seed)
    yield* world.prompt(root, CONTINUE)
    yield* world.until(() => answers().length === 1, 30_000)
    expect(answers()[0]).toContain("The subagent is latched")
    yield* world.restart
    yield* world.until(() => said(state.child, TWO_DONE) >= 1, OPEN_MS * 4)
    yield* world.until(() => false, 120_000).pipe(Effect.ignore)
    expect(rounds(state.child, ROUND_TWO).length).toBe(1)
    expect(said(state.child, TWO_DONE)).toBe(1)
  }),
)

seeded("order: latches open first come, first served by the time they were held; a continued round held before a new start opens first, and the new start, pushed past the line, latches again by itself", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, root, state, gate, calls, childrenOf, said, rounds, answers } = yield* boot(seed)
    const opening = gate.openAt
    yield* world.prompt(root, CONTINUE)
    yield* world.until(() => answers().length === 1, 30_000)
    expect(answers()[0]).toContain("The subagent is latched")
    // The new start is held later, for the same opening; the continued round is decided again before it and
    // latches again, so the wakes hand the new start in first at the opening.
    yield* world.until(() => world.now() >= opening - OPEN_MS + 5_000, 30_000).pipe(Effect.ignore)
    yield* world.prompt(root, FRESH)
    yield* world.until(() => answers().length === 2, 30_000)
    expect(answers()[1]).toContain("The subagent is latched")
    yield* world.prompt(root, AUDIT)
    yield* world.until(() => answers().length === 3, 30_000)
    expect(answers()[2]).toContain("The subagent is latched")
    const done = () => [IMPORT_DONE, AUDIT_DONE].every((text) => childrenOf().some((child) => said(child.id, text) === 1)) && said(state.child, TWO_DONE) === 1
    yield* world.until(done, OPEN_MS * 8)
    const first = (brief: string) => childrenOf().flatMap((child) => rounds(child.id, brief))
    const continued = rounds(state.child, ROUND_TWO)
    const imported = first(IMPORT)
    const audited = first(AUDIT_BRIEF)
    expect([continued.length, imported.length, audited.length]).toEqual([1, 1, 1])
    expect(continued[0]!.created).toBeGreaterThanOrEqual(opening)
    // Held first, opened first: the continued round, then the import, then the audit, as the call log records their starts.
    const importer = childrenOf().find((child) => rounds(child.id, IMPORT).length === 1)!.id
    const auditor = childrenOf().find((child) => rounds(child.id, AUDIT_BRIEF).length === 1)!.id
    expect(calls.filter((line) => line.kind === "call").map(childOf).slice(-3)).toEqual([state.child, importer, auditor].map(Option.some))
    // The import's start moved the line: the audit, next in the queue, latched again by itself for the new opening.
    expect(audited[0]!.created).toBeGreaterThanOrEqual(imported[0]!.created + LINE_MS)
    // Nothing was refused: every answer was a latch, and nothing told the root to start it again.
    expect(world.messages(root).some((message) => message.type === "tool" && message.error)).toBe(false)
    expect(world.messages(root).some((message) => (message.type === "synthetic" && START_AGAIN.test(message.text)) || (message.type === "tool" && START_AGAIN.test(message.output)))).toBe(false)
  }),
)
