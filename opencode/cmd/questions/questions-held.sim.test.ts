// Questions put to a session (`to`), below the plugin, at the seed runner's
// seeds (sim/seed.ts): who may answer them, over sheets and calls each seed
// generates; how a sheet stored before `to` existed reads; and the question
// letter under faults over the memory doubles (the courier refuses once, or
// the write that marks the letter sent fails once): after `resend` the
// session it is put to holds exactly one letter, under the id recorded first.
import * as MemoryDigest from "@dotfiles/opencode-digest/memory/log"
import { Effect, Exit, Layer, Option, Random, Schema } from "effect"
import * as MemoryCourier from "@dotfiles/opencode-questions/memory/courier"
import * as MemoryStore from "@dotfiles/opencode-questions/memory/store"
import * as Model from "@dotfiles/opencode-questions/model"
import { AnswerQuestions, decideAnswers, heldOf, ownersOf, type Row, Sheet } from "@dotfiles/opencode-questions/question"
import { Changes, QuestionStore } from "@dotfiles/opencode-questions/service"
import * as Seed from "../../sim/seed.ts"

const { seeded } = Seed.runner("cmd/questions/questions-held.sim.test.ts")

const AT = Date.parse("2026-11-19T10:00:00Z")
const SESSIONS = ["ses_parent", "ses_other"]
/** Generated cases a seed checks. */
const CASES = 25

const pick = <A,>(items: readonly [A, ...ReadonlyArray<A>]) => Effect.map(Random.nextIntBetween(0, items.length), (index) => items[index] ?? items[0])

const putTo = (to: Option.Option<string>) => Option.match(to, { onNone: () => ({}), onSome: (session) => ({ to: session }) })
const answeredIf = (answered: boolean) =>
  Option.match(Option.liftPredicate(answered, Boolean), { onNone: () => ({}), onSome: () => ({ answered: { answer: "no", delivery: "msg_old" } }) })

/** A row put to the owner (none) or to one of the sessions, open or answered. */
const rowOf = (index: number) =>
  Effect.gen(function* () {
    const to = yield* pick([Option.none<string>(), ...SESSIONS.map(Option.some)])
    const answered = yield* Random.nextBoolean
    const row: Row = { id: `q${index + 1}`, sessionID: "ses_child", question: `Question ${index + 1}?`, assume: "yes", askedAt: AT }
    return { ...row, ...putTo(to), ...answeredIf(answered) }
  })

/** A sheet of 1 to 6 rows and an answer call: 1 to 3 ids (one may be unknown), by the owner (none) or a session. */
const caseOf = Effect.gen(function* () {
  const count = yield* Random.nextIntBetween(1, 7)
  const rows: ReadonlyArray<Row> = yield* Effect.forEach(Array.from({ length: count }, (_, index) => index), rowOf)
  const ids = yield* Effect.forEach(Array.from({ length: yield* Random.nextIntBetween(1, 4) }), () => pick(["q99", ...rows.map((row) => row.id)]))
  const by = yield* pick([Option.none<string>(), ...SESSIONS.map(Option.some)])
  return { sheet: { next: count + 1, rows }, ids: [...new Set(ids)], by }
})

const commandOf = (ids: ReadonlyArray<string>, by: Option.Option<string>) =>
  AnswerQuestions.make({ answers: ids.map((id) => ({ id, answer: "maybe" })), delivery: "msg_new", ...Option.match(by, { onNone: () => ({}), onSome: (session) => ({ by: session }) }) })

/** Whether the decision refused the call as answering questions not put to the caller. */
const notHeld = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Exit.match(exit, { onFailure: (cause) => cause.reasons.some((reason) => reason._tag === "Fail" && reason.error._tag === "NotHeld"), onSuccess: () => false })

seeded("a question put to a session is answered only by that session or by the owner, at every generated sheet and call", ({ seed, expect }) =>
  Effect.gen(function* () {
    const outcomes = yield* Effect.forEach(Array.from({ length: CASES }), () =>
      Effect.gen(function* () {
        const { sheet, ids, by } = yield* caseOf
        const refused = notHeld(yield* Effect.exit(decideAnswers(sheet, commandOf(ids, by))))
        // The session may answer exactly the open questions put to it; the owner (no `by`) is never refused as not holding.
        const held = (session: string) => sheet.rows.filter((row) => row.to === session && !("answered" in row)).map((row) => row.id)
        const want = Option.match(by, { onNone: () => false, onSome: (session) => ids.some((id) => !held(session).includes(id)) })
        expect({ ids, by, refused }).toEqual({ ids, by, refused: want })
        return refused
      }),
    ).pipe(Random.withSeed(`questions-held:${seed}`))
    // Neither side is vacuous across the seed's cases.
    expect(new Set(outcomes)).toEqual(new Set([true, false]))
  }),
)

