// A job's end as a durable event, on the simulated host (sim/world.ts) at 20
// seeds: the wakes plugin (`cmd/wake/server.ts`'s `make`, sim/plugins.ts) on
// the runner's memory double, which the test drives as the job's runner
// would: it records the end (`MemoryRunner.ended`, `lost`, `spawnFailed`),
// then rings the wakes' `due`, the call cmd/wake/job.ts makes through the OS
// backstop's script once the exit is written. Nothing here prewrites a fire,
// a delivery or a marker: every recovery reads what the plugin itself wrote.
//
// - A worker's job: the run's receipt ends its turn; while the job runs the
//   model is asked nothing and the plugin looks at the job at most once per
//   RECOVER_MS (no per-job scan); the runner's call, at a barrier that is no
//   10 s tick, steers one letter at once with its typed end and log handle,
//   and that one letter makes one turn.
// - 22u B1 as a job: the runner's call lands inside the owner's turn, after
//   its inbox was read; the letter still makes a turn once that one ends.
// - T1 as a job: the plugin's own storage write of the fire dies; the
//   runner's call is retried and the sweep reconciles, one letter. The write
//   of its delivery dies after the session took the letter: the resend under
//   the same id adds no message and no turn.
// - A call lost across a reload, an outage and two locations starting: the
//   start or the sweep delivers it, within RECOVER_MS.
// - The backstop off (no runner's call): the job's watch announces the end at
//   once; a missed event and a host out of watches leave it to the sweep,
//   within RECOVER_MS; a watch per live job, none once all are delivered.
// - A generated property: seeds interleave starts, ends of every kind, the
//   runner's call or the watch's event rung or lost, checks, the owner's park, wait and kill (its
//   end seen, or not yet), an ancestor's kill and the TUI's stop, failed
//   writes, session deletion, reloads and outages. An independent fold of the
//   history says what each job owes; the observed letters and the owner's
//   answers must deliver each eligible end exactly once, with its kind, and
//   every letter must reach a model request.
import { Array as Arr, Console, Effect, Match, Option, Schema } from "effect"
import * as MemoryRunner from "@dotfiles/opencode-wake/memory/runner"
import { WAKES } from "@dotfiles/opencode-wake/wake"
import * as Plugins from "../../sim/plugins.ts"
import { below, generator } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/wake/job-events.sim.test.ts")

const WORK = "/scratch/project"
const OTHER = "/scratch/other"
const SECOND = 1_000
const MINUTE = 60_000
/** The old per-job scan's period: an end announced at a barrier between its ticks goes at once. */
const OLD_TICK = 10 * SECOND
/** The bound the design gives an end no call announced (job.ts RECOVER_MS), held here as a number: the test reads the same on any base. */
const RECOVER_MS = MINUTE

type Synthetic = Extract<World.Message, { readonly type: "synthetic" }>
type Assistant = Extract<World.Message, { readonly type: "assistant" }>
type ToolMessage = Extract<World.Message, { readonly type: "tool" }>

const isLetter = (message: World.Message): message is Synthetic => message.type === "synthetic" && message.metadata["kind"] === "job" && message.metadata["progress"] !== true
const isAssistant = (message: World.Message): message is Assistant => message.type === "assistant"

/** A job's end letters in a session: synthetic job messages that are not progress; of the jobs named, when any are. */
const lettersIn = (world: World.World, session: string, ...ids: ReadonlyArray<string>): ReadonlyArray<Synthetic> =>
  world
    .messages(session)
    .filter(isLetter)
    .filter((message) => ids.length === 0 || ids.some((id) => message.metadata["id"] === id))

/** The kind of end a letter carries in its typed event. */
const Ended = Schema.Struct({ disposition: Schema.String })
const kindIn = (letter: Synthetic) =>
  Schema.decodeUnknownOption(Ended)(letter.metadata["event"]).pipe(
    Option.map((event) => event.disposition),
    Option.getOrElse(() => "no event"),
  )

/** The runner's call once its exit is written: what it got, or that it did not reach a server. */
const Answered = Schema.Struct({ outcome: Schema.String })
const doorbell = (world: World.World, id: string) =>
  world.rpc(WAKES.id, "due", { id }).pipe(
    Effect.map((answer) =>
      Schema.decodeUnknownOption(Answered)(answer).pipe(
        Option.map((said) => said.outcome),
        Option.getOrElse(() => "none"),
      ),
    ),
    Effect.orElseSucceed(() => "unreached"),
  )

const jobIdOf = (output: string) => Option.flatMapNullishOr(Option.fromNullishOr(/Job (j[0-9a-z]{6}) started/.exec(output)), (found) => found[1])

const idle = (world: World.World, session: string) => world.sessions.get(session)?.running !== true

