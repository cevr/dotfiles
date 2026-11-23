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
// - T1 as a job: the write of the job record's delivery claim dies; the
//   runner's call is retried and the sweep reconciles, one letter. The write
//   that marks it delivered dies after the session took the letter: after a
//   reload the resend under the same id adds no message and no turn.
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
import { expect as bunExpect } from "bun:test"
import { Array as Arr, Clock, Console, Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Match, Option, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import * as MemoryBackstop from "@dotfiles/opencode-wake/memory/backstop"
import * as MemoryChecks from "@dotfiles/opencode-wake/memory/checks"
import * as MemoryCourier from "@dotfiles/opencode-wake/memory/courier"
import * as MemoryOpener from "@dotfiles/opencode-wake/memory/opener"
import * as MemoryRunner from "@dotfiles/opencode-wake/memory/runner"
import * as MemoryStore from "@dotfiles/opencode-wake/memory/store"
import * as Model from "@dotfiles/opencode-wake/model"
import { type CallAnswer, Changes, Courier, Runner, WakeStore } from "@dotfiles/opencode-wake/service"
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
    .flatMap((message) => Option.toArray(Option.filter(message.call, (used) => used.name === "job")).map((used) => ({ at: message.created, id: used.id, action: actionOf(used.input) })))
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

seeded("an archived owner gets its job's end once, in its own session, across the runner's call, a reload and the sweep; a deleted owner's end goes to nobody and is not sent again", ({ seed, expect }) =>
  Effect.gen(function* () {
    const runner = MemoryRunner.empty()
    const world = World.make({ seed, script: reading("archived") })
    yield* world.load(Plugins.wake(world, runner), { directory: WORK, options: { backstop: "off" } })
    const start = (session: string, note: string) => world.tool(session, "job", { command: `make ${note}`, note }).pipe(Effect.map((answer) => Option.getOrElse(jobIdOf(answer.output), () => "missing")))
    const archived = yield* world.session(WORK)
    const deleted = yield* world.session(WORK)
    const kept = yield* start(archived, "kept")
    const gone = yield* start(deleted, "gone")
    for (const id of [kept, gone]) MemoryRunner.running(runner, id, world.now())
    yield* world.archive(archived)
    yield* world.remove(deleted)
    for (const id of [kept, gone]) MemoryRunner.ended(runner, id, 0, world.now())
    for (const id of [kept, gone]) yield* doorbell(world, id)
    yield* world.restart
    for (const id of [kept, gone]) yield* doorbell(world, id)
    yield* world.advance(2 * RECOVER_MS)
    // The archived session holds the one letter; the deleted one's record says nobody, and nothing is owed.
    expect(lettersIn(world, archived, kept).map(kindIn)).toEqual(["succeeded"])
    const final = (id: string) => Option.getOrElse(Option.map(Option.fromNullishOr(runner.deliveries.get(id)?.at(-1)), (slot) => (slot.state === "delivered" ? `delivered to ${slot.to}` : slot.state)), () => "none")
    expect([final(kept), final(gone)]).toEqual(["delivered to letter", "delivered to nobody"])
    // What the fork does with an archived session's inbox is its own: a turn here or none; the letter is there either way.
    const turns = world.asked().filter((request) => request.sessionID === archived && request.text.includes("Note: kept")).length
    yield* Console.log(`job-events archived: letters=${lettersIn(world, archived, kept).length} turns=${turns}`)
  }),
)

seeded("T1 as a job: a claim write that dies and a delivered write that dies after the session took the letter each end with one letter and one turn, from the record's own writes", ({ seed, expect }) =>
  Effect.gen(function* () {
    const runner = MemoryRunner.empty()
    const world = World.make({ seed, script: reading("T1") })
    yield* world.load(Plugins.wake(world, runner), { directory: WORK, options: { backstop: "off" } })
    const session = yield* world.session(WORK)
    const start = (note: string) => world.tool(session, "job", { command: `make ${note}`, note }).pipe(Effect.map((answer) => Option.getOrElse(jobIdOf(answer.output), () => "missing")))

    // The claim's own write dies: the call fails, the record is as it was; the runner's retried call delivers.
    const first = yield* start("first")
    MemoryRunner.running(runner, first, world.now())
    MemoryRunner.ended(runner, first, 0, world.now())
    MemoryRunner.failWrites(runner, 1)
    yield* doorbell(world, first)
    expect(lettersIn(world, session, first)).toHaveLength(0)
    yield* doorbell(world, first)
    expect(lettersIn(world, session, first)).toHaveLength(1)

    // Again with no second call: the sweep's retry delivers within RECOVER_MS.
    const second = yield* start("second")
    MemoryRunner.running(runner, second, world.now())
    MemoryRunner.ended(runner, second, 1, world.now())
    MemoryRunner.failWrites(runner, 1)
    yield* doorbell(world, second)
    expect(lettersIn(world, session, second)).toHaveLength(0)
    yield* world.advance(RECOVER_MS)
    expect(lettersIn(world, session, second)).toHaveLength(1)

    // The claim is written and the session takes the letter; the write marking it delivered dies; then a reload.
    const third = yield* start("third")
    MemoryRunner.running(runner, third, world.now())
    MemoryRunner.ended(runner, third, 2, world.now())
    MemoryRunner.failWrites(runner, 1, 1)
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

/** The owner's own call whose committed answer delivered a job's end ("This answer is its end"), with the kind it said. */
interface Answered {
  readonly job: string
  readonly at: number
  readonly kind: string
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

/** The owner's call whose answer the session holds: a delivery when it says it is the end, with the kind its end line names. */
const answered = (run: Run, job: Folded, answer: Option.Option<ToolMessage>) => {
  for (const ok of Option.toArray(Option.filter(answer, (each) => !each.error && each.output.includes("This answer is its end"))))
    run.answers.push({ job: job.id, at: ok.created, kind: Option.getOrElse(Option.flatMapNullishOr(Option.fromNullishOr(/End: ([a-z-]+) /.exec(ok.output)), (found) => found[1]), () => "no end line") })
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

seeded("an owner's wait that sees its job end, and the runner's call rung meanwhile, returns the end itself; no letter follows", ({ seed, expect }) =>
  Effect.gen(function* () {
    actions.clear()
    const runner = MemoryRunner.empty()
    const world = World.make({ seed, script: actScript })
    yield* world.load(Plugins.wake(world, runner), { directory: WORK, options: { backstop: "off" } })
    const owner = yield* world.session(WORK)
    const run: Run = { world, runner, sessions: [owner], jobs: [], answers: [], deleted: false, acts: 0 }
    yield* startJob(run, { type: "job", session: 0, started: true })
    const job = Option.getOrThrow(Arr.head(run.jobs))
    // The wait's call goes out; 3 s in, the runner records the end and rings, as a runner would while the owner waits.
    yield* look(run, { type: "wait", job: 0, endDuring: true })
    const answer = Option.getOrThrow(Arr.last(world.messages(owner).filter((message): message is ToolMessage => message.type === "tool")))
    expect(answer.output).toContain(`End: succeeded (generation 1); log job-log:${job.id}/1.`)
    expect(answer.output).toContain("This answer is its end: no letter follows.")
    yield* world.advance(2 * RECOVER_MS)
    yield* world.until(() => idle(world, owner), MINUTE)
    expect(lettersIn(world, owner, job.id)).toEqual([])
    expect([...runner.watched.keys()]).toEqual([])
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
    // The success numbers, with their denominator. A poll is a `job` call the history did not ask for: each scripted
    // act (a start, an explicit check, park, wait or kill) is its own call id, `call_job_<n>`, made in answer to its
    // prompt (once, or again when a restart cut its turn); any other `job` call is a model looking for an end again.
    const polls = run.sessions.flatMap((session) => jobCalls(world, session, 0, Number.POSITIVE_INFINITY)).filter((call) => !/^call_job_\d+$/.test(call.id) || !actions.has(Number(call.id.slice(9)))).length
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

/** The fold of one job: its deliveries are its letters plus every committed answer of the owner's that said it was the end, whenever it came; each says a kind. */
const rowOf = (run: Run, job: Folded) => {
  const letters = lettersIn(run.world, run.sessions[job.owner] ?? "", job.id)
  const answered = run.answers.filter((answer) => answer.job === job.id)
  return {
    job: job.id,
    deliveries: letters.length + answered.length,
    deletedOwner: run.deleted && job.owner === 1,
    kinds: [...letters.map(kindIn), ...answered.map((answer) => answer.kind)],
    expected: Option.getOrElse(Option.map(job.end, (end) => end.kind), () => "no end"),
  }
}

/** The letters of a session that no model request of it carried. */
const unasked = (world: World.World, session: string) =>
  lettersIn(world, session)
    .map((letter) => ({ created: letter.created, head: letter.text.split("\n")[0] ?? "" }))
    .filter((letter) => !world.asked().some((request) => request.sessionID === session && world.start + request.at >= letter.created && request.text.includes(letter.head)))

// ── Two locations at every storage boundary ──
//
// The model itself, in two locations over one store, one runner's record and one inbox, as OpenCode's locations share
// them: A, the job's own, and B, where its owner's session moved (its tools run there; the runner's call still reaches
// A). Each family races two actors. In turn the first is held, or stopped just before or just after, at each of its
// location's writes (the record's claim, retirement and delivery slots, the store's writes, the courier's send), while
// the second runs; a stop kills that location as a crash would (nothing more it writes lands). Then every stopped
// location reopens, the host settles a call a dead location left running as failed (as its own restart does), every
// location starts and the sweeps run. The oracle counts what the owner was given: each answer the host committed that
// said it was the end, and each letter; one per job, never zero and never two, each with the kind the runner recorded,
// and a job retired as never started never ran.

const OWNER = "ses_owner"
const HOME = "/scratch/job-home"
const MOVED = "/scratch/moved-to"

type Where = "A" | "B"
type Mode = "hold" | "stop-before" | "stop-after"
interface Plan {
  readonly where: Where
  readonly at: number
  readonly mode: Mode
}

interface Place {
  readonly model: Context.Service.Shape<typeof Model.WakesModel>
  readonly close: Effect.Effect<void>
  readonly state: { dead: boolean }
}

interface Matrix {
  readonly store: MemoryStore.MemoryWakes
  readonly runner: MemoryRunner.MemoryRunner
  readonly inbox: MemoryCourier.MemorySessions
  /** The host's calls, as each one's session records it. */
  readonly calls: Map<string, "running" | "committed" | "failed">
  /** The kinds the owner's committed answers said, each an end it delivered. */
  readonly answers: Array<string>
  readonly places: Map<Where, Place>
  readonly release: Deferred.Deferred<void>
  plan: Option.Option<Plan>
  /** Writes at the plan's place so far. */
  seen: number
  /** The job's command ran (the supervisor's claim won). */
  ran: boolean
}

/** A write of the location `where`: dead, it lands nothing; at the plan's write, held or stopped before or after it. */
const gate =
  (m: Matrix, where: Where, state: { dead: boolean }) =>
  <A, E>(write: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.suspend(() => {
      if (state.dead) return Effect.interrupt
      return Option.match(
        Option.filter(m.plan, (plan) => plan.where === where),
        {
          onNone: () => write,
          onSome: (plan) => {
            m.seen += 1
            if (m.seen !== plan.at) return write
            if (plan.mode === "hold") return Deferred.await(m.release).pipe(Effect.andThen(write))
            if (plan.mode === "stop-before") {
              state.dead = true
              return Effect.interrupt
            }
            return write.pipe(
              Effect.tap(() => Effect.sync(() => void (state.dead = true))),
              Effect.andThen(Effect.interrupt),
            )
          },
        },
      )
    })

/** The location `where` opened (again): its model over the shared externals, every write through its gate. */
const openPlace = (m: Matrix, where: Where) =>
  Effect.gen(function* () {
    const state = { dead: false }
    const gated = gate(m, where, state)
    const scope = yield* Scope.make()
    const runner = Layer.effect(
      Runner,
      Effect.gen(function* () {
        const inner = yield* Runner
        return Runner.of({ ...inner, advance: (id, version, next) => gated(inner.advance(id, version, next)), retire: (id) => gated(inner.retire(id)) })
      }),
    ).pipe(Layer.provide(MemoryRunner.layer(m.runner)))
    const store = Layer.effect(
      WakeStore,
      Effect.gen(function* () {
        const inner = yield* WakeStore
        return WakeStore.of({ ...inner, write: (entry) => gated(inner.write(entry)), remove: (id) => gated(inner.remove(id)) })
      }),
    ).pipe(Layer.provide(MemoryStore.layer(m.store)))
    const courier = Layer.effect(
      Courier,
      Effect.gen(function* () {
        const inner = yield* Courier
        return Courier.of({ ...inner, deliver: (sessionID, delivery, letter, resume) => gated(inner.deliver(sessionID, delivery, letter, resume)) })
      }),
    ).pipe(Layer.provide(MemoryCourier.layer(m.inbox)))
    const answered = (_sessionID: string, call: string) => Effect.sync((): CallAnswer => Option.getOrElse(Option.fromNullishOr(m.calls.get(call)), (): CallAnswer => "unknown"))
    const layer = Model.layer({ directory: where === "A" ? HOME : MOVED, recoverMs: RECOVER_MS, answered }).pipe(
      Layer.provide(Layer.mergeAll(runner, store, courier, MemoryBackstop.layer(MemoryBackstop.empty()), MemoryChecks.layer(MemoryChecks.empty()), MemoryOpener.layer(MemoryOpener.empty()))),
      Layer.provide(Layer.succeed(Changes, { changed: () => Effect.void })),
    )
    const model = Context.get(yield* Layer.buildWithScope(layer, scope), Model.WakesModel)
    const place: Place = { model, close: Scope.close(scope, Exit.void), state }
    m.places.set(where, place)
    return place
  })

const placeOf = (m: Matrix, where: Where) => Option.getOrThrow(Option.fromNullishOr(m.places.get(where)))

/** Let every fiber that can run, run. */
const settle = Effect.forEach(Arr.range(1, 200), () => Effect.yieldNow, { discard: true })

type Actor = (m: Matrix, id: string) => Effect.Effect<void>

/** The kind an end event says. */
const kindOfEvent = (event: Option.Option<{ readonly disposition: string }>) =>
  Option.getOrElse(
    Option.map(event, (each) => each.disposition),
    () => "no event",
  )

/**
 * The owner's `how` call in `where`, as the host runs it: a call id of its own; what the tool returned is committed to
 * the session unless its location died first (then the host's restart records the call failed); with `crash`, the host
 * dies after the tool returned and before it committed the answer.
 */
const answering =
  (where: Where, how: "wait" | "kill" | "park", crash = false): Actor =>
  (m, id) =>
    Effect.gen(function* () {
      const place = placeOf(m, where)
      const call = `call_${m.calls.size + 1}`
      m.calls.set(call, "running")
      const exit = yield* Effect.exit(
        Match.value(how).pipe(
          Match.when("wait", () => place.model.wait(OWNER, id, 5 * SECOND, call)),
          Match.when("kill", () => place.model.kill(OWNER, id, call)),
          Match.orElse(() => place.model.park(OWNER, id, call)),
        ),
      )
      if (Exit.isFailure(exit) || place.state.dead || crash) {
        if (crash) place.state.dead = true
        m.calls.set(call, "failed")
        return
      }
      yield* Effect.exit(place.model.answered(call, "observed"))
      if (place.state.dead) {
        m.calls.set(call, "failed")
        return
      }
      m.calls.set(call, "committed")
      if (exit.value.delivered) m.answers.push(kindOfEvent(Option.flatten(Option.fromNullishOr(exit.value.view.event))))
      yield* Effect.exit(place.model.answered(call, "committed"))
    })

/** The runner's call (`due`) reaching `where`. */
const ringing =
  (where: Where): Actor =>
  (m, id) =>
    Effect.asVoid(Effect.exit(placeOf(m, where).model.due(id)))

/** `where` restarts: its server stops and starts again. */
const restarting =
  (where: Where): Actor =>
  (m) =>
    Effect.gen(function* () {
      yield* placeOf(m, where).close
      const place = yield* openPlace(m, where)
      yield* Effect.exit(place.model.start)
    })

/** The job's supervisor comes up: it claims the launch slot, and only when it won runs the command (which exits 0) and rings A. */
const supervising: Actor = (m, id) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    if (!MemoryRunner.claim(m.runner, id, now)) return
    m.ran = true
    MemoryRunner.ended(m.runner, id, 0, now)
    yield* Effect.exit(placeOf(m, "A").model.due(id))
  })

interface Family {
  readonly name: string
  /** The command's exit code, or `unclaimed`: no runner claimed it, and it is past its start grace. */
  readonly end: number | "unclaimed"
  /** Where the first actor writes: the place its plan holds or stops. */
  readonly where: Where
  readonly first: Actor
  readonly second: Actor
  /** Whether some history of it delivers by the owner's committed answer (the owner can win the end and its host commits). */
  readonly byAnswer: boolean
}

const FAMILIES: ReadonlyArray<Family> = [
  { name: "the owner's wait in A against the runner's call in A", end: 0, where: "A", first: answering("A", "wait"), second: ringing("A"), byAnswer: true },
  { name: "moved: the owner's wait in B against the runner's call in A", end: 0, where: "B", first: answering("B", "wait"), second: ringing("A"), byAnswer: true },
  { name: "moved: the runner's call in A against the owner's kill in B", end: 3, where: "A", first: ringing("A"), second: answering("B", "kill"), byAnswer: true },
  { name: "moved: the owner's park in B against A's restart", end: 1, where: "B", first: answering("B", "park"), second: restarting("A"), byAnswer: true },
  { name: "moved: the owner's wait in B returns and its host dies before committing it, against the runner's call in A", end: 0, where: "B", first: answering("B", "wait", true), second: ringing("A"), byAnswer: false },
  { name: "the retirement in A against the supervisor's claim", end: "unclaimed", where: "A", first: ringing("A"), second: supervising, byAnswer: false },
  { name: "the supervisor's claim against the retirement in A", end: "unclaimed", where: "A", first: supervising, second: ringing("A"), byAnswer: false },
]

/** One history of `family` under `plan` (none: a count of the first actor's writes): what the owner was given. */
const history = (family: Family, plan: Option.Option<Plan>) =>
  Effect.gen(function* () {
    const m: Matrix = {
      store: MemoryStore.empty(),
      runner: MemoryRunner.empty(),
      inbox: MemoryCourier.empty(OWNER),
      calls: new Map(),
      answers: [],
      places: new Map(),
      release: yield* Deferred.make<void>(),
      plan: Option.none(),
      seen: 0,
      ran: false,
    }
    const home = yield* openPlace(m, "A")
    yield* openPlace(m, "B")
    const { job } = yield* home.model.job(OWNER, { command: "true", note: "matrix" })
    const now = yield* Clock.currentTimeMillis
    // The job's admission looks at it once: it runs (or, unclaimed, it is past its grace). Then it ends, with nothing
    // announcing it, so the two actors are the first to see the end.
    if (family.end === "unclaimed") yield* TestClock.adjust(31 * SECOND)
    else MemoryRunner.running(m.runner, job.id, now)
    yield* settle
    if (family.end !== "unclaimed") MemoryRunner.ended(m.runner, job.id, family.end, now)
    // Nothing reached the owner yet: the history starts from the end owed.
    const owedAtStart = (m.runner.deliveries.get(job.id) ?? []).length === 0 && (m.inbox.inboxes.get(OWNER) ?? []).length === 0
    // Count the first actor's writes (a plan that never comes), or hold or stop it at one.
    m.plan = Option.orElse(plan, () => Option.some({ where: family.where, at: Number.POSITIVE_INFINITY, mode: "hold" as const }))
    const first = yield* Effect.forkChild(family.first(m, job.id))
    yield* settle
    const second = yield* Effect.forkChild(family.second(m, job.id))
    yield* settle
    yield* Deferred.succeed(m.release, undefined)
    yield* Fiber.await(first)
    yield* Fiber.await(second)
    const writes = m.seen
    m.plan = Option.none()
    // Recovery: what stopped reopens, the host settles the calls a dead location left running, every location starts, the sweeps run.
    for (const where of ["A", "B"] as const) {
      const place = placeOf(m, where)
      if (!place.state.dead) continue
      yield* place.close
      yield* openPlace(m, where)
    }
    for (const [call, said] of m.calls) if (said === "running") m.calls.set(call, "failed")
    for (const where of ["A", "B"] as const) yield* Effect.exit(placeOf(m, where).model.start)
    for (const _ of Arr.range(1, 4)) {
      yield* settle
      yield* TestClock.adjust(RECOVER_MS + 30 * SECOND)
    }
    yield* settle
    const letters = (m.inbox.inboxes.get(OWNER) ?? []).filter((received) => received.letter.metadata["kind"] === "job" && received.letter.metadata["progress"] !== true)
    const kinds = [...letters.map((received) => kindOfEvent(Schema.decodeUnknownOption(Ended)(received.letter.metadata["event"]))), ...m.answers]
    const expected = family.end === "unclaimed" ? (m.ran ? "succeeded" : "never-started") : family.end === 0 ? "succeeded" : "failed"
    const final = Option.map(Option.fromNullishOr(m.runner.deliveries.get(job.id)?.at(-1)), (slot) => slot.state)
    for (const where of ["A", "B"] as const) yield* placeOf(m, where).close
    return { writes, owedAtStart, answers: m.answers.length, given: letters.length + m.answers.length, kinds, expected, final: Option.getOrElse(final, () => "none"), ran: m.ran }
  })

Seed.effect("each job's end reaches its owner once across two locations, a move, wait, kill, park, the runner's call, restart and the supervisor's claim, held or stopped at every write",
  Effect.gen(function* () {
    const failures: Array<unknown> = []
    let histories = 0
    const coverage: Array<{ readonly family: string; readonly writes: number; readonly byAnswer: number }> = []
    for (const family of FAMILIES) {
      const counted = yield* history(family, Option.none())
      let byAnswer = 0
      const plans = Arr.range(1, Math.max(1, counted.writes)).flatMap((at) => (["hold", "stop-before", "stop-after"] as const).map((mode) => ({ where: family.where, at, mode })))
      for (const plan of [Option.none<Plan>(), ...plans.map((each) => Option.some(each))]) {
        const seen = yield* history(family, plan)
        histories += 1
        const ok = seen.owedAtStart && seen.given === 1 && seen.kinds.every((kind) => kind === seen.expected) && seen.final === "delivered"
        byAnswer += seen.answers
        if (!ok) failures.push({ family: family.name, plan: Option.getOrUndefined(plan), owedAtStart: seen.owedAtStart, given: seen.given, kinds: seen.kinds, expected: seen.expected, final: seen.final, ran: seen.ran })
      }
      coverage.push({ family: family.name, writes: counted.writes, byAnswer })
    }
    yield* Console.log(`job-events boundaries: histories=${histories} failures=${failures.length} ${coverage.map((each) => `${each.writes}w/${each.byAnswer}a`).join(" ")}`)
    bunExpect(failures).toEqual([])
    // Each family exercised what it names: its first actor wrote (so each write was held and stopped), and a family
    // whose owner can win the end had histories where the committed answer was the delivery.
    bunExpect(coverage.map((each) => ({ family: each.family, wrote: each.writes > 0, byAnswer: each.byAnswer > 0 }))).toEqual(FAMILIES.map((family) => ({ family: family.name, wrote: true, byAnswer: family.byAnswer })))
  }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([]))),
)

Seed.effect("an owner's wait on a running job reads nothing while it waits: fifty quiet seconds add no read, and its end wakes it",
  Effect.gen(function* () {
    const m: Matrix = {
      store: MemoryStore.empty(),
      runner: MemoryRunner.empty(),
      inbox: MemoryCourier.empty(OWNER),
      calls: new Map(),
      answers: [],
      places: new Map(),
      release: yield* Deferred.make<void>(),
      plan: Option.none(),
      seen: 0,
      ran: false,
    }
    const home = yield* openPlace(m, "A")
    const { job } = yield* home.model.job(OWNER, { command: "true", note: "quiet" })
    MemoryRunner.running(m.runner, job.id, yield* Clock.currentTimeMillis)
    m.calls.set("call_wait", "running")
    const waiting = yield* Effect.forkChild(home.model.wait(OWNER, job.id, 15 * MINUTE, "call_wait"))
    yield* settle
    const reads = m.runner.reads
    // Under the sweep's period: only the wait could read, and it does not.
    for (const _ of Arr.range(1, 10)) {
      yield* TestClock.adjust(5 * SECOND)
      yield* settle
    }
    bunExpect(m.runner.reads).toBe(reads)
    MemoryRunner.ended(m.runner, job.id, 0, yield* Clock.currentTimeMillis)
    MemoryRunner.announce(m.runner, job.id)
    yield* settle
    const answer = yield* Fiber.join(waiting)
    bunExpect({ ended: answer.ended, delivered: answer.delivered }).toEqual({ ended: true, delivered: true })
    yield* home.close
  }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([]))),
)
