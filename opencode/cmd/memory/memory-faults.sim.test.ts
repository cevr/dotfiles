// A generated property over faults, on the simulated host at 20 seeds: the
// memory plugin from its composition root on one memory file (the host's files
// held in memory, mods/memory/memory/files.ts), the seed choosing up to 40
// commands of root and subagent sessions, saves (new, near repeats, corrections
// by id), searches, forgets, a store write that fails, a restart of every plugin
// and the clock moving on.
//
// After each command:
// - every memory tool answer is the plugin's own: a save, a find, a forget, or a
//   named refusal (`explain`, the store's or the session's failure), never a raw
//   defect; a subagent's save or forget is refused;
// - with no write failing during it, a root session's save is kept and a forget
//   of a note it can see removes it;
// - the notes in the file are exactly those saved and not forgotten (the CLI's
//   list), and no search answers a forgotten id;
// - a session's requests carry one digest at most, across restarts; one may go
//   without it only when a write failed during one of its requests (round 1's
//   finding 1: the digest is then missing, and the cached prefix changes);
// - no timer of a closed copy fires.
// And one seed run twice gives byte-equal traces.
import { expect as bunExpect } from "bun:test"
import { Array as Arr, Effect, Option, Schema } from "effect"
import * as MemoryFiles from "@dotfiles/opencode-memory/memory/files"
import { main } from "./cli.ts"
import { liveWith, make } from "./server.ts"
import { below, generator, line, plain } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/memory/memory-faults.sim.test.ts")

const WORK = "/scratch/work"
const DB = "/scratch/state/memory.db"
const RUN_LIMIT_MS = 120_000
const MINUTE = 60_000
/** The system prompt of a request with no digest: the host's instructions alone. */
const BARE = "You are OpenCode."
/** How a prompt asks the model for a call, as the script reads the conversation. */
const PROMPT = "user: do "

/** The facts a save picks from: the second a near repeat of the first. */
const FACTS = [
  "The user prefers bun over npm",
  "The user prefers bun over npm for scripts",
  "Run the gate before every push",
  "Deploys need a changeset",
  "The workbox is reached over Tailscale",
]
const WORDS = ["bun", "gate", "deploys", "workbox", "push"]

/** What the model sends: one memory tool call, by the prompt that asks for it. */
const CallSchema = Schema.Union([
  Schema.Struct({
    tool: Schema.Literal("memory_save"),
    input: Schema.Struct({ text: Schema.String, scope: Schema.optional(Schema.Literals(["global", "project"])), id: Schema.optional(Schema.Number) }),
  }),
  Schema.Struct({ tool: Schema.Literal("memory_search"), input: Schema.Struct({ query: Schema.String }) }),
  Schema.Struct({ tool: Schema.Literal("memory_forget"), input: Schema.Struct({ id: Schema.Number }) }),
])
type Call = typeof CallSchema.Type
const decodeCall = Schema.decodeUnknownOption(Schema.fromJsonString(CallSchema))
const decodeListed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.Number }))))

type Command =
  | { readonly type: "session"; readonly child: boolean }
  | { readonly type: "call"; readonly session: number; readonly call: Call }
  | { readonly type: "write-fails"; readonly count: number }
  | { readonly type: "restart" }
  | { readonly type: "advance"; readonly ms: number }

type Random = ReturnType<typeof generator>

const SCOPES = [{}, { scope: "global" as const }, { scope: "project" as const }]
const pickOf = <A>(random: Random, from: ReadonlyArray<A>, fallback: A) => Option.getOrElse(Arr.get(from, below(random, from.length)), () => fallback)

const saveOf = (random: Random): Call => {
  const text = pickOf(random, FACTS, "")
  const scope = pickOf(random, SCOPES, {})
  if (below(random, 4) > 0) return { tool: "memory_save", input: { text, ...scope } }
  return { tool: "memory_save", input: { text, ...scope, id: 1 + below(random, 6) } }
}

const callOf = (random: Random): Call => {
  const pick = below(random, 10)
  if (pick < 5) return saveOf(random)
  if (pick < 8) return { tool: "memory_search", input: { query: pickOf(random, WORDS, "") } }
  return { tool: "memory_forget", input: { id: 1 + below(random, 6) } }
}

const commandOf = (pick: number, random: Random): Command => {
  if (pick < 2) return { type: "session", child: below(random, 3) === 0 }
  if (pick < 12) return { type: "call", session: below(random, 4), call: callOf(random) }
  if (pick < 14) return { type: "write-fails", count: 1 + below(random, 2) }
  if (pick < 15) return { type: "restart" }
  return { type: "advance", ms: below(random, 3) * MINUTE * (1 + below(random, 60)) }
}

/** Up to 40 commands, the seed choosing each; the first opens a root session. */
const commandsOf = (seed: number): ReadonlyArray<Command> => {
  const random = generator(`memory-faults:${seed}`)
  const count = 10 + below(random, 31)
  return [{ type: "session", child: false }, ...Array.from({ length: count - 1 }, () => commandOf(below(random, 16), random))]
}