/** A model that names its conversation `title` and answers anything else by reading it. */
const reading = (title: string) => (request: World.Request) =>
  World.say(
    Match.value(request.kind).pipe(
      Match.when("title", () => title),
      Match.orElse(() => "Read."),
    ),
  )

/** The `job` calls a session's model made, by action, between two instants. */
const Acted = Schema.Struct({ action: Schema.String })
/** A `job` call's action; a call with none starts a job. */
const actionOf = (input: Schema.Json) =>
  Schema.decodeUnknownOption(Acted)(input).pipe(
    Option.map((acted) => acted.action),
    Option.getOrElse(() => "start"),
  )

const jobCalls = (world: World.World, session: string, from: number, to: number) =>
  world
    .messages(session)
    .filter(isAssistant)
    .flatMap((message) => Option.toArray(Option.filter(message.call, (used) => used.name === "job")).map((used) => ({ at: message.created, action: actionOf(used.input) })))
    .filter((call) => call.at >= from && call.at <= to)

seeded("a worker's job ends its turn; nothing polls it while it runs; the runner's call at a barrier before the next 10 s tick wakes it once with its typed end and log handle", ({ seed, expect }) =>
  Effect.gen(function* () {
    const runner = MemoryRunner.empty()
    const world = World.make({
      seed,
      script: (request) => {
        if (request.kind === "title") return World.say("Job events")
        const text = request.text
        const markers = [
          ["step-run", () => World.call("call_job_alpha", "job", { command: "make check", note: "ALPHA: read the result" })],
          ["call_job_alpha", () => World.say("Parked.")],
          ["Note: ALPHA", () => World.say("Woke on alpha.")],
        ] as const
        const latest = Arr.head(markers.map(([marker, respond]) => ({ at: text.lastIndexOf(marker), respond })).toSorted((left, right) => right.at - left.at))
        return Option.match(Option.filter(latest, (found) => found.at >= 0), { onNone: () => World.say("Nothing to do."), onSome: (found) => found.respond() })
      },
    })
    yield* world.load(Plugins.wake(world, runner), { directory: WORK, options: { backstop: "off" } })
    const session = yield* world.session(WORK)
    const replies = () =>
      world
        .messages(session)
        .filter(isAssistant)
        .map((message) => message.text)
        .filter((text) => text !== "")

    // The run: its receipt, then the turn ends (no wait, no shell loop).
    yield* world.prompt(session, "step-run")
    yield* world.until(() => idle(world, session) && replies().includes("Parked."), MINUTE)
    const job = Option.getOrThrow(Arr.head([...runner.jobs.values()]))
    const id = job.spec.id
    MemoryRunner.running(runner, id, world.now())
    const parkedAt = world.now()
    const asked = world.asked().length
    const reads = runner.reads

    // Five minutes and three seconds of running: no model request, no job call, and no per-job scan.
    yield* world.advance(5 * MINUTE + 3 * SECOND)
    expect(world.asked().length).toBe(asked)
    expect(jobCalls(world, session, parkedAt, world.now())).toEqual([])
    expect(runner.reads - reads).toBeLessThanOrEqual(Math.ceil((5 * MINUTE + 3 * SECOND) / RECOVER_MS))
    expect((world.now() - world.start) % OLD_TICK).not.toBe(0)

    // The runner records the exit, then rings: the letter is in the session at that same instant.
    job.log = "alpha-start\nALPHA-DONE\n"
    const endedAt = world.now()
    MemoryRunner.ended(runner, id, 3, endedAt)
    expect(yield* doorbell(world, id)).toBe("fired")
    const [letter] = lettersIn(world, session, id)
    expect(letter?.created).toBe(endedAt)
    expect(letter?.metadata["event"]).toEqual({ version: 1, job: id, generation: 1, sequence: 1, disposition: "failed", at: endedAt, exitCode: 3, log: `job-log:${id}/1` })
    expect(letter?.text).toContain(`End: failed (generation 1); log job-log:${id}/1.`)
    expect(letter?.text).toContain("ALPHA-DONE")

    // One letter, one turn that read it, and nothing more past several sweeps.
    yield* world.until(() => idle(world, session) && replies().includes("Woke on alpha."), MINUTE)
    yield* world.advance(3 * RECOVER_MS)
    const after = world.asked().filter((request) => request.sessionID === session && request.kind === "primary" && request.at >= endedAt - world.start)
    expect(after).toHaveLength(1)
    expect(after[0]?.text).toContain("Note: ALPHA")
    expect(lettersIn(world, session)).toHaveLength(1)
    expect(replies().filter((text) => text === "Woke on alpha.")).toHaveLength(1)
    expect(world.stale()).toEqual([])
  }),
)

