// Questions put to a session (`to`), below the plugin, at the seed runner's
// seeds (sim/seed.ts): who may answer them, over sheets and calls each seed
// generates; how a sheet stored before `to` existed reads; and the question
// letter under faults over the memory doubles (the courier refuses once, or
// the write that marks the letter sent fails once): after `resend` the
// session it is put to holds exactly one letter, under the id recorded first;
// and an owner's answer whose process is killed at its letter or at its close,
// delivered exactly once after the restart.
import * as MemoryDigest from "@dotfiles/opencode-digest/memory/log"
import { Effect, Exit, Layer, Option, Random, Ref, Schema } from "effect"
import * as MemoryCourier from "@dotfiles/opencode-questions/memory/courier"
import * as MemoryStore from "@dotfiles/opencode-questions/memory/store"
import * as Model from "@dotfiles/opencode-questions/model"
import { AnswerQuestions, decideAnswers, heldOf, ownersOf, QuestionAnswered, type Row, Sheet } from "@dotfiles/opencode-questions/question"
import type { Letter } from "@dotfiles/opencode-questions/reply"
import { Changes, Courier, QuestionStore } from "@dotfiles/opencode-questions/service"
import * as Seed from "../../sim/seed.ts"
import { assertEffectWitness } from "../../sim/witnesses.ts"

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
    yield* Effect.forEach(Array.from({ length: CASES }), () =>
      Effect.gen(function* () {
        const { sheet, ids, by } = yield* caseOf
        const refused = notHeld(yield* Effect.exit(decideAnswers(sheet, commandOf(ids, by), 0)))
        // The session may answer exactly the open questions put to it; the owner (no `by`) is never refused as not holding.
        const held = (session: string) => sheet.rows.filter((row) => row.to === session && !("answered" in row)).map((row) => row.id)
        const want = Option.match(by, { onNone: () => false, onSome: (session) => ids.some((id) => !held(session).includes(id)) })
        expect({ ids, by, refused }).toEqual({ ids, by, refused: want })
      }),
      { discard: true },
    ).pipe(Random.withSeed(`questions-held:${seed}`))
  }),
)

Seed.effect("W: the holder answers; a different session receives NotHeld", Effect.gen(function* () {
  const sheet = { next: 2, rows: [{ id: "q1", sessionID: "ses_child", to: "ses_parent", question: "Held question?", assume: "yes", askedAt: AT }] }
  const play = (matches: boolean) => {
    const caller = Option.getOrElse(Option.liftPredicate("ses_parent", () => matches), () => "ses_other")
    return Effect.exit(decideAnswers(sheet, commandOf(["q1"], Option.some(caller)), 0))
  }
  yield* assertEffectWitness("a matching caller records the answer", [QuestionAnswered.make({ id: "q1", answer: "maybe", delivery: "msg_new", at: 0 })], (cause) =>
    Effect.map(play(cause), (exit) => Exit.match(exit, { onFailure: () => [], onSuccess: (events) => events })))
  yield* assertEffectWitness("a mismatching caller gets NotHeld", true, (cause) => Effect.map(play(!cause), notHeld))
}))

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
    expect(notHeld(yield* Effect.exit(decideAnswers(sheet, commandOf(["q1"], Option.none()), 0)))).toBe(false)
    expect(notHeld(yield* Effect.exit(decideAnswers(sheet, commandOf(["q1"], Option.some("ses_parent")), 0)))).toBe(true)
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
        writeIf: (sessionID, sheet, rev) =>
          Effect.suspend(() => {
            if (failing.left > 0 && marksSent(sheet)) {
              failing.left -= 1
              return Effect.die("the store would not take the write")
            }
            return inner.writeIf(sessionID, sheet, rev)
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

const ROOT = "ses_root"

/**
 * The owner's answer from the page, with the process killed at one point of it, then started again: the sheets, the
 * sessions and the digest outlive it, the model does not. `crash` is where it dies: in the letter's delivery (the
 * answer stored, no letter yet), or in the write that closes the question (the letter gone, the sheet not told).
 */
const crashRig = (crash: "letter" | "close") => {
  const sheets = MemoryStore.empty()
  const sessions = MemoryCourier.empty(ROOT)
  const digest = MemoryDigest.empty()
  const armed = { left: 1 }
  /** Once: the process dies here. */
  const dies = <A, E>(here: boolean, otherwise: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      if (!here || armed.left === 0) return otherwise
      armed.left -= 1
      return Effect.die("the process was killed here")
    })
  const store = Layer.effect(
    QuestionStore,
    Effect.gen(function* () {
      const inner = yield* QuestionStore
      // The close is the one write with q1 gone from the sheet.
      return QuestionStore.of({ ...inner, writeIf: (sessionID, sheet, rev) => dies(crash === "close" && !sheet.rows.some((row) => row.id === "q1"), inner.writeIf(sessionID, sheet, rev)) })
    }),
  ).pipe(Layer.provide(MemoryStore.layer(sheets)))
  const courier = Layer.effect(
    Courier,
    Effect.gen(function* () {
      const inner = yield* Courier
      return Courier.of({ ...inner, deliver: (sessionID: string, delivery: string, letter: Letter) => dies(crash === "letter", inner.deliver(sessionID, delivery, letter)) })
    }),
  ).pipe(Layer.provide(MemoryCourier.layer(sessions)))
  /** One run of the plugin: a fresh model over what outlives it. */
  const run = Model.layer.pipe(
    Layer.provide(MemoryDigest.writer(digest)),
    Layer.provide(store),
    Layer.provide(Layer.merge(MemoryCourier.layer(sessions), courier)),
    Layer.provide(Layer.succeed(Changes, Changes.of({ changed: () => Effect.void }))),
  )
  const letters = () => sessions.inboxes.get(ROOT) ?? []
  const answeredLines = Effect.map(Ref.get(digest.lines), (lines) => lines.filter((line) => line.includes('"_tag":"Answered"')))
  return { run, letters, answeredLines, sheets }
}

for (const crash of ["letter", "close"] as const)
  seeded(`an answer whose process is killed at its ${crash} is delivered exactly once after the restart, and its digest line written once`, ({ expect }) => {
    const { run, letters, answeredLines, sheets } = crashRig(crash)
    /** The first life: the question asked, then answered from the page, until the kill. */
    const killed = Effect.exit(
      Effect.gen(function* () {
        const model = yield* Model.QuestionsModel
        yield* model.ask(ROOT, { questions: [QUESTION] })
        yield* model.answer(ROOT, [{ id: "q1", answer: "3000" }], [], Option.none(), "page")
      }).pipe(Effect.provide(run)),
    )
    /** The second life: the server's start resends what its sheets hold undelivered (cmd/questions/server.ts), twice to be sure. */
    const restarted = Effect.gen(function* () {
      const model = yield* Model.QuestionsModel
      yield* model.resend
      yield* model.resend
    }).pipe(Effect.provide(run))
    return Effect.gen(function* () {
      expect(Exit.isFailure(yield* killed)).toBe(true)
      // Killed at the letter: none went. Killed at the close: it went, and the sheet still holds the answer.
      expect(letters()).toHaveLength(Number(crash === "close"))
      expect(sheets.sheets.get(ROOT)?.rows.map((row) => row.answered?.answer)).toEqual(["3000"])
      yield* restarted
      expect(letters().map((message) => message.letter.text.includes("3000"))).toEqual([true])
      expect(sheets.sheets.get(ROOT)?.rows).toEqual([])
      expect((yield* answeredLines).map((line) => line.includes('"via":"page"'))).toEqual([true])
    })
  })
