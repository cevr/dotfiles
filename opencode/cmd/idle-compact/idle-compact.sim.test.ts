// Idle compaction on the simulated host (sim/world.ts), each test at 20
// seeds: tests/idle-compact.test.ts's names and claims, moved off real
// OpenCode (it waited out a 20 s cache in real time). The plugin is the one
// OpenCode loads (`cmd/idle-compact/server.ts`'s default export), with the
// real run's options: a 20 s cache and a 5 s margin, a 50-token threshold. The
// model answers as the real run's scripted model did (tests/idle-compact/sim.ts).
// The seed varies how long each request streams, the order of fibers and of
// timers due at one instant, and the ids.
import { Effect } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import { line } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"
import {
  ANSWER,
  BACKGROUND_SECONDS,
  BACKGROUND_TASK,
  EARLY_MS,
  LATE_MS,
  MARGIN_SECONDS,
  PRECOMPUTE_FIRST,
  PRECOMPUTE_PROMPT,
  PRECOMPUTE_TASK,
  PROMPT_TOKENS,
  SUMMARY,
  TASK,
  TTL_SECONDS,
  WAKE_MS,
} from "../../tests/idle-compact/sim.ts"

const { seeded } = Seed.runner("cmd/idle-compact/idle-compact.sim.test.ts")

/** A reply's usage for a prompt of `prompt` tokens: as the real sim reports, 400 read from the cache and 500 written. */
const usage = (prompt: number): World.Usage => ({ input: prompt - 900, read: 400, write: 500 })

/** The precompute task's turn: a foreground shell first, then the answer on a prompt near the window's ceiling. */
const precomputing = (started: boolean) => {
  if (started) return World.say(ANSWER, usage(PRECOMPUTE_PROMPT))
  return World.call("call_fg", "shell", { command: "true", background: false }, usage(PRECOMPUTE_FIRST))
}

/** The real run's scripted model (tests/idle-compact/sim.ts `replyOf`): a summary for a compaction, the background and precompute tasks' shells, else one line. */
const script: World.Script = (request) => {
  if (request.kind === "title") return World.say("Idle run")
  if (request.kind === "compaction") return World.say(SUMMARY, usage(PROMPT_TOKENS))
  const started = request.text.includes("\ntool ")
  if (request.text.includes(BACKGROUND_TASK) && !started)
    return World.call("call_bg", "shell", { command: `sleep ${BACKGROUND_SECONDS}`, background: true }, usage(PROMPT_TOKENS))
  if (request.text.includes(PRECOMPUTE_TASK)) return precomputing(started)
  return World.say(ANSWER, usage(PROMPT_TOKENS))
}

const OPTIONS = { ttlSeconds: TTL_SECONDS, shortMarginSeconds: MARGIN_SECONDS, thresholdTokens: 50 }
const WORK = "/scratch/work"

interface Spec {
  readonly background?: boolean
  readonly others?: number
  readonly precompute?: boolean
  /** The host records a compaction's reason (the fork); without it, every compaction is `manual`. */
  readonly reason?: boolean
}

/** The task the session is given: the background shell's, the precompute one's, or the plain one. */
const taskOf = (spec: Spec) => {
  if (spec.background === true) return BACKGROUND_TASK
  if (spec.precompute === true) return PRECOMPUTE_TASK
  return TASK
}

/** The fork's background summary of a 128k window: past the trigger (64.4k) and under the ceiling (108.8k). */
const WINDOW = { trigger: 64_400, ceiling: 108_800 }

/** The world for a spec, the plugin loaded for the work directory (and `others` more), and the session. */
const boot = (seed: number, spec: Spec) =>
  Effect.gen(function* () {
    const world = World.make({ seed, script, compactionReason: spec.reason !== false, ...(spec.precompute === true && { backgroundCompaction: WINDOW }) })
    const session = yield* world.session(WORK)
    yield* world.load(Plugins.idleCompact, { directory: WORK, options: OPTIONS })
    for (let index = 0; index < (spec.others ?? 0); index += 1)
      yield* world.load(Plugins.idleCompact, { directory: `/scratch/other-${index}`, options: OPTIONS })
    // Past each copy's first look, which waits for the catalog to settle.
    if (spec.others !== void 0) yield* world.advance(3_000)
    return { world, session }
  })

