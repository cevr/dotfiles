// A subagent asks its orchestrator, not the owner: a model-based test on the
// simulated host at 20 seeds. One directory holds a root R, its subagent C and
// C's subagent G; the seed chooses up to 40 commands: a session asks (R with
// `ask_user_async`, C and G with `ask_orchestrator`), the session a question
// is put to answers it (`answer_subagent`), another session tries to, the
// asker withdraws, the owner answers over the RPC, a session calls the tool
// that is not its own, the plugin reloads, time passes.
//
// The reference model is one map: each question's ref (`<session>:<id>`), the
// session it is put to (none: the owner) and whether it is open. After every
// command the plugin must agree with it:
// - the RPC's `open` lists as `questions` exactly the open questions put to
//   the owner (only R's own), and as `held` exactly the open ones put to a
//   session, each naming it (`to`): a subagent's question is never the owner's;
// - each session holds exactly one question letter per question put to it
//   (C's go to R, G's to C: one level, never further), and each woke it;
// - each answered question has exactly one answer letter in the session that
//   asked, with the answer given and whether it differs from the assumption;
// - a call by a session a question is not put to, and a call of the other
//   session kind's tool, is refused and changes nothing.
// The first commands walk the escalation by hand: G asks C, C asks R in its
// own words, R asks the owner, the owner answers R, R answers C, C answers G.
//
// A second test: a directory loaded with `subagents: "owner"` keeps today's
// rule (a subagent's `ask_user_async` question is the owner's, no letter).
import { fileURLToPath } from "bun"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { QUESTIONS } from "@dotfiles/opencode-questions/question"
import * as Plugins from "../../sim/plugins.ts"
import { below, generator, plain } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/questions/questions-routing.sim.test.ts")

const DIRECTORY = "/scratch/routing"
const STRAIGHT = "/scratch/straight"
const MAX_ASKS = 6
const SETTLE_MS = 5_000
/** The principles folder of this checkout: both nudges name it. */
const PRINCIPLES = fileURLToPath(new URL("../../../principles", import.meta.url))

type Command =
  | { readonly type: "ask"; readonly session: number }
  | { readonly type: "answer"; readonly pick: number; readonly same: boolean }
  | { readonly type: "stranger"; readonly pick: number }
  | { readonly type: "withdraw"; readonly pick: number }
  | { readonly type: "owner"; readonly pick: number }
  | { readonly type: "wrong-tool"; readonly session: number }
  | { readonly type: "restart" }
  | { readonly type: "advance"; readonly ms: number }

const commandOf = (pick: number, random: ReturnType<typeof generator>): Command => {
  if (pick < 7) return { type: "ask", session: below(random, 3) }
  if (pick < 11) return { type: "answer", pick: below(random, 8), same: below(random, 2) === 0 }
  if (pick < 13) return { type: "stranger", pick: below(random, 8) }
  if (pick < 15) return { type: "withdraw", pick: below(random, 8) }
  if (pick < 17) return { type: "owner", pick: below(random, 8) }
  if (pick < 18) return { type: "wrong-tool", session: below(random, 3) }
  if (pick < 19) return { type: "restart" }
  return { type: "advance", ms: below(random, 30_000) }
}

/** The escalation by hand (G, C, R ask in turn; the owner, R, C answer in turn), then the seed's commands. */
const commandsOf = (seed: number): ReadonlyArray<Command> => {
  const random = generator(`questions-routing:${seed}`)
  const first: ReadonlyArray<Command> = [
    { type: "ask", session: 2 },
    { type: "ask", session: 1 },
    { type: "ask", session: 0 },
    { type: "owner", pick: 2 },
    { type: "answer", pick: 1, same: false },
    { type: "answer", pick: 0, same: true },
  ]
  return [...first, ...Array.from({ length: 4 + below(random, 31) }, () => commandOf(below(random, 20), random))]
}

/** A question as the model keeps it. */
interface Entry {
  readonly ref: string
  readonly sessionID: string
  readonly id: string
  /** The session it is put to; none for the owner. */
  readonly to: Option.Option<string>
  open: boolean
  answer?: string
}

interface State {
  /** R, C, G. */
  readonly sessions: ReadonlyArray<string>
  readonly parent: ReadonlyMap<string, string>
  readonly entries: Array<Entry>
  readonly asks: Map<string, number>
}

