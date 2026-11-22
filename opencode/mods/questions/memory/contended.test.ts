// Two copies of the questions model over one store, as OpenCode runs the plugin once per directory (or two servers
// share one database): each copy has its own lock, so only the store's write over the rev it read keeps one
// question from closing twice. Every read yields once it has read, so both answers read the same sheet before
// either writes. A store that writes blind (over whatever rev it finds now, as `write` did before `writeIf`) shows
// the race: two letters.
import * as MemoryDigest from "@dotfiles/opencode-digest/memory/log"
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Option, Ref } from "effect"
import * as MemoryCourier from "./courier.ts"
import * as MemoryStore from "./store.ts"
import * as Model from "../model.ts"
import { QuestionsModel } from "../model.ts"
import { NotOpen, type Via } from "../question.ts"
import { Changes, QuestionStore } from "../service.ts"

const port = { question: "Which port?", header: "Port", options: [{ label: "8080" }, { label: "3000" }], assume: "8080" }

/** The write a store makes: over the rev it was read at, or blind over the one stored now. */
type Write = "conditional" | "blind"

const contended = (mode: Write) => {
  const sheets = MemoryStore.empty()
  const sessions = MemoryCourier.empty("ses_a")
  const digest = MemoryDigest.empty()
  const store = Layer.effect(
    QuestionStore,
    Effect.gen(function* () {
      const inner = yield* QuestionStore
      const blind: QuestionStore["Service"]["writeIf"] = (sessionID, sheet) =>
        Effect.flatMap(Effect.orDie(inner.read(sessionID)), (now) => inner.writeIf(sessionID, sheet, Option.fromUndefinedOr(now.rev)))
      return QuestionStore.of({
        ...inner,
        read: (sessionID) => Effect.tap(inner.read(sessionID), () => Effect.yieldNow),
        writeIf: { blind, conditional: inner.writeIf }[mode],
      })
    }),
  ).pipe(Layer.provide(MemoryStore.layer(sheets)))
  // Each call builds its own copy of the model: its own lock, as another directory's or server's.
  const copy = () =>
    Model.layer.pipe(
      Layer.provide(MemoryDigest.writer(digest)),
      Layer.provide(store),
      Layer.provide(MemoryCourier.layer(sessions)),
      Layer.provide(Layer.succeed(Changes, Changes.of({ changed: () => Effect.void }))),
    )
  const run = <A, E>(body: (model: QuestionsModel["Service"]) => Effect.Effect<A, E>) => QuestionsModel.use(body).pipe(Effect.provide(copy()))
  const answer = (given: string, via: Via) => Effect.exit(run((model) => model.answer("ses_a", [{ id: "q1", answer: given }], [], Option.none(), via)))
  const race = Effect.gen(function* () {
    yield* run((model) => model.ask("ses_a", { questions: [port] }))
    const [tray, page] = yield* Effect.all([answer("8080", "tray"), answer("3000", "page")], { concurrency: "unbounded" })
    const letters = (sessions.inboxes.get("ses_a") ?? []).filter((message) => message.letter.text.includes("A: "))
    const answered = (yield* Ref.get(digest.lines)).filter((line) => line.includes('"Answered"'))
    return { tray, page, letters, answered }
  })
  return Effect.runPromise(race)
}

describe("two copies of the model over one store", () => {
  test("a store that writes blind lets both answers close the question: two letters (the race writeIf closes)", async () => {
    const { letters } = await contended("blind")
    expect(letters).toHaveLength(2)
  })

  test("both at once: exactly one closes it, with one letter and one Answered line naming where; the other is refused as not open", async () => {
    const { tray, page, letters, answered } = await contended("conditional")
    expect(letters).toHaveLength(1)
    expect(answered).toHaveLength(1)
    const outcomes = [tray, page]
    expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1)
    const refusals = outcomes.flatMap((outcome) => Exit.match(outcome, { onSuccess: () => [], onFailure: (cause) => [Cause.squash(cause)] }))
    expect(refusals).toEqual([new NotOpen({ id: "q1" })])
    const winner = Exit.match(tray, { onSuccess: () => "tray", onFailure: () => "page" })
    expect(answered[0]).toContain(`"via":"${winner}"`)
  })
})