seeded("a call that lands inside the owner's turn after its inbox was read (22u B1) still makes one turn once that turn ends", ({ seed, expect }) =>
  Effect.gen(function* () {
    const runner = MemoryRunner.empty()
    let rang = false
    let pending = Option.none<string>()
    const world: World.World = World.make({
      seed,
      script: (request) => {
        if (request.kind === "title") return World.say("Busy owner")
        if (request.text.lastIndexOf("Note: BETA") > request.text.lastIndexOf("user-work")) return World.say("Woke on beta.")
        if (request.text.includes("user-work") && !rang && Option.isSome(pending)) {
          rang = true
          const id = pending.value
          // The runner ends and rings while this turn's request is out: its inbox was read before.
          return Effect.sync(() => MemoryRunner.ended(runner, id, 0, world.now())).pipe(Effect.andThen(world.clientRpc(WAKES.id, "due", { id })), Effect.ignore, Effect.as(World.say("Did the user's work.")))
        }
        return World.say("Nothing to do.")
      },
    })
    yield* world.load(Plugins.wake(world, runner), { directory: WORK, options: { backstop: "off" } })
    const session = yield* world.session(WORK)
    const started = yield* world.tool(session, "job", { command: "make beta", note: "BETA: read it" })
    pending = jobIdOf(started.output)
    const beta = Option.getOrThrow(pending)
    MemoryRunner.running(runner, beta, world.now())
    // A reload, then the owner's work at once, as a boot that accepts work while it reconciles.
    yield* world.restart
    yield* world.prompt(session, "user-work")
    yield* world.until(() => idle(world, session) && rang, MINUTE)
    yield* world.until(() => idle(world, session), MINUTE)
    const letters = lettersIn(world, session, beta)
    expect(letters).toHaveLength(1)
    const letterAt = letters[0]?.created ?? Number.POSITIVE_INFINITY
    const reading = world.asked().filter((request) => request.sessionID === session && request.kind === "primary" && world.start + request.at >= letterAt && request.text.includes("Note: BETA"))
    expect(reading).toHaveLength(1)
    expect(world.sessions.get(session)?.inbox ?? []).toEqual([])
  }),
)

seeded("T1 as a job: a fire write that dies and a delivery write that dies after the session took the letter each end with one letter and one turn, from the plugin's own writes", ({ seed, expect }) =>
  Effect.gen(function* () {
    const runner = MemoryRunner.empty()
    const world = World.make({ seed, script: reading("T1") })
    yield* world.load(Plugins.wake(world, runner), { directory: WORK, options: { backstop: "off" } })
    const session = yield* world.session(WORK)
    const start = (note: string) => world.tool(session, "job", { command: `make ${note}`, note }).pipe(Effect.map((answer) => Option.getOrElse(jobIdOf(answer.output), () => "missing")))

    // The fire's own write dies: the call fails, the entry is as it was; the runner's retried call delivers.
    const first = yield* start("first")
    MemoryRunner.running(runner, first, world.now())
    MemoryRunner.ended(runner, first, 0, world.now())
    world.faults.failWrites(WAKES.id, 1)
    yield* doorbell(world, first)
    expect(lettersIn(world, session, first)).toHaveLength(0)
    yield* doorbell(world, first)
    expect(lettersIn(world, session, first)).toHaveLength(1)

    // Again with no second call: the sweep's retry delivers within RECOVER_MS.
    const second = yield* start("second")
    MemoryRunner.running(runner, second, world.now())
    MemoryRunner.ended(runner, second, 1, world.now())
    world.faults.failWrites(WAKES.id, 1)
    yield* doorbell(world, second)
    expect(lettersIn(world, session, second)).toHaveLength(0)
    yield* world.advance(RECOVER_MS)
    expect(lettersIn(world, session, second)).toHaveLength(1)

    // The fire is written and the session takes the letter; the write of its delivery dies; then a reload.
    const third = yield* start("third")
    MemoryRunner.running(runner, third, world.now())
    MemoryRunner.ended(runner, third, 2, world.now())
    world.faults.failWrites(WAKES.id, 1, 1)
    yield* doorbell(world, third)
    expect(lettersIn(world, session, third)).toHaveLength(1)
    yield* world.restart
    yield* world.advance(2 * RECOVER_MS)
    yield* world.until(() => idle(world, session), MINUTE)
    expect(lettersIn(world, session, third)).toHaveLength(1)
    const thirdAt = lettersIn(world, session, third)[0]?.created ?? 0
    expect(world.asked().filter((request) => request.sessionID === session && world.start + request.at >= thirdAt && request.text.includes("Note: third"))).toHaveLength(1)
    expect([first, second, third].map((id) => world.storage.get(WAKES.id)?.has(`wake:${id}`) ?? false)).toEqual([false, false, false])
  }),
)