const ASSUME = "yes"
const ASK_OWNER = "ask_user_async"
const ASK_PARENT = "ask_orchestrator"
const toolOf = (state: State, sessionID: string) =>
  Option.match(Option.fromNullishOr(state.parent.get(sessionID)), { onNone: () => ASK_OWNER, onSome: () => ASK_PARENT })
/** The ask tool a session must not call. */
const wrongOf = (state: State, sessionID: string) =>
  Option.match(Option.fromNullishOr(state.parent.get(sessionID)), { onNone: () => ASK_PARENT, onSome: () => ASK_OWNER })
const openOf = (state: State) => state.entries.filter((entry) => entry.open)
const heldOf = (state: State) => openOf(state).filter((entry) => Option.isSome(entry.to))
const pickOf = <A,>(items: ReadonlyArray<A>, pick: number): Option.Option<A> =>
  Arr.match(items, { onEmpty: () => Option.none(), onNonEmpty: (all) => Arr.get(all, pick % all.length) })
const toOf = (entry: Entry) => Option.getOrElse(entry.to, () => "")
/** An answer given by the session a question is put to: the assumption, or a different one naming it. */
const replyOf = (same: boolean, entry: Entry) => {
  if (same) return ASSUME
  return `no, says ${toOf(entry)}`
}
const howOf = (matches: boolean) => {
  if (matches) return "as assumed"
  return "differs"
}

const ask = (world: World.World, state: State, session: number, receipts: Array<string>) =>
  Effect.gen(function* () {
    const sessionID = state.sessions[session] ?? ""
    const asks = state.asks.get(sessionID) ?? 0
    if (asks >= MAX_ASKS) return
    state.asks.set(sessionID, asks + 1)
    const answer = yield* world.tool(sessionID, toolOf(state, sessionID), {
      questions: [{ question: `Question ${asks + 1} of ${sessionID}?`, options: [{ label: "yes" }, { label: "no" }], assume: ASSUME }],
    })
    if (answer.error) return void receipts.push(`refused: ${toolOf(state, sessionID)} in ${sessionID}: ${answer.output}`)
    receipts.push(answer.output)
    for (const match of answer.output.matchAll(/^- (q\d+):/gm))
      state.entries.push({ ref: `${sessionID}:${match[1]}`, sessionID, id: match[1] ?? "", to: Option.fromNullishOr(state.parent.get(sessionID)), open: true })
  })

const answerHeld = (world: World.World, entry: Entry, same: boolean, receipts: Array<string>) =>
  Effect.gen(function* () {
    const text = replyOf(same, entry)
    const answer = yield* world.tool(toOf(entry), "answer_subagent", { answers: [{ id: entry.ref, text }] })
    if (answer.error) return void receipts.push(`refused: answer_subagent of ${entry.ref} by ${toOf(entry)}: ${answer.output}`)
    entry.open = false
    entry.answer = text
  })

const stranger = (world: World.World, state: State, entry: Entry, receipts: Array<string>) =>
  Effect.gen(function* () {
    const other = state.sessions.find((sessionID) => sessionID !== toOf(entry)) ?? ""
    const answer = yield* world.tool(other, "answer_subagent", { answers: [{ id: entry.ref, text: "not mine to answer" }] })
    if (!answer.error) receipts.push(`not refused: answer_subagent of ${entry.ref} by ${other}, put to ${toOf(entry)}`)
  })

const withdraw = (world: World.World, state: State, entry: Entry, receipts: Array<string>) =>
  Effect.gen(function* () {
    const answer = yield* world.tool(entry.sessionID, toolOf(state, entry.sessionID), { withdraw: [entry.id] })
    if (answer.error) return void receipts.push(`refused: withdraw of ${entry.ref}: ${answer.output}`)
    entry.open = false
  })

const owner = (world: World.World, entry: Entry) =>
  Effect.gen(function* () {
    const text = `owner on ${entry.ref}`
    yield* world.rpc(QUESTIONS.id, "answer", { sessionID: entry.sessionID, answers: [{ id: entry.id, answer: text }] })
    entry.open = false
    entry.answer = text
  })

const wrongTool = (world: World.World, state: State, session: number, receipts: Array<string>) =>
  Effect.gen(function* () {
    const sessionID = state.sessions[session] ?? ""
    const wrong = wrongOf(state, sessionID)
    const answer = yield* world.tool(sessionID, wrong, { questions: [{ question: `Wrong tool in ${sessionID}?`, assume: ASSUME }] })
    if (!answer.error) receipts.push(`not refused: ${wrong} in ${sessionID}`)
  })

