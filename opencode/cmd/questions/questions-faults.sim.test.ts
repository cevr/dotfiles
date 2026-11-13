// A generated property over faults, on the simulated host at 20 seeds: the
// questions plugin loaded for two directories, each with a root session and
// a subagent of it; the seed choosing up to 40 commands of questions asked
// (through `ask_user_async`, as a model calls it), /answer forms opened in a
// root and replied (answers, blanks and dismissals, the subagent's questions
// among the root's), prompts, time, and faults: storage writes that fail
// (after a few that go through, so a letter can go out and its question's
// close fail), a reload of every copy, and the server down for a while.
//
// After each command:
// - no session holds two answers to one question, each carried by a letter
//   in the session that asked it, with the answer the form gave it;
// - a notice goes only to the root of the subagent it names, and never wakes
//   it (admitted without resume);
// - the plugin warns only at an instant a write failed: no copy finds a
//   question closed that another copy answered, as one submit is handled by
//   its own location's copy alone.
// Then, faults healed and one more reload: no answer is left recorded and not
// delivered, and every question asked is open, answered by a letter, or
// dismissed.
import { Array as Arr, Effect, Option, Schema } from "effect"
import { formOf } from "@dotfiles/opencode-questions/form"
import { Question, QUESTIONS, Sheet } from "@dotfiles/opencode-questions/question"
import * as Plugins from "../../sim/plugins.ts"
import { below, generator, line, plain } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/questions/questions-faults.sim.test.ts")

const DIRECTORIES = ["/scratch/a", "/scratch/b"] as const
/** Questions one session asks at most: under the open cap, so none is dropped for another. */
const MAX_ASKS = 6
const SETTLE_MS = 5_000

type Command =
  | { readonly type: "ask"; readonly session: number }
  | { readonly type: "answer"; readonly family: number; readonly picks: ReadonlyArray<number> }
  | { readonly type: "prompt"; readonly session: number }
  | { readonly type: "write-fails"; readonly count: number; readonly after: number }
  | { readonly type: "restart" }
  | { readonly type: "down"; readonly ms: number }
  | { readonly type: "advance"; readonly ms: number }

/** A field's pick: 0 left blank, 1 dismissed, else answered. */
const PICKS = 4

const commandOf = (pick: number, random: ReturnType<typeof generator>): Command => {
  if (pick < 7) return { type: "ask", session: below(random, 4) }
  if (pick < 12) return { type: "answer", family: below(random, 2), picks: Array.from({ length: 12 }, () => below(random, PICKS)) }
  if (pick < 14) return { type: "prompt", session: below(random, 4) }
  if (pick < 16) return { type: "write-fails", count: 1 + below(random, 3), after: below(random, 3) }
  if (pick < 17) return { type: "restart" }
  if (pick < 18) return { type: "down", ms: 1_000 + below(random, 60_000) }
  return { type: "advance", ms: below(random, 30_000) }
}

/** Up to 40 commands, the seed choosing each; the first two ask in a subagent and answer it in its root's form. */
const commandsOf = (seed: number): ReadonlyArray<Command> => {
  const random = generator(`questions-faults:${seed}`)
  const count = 10 + below(random, 31)
  const first: ReadonlyArray<Command> = [
    { type: "ask", session: 1 },
    { type: "answer", family: 0, picks: [2] },
  ]
  return [...first, ...Array.from({ length: count - 2 }, () => commandOf(below(random, 20), random))]
}

/** A letter or a notice of the plugin, as a session holds it. */
const Letter = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("synthetic"),
  metadata: Schema.Struct({
    source: Schema.Literal("questions"),
    notice: Schema.optional(Schema.Struct({ sessionID: Schema.String })),
    dismissed: Schema.optional(Schema.Array(Schema.String)),
    answers: Schema.Array(Schema.Struct({ id: Schema.String, answer: Schema.String })),
  }),
})
type Letter = typeof Letter.Type

const Open = Schema.Struct({ questions: Schema.Array(Question) })
const Admitted = Schema.fromJsonString(Schema.Struct({ kind: Schema.Literal("admitted"), id: Schema.String, resume: Schema.Boolean }))
const Warned = Schema.Struct({ level: Schema.Literal("Warn"), message: Schema.String })
const Failed = Schema.fromJsonString(Schema.Struct({ t: Schema.Number, kind: Schema.Literal("store-set-failed") }))

/** The answer the form gives a question: it names the session and the question, so a letter shows where it belongs. */
const answerOf = (sessionID: string, id: string) => `answer ${sessionID} ${id}`