seeded("a call lost across a reload, an outage and two locations starting is delivered once by the owning location's start or sweep, within RECOVER_MS", ({ seed, expect }) =>
  Effect.gen(function* () {
    const runner = MemoryRunner.empty()
    const world = World.make({ seed, script: reading("Lost calls") })
    yield* world.load(Plugins.wake(world, runner), { directory: WORK, options: { backstop: "off" } })
    yield* world.load(Plugins.wake(world, runner), { directory: OTHER, options: { backstop: "off" } })
    const session = yield* world.session(WORK)
    const start = (note: string) => world.tool(session, "job", { command: `make ${note}`, note }).pipe(Effect.map((answer) => Option.getOrElse(jobIdOf(answer.output), () => "missing")))

    // Ended while the server was down: its call found nobody; the start delivers it.
    const down = yield* start("down")
    MemoryRunner.running(runner, down, world.now())
    yield* world.down
    MemoryRunner.ended(runner, down, 0, world.now())
    yield* world.advance(2 * MINUTE)
    yield* world.up
    expect(lettersIn(world, session, down)).toHaveLength(1)
    expect(lettersIn(world, session, down)[0]?.text).toContain("no OpenCode server was running then")

    // Ended with both locations up and its call lost: the owning location's sweep delivers it, the other never.
    const quiet = yield* start("quiet")
    MemoryRunner.running(runner, quiet, world.now())
    MemoryRunner.ended(runner, quiet, 0, world.now())
    const endedAt = world.now()
    yield* world.restart
    yield* world.advance(RECOVER_MS)
    const letters = lettersIn(world, session, quiet)
    expect(letters).toHaveLength(1)
    expect((letters[0]?.created ?? Number.POSITIVE_INFINITY) - endedAt).toBeLessThanOrEqual(RECOVER_MS)

    // A runner gone without an exit, a launch never claimed, and a command that never started: each its own kind, once.
    const gone = yield* start("gone")
    MemoryRunner.running(runner, gone, world.now())
    const unclaimed = yield* start("unclaimed")
    const unstarted = yield* start("unstarted")
    MemoryRunner.spawnFailed(runner, unstarted, world.now())
    yield* doorbell(world, unstarted)
    MemoryRunner.lost(runner, gone)
    yield* world.advance(2 * RECOVER_MS)
    yield* world.until(() => idle(world, session), MINUTE)
    const kinds = [gone, unclaimed, unstarted].map((id) => lettersIn(world, session, id).map(kindIn))
    expect(kinds).toEqual([["lost"], ["never-started"], ["spawn-failed"]])
    expect(world.stale()).toEqual([])
  }),
)

seeded("with no runner's call (the backstop off), the job's watch announces its end at once; a missed event and a host out of watches are found by the sweep within RECOVER_MS; watches are one per live job and none after", ({ seed, expect }) =>
  Effect.gen(function* () {
    const runner = MemoryRunner.empty()
    const world = World.make({ seed, script: reading("Watched") })
    yield* world.load(Plugins.wake(world, runner), { directory: WORK, options: { backstop: "off" } })
    const session = yield* world.session(WORK)
    const start = (note: string) => world.tool(session, "job", { command: `make ${note}`, note }).pipe(Effect.map((answer) => Option.getOrElse(jobIdOf(answer.output), () => "missing")))

    // The exit file appears under the watch: the letter is in the session at that instant, and the watch closes.
    const heard = yield* start("heard")
    const missed = yield* start("missed")
    expect([...runner.watched.keys()].toSorted()).toEqual([heard, missed].toSorted())
    MemoryRunner.running(runner, heard, world.now())
    MemoryRunner.running(runner, missed, world.now())
    yield* world.advance(7 * SECOND)
    const heardAt = world.now()
    MemoryRunner.ended(runner, heard, 0, heardAt)
    MemoryRunner.announce(runner, heard)
    yield* world.advance(1)
    expect(lettersIn(world, session, heard).map((message) => message.created - heardAt)).toEqual([0])
    expect([...runner.watched.keys()]).toEqual([missed])

    // An end whose file event never came: the sweep's next look, within RECOVER_MS.
    const missedAt = world.now()
    MemoryRunner.ended(runner, missed, 1, missedAt)
    yield* world.advance(RECOVER_MS)
    const late = lettersIn(world, session, missed)
    expect(late).toHaveLength(1)
    expect((late[0]?.created ?? Number.POSITIVE_INFINITY) - missedAt).toBeLessThanOrEqual(RECOVER_MS)
    // The watch's event, the runner's call and a reload after the delivery add nothing.
    MemoryRunner.announce(runner, missed)
    yield* doorbell(world, missed)
    yield* world.restart
    yield* world.advance(RECOVER_MS)
    expect(lettersIn(world, session, missed)).toHaveLength(1)

    // A host out of watches: the job runs on, and the sweep finds its end.
    runner.watches = false
    const unwatched = yield* start("unwatched")
    expect(runner.watched.has(unwatched)).toBe(false)
    MemoryRunner.running(runner, unwatched, world.now())
    const unwatchedAt = world.now()
    MemoryRunner.ended(runner, unwatched, 0, unwatchedAt)
    yield* world.advance(RECOVER_MS)
    expect(lettersIn(world, session, unwatched).map((message) => message.created - unwatchedAt <= RECOVER_MS)).toEqual([true])

    // A job still running at a reload is watched again by the start; its end then goes at once (the session idle,
    // so the letter is not held for a turn).
    yield* world.until(() => idle(world, session), MINUTE)
    runner.watches = true
    const kept = yield* start("kept")
    MemoryRunner.running(runner, kept, world.now())
    yield* world.restart
    expect([...runner.watched.keys()]).toEqual([kept])
    const keptAt = world.now()
    MemoryRunner.ended(runner, kept, 0, keptAt)
    MemoryRunner.announce(runner, kept)
    yield* world.advance(1)
    expect(lettersIn(world, session, kept).map((message) => message.created - keptAt)).toEqual([0])
    yield* world.until(() => idle(world, session), MINUTE)
    expect(runner.watched.size).toBe(0)
    expect(world.stale()).toEqual([])
  }),
)