/** A command on the picked entry, when there is one to pick. */
const onPicked = (entries: ReadonlyArray<Entry>, pick: number, run: (entry: Entry) => Effect.Effect<void, unknown>) =>
  Option.match(pickOf(entries, pick), { onNone: () => Effect.void, onSome: run })

const apply = (world: World.World, state: State, command: Command, receipts: Array<string>) =>
  Effect.gen(function* () {
    world.record("command", command)
    switch (command.type) {
      case "ask":
        return yield* ask(world, state, command.session, receipts)
      case "answer":
        return yield* onPicked(heldOf(state), command.pick, (entry) => answerHeld(world, entry, command.same, receipts))
      case "stranger":
        return yield* onPicked(heldOf(state), command.pick, (entry) => stranger(world, state, entry, receipts))
      case "withdraw":
        return yield* onPicked(openOf(state), command.pick, (entry) => withdraw(world, state, entry, receipts))
      case "owner":
        return yield* onPicked(openOf(state), command.pick, (entry) => owner(world, entry))
      case "wrong-tool":
        return yield* wrongTool(world, state, command.session, receipts)
      case "restart":
        return yield* world.restart
      case "advance":
        return yield* world.advance(command.ms)
    }
  })

const Open = Schema.Struct({
  questions: Schema.Array(Schema.Struct({ sessionID: Schema.String, id: Schema.String })),
  held: Schema.optional(Schema.Array(Schema.Struct({ sessionID: Schema.String, id: Schema.String, to: Schema.String }))),
})

/** A question letter: the questions one ask put to the session that holds it. */
const QuestionLetter = Schema.Struct({
  id: Schema.String,
  metadata: Schema.Struct({
    source: Schema.Literal("questions"),
    asked: Schema.Struct({ sessionID: Schema.String, questions: Schema.Array(Schema.Struct({ ref: Schema.String, assume: Schema.String })) }),
  }),
})

/** An answer letter, as today's: not a notice. */
const AnswerLetter = Schema.Struct({
  metadata: Schema.Struct({
    source: Schema.Literal("questions"),
    notice: Schema.optional(Schema.Undefined),
    asked: Schema.optional(Schema.Undefined),
    answers: Schema.Array(Schema.Struct({ id: Schema.String, answer: Schema.String, matches: Schema.Boolean })),
  }),
})

const Admitted = Schema.fromJsonString(Schema.Struct({ kind: Schema.Literal("admitted"), id: Schema.String, resume: Schema.Boolean }))

/** A value as JSON text. */
const jsonOf = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const read = <A,>(world: World.World, sessionID: string, schema: Schema.Decoder<A>) =>
  world.messages(sessionID).flatMap((message) => Option.toArray(Schema.decodeUnknownOption(schema)(plain(message))))

const sorted = (items: ReadonlyArray<string>) => items.toSorted()

/** Where one session's letters and the model disagree, in words. */
const brokenIn = (world: World.World, state: State, sessionID: string, woke: ReadonlySet<string>, differ: (what: string, got: ReadonlyArray<string>, want: ReadonlyArray<string>) => void, failures: Array<string>) => {
  const letters = read(world, sessionID, QuestionLetter)
  differ(`the question letters in ${sessionID}`, letters.flatMap((letter) => letter.metadata.asked.questions.map((question) => question.ref)), state.entries.filter((entry) => Option.contains(entry.to, sessionID)).map((entry) => entry.ref))
  for (const letter of letters) if (!woke.has(letter.id)) failures.push(`the question letter ${letter.id} did not wake ${sessionID}`)
  const answers = read(world, sessionID, AnswerLetter).flatMap((letter) => letter.metadata.answers)
  differ(
    `the answers ${sessionID} was given`,
    answers.map((answer) => `${answer.id} = ${answer.answer} (${howOf(answer.matches)})`),
    state.entries.flatMap((entry) =>
      Option.toArray(
        Option.flatMap(Option.liftPredicate(entry, (mine) => mine.sessionID === sessionID), (mine) =>
          Option.map(Option.fromNullishOr(mine.answer), (answer) => `${mine.id} = ${answer} (${howOf(answer === ASSUME)})`),
        ),
      ),
    ),
  )
}