const run = (seed: number, check: (world: World.World, state: State) => void) =>
  Effect.gen(function* () {
    const world = World.make({ seed, script: (request) => World.say(`turn of ${request.sessionID}`) })
    for (const directory of DIRECTORIES) yield* world.load(Plugins.questions, { directory })
    const roots = yield* Effect.forEach(DIRECTORIES, (directory) => world.session(directory))
    const children = yield* Effect.forEach(DIRECTORIES, (directory, at) => world.session(directory, { parentID: roots[at], title: `worker ${at}` }))
    const sessions = [roots[0], children[0], roots[1], children[1]]
    const state: State = { sessions, roots, children, asked: new Map(), dismissed: new Set(), asks: new Map() }

    for (const command of commandsOf(seed)) {
      yield* apply(world, state, command)
      yield* world.advance(SETTLE_MS)
      check(world, state)
    }
    // Healed: no write fails, one more reload sends what was recorded, and the sessions come to rest.
    world.faults.failWrites(QUESTIONS.id, 0)
    yield* world.restart
    yield* world.advance(60_000)
    check(world, state)
    return { world, state }
  })

interface State {
  readonly sessions: ReadonlyArray<string>
  readonly roots: ReadonlyArray<string>
  readonly children: ReadonlyArray<string>
  /** Each question asked, `<session> <id>`, by the tool's receipt. */
  readonly asked: Map<string, { readonly sessionID: string; readonly id: string }>
  /** Each question a form dismissed, `<session> <id>`. */
  readonly dismissed: Set<string>
  /** How many times each session asked. */
  readonly asks: Map<string, number>
}

const keyOf = (sessionID: string, id: string) => `${sessionID} ${id}`

const apply = (world: World.World, state: State, command: Command) =>
  Effect.gen(function* () {
    world.record("command", command)
    if (command.type === "ask") {
      const sessionID = state.sessions[command.session] ?? ""
      const asks = state.asks.get(sessionID) ?? 0
      if (asks >= MAX_ASKS) return
      state.asks.set(sessionID, asks + 1)
      const answer = yield* world.tool(sessionID, "ask_user_async", { questions: [{ question: `Question ${asks + 1} of ${sessionID}?`, assume: "yes" }] })
      if (answer.error) return
      for (const match of answer.output.matchAll(/^- (q\d+):/gm)) state.asked.set(keyOf(sessionID, match[1] ?? ""), { sessionID, id: match[1] ?? "" })
      return
    }
    if (command.type === "answer") {
      const root = state.roots[command.family] ?? ""
      const child = state.children[command.family] ?? ""
      const reply = Schema.decodeUnknownSync(Open)(yield* world.rpc(QUESTIONS.id, "open", { sessionIDs: [root, child] }))
      const input = formOf(reply.questions, root, (sessionID) => `worker of ${sessionID}`)
      if (input === void 0) return
      const form = yield* world.form.create(root, input)
      const answer: Record<string, string> = {}
      const ordered = reply.questions.toSorted((left, right) => Number(left.sessionID !== root) - Number(right.sessionID !== root) || left.askedAt - right.askedAt)
      ordered.forEach((question, at) => {
        const pick = command.picks[at % command.picks.length] ?? 0
        const key = input.fields[at]?.key ?? ""
        if (pick === 1) {
          answer[key] = "ask_user_async:dismiss"
          state.dismissed.add(keyOf(question.sessionID, question.id))
        }
        if (pick > 1) answer[key] = answerOf(question.sessionID, question.id)
      })
      yield* world.form.reply(form, answer)
      return
    }
    if (command.type === "prompt") return yield* world.prompt(state.sessions[command.session] ?? "", "go on")
    if (command.type === "write-fails") return world.faults.failWrites(QUESTIONS.id, command.count, command.after)
    if (command.type === "restart") return yield* world.restart
    if (command.type === "down") {
      yield* world.down
      yield* world.advance(command.ms)
      return yield* world.up
    }
    return yield* world.advance(command.ms)
  })

/** The plugin's letters and notices a session holds. */
const lettersOf = (world: World.World, sessionID: string): ReadonlyArray<Letter> =>
  world.messages(sessionID).flatMap((message) => Option.toArray(Schema.decodeUnknownOption(Letter)(plain(message))))

/** The trace's records `schema` reads. */
const traced = <A>(world: World.World, schema: Schema.Decoder<A>) =>
  world
    .trace()
    .split("\n")
    .flatMap((text) => Option.toArray(Schema.decodeUnknownOption(schema)(text)))