// ── The generated property ──

type By = "owner" | "parent" | "ui"
type How = "exit0" | "exit1" | "spawn" | "lost" | "timeout"

type Command =
  | { readonly type: "job"; readonly session: number; readonly started: boolean }
  | { readonly type: "end"; readonly job: number; readonly how: How; readonly bell: boolean }
  | { readonly type: "bell"; readonly job: number; readonly watch: boolean }
  | { readonly type: "check"; readonly job: number }
  | { readonly type: "park"; readonly job: number }
  | { readonly type: "wait"; readonly job: number; readonly endDuring: boolean }
  | { readonly type: "kill"; readonly job: number; readonly by: By; readonly ends: boolean }
  | { readonly type: "fail-write"; readonly after: number }
  | { readonly type: "delete" }
  | { readonly type: "advance"; readonly ms: number }
  | { readonly type: "restart" }
  | { readonly type: "outage"; readonly ms: number }

const HOWS: ReadonlyArray<How> = ["exit0", "exit1", "spawn", "lost", "timeout"]
const BYS: ReadonlyArray<By> = ["owner", "parent", "ui"]

const commandOf = (pick: number, random: ReturnType<typeof generator>): Command => {
  if (pick < 4) return { type: "job", session: below(random, 3), started: below(random, 5) > 0 }
  if (pick < 7) return { type: "end", job: below(random, 12), how: HOWS[below(random, HOWS.length)] ?? "exit0", bell: below(random, 3) > 0 }
  if (pick < 8) return { type: "bell", job: below(random, 12), watch: below(random, 2) === 0 }
  if (pick < 9) return { type: "check", job: below(random, 12) }
  if (pick < 11) return { type: "park", job: below(random, 12) }
  if (pick < 12) return { type: "wait", job: below(random, 12), endDuring: below(random, 2) === 0 }
  if (pick < 14) return { type: "kill", job: below(random, 12), by: BYS[below(random, BYS.length)] ?? "owner", ends: below(random, 3) > 0 }
  if (pick < 15) return { type: "fail-write", after: below(random, 2) }
  if (pick < 16) return { type: "delete" }
  if (pick < 18) return { type: "advance", ms: 1 + below(random, 2 * MINUTE) }
  if (pick < 19) return { type: "restart" }
  return { type: "outage", ms: 1 + below(random, 3 * MINUTE) }
}

const commandsOf = (seed: number): ReadonlyArray<Command> => {
  const random = generator(`job-events:${seed}`)
  const count = 12 + below(random, 14)
  return [{ type: "job", session: 0, started: true }, ...Array.from({ length: count - 1 }, () => commandOf(below(random, 20), random))]
}

/** What the fold keeps of one job: who owns it, and its end as the runner recorded it. Nothing of the plugin's. */
interface Folded {
  readonly id: string
  readonly owner: number
  readonly setAt: number
  started: boolean
  /** The end's kind and when the runner recorded it; none while it runs. */
  end: Option.Option<{ readonly kind: string; readonly at: number }>
}

const kindOf = (how: How) => ({ exit0: "succeeded", exit1: "failed", spawn: "spawn-failed", lost: "lost", timeout: "timed-out" })[how]

/** The owner's own call that returned an ended job's end: the fold's delivery, when no letter came before. */
interface Answered {
  readonly job: string
  readonly at: number
}

interface Run {
  readonly world: World.World
  readonly runner: MemoryRunner.MemoryRunner
  /** s0 and s1 roots, s2 a subagent of s0. */
  readonly sessions: ReadonlyArray<string>
  readonly jobs: Array<Folded>
  readonly answers: Array<Answered>
  deleted: boolean
  acts: number
}