/** The model: a prompt `do <call>` answered with that call, its result with `done`; a title with a title. */
const reply = (request: World.Request): World.Reply => {
  if (request.kind !== "primary") return World.say("Memory faults")
  const last = Option.fromNullishOr(request.text.split("\n").findLast((entry) => entry.startsWith("user: ") || entry.startsWith("tool ")))
  const call = last.pipe(
    Option.filter((entry) => entry.startsWith(PROMPT)),
    Option.flatMap((entry) => decodeCall(entry.slice(PROMPT.length))),
  )
  return Option.match(call, { onNone: () => World.say("done"), onSome: (asked) => World.call(`call_${request.text.length}`, asked.tool, plain(asked.input)) })
}

/** The refusals the plugin names (notebook.ts `explain`, server.ts `messageOf`), as the host prints a failed tool. */
const REFUSALS = [
  "Error: The note is empty",
  "Error: The note is ",
  "Error: No note #",
  "Error: A subagent does not write memory",
  "Error: Memory could not be read or written: the write to ",
  "Error: The session could not be read: ",
]
const ANSWERS = [/^Saved #\d+ \((global|project)\)\.$/, /^Updated #\d+ /, /^Corrected #\d+ /, /^No note matches "/, /^\d+ notes? for "/, /^Forgot #\d+: "/]

/** The kinds of answer a run can meet, by the answer's start: the sweep below holds that the gate's seeds meet each. */
const KINDS = [
  ["saved", "Saved #"],
  ["updated", "Updated #"],
  ["corrected", "Corrected #"],
  ["found", "1 note for"],
  ["none found", "No note matches"],
  ["forgot", "Forgot #"],
  ["not found", "Error: No note #"],
  ["subagent", "Error: A subagent does not write memory"],
  ["store failed", "Error: Memory could not be read or written"],
] as const

interface Answer {
  readonly output: string
  readonly error: boolean
}

interface SessionOf {
  readonly id: string
  readonly child: boolean
}

/** One run's state: the world, its files, its sessions, the notes kept and gone, what broke and what it met. */
const stateOf = (seed: number) =>
  Effect.gen(function* () {
    const files = yield* MemoryFiles.make
    const world = World.make({ seed, script: reply })
    yield* world.load(make(liveWith(files.files)), { directory: WORK, options: { path: DB } })
    return {
      seed,
      files,
      world,
      roots: new Array<string>(),
      sessions: new Array<SessionOf>(),
      live: new Set<number>(),
      gone: new Set<number>(),
      broken: new Array<string>(),
      faulted: new Set<string>(),
      reached: new Set<string>(),
    }
  })

type State = Effect.Success<ReturnType<typeof stateOf>>

const brokenBy = (state: State, index: number, command: Command) => (why: string) => void state.broken.push(`${index} ${line(command)}: ${why}`)

/** A new session: a root, or a subagent of a root the seed picks. */
const open = (state: State, index: number, child: boolean) =>
  Effect.gen(function* () {
    const parent = Option.filter(Arr.get(state.roots, below(generator(`${state.seed}:${index}`), Math.max(1, state.roots.length))), () => child)
    const id = yield* state.world.session(WORK, Option.match(parent, { onNone: () => ({}), onSome: (parentID) => ({ parentID }) }))
    state.sessions.push({ id, child: Option.isSome(parent) })
    if (Option.isNone(parent)) state.roots.push(id)
  })

/** The session asks for `call` and runs to rest: its tool answers, and whether a write failed meanwhile. */
const ask = (state: State, session: SessionOf, call: Call) =>
  Effect.gen(function* () {
    const failedBefore = state.files.failed()
    const before = state.world.messages(session.id).length
    yield* state.world.prompt(session.id, `do ${line(call)}`)
    yield* state.world.until(() => Option.exists(Option.fromNullishOr(state.world.sessions.get(session.id)), (held) => !held.running), RUN_LIMIT_MS)
    const answers = state.world
      .messages(session.id)
      .slice(before)
      .filter((message): message is Extract<World.Message, { readonly type: "tool" }> => message.type === "tool")
      .map((message): Answer => ({ output: message.output, error: message.error }))
    return { answers, faulted: state.files.failed() > failedBefore }
  })

/** An answer's words: the plugin's own, a subagent refused its writes, and a root's write with no fault kept. */
const judge = (state: State, session: SessionOf, call: Call, answer: Answer, faulted: boolean, fail: (why: string) => void) => {
  if (answer.error && !REFUSALS.some((prefix) => answer.output.startsWith(prefix))) fail(`an unnamed refusal: ${answer.output}`)
  if (!answer.error && !ANSWERS.some((pattern) => pattern.test(answer.output))) fail(`an answer not the plugin's: ${answer.output}`)
  const writes = call.tool !== "memory_search"
  if (session.child && writes && !answer.output.startsWith("Error: A subagent does not write memory")) fail(`a subagent wrote: ${answer.output}`)
  const kept = !session.child && !faulted && answer.error
  if (kept && call.tool === "memory_save" && Option.isNone(Option.fromNullishOr(call.input.id))) fail(`a save with no fault was refused: ${answer.output}`)
  if (kept && call.tool === "memory_forget" && state.live.has(call.input.id)) fail(`a forget of a kept note with no fault was refused: ${answer.output}`)
}

/** What an answer did to the notes: a save keeps an id, a forget drops one; a search names no forgotten id. */
const follow = (state: State, answer: Answer, fail: (why: string) => void) => {
  for (const [kind, prefix] of KINDS) if (answer.output.startsWith(prefix)) state.reached.add(kind)
  const idOf = (pattern: RegExp) =>
    Option.fromNullishOr(pattern.exec(answer.output)).pipe(
      Option.filter(() => !answer.error),
      Option.flatMap((match) => Arr.get(match, 1)),
      Option.map(Number),
    )
  Option.map(idOf(/^Saved #(\d+) /), (id) => state.live.add(id))
  Option.map(idOf(/^Forgot #(\d+):/), (id) => {
    state.live.delete(id)
    state.gone.add(id)
  })
  for (const id of state.gone) if (answer.output.includes(`#${id} [`)) fail(`a search answered forgotten #${id}`)
}

/** One call from the session the seed picks, judged. */
const callFrom = (state: State, command: Extract<Command, { type: "call" }>, fail: (why: string) => void) =>
  Effect.gen(function* () {
    const picked = Arr.get(state.sessions, command.session % Math.max(1, state.sessions.length))
    if (Option.isNone(picked)) return
    const session = picked.value
    const { answers, faulted } = yield* ask(state, session, command.call)
    if (faulted) state.faulted.add(session.id)
    const [answer, ...more] = answers
    if (answer === void 0 || more.length > 0) return fail(`${answers.length} tool answers`)
    judge(state, session, command.call, answer, faulted, fail)
    follow(state, answer, fail)
  })

/** After a command: the file holds the notes kept, each session's digest held, no stale timer. */
const settled = (state: State, fail: (why: string) => void) =>
  Effect.gen(function* () {
    const listed = yield* Effect.promise(() => main(["list", "--json"], { db: DB, now: state.world.now(), files: state.files.files }))
    const ids = Option.getOrElse(decodeListed(listed.out), () => [{ id: -1 }]).map((note) => note.id)
    const sorted = (all: Iterable<number>) => line([...all].toSorted((a, b) => a - b))
    if (sorted(ids) !== sorted(state.live)) fail(`the file holds ${line(ids)}, not ${line([...state.live])}`)
    for (const session of state.sessions) {
      const systems = new Set(state.world.asked().flatMap((asked) => Arr.filter([asked.system], () => asked.sessionID === session.id && asked.kind === "primary")))
      const digests = [...systems].filter((system) => system !== BARE)
      if (digests.length > 1) fail(`session ${session.id} sent ${digests.length} digests`)
      if (systems.size > 1 && !state.faulted.has(session.id)) fail(`session ${session.id} lost or gained its digest with no write failing`)
    }
    if (state.world.stale().length > 0) fail(`timers of closed copies fired: ${line(state.world.stale())}`)
  })

const step = (state: State, index: number, command: Command) =>
  Effect.gen(function* () {
    const fail = brokenBy(state, index, command)
    if (command.type === "session") yield* open(state, index, command.child)
    if (command.type === "write-fails") state.files.fail(command.count)
    if (command.type === "restart") yield* state.world.restart
    if (command.type === "advance") yield* state.world.advance(command.ms)
    if (command.type === "call") yield* callFrom(state, command, fail)
    yield* settled(state, fail)
  })

/** One run of `commands` on `seed`: its trace, each invariant broken (as a line naming the command), and what it met. */
const runOf = (seed: number, commands: ReadonlyArray<Command>) =>
  Effect.gen(function* () {
    const state = yield* stateOf(seed)
    for (const [index, command] of commands.entries()) yield* step(state, index, command)
    if (state.faulted.size > 0) state.reached.add("faulted-session")
    return { trace: state.world.trace(), broken: state.broken, reached: state.reached }
  }).pipe(Effect.scoped)

seeded("memory keeps its notes, its answers and each session's system prompt through write failures and restarts", ({ seed, expect }) =>
  Effect.gen(function* () {
    const commands = commandsOf(seed)
    const first = yield* runOf(seed, commands)
    expect(first.broken).toEqual([])
    const second = yield* runOf(seed, commands)
    expect(second.trace).toBe(first.trace)
  }),
)

Seed.effect(
  "the gate's 20 seeds meet every kind of answer, a write failing during a session's request, and distinct runs",
  Effect.gen(function* () {
    const reached = new Set<string>()
    const traces = new Set<string>()
    for (const seed of Array.from({ length: Seed.SEEDS }, (_, index) => index + 1)) {
      const ran = yield* runOf(seed, commandsOf(seed))
      for (const kind of ran.reached) reached.add(kind)
      traces.add(ran.trace)
    }
    bunExpect([...reached].toSorted()).toEqual([...KINDS.map(([kind]) => kind), "faulted-session"].toSorted())
    bunExpect(traces.size).toBe(Seed.SEEDS)
  }),
)