/** A request's kind as the real run's sim names it: a primary request is a turn. */
const kindOf = (kind: "primary" | "compaction" | "title") => {
  if (kind === "primary") return "turn"
  return kind
}

/** How long after the turn the run reads the late context: past the shell's wake with a background shell. */
const lateOf = (spec: Spec) => {
  if (spec.background === true) return WAKE_MS
  return LATE_MS
}

/** One run as tests/idle-compact/run.ts made it in real OpenCode: the prompt, the context early and late, the requests and the log. */
const run = (seed: number, spec: Spec = {}) =>
  Effect.gen(function* () {
    const { world, session } = yield* boot(seed, spec)
    yield* world.prompt(session, taskOf(spec))
    const running = () => world.sessions.get(session)?.running === true
    yield* world.until(() => !running(), 60_000)
    const seen = () => world.requests().map((request) => ({ kind: kindOf(request.kind), at: request.at }))
    const turn = seen().findLast((item) => item.kind === "turn")?.at ?? world.elapsed()
    yield* world.advance(turn + EARLY_MS - world.elapsed())
    const early = world.context(session)
    const compacted = () => world.context(session).some((message) => message.type === "compaction" && message.status === "completed")
    const compaction = () => seen().find((item) => item.kind === "compaction")?.at ?? Number.POSITIVE_INFINITY
    const woke = () => seen().some((item) => item.kind === "turn" && item.at > compaction())
    const done = () => compacted() && (spec.background !== true || woke())
    const limit = turn + lateOf(spec)
    while (world.elapsed() < limit && !done()) yield* world.advance(500)
    if (spec.background === true) yield* world.until(() => !running(), 60_000)
    const log = world
      .logs()
      .filter((line) => line.message === "loading plugin" || line.message.startsWith("idle-compact"))
      .map((line) => ({ message: line.message, sessionID: String(line.annotations["sessionID"] ?? ""), trigger: String(line.annotations["trigger"] ?? "") }))
    // The request's start as the host saw it: the clock the plugin reads.
    return { early, late: world.context(session), seen: seen(), started: world.requests(), log }
  })

const compactions = (messages: ReadonlyArray<World.Message>) => messages.flatMap(compactionOf)
/** A compaction message, alone; nothing for another. */
const compactionOf = (message: World.Message) => {
  if (message.type === "compaction") return [message]
  return []
}
/** When the compaction is due: the cache's lifetime less the margin, from the request's start as the host saw it. */
const dueAfter = (start: ReadonlyArray<{ readonly at: number }>) => (start.at(-1)?.at ?? Number.NaN) + (TTL_SECONDS - MARGIN_SECONDS) * 1_000

seeded("an idle session is not compacted while its cache has time left, and is compacted once it is a margin from expiring", ({ seed, expect }) =>
  Effect.gen(function* () {
    const result = yield* run(seed)
    const turn = result.seen.find((item) => item.kind === "turn")
    expect(turn).toBeDefined()
    // Ten seconds in, with five left before the margin: the session sat idle and nothing compacted it.
    expect(compactions(result.early)).toEqual([])
    expect(line(result.early)).toContain(ANSWER)
    expect(result.seen.filter((item) => item.at <= (turn?.at ?? 0) + EARLY_MS).map((item) => item.kind)).not.toContain("compaction")
    // Then, once: OpenCode's compaction ran on the model, no sooner than the cache's lifetime less the margin.
    const summaries = result.seen.filter((item) => item.kind === "compaction")
    expect(summaries).toHaveLength(1)
    const due = dueAfter(result.started.filter((item) => item.kind === "primary").slice(0, 1))
    expect(summaries[0]?.at).toBeGreaterThanOrEqual(due)
    expect(summaries[0]?.at).toBeLessThan(due + 5_000)
    const [compaction] = compactions(result.late)
    expect(compaction?.status).toBe("completed")
    expect(compaction?.summary).toContain(SUMMARY)
    // No turn came after the prompt's: the compaction ran on its own.
    expect(result.seen.filter((item) => item.kind === "turn")).toHaveLength(1)
  }),
)

seeded("the idle compaction is recorded as automatic", ({ seed, expect }) =>
  Effect.gen(function* () {
    const [compaction] = compactions((yield* run(seed)).late)
    expect(compaction?.reason).toBe("auto")
  }),
)