/** The runner records `how` for the job now (as its own file), when it has not already ended. */
const endJob = (run: Run, job: Folded, how: How) => {
  if (Option.isSome(job.end)) return
  const now = run.world.now()
  Match.value(how).pipe(
    Match.when("spawn", () => MemoryRunner.spawnFailed(run.runner, job.id, now)),
    Match.when("lost", () => MemoryRunner.lost(run.runner, job.id)),
    Match.when("timeout", () => MemoryRunner.timedOut(run.runner, job.id, now)),
    Match.when("exit1", () => MemoryRunner.ended(run.runner, job.id, 1, now)),
    Match.when("exit0", () => MemoryRunner.ended(run.runner, job.id, 0, now)),
    Match.exhaustive,
  )
  job.end = Option.some({ kind: kindOf(how), at: now })
}

/** The runner recorded the job's end as `kind` at `at`, when the fold has none yet. */
const ends = (job: Folded, kind: string, at: number) => {
  if (Option.isNone(job.end)) job.end = Option.some({ kind, at })
}

/** The owner's model makes the call: a turn that calls `job` with `input`, then says it is done. */
const act = (run: Run, session: string, input: Record<string, string | number>) =>
  Effect.gen(function* () {
    run.acts += 1
    const n = run.acts
    actions.set(n, input)
    yield* run.world.prompt(session, `ACT#${n}`)
    yield* run.world.until(() => idle(run.world, session), 2 * MINUTE)
    return Arr.findFirst(run.world.messages(session), (message): message is ToolMessage => message.type === "tool" && message.callID === `call_job_${n}`)
  })

/** The owner's call that answered without an error: a delivery when it returned the end. */
const answered = (run: Run, job: Folded, answer: Option.Option<ToolMessage>) => {
  for (const ok of Option.toArray(Option.filter(answer, (each) => !each.error))) run.answers.push({ job: job.id, at: ok.created })
}

/** The call each prompt `ACT#N` makes, read by the script. */
const actions = new Map<number, Record<string, string | number>>()