/** Each session's answers: one per question, each the one the form gave, in the session that asked it. */
const lettersBroken = (world: World.World, state: State) =>
  state.sessions.flatMap((sessionID) => {
    const answers = lettersOf(world, sessionID)
      .filter((letter) => letter.metadata.notice === void 0)
      .flatMap((letter) => letter.metadata.answers)
    const ids = answers.map((answer) => answer.id)
    const twice = Arr.filter([`${sessionID} holds two answers to one question: ${ids.join(",")}`], () => new Set(ids).size !== ids.length)
    const wrong = answers.filter((answer) => answer.answer !== answerOf(sessionID, answer.id)).map((answer) => `${sessionID} holds the answer "${answer.answer}" to its ${answer.id}`)
    return [...twice, ...wrong]
  })

/** Each notice: in the root of the subagent it names, admitted without waking it. */
const noticesBroken = (world: World.World, state: State) => {
  const woke = new Set(traced(world, Admitted).flatMap((entry) => Arr.filter([entry.id], () => entry.resume)))
  return state.sessions.flatMap((sessionID) =>
    lettersOf(world, sessionID).flatMap((letter) =>
      Option.match(Option.fromNullishOr(letter.metadata.notice), {
        onNone: () => [],
        onSome: (notice) => {
          const at = state.children.indexOf(notice.sessionID)
          const misplaced = Arr.filter([`${sessionID} holds a notice of ${notice.sessionID}, not its subagent`], () => at < 0 || state.roots[at] !== sessionID)
          return [...misplaced, ...Arr.filter([`the notice ${letter.id} in ${sessionID} woke it`], () => woke.has(letter.id))]
        },
      }),
    ),
  )
}

/**
 * The plugin's warnings: each at an instant a write failed. One without (a copy finding a question another copy
 * answered closed) is a submit handled twice.
 */
const warningsBroken = (world: World.World) => {
  const failedAt = new Set(traced(world, Failed).map((entry) => entry.t))
  return world
    .logs()
    .flatMap((entry) => Option.toArray(Schema.decodeUnknownOption(Warned)(entry)).map((warning) => ({ ...warning, at: entry.at - world.start })))
    .filter((warning) => warning.message.startsWith("questions:") && !failedAt.has(warning.at))
    .map((warning) => `a warning with no write failing: ${line(warning)}`)
}

seeded("questions under faults: one letter per answer, in the session that asked; notices to the root alone, never waking it; one copy per submit; nothing recorded is left unsent", ({ seed, expect }) =>
  Effect.gen(function* () {
    const failures: Array<string> = []
    const fail = (world: World.World, what: string) => failures.push(`at ${world.elapsed()} ms: ${what}`)
    const { world, state } = yield* run(seed, (world, state) => {
      for (const what of [...lettersBroken(world, state), ...noticesBroken(world, state), ...warningsBroken(world)]) fail(world, what)
    })
    expect(failures).toEqual([])
    // Healed and reloaded: nothing recorded is left unsent.
    const left = [...world.storage.get(QUESTIONS.id)?.values() ?? []].flatMap((value) => Option.toArray(Schema.decodeUnknownOption(Sheet)(value))).flatMap((sheet) => sheet.rows.filter((row) => row.answered !== void 0))
    expect(left.map((row) => `${row.sessionID} ${row.id}`)).toEqual([])
    // Every question asked is open, answered by a letter, or dismissed.
    const open = Schema.decodeUnknownSync(Open)(yield* world.rpc(QUESTIONS.id, "open", { sessionIDs: [...state.sessions] }))
    const stillOpen = new Set(open.questions.map((question) => keyOf(question.sessionID, question.id)))
    const lettered = new Set(state.sessions.flatMap((sessionID) => lettersOf(world, sessionID).filter((letter) => letter.metadata.notice === void 0).flatMap((letter) => letter.metadata.answers.map((answer) => keyOf(sessionID, answer.id)))))
    const lost = [...state.asked.keys()].filter((key) => !stillOpen.has(key) && !lettered.has(key) && !state.dismissed.has(key))
    expect(lost).toEqual([])
    // The run reached what it is about: a subagent's answer delivered, and its root told.
    expect(lettersOf(world, state.children[0] ?? "").length).toBeGreaterThan(0)
    expect(lettersOf(world, state.roots[0] ?? "").some((letter) => letter.metadata.notice !== void 0)).toBe(true)
  }),
)