/** Where the plugin and the model disagree, in words. */
const broken = (world: World.World, state: State) =>
  Effect.gen(function* () {
    const open = Schema.decodeUnknownSync(Open)(yield* world.rpc(QUESTIONS.id, "open", { sessionIDs: [...state.sessions] }))
    const failures: Array<string> = []
    const differ = (what: string, got: ReadonlyArray<string>, want: ReadonlyArray<string>) => {
      if (jsonOf(sorted(got)) !== jsonOf(sorted(want))) failures.push(`${what}: got [${sorted(got).join(", ")}], the model has [${sorted(want).join(", ")}]`)
    }
    differ("the owner's open questions", open.questions.map((question) => `${question.sessionID}:${question.id}`), openOf(state).filter((entry) => Option.isNone(entry.to)).map((entry) => entry.ref))
    differ("the questions held by a session", (open.held ?? []).map((question) => `${question.sessionID}:${question.id} -> ${question.to}`), heldOf(state).map((entry) => `${entry.ref} -> ${toOf(entry)}`))
    const woke = new Set(world.trace().split("\n").flatMap((text) => Option.toArray(Schema.decodeUnknownOption(Admitted)(text))).filter((entry) => entry.resume).map((entry) => entry.id))
    for (const sessionID of state.sessions) brokenIn(world, state, sessionID, woke, differ, failures)
    return failures
  })

seeded("a subagent's question goes to the session that started it, one level, and never to the owner; its answer comes back as the owner's would", ({ seed, expect }) =>
  Effect.gen(function* () {
    const world = World.make({ seed, script: (request) => World.say(`turn of ${request.sessionID}`) })
    yield* world.load(Plugins.questions, { directory: DIRECTORY })
    yield* world.load(Plugins.orchestrate(), { directory: DIRECTORY })
    const root = yield* world.session(DIRECTORY)
    const child = yield* world.session(DIRECTORY, { parentID: root, title: "implementor auth r1" })
    const grandchild = yield* world.session(DIRECTORY, { parentID: child, title: "worker probe" })
    const state: State = { sessions: [root, child, grandchild], parent: new Map([[child, root], [grandchild, child]]), entries: [], asks: new Map() }
    const receipts: Array<string> = []
    const failures: Array<string> = []
    for (const command of commandsOf(seed)) {
      yield* apply(world, state, command, receipts)
      yield* world.advance(SETTLE_MS)
      for (const what of yield* broken(world, state)) failures.push(`at ${world.elapsed()} ms, after ${command.type}: ${what}`)
    }
    expect(failures.slice(0, 5)).toEqual([])
    expect(receipts.filter((receipt) => /^(not )?refused:/.test(receipt))).toEqual([])
    // The escalation by hand reached its end: G's question answered by C, C's by R, R's by the owner.
    expect(state.entries.slice(0, 3).map((entry) => entry.answer)).toEqual([ASSUME, `no, says ${root}`, `owner on ${root}:q1`])
    // Both nudges name the documents: the subagent's receipt and the letter its orchestrator reads.
    expect(receipts[0]).toContain(PRINCIPLES)
    expect(jsonOf(world.messages(child).map(plain))).toContain(PRINCIPLES)
  }),
)

seeded("with subagents: \"owner\", a subagent's ask_user_async question is the owner's, as before, and no session gets a letter of it", ({ seed, expect }) =>
  Effect.gen(function* () {
    const world = World.make({ seed, script: (request) => World.say(`turn of ${request.sessionID}`) })
    yield* world.load(Plugins.questions, { directory: STRAIGHT })
    yield* world.load(Plugins.orchestrate(), { directory: STRAIGHT, options: { subagents: "owner" } })
    const root = yield* world.session(STRAIGHT)
    const child = yield* world.session(STRAIGHT, { parentID: root, title: "worker" })
    const answer = yield* world.tool(child, "ask_user_async", { questions: [{ question: "Straight to the owner?", assume: ASSUME }] })
    expect(answer.error).toBeFalsy()
    yield* world.advance(SETTLE_MS)
    const open = Schema.decodeUnknownSync(Open)(yield* world.rpc(QUESTIONS.id, "open", { sessionIDs: [root, child] }))
    expect(open.questions.map((question) => `${question.sessionID}:${question.id}`)).toEqual([`${child}:q1`])
    expect(open.held ?? []).toEqual([])
    expect(read(world, root, QuestionLetter)).toEqual([])
  }),
)