/** The generated sessions' model: a prompt `ACT#N` makes its call once; anything else (a letter, the call's answer) is read. */
const actScript = (request: World.Request): World.Reply => {
  if (request.kind === "title") return World.say("Generated")
  return Option.match(Arr.last([...request.text.matchAll(/user: ACT#(\d+)/g)]), {
    onNone: () => World.say("ok"),
    onSome: (last) => {
      const n = Number(last[1])
      if (request.text.lastIndexOf(`tool call_job_${n} job:`) > (last.index ?? 0)) return World.say("ok")
      return World.call(`call_job_${n}`, "job", actions.get(n) ?? { action: "list" })
    },
  })
}

/** What a command about a job acts on: the job, its owner's session, and whether that session is still there. */
interface Target {
  readonly job: Folded
  readonly owner: string
}

const alive = (run: Run, index: number) => !(run.deleted && index === 1)

/** The job a command names (its index wraps over the jobs so far), with its owner; none before any job, or with its owner gone. */
const targetOf = (run: Run, index: number): Option.Option<Target> =>
  jobAt(run, index).pipe(
    Option.filter((job) => alive(run, job.owner)),
    Option.flatMap((job) => Option.map(Option.fromNullishOr(run.sessions[job.owner]), (owner) => ({ job, owner }))),
  )

/** Run `body` on the command's job while the server is up; nothing otherwise. */
const onJob = (run: Run, index: number, body: (target: Target) => Effect.Effect<void, World.SimError>) =>
  Option.match(Option.filter(targetOf(run, index), () => run.world.isUp()), { onNone: () => Effect.void, onSome: body })

const startJob = (run: Run, command: Extract<Command, { readonly type: "job" }>) =>
  Effect.gen(function* () {
    if (!run.world.isUp() || !alive(run, command.session)) return
    const answer = yield* run.world.tool(run.sessions[command.session] ?? "", "job", { command: `work ${run.jobs.length}`, note: `J${run.jobs.length}` })
    for (const id of Option.toArray(jobIdOf(answer.output))) {
      run.jobs.push({ id, owner: command.session, setAt: run.world.now(), started: command.started, end: Option.none() })
      if (command.started) MemoryRunner.running(run.runner, id, run.world.now())
    }
  })

/** The runner's end of a started job, its call rung or not; a job's end is recorded even while the server is down. */
const endCommand = (run: Run, command: Extract<Command, { readonly type: "end" }>) =>
  Effect.gen(function* () {
    for (const job of Option.toArray(Option.filter(jobAt(run, command.job), (each) => each.started))) {
      endJob(run, job, command.how)
      if (command.bell && run.world.isUp()) yield* doorbell(run.world, job.id)
    }
  })

/** The runner's call, or the exit file's event under the job's watch (nothing when it is not watched). */
const bell = (run: Run, command: Extract<Command, { readonly type: "bell" }>) =>
  Effect.forEach(Option.toArray(Option.filter(jobAt(run, command.job), () => run.world.isUp())), (job) =>
    Match.value(command.watch).pipe(
      Match.when(false, () => Effect.asVoid(doorbell(run.world, job.id))),
      Match.orElse(() => Effect.sync(() => MemoryRunner.announce(run.runner, job.id)).pipe(Effect.andThen(run.world.advance(1)))),
    ),
  ).pipe(Effect.asVoid)

/** The job a command names: its index wraps over the jobs so far; none before any job. */
const jobAt = (run: Run, index: number) => Option.fromNullishOr(run.jobs[index % Math.max(1, run.jobs.length)])

/** The owner's park or wait; a wait may see the end come while it waits. */
const look = (run: Run, command: Extract<Command, { readonly type: "park" | "wait" }>) =>
  onJob(run, command.job, ({ job, owner }) =>
    Effect.gen(function* () {
      if (command.type === "wait" && command.endDuring && job.started && Option.isNone(job.end))
        run.world.runtime.fork(
          Effect.sleep("3 seconds").pipe(
            Effect.andThen(Effect.sync(() => endJob(run, job, "exit0"))),
            Effect.andThen(run.world.clientRpc(WAKES.id, "due", { id: job.id })),
            Effect.ignore,
          ),
        )
      const input = Match.value(command.type).pipe(
        Match.when("park", () => ({ action: "park", id: job.id })),
        Match.orElse(() => ({ action: "wait", id: job.id, ms: 20_000 })),
      )
      answered(run, job, yield* act(run, owner, input))
    }),
  )

/** A stop: the TUI's, the owner's own, or its parent's (a subagent's job); the runner ends the job at once, or only asks. */
const kill = (run: Run, command: Extract<Command, { readonly type: "kill" }>) =>
  onJob(run, command.job, ({ job, owner }) =>
    Effect.gen(function* () {
      run.runner.killEnds = command.ends
      const killedBefore = run.runner.killed.length
      if (command.by === "ui") yield* run.world.rpc(WAKES.id, "kill", { sessionID: owner, id: job.id }).pipe(Effect.ignore)
      if (command.by === "owner") answered(run, job, yield* act(run, owner, { action: "kill", id: job.id }))
      // Only a subagent's job has a parent to stop it.
      if (command.by === "parent" && job.owner === 2) yield* act(run, run.sessions[0] ?? "", { action: "kill", id: job.id })
      run.runner.killEnds = true
      // The runner recorded the stop at once (a stop that only asked leaves the job running until its end).
      if (command.ends && run.runner.killed.length > killedBefore) ends(job, "cancelled", endedAt(run, job))
    }),
  )

/** When the runner recorded the job's end, or now. */
const endedAt = (run: Run, job: Folded) =>
  Option.fromNullishOr(run.runner.jobs.get(job.id)?.run).pipe(
    Option.flatMap((recorded) =>
      Match.value(recorded).pipe(
        Match.discriminator("state")("ended", (ended) => Option.some(ended.exit.endedAt)),
        Match.orElse(() => Option.none<number>()),
      ),
    ),
    Option.getOrElse(() => run.world.now()),
  )

const remove = (run: Run) =>
  Effect.gen(function* () {
    if (run.deleted || !run.world.isUp()) return
    run.deleted = true
    yield* run.world.remove(run.sessions[1] ?? "")
    // The deleted session's running jobs are killed by the plugin: the runner records that, as it would.
    for (const each of run.jobs) if (each.owner === 1 && run.runner.killed.includes(each.id)) ends(each, "cancelled", run.world.now())
  })

const outage = (run: Run, ms: number) =>
  Effect.gen(function* () {
    if (!run.world.isUp()) return
    yield* run.world.down
    yield* run.world.advance(ms)
    yield* run.world.up
  })

const apply = (run: Run, command: Command): Effect.Effect<void, World.SimError> =>
  Match.value(command).pipe(
    Match.discriminatorsExhaustive("type")({
      job: (each) => startJob(run, each),
      end: (each) => endCommand(run, each),
      bell: (each) => bell(run, each),
      check: (each) => onJob(run, each.job, ({ job, owner }) => Effect.asVoid(run.world.tool(owner, "job", { action: "check", id: job.id }))),
      park: (each) => look(run, each),
      wait: (each) => look(run, each),
      kill: (each) => kill(run, each),
      "fail-write": (each) => Effect.sync(() => run.world.faults.failWrites(WAKES.id, 1, each.after)),
      delete: () => remove(run),
      advance: (each) => run.world.advance(each.ms),
      restart: () => Effect.when(run.world.restart, Effect.sync(() => run.world.isUp())).pipe(Effect.asVoid),
      outage: (each) => outage(run, each.ms),
    }),
  )

seeded("each managed job's end is delivered exactly once, by its letter or the owner's own call that returned it, across calls rung or lost, kills, failed writes, deletion, reloads and outages", ({ seed, expect }) =>
  Effect.gen(function* () {
    actions.clear()
    const runner = MemoryRunner.empty()
    const world = World.make({ seed, script: actScript })
    yield* world.load(Plugins.wake(world, runner), { directory: WORK, options: { backstop: "off" } })
    const s0 = yield* world.session(WORK)
    const s1 = yield* world.session(WORK)
    const s2 = yield* world.session(WORK, { parentID: s0 })
    const run: Run = { world, runner, sessions: [s0, s1, s2], jobs: [], answers: [], deleted: false, acts: 0 }

    for (const command of commandsOf(seed)) {
      yield* apply(run, command)
      // At no point does a job have two letters.
      for (const job of run.jobs) for (const session of run.sessions) expect(lettersIn(world, session, job.id).length).toBeLessThanOrEqual(1)
      // A watch is held only by a job whose entry is still kept: never more watches than live jobs.
      const kept = new Set(world.storage.get(WAKES.id)?.keys() ?? [])
      for (const id of runner.watched.keys()) expect({ watched: id, kept: kept.has(`wake:${id}`) }).toEqual({ watched: id, kept: true })
    }

    yield* finish(run)
    // Every end delivered: no watch is left open.
    expect([...runner.watched.keys()]).toEqual([])
    for (const job of run.jobs) if (!job.started) ends(job, "never-started", job.setAt + 30 * SECOND + 1)

    const rows = run.jobs.map((job) => rowOf(run, job))
    for (const row of rows) {
      expect({ job: row.job, deliveries: Math.min(row.deliveries, Number(!row.deletedOwner)) }).toEqual({ job: row.job, deliveries: Number(!row.deletedOwner) })
      expect({ job: row.job, deliveries: row.deliveries <= 1 }).toEqual({ job: row.job, deliveries: true })
      for (const kind of row.kinds) expect({ job: row.job, kind }).toEqual({ job: row.job, kind: row.expected })
    }
    // Every letter reached a model request of its session.
    for (const session of run.sessions.filter((each) => !(run.deleted && each === s1))) expect(unasked(world, session)).toEqual([])
    expect(world.stale()).toEqual([])
    // The success numbers, with their denominator: the owner's model never called check or wait to look for an end.
    const polls = run.sessions.flatMap((session) => jobCalls(world, session, 0, Number.POSITIVE_INFINITY)).filter((call) => call.action === "check").length
    const eligible = rows.filter((row) => !row.deletedOwner)
    const delivered = eligible.filter((row) => row.deliveries === 1).length
    const duplicate = rows.filter((row) => row.deliveries > 1).length
    yield* Console.log(`job-events seed ${seed}: eligible_terminal_events=${eligible.length} delivered_once=${delivered} lost=${eligible.length - delivered} duplicate=${duplicate} agent_poll_calls=${polls}`)
    expect(eligible.length).toBeGreaterThan(0)
    expect(delivered).toBe(eligible.length)
    expect(duplicate).toBe(0)
    expect(polls).toBe(0)
  }),
)

/** The end of the history: the server up, every started job ended; a third announced by the runner's call, a third by the watch, a third by nothing. */
const finish = (run: Run) =>
  Effect.gen(function* () {
    if (!run.world.isUp()) yield* run.world.up
    for (const [index, job] of run.jobs.entries()) {
      if (!job.started) continue
      endJob(run, job, "exit0")
      if (index % 3 === 0) yield* doorbell(run.world, job.id)
      if (index % 3 === 1) MemoryRunner.announce(run.runner, job.id)
    }
    yield* run.world.advance(2 * RECOVER_MS + 31 * SECOND)
    yield* run.world.until(() => run.sessions.every((session) => idle(run.world, session)), 5 * MINUTE)
  })

/** The fold of one job: its deliveries are its letters, plus at most one of the owner's own calls that returned its end before any letter came. */
const rowOf = (run: Run, job: Folded) => {
  const letters = lettersIn(run.world, run.sessions[job.owner] ?? "", job.id)
  const firstLetter = Math.min(...letters.map((message) => message.created))
  const answered = run.answers.filter((answer) => answer.job === job.id && Option.exists(job.end, (end) => end.at <= answer.at) && answer.at < firstLetter)
  return {
    job: job.id,
    deliveries: letters.length + Math.min(1, answered.length),
    deletedOwner: run.deleted && job.owner === 1,
    kinds: letters.map(kindIn),
    expected: Option.getOrElse(Option.map(job.end, (end) => end.kind), () => "no end"),
  }
}

/** The letters of a session that no model request of it carried. */
const unasked = (world: World.World, session: string) =>
  lettersIn(world, session)
    .map((letter) => ({ created: letter.created, head: letter.text.split("\n")[0] ?? "" }))
    .filter((letter) => !world.asked().some((request) => request.sessionID === session && world.start + request.at >= letter.created && request.text.includes(letter.head)))