seeded("a host without a compaction reason records the idle compaction as manual", ({ seed, expect }) =>
  Effect.gen(function* () {
    const [compaction] = compactions((yield* run(seed, { reason: false })).late)
    expect(compaction?.reason).toBe("manual")
  }),
)

seeded("with copies of the plugin for other directories on the host, the idle session is compacted once, by its own directory's", ({ seed, expect }) =>
  Effect.gen(function* () {
    const result = yield* run(seed, { others: 2 })
    const summaries = result.seen.filter((item) => item.kind === "compaction")
    expect(summaries).toHaveLength(1)
    const due = dueAfter(result.started.filter((item) => item.kind === "primary").slice(0, 1))
    expect(summaries[0]?.at).toBeGreaterThanOrEqual(due)
    expect(summaries[0]?.at).toBeLessThan(due + 5_000)
    expect(compactions(result.late)).toHaveLength(1)
    // Three copies ran, and the idle window got one decision: one line scheduling it, one compacting it (the
    // compaction's own end is decided after, as not compacting).
    expect(result.log.filter((line) => line.message === "loading plugin")).toHaveLength(3)
    const session = result.log.find((line) => line.message === "idle-compact: compaction scheduled")?.sessionID
    expect(
      result.log.filter((line) => line.sessionID === session && line.message !== "idle-compact: not compacting").map((line) => [line.message, line.trigger]),
    ).toEqual([
      ["idle-compact: compaction scheduled", "settled"],
      ["idle-compact: compacting the idle session before its cache expires", "timer"],
    ])
  }),
)

seeded("with background compaction on, the idle compaction swaps in the summary the host held, and asks the model for none", ({ seed, expect }) =>
  Effect.gen(function* () {
    const result = yield* run(seed, { precompute: true })
    // The one summary request came as the turn ended (the host's background summary), long before the idle one was due.
    const summaries = result.seen.filter((item) => item.kind === "compaction")
    expect(summaries).toHaveLength(1)
    const due = dueAfter(result.started.filter((item) => item.kind === "primary"))
    expect(summaries[0]?.at).toBeLessThan(due - 5_000)
    expect(compactions(result.early)).toEqual([])
    // Then the plugin compacted on time, and the compaction took the held summary: no second request.
    const session = result.log.find((line) => line.message === "idle-compact: compaction scheduled")?.sessionID
    expect(result.log.some((line) => line.sessionID === session && line.message.startsWith("idle-compact: compacting"))).toBe(true)
    const [compaction] = compactions(result.late)
    expect(compaction?.status).toBe("completed")
    expect(compaction?.summary).toContain(SUMMARY)
    expect(result.started.filter((item) => item.kind === "compaction")).toHaveLength(1)
    expect(result.seen.filter((item) => item.kind === "turn")).toHaveLength(2)
  }),
)

seeded(
  "a session idle behind a background shell that outlives its cache is compacted a margin from expiry, before the shell's notice wakes it",
  ({ seed, expect }) =>
    Effect.gen(function* () {
      const result = yield* run(seed, { background: true })
      const compaction = result.seen.find((item) => item.kind === "compaction")
      expect(compaction).toBeDefined()
      // The cache's last refresh: the turn's last request before the compaction, the one after the shell started.
      const turns = result.seen.filter((item) => item.kind === "turn")
      expect(turns.filter((item) => item.at < (compaction?.at ?? 0))).toHaveLength(2)
      const compacting = result.started.find((item) => item.kind === "compaction")
      const due = dueAfter(result.started.filter((item) => item.kind === "primary" && item.at < (compacting?.at ?? 0)))
      expect(compaction?.at).toBeGreaterThanOrEqual(due)
      expect(compaction?.at).toBeLessThan(due + 5_000)
      // The shell was still running then: its notice woke the session afterwards, onto the summary.
      const wake = turns.find((item) => item.at > (compaction?.at ?? 0))
      expect(wake).toBeDefined()
      expect(wake?.at).toBeGreaterThanOrEqual((turns[0]?.at ?? 0) + BACKGROUND_SECONDS * 1_000)
      expect(result.seen.filter((item) => item.kind === "compaction")).toHaveLength(1)
      const [summary] = compactions(result.late)
      expect(summary?.status).toBe("completed")
      expect(line(result.late)).toContain(`sleep ${BACKGROUND_SECONDS}`)
    }),
)