seeded("a sheet stored before `to` existed decodes, every question on it is the owner's, and only the owner answers it", ({ expect }) =>
  Effect.gen(function* () {
    const stored = {
      next: 3,
      rows: [
        { id: "q1", sessionID: "ses_child", question: "Old one?", assume: "yes", askedAt: AT },
        { id: "q2", sessionID: "ses_child", question: "Old two?", assume: "no", askedAt: AT, answered: { answer: "no", delivery: "msg_1" } },
      ],
    }
    const sheet = yield* Schema.decodeUnknownEffect(Sheet)(stored)
    expect(ownersOf(sheet.rows).map((row) => row.id)).toEqual(["q1", "q2"])
    expect(heldOf(sheet.rows)).toEqual([])
    expect(notHeld(yield* Effect.exit(decideAnswers(sheet, commandOf(["q1"], Option.none()))))).toBe(false)
    expect(notHeld(yield* Effect.exit(decideAnswers(sheet, commandOf(["q1"], Option.some("ses_parent")))))).toBe(true)
  }),
)

const PARENT = "ses_parent"
const CHILD = "ses_child"
const QUESTION = { question: "Which port?", options: [{ label: "8080" }, { label: "3000" }], assume: "8080" }
const NUDGE = "Answer from the documents."

/** Whether a stored sheet records a letter as sent: the write that marks it. */
const marksSent = (sheet: Sheet) => sheet.rows.some((row) => row.letter?.sent === true)

/** The model over memory doubles; `failMark` makes the first write that marks a letter sent fail. */
const rig = (failMark: boolean) => {
  const sheets = MemoryStore.empty()
  const sessions = MemoryCourier.empty(PARENT)
  MemoryCourier.child(sessions, { id: CHILD, parentID: PARENT })
  const failing = { left: Number(failMark) }
  const store = Layer.effect(
    QuestionStore,
    Effect.gen(function* () {
      const inner = yield* QuestionStore
      return QuestionStore.of({
        ...inner,
        write: (sessionID, sheet) =>
          Effect.suspend(() => {
            if (failing.left > 0 && marksSent(sheet)) {
              failing.left -= 1
              return Effect.die("the store would not take the write")
            }
            return inner.write(sessionID, sheet)
          }),
      })
    }),
  ).pipe(Layer.provide(MemoryStore.layer(sheets)))
  const layer = Model.layer.pipe(
    Layer.provide(MemoryDigest.writer()),
    Layer.provide(store),
    Layer.provide(MemoryCourier.layer(sessions)),
    Layer.provide(Layer.succeed(Changes, Changes.of({ changed: () => Effect.void }))),
  )
  const letters = () => (sessions.inboxes.get(PARENT) ?? []).filter((message) => message.letter.metadata.asked?.sessionID === CHILD)
  return { sessions, layer, letters }
}

seeded("a question letter the courier refuses once is not there, and after resend is there exactly once", ({ expect }) => {
  const { sessions, layer, letters } = rig(false)
  return Effect.gen(function* () {
    const model = yield* Model.QuestionsModel
    sessions.refusing.set(PARENT, "the host would not take it")
    yield* model.put(CHILD, { questions: [QUESTION] }, PARENT, NUDGE)
    expect(letters()).toEqual([])
    sessions.refusing.delete(PARENT)
    yield* model.resend
    yield* model.resend
    expect(letters().map((message) => message.letter.metadata.asked?.questions.map((question) => question.ref))).toEqual([[`${CHILD}:q1`]])
  }).pipe(Effect.provide(layer))
})

seeded("a question letter whose mark-sent write fails once went, and resend sends it under the same id, so once", ({ expect }) => {
  const { layer, letters } = rig(true)
  return Effect.gen(function* () {
    const model = yield* Model.QuestionsModel
    yield* model.put(CHILD, { questions: [QUESTION] }, PARENT, NUDGE)
    const first = letters().map((message) => message.id)
    expect(first).toHaveLength(1)
    yield* model.resend
    yield* model.resend
    expect(letters().map((message) => message.id)).toEqual(first)
  }).pipe(Effect.provide(layer))
})
