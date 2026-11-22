// The owner's answer from the digest page: to an open question (`question:<session>:<id>`, the questions plugin's
// own answer, as the tray's form gives it) or to a needs-you queue item (`item:<root>:<id>`, the queue's answer, as
// its form gives it). The page names the message and gives one of its options or a text of his own; this module
// checks both against what the log says the message asks, sends it through the plugin that owns it, and says what
// happened:
// - Answered: it went (with the item's earlier answer it replaced, when it had one).
// - AlreadyClosed: another answer (the tray's, or the page's in another tab) closed it first: that answer, where it
//   was given and when, as far as the log knows yet. Nothing changes.
// - Refused: why not (no such message, not one of its options, empty or too long, the plugin refused it).
// The plugin that owns the question decides who was first (mods/questions: one write over the rev it read); this
// module reads the log only to refuse early and to say who answered.
import { Data, Effect, Match, Option, Predicate, Schema } from "effect"
import { type Item, keyOf, type State } from "./fold.ts"

/** An answer's most characters: past it the page is told so and nothing goes. */
export const ANSWER_MAX = 2_000

/** What the page sends: the message, and one of its options or a text of his own. */
export const PageAnswer = Schema.Struct({ id: Schema.NonEmptyString, option: Schema.optionalKey(Schema.String), text: Schema.optionalKey(Schema.String) })
export type PageAnswer = typeof PageAnswer.Type

export type AnswerOutcome = Data.TaggedEnum<{
  Answered: { readonly replaced: Option.Option<string> }
  AlreadyClosed: { readonly answer: Option.Option<string>; readonly via: Option.Option<string>; readonly at: Option.Option<number> }
  Refused: { readonly status: number; readonly reason: string }
}>
export const AnswerOutcome = Data.taggedEnum<AnswerOutcome>()

/** What the questions plugin's `answer` answers (its Reply): `closed` when none of it was open any more. */
export const QuestionReply = Schema.Struct({ ok: Schema.Boolean, message: Schema.optionalKey(Schema.String), closed: Schema.optionalKey(Schema.Literal(true)) })
export type QuestionReply = typeof QuestionReply.Type

/** What the queue's `answer` answers: sent (and the answer it replaced), or why not. */
export const ItemReply = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.optionalKey(Schema.String),
  replaced: Schema.optionalKey(Schema.Struct({ answer: Schema.String, at: Schema.Number })),
})
export type ItemReply = typeof ItemReply.Type

/** The plugins that own what is answered, as the digest plugin reaches them (their RPCs). */
export interface Answerers {
  readonly question: (session: string, id: string, answer: string) => Effect.Effect<QuestionReply>
  readonly item: (root: string, id: string, answer: string) => Effect.Effect<ItemReply>
}

/** A message the page answers, by its id's parts. */
type Target = Data.TaggedEnum<{ Question: { readonly session: string; readonly id: string }; Item: { readonly root: string; readonly id: string } }>
const Target = Data.taggedEnum<Target>()

const TARGET = /^(question|item):([^:]+):(.+)$/

const targetOf = (id: string): Option.Option<Target> =>
  Option.flatMap(Option.fromNullishOr(TARGET.exec(id)), ([, kind = "", first = "", rest = ""]) =>
    Match.value(kind).pipe(
      Match.when("question", () => Option.some(Target.Question({ session: first, id: rest }))),
      Match.when("item", () => Option.some(Target.Item({ root: first, id: rest }))),
      Match.orElse(() => Option.none<Target>()),
    ),
  )

const refused = (status: number, reason: string) => AnswerOutcome.Refused({ status, reason })

/** A text he typed: within ANSWER_MAX and not blank. */
const typedOf = (text: string): Effect.Effect<string, AnswerOutcome> => {
  const typed = text.trim()
  if (typed === "") return Effect.fail(refused(400, "an answer needs text"))
  if ([...typed].length > ANSWER_MAX) return Effect.fail(refused(413, `an answer is at most ${ANSWER_MAX} characters`))
  return Effect.succeed(typed)
}

/** The answer the page gave, checked against what the message offers: one option of its own, or one text. */
const givenOf = (input: PageAnswer, options: ReadonlyArray<string>): Effect.Effect<string, AnswerOutcome> =>
  Match.value({ option: Option.fromUndefinedOr(input.option), text: Option.fromUndefinedOr(input.text) }).pipe(
    Match.when({ option: Option.isSome, text: Option.isNone }, ({ option }) =>
      Effect.filterOrFail(
        Effect.succeed(Option.getOrElse(option, () => "")),
        (chosen) => options.includes(chosen),
        (chosen) => refused(400, `"${chosen}" is not one of its options`),
      ),
    ),
    Match.when({ option: Option.isNone, text: Option.isSome }, ({ text }) => typedOf(Option.getOrElse(text, () => ""))),
    Match.orElse(() => Effect.fail(refused(400, "an answer is one option or one text"))),
  )

/** What the log says closed the question, if anything did: its answer (where, when), or that it closed unanswered. */
const closedQuestion = (state: State, session: string, id: string): Option.Option<AnswerOutcome> => {
  const key = keyOf(session, id)
  return Option.orElse(
    Option.map(Option.fromUndefinedOr(state.answered.get(key)), (line) => AnswerOutcome.AlreadyClosed({ answer: Option.some(line.answer), via: line.via, at: Option.some(line.t) })),
    () => Option.map(Option.fromUndefinedOr(state.closed.get(key)), (line) => AnswerOutcome.AlreadyClosed({ answer: Option.none(), via: Option.some(line.reason), at: Option.some(line.t) })),
  )
}

const unknownCloser = AnswerOutcome.AlreadyClosed({ answer: Option.none(), via: Option.none(), at: Option.none() })

const answerQuestion = (state: Effect.Effect<State>, answerers: Answerers, input: PageAnswer, session: string, id: string) =>
  Effect.gen(function* () {
    const now = yield* state
    const asked = Option.fromUndefinedOr(now.asked.get(keyOf(session, id)))
    if (Option.isNone(asked)) return refused(404, `no question ${input.id}`)
    const closed = closedQuestion(now, session, id)
    if (Option.isSome(closed)) return closed.value
    const reply = yield* answerers.question(session, id, yield* givenOf(input, asked.value.options))
    if (reply.ok) return AnswerOutcome.Answered({ replaced: Option.none() })
    // Refused as no longer open: the other answer was first. Its line may not have reached the log yet.
    if (Predicate.isNotUndefined(reply.closed)) return Option.getOrElse(closedQuestion(yield* state, session, id), () => unknownCloser)
    return refused(502, Option.getOrElse(Option.fromUndefinedOr(reply.message), () => "the questions plugin refused it"))
  }).pipe(Effect.catch(Effect.succeed))

const isItem = (each: unknown): each is Item => Predicate.isTagged(each, "Item")

const answerItem = (state: Effect.Effect<State>, answerers: Answerers, input: PageAnswer, root: string, id: string) =>
  Effect.gen(function* () {
    const item = Option.filter(Option.filter(Option.fromUndefinedOr((yield* state).items.get(keyOf(root, id))), isItem), (each) => each.state === "needs-you")
    if (Option.isNone(item)) return refused(404, `no item needing you ${input.id}`)
    // The page offers an item's answer once; another goes through the Queue tab.
    if (Option.isSome(item.value.answer)) return AnswerOutcome.AlreadyClosed({ answer: item.value.answer, via: Option.none(), at: Option.some(item.value.t) })
    const reply = yield* answerers.item(root, id, yield* givenOf(input, Option.getOrElse(item.value.choices, () => [])))
    if (!reply.ok) return refused(502, Option.getOrElse(Option.fromUndefinedOr(reply.message), () => "the queue refused it"))
    return AnswerOutcome.Answered({ replaced: Option.map(Option.fromUndefinedOr(reply.replaced), (each) => each.answer) })
  }).pipe(Effect.catch(Effect.succeed))

/** The page's answer `input`, checked against the log (`state`, read fresh) and sent through the plugin that owns it. */
export const answer = (state: Effect.Effect<State>, answerers: Answerers, input: PageAnswer): Effect.Effect<AnswerOutcome> =>
  Option.match(targetOf(input.id), {
    onNone: () => Effect.succeed(refused(404, `not a message the page answers: ${input.id}`)),
    onSome: Target.$match({
      Question: ({ session, id }) => answerQuestion(state, answerers, input, session, id),
      Item: ({ root, id }) => answerItem(state, answerers, input, root, id),
    }),
  })
