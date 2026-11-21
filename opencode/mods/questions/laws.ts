// What every implementation of QuestionStore and Courier owes, as shared test
// suites. Each implementation's test beside it runs the suite over its Layer.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer, Option, type Scope } from "effect"
import { EMPTY, type Sheet } from "./question.ts"
import { letterOf, type Letter } from "./reply.ts"
import { Courier, QuestionStore } from "./service.ts"

const scenario = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

/** A store under test: its Layer, and a way to make one session's stored sheet unreadable. */
export interface StoreProbe {
  readonly layer: Layer.Layer<QuestionStore>
  readonly spoil: (sessionID: string) => Effect.Effect<void>
}

const ASKED = 1_700_000_000_000

const one: Sheet = {
  next: 2,
  rows: [{ id: "q1", sessionID: "ses_a", question: "Which port?", header: "Port", options: [{ label: "8080" }, { label: "3000", description: "the dev default" }], assume: "8080", askedAt: ASKED }],
}
const two: Sheet = {
  next: 3,
  rows: [
    { id: "q1", sessionID: "ses_a", question: "Which port?", assume: "8080", askedAt: ASKED, answered: { answer: "3000", delivery: "msg_a" } },
    { id: "q2", sessionID: "ses_a", question: "Keep the old flag?", assume: "yes", askedAt: ASKED + 1 },
    // Dismissed beside q1's answer, on its assumption: it rides in the same message, named as dismissed.
    { id: "q3", sessionID: "ses_a", question: "Log the change?", assume: "no", askedAt: ASKED + 2, answered: { answer: "no", delivery: "msg_a", dismissed: true } },
  ],
}

/** `make` gives an empty store within the test's scope. */
export const storeLaws = (name: string, make: Effect.Effect<StoreProbe, never, Scope.Scope>) =>
  describe(`${name} keeps the QuestionStore laws`, () => {
    const using = (probe: StoreProbe) => <A, E>(body: (store: QuestionStore["Service"]) => Effect.Effect<A, E>) =>
      QuestionStore.use(body).pipe(Effect.provide(probe.layer))

    test("a session with no sheet reads as empty, and no session is listed", () =>
      scenario(
        Effect.gen(function* () {
          const run = using(yield* make)
          expect(yield* run((store) => store.read("ses_none"))).toEqual(EMPTY)
          expect(yield* run((store) => store.sessions)).toEqual([])
        }),
      ))

    test("reads what was last written, per session, every field kept, at the next rev", () =>
      scenario(
        Effect.gen(function* () {
          const run = using(yield* make)
          expect(yield* run((store) => store.writeIf("ses_a", one, Option.none()))).toBe(true)
          expect(yield* run((store) => store.read("ses_a"))).toEqual({ ...one, rev: 1 })
          expect(yield* run((store) => store.writeIf("ses_a", two, Option.some(1)))).toBe(true)
          expect(yield* run((store) => store.read("ses_a"))).toEqual({ ...two, rev: 2 })
          expect(yield* run((store) => store.read("ses_b"))).toEqual(EMPTY)
        }),
      ))

    test("a write made at a rev no longer stored writes nothing and says so", () =>
      scenario(
        Effect.gen(function* () {
          const run = using(yield* make)
          yield* run((store) => store.writeIf("ses_a", one, Option.none()))
          // Another writer read none stored, or the sheet before its last write: both lost.
          expect(yield* run((store) => store.writeIf("ses_a", two, Option.none()))).toBe(false)
          expect(yield* run((store) => store.writeIf("ses_a", two, Option.some(0)))).toBe(false)
          expect(yield* run((store) => store.writeIf("ses_a", two, Option.some(2)))).toBe(false)
          expect(yield* run((store) => store.read("ses_a"))).toEqual({ ...one, rev: 1 })
          // None stored has no rev to match.
          expect(yield* run((store) => store.writeIf("ses_b", two, Option.some(0)))).toBe(false)
          expect(yield* run((store) => store.read("ses_b"))).toEqual(EMPTY)
        }),
      ))

    test("of two writers that read one rev, exactly one writes", () =>
      scenario(
        Effect.gen(function* () {
          const run = using(yield* make)
          yield* run((store) => store.writeIf("ses_a", one, Option.none()))
          const both = yield* Effect.all([run((store) => store.writeIf("ses_a", two, Option.some(1))), run((store) => store.writeIf("ses_a", one, Option.some(1)))], { concurrency: "unbounded" })
          expect(both.filter(Boolean)).toHaveLength(1)
          expect((yield* run((store) => store.read("ses_a"))).rev).toBe(2)
        }),
      ))

    test("lists the sessions that have a sheet", () =>
      scenario(
        Effect.gen(function* () {
          const run = using(yield* make)
          yield* run((store) => store.writeIf("ses_a", one, Option.none()))
          yield* run((store) => store.writeIf("ses_b", two, Option.none()))
          expect((yield* run((store) => store.sessions)).toSorted()).toEqual(["ses_a", "ses_b"])
        }),
      ))

    test("remove forgets a session's sheet, and removing none succeeds", () =>
      scenario(
        Effect.gen(function* () {
          const run = using(yield* make)
          yield* run((store) => store.writeIf("ses_a", one, Option.none()))
          yield* run((store) => store.remove("ses_a"))
          expect(yield* run((store) => store.read("ses_a"))).toEqual(EMPTY)
          expect(yield* run((store) => store.sessions)).toEqual([])
          yield* run((store) => store.remove("ses_a"))
          // Removed, it is absent again: a write at none stored lands.
          expect(yield* run((store) => store.writeIf("ses_a", two, Option.none()))).toBe(true)
        }),
      ))

    test("a sheet that cannot be read fails QuestionsUnreadable and says why", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const run = using(probe)
          yield* run((store) => store.writeIf("ses_a", one, Option.none()))
          yield* probe.spoil("ses_a")
          const failure = yield* run((store) => store.read("ses_a")).pipe(Effect.flip)
          expect(failure._tag).toBe("QuestionsUnreadable")
          expect(failure.message).not.toBe("")
        }),
      ))
  })

/** A message a session received: its id and what it carried. */
export interface Received {
  readonly id: string
  readonly letter: Letter
}

/** A courier under test: its Layer, a way to open a session, and what a session received. */
export interface CourierProbe {
  readonly layer: Layer.Layer<Courier>
  readonly open: (sessionID: string) => Effect.Effect<void>
  readonly received: (sessionID: string) => Effect.Effect<ReadonlyArray<Received>>
}

const letter = letterOf([{ question: { id: "q1", sessionID: "ses_a", question: "Which port?", header: "Port", assume: "8080", askedAt: ASKED }, answer: "3000" }])

/** `make` gives a courier with no sessions within the test's scope. */
export const courierLaws = (name: string, make: Effect.Effect<CourierProbe, never, Scope.Scope>) =>
  describe(`${name} keeps the Courier laws`, () => {
    const using = (probe: CourierProbe) => <A, E>(body: (courier: Courier["Service"]) => Effect.Effect<A, E>) =>
      Courier.use(body).pipe(Effect.provide(probe.layer))

    test("delivery ids are distinct message ids, each sorting after the one before", () =>
      scenario(
        Effect.gen(function* () {
          const run = using(yield* make)
          const ids = yield* Effect.forEach(Array.from({ length: 20 }), () => run((courier) => courier.newDelivery))
          expect(new Set(ids).size).toBe(ids.length)
          expect(ids.toSorted()).toEqual(ids)
          for (const id of ids) expect(id).toMatch(/^msg_/)
        }),
      ))

    test("delivers the letter into the session under its id, text, description and metadata kept", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const run = using(probe)
          yield* probe.open("ses_a")
          const id = yield* run((courier) => courier.newDelivery)
          yield* run((courier) => courier.deliver("ses_a", id, letter))
          expect(yield* probe.received("ses_a")).toEqual([{ id, letter }])
        }),
      ))

    test("delivering one id twice puts one message in the session", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const run = using(probe)
          yield* probe.open("ses_a")
          const id = yield* run((courier) => courier.newDelivery)
          yield* run((courier) => courier.deliver("ses_a", id, letter))
          yield* run((courier) => courier.deliver("ses_a", id, letter))
          expect(yield* probe.received("ses_a")).toEqual([{ id, letter }])
        }),
      ))

    test("a notice goes into the session under its id, once, and to a session that does not exist is refused as gone", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const run = using(probe)
          yield* probe.open("ses_a")
          const id = yield* run((courier) => courier.newDelivery)
          yield* run((courier) => courier.notify("ses_a", id, letter))
          yield* run((courier) => courier.notify("ses_a", id, letter))
          expect(yield* probe.received("ses_a")).toEqual([{ id, letter }])
          const failure = yield* run((courier) => courier.notify("ses_gone", id, letter)).pipe(Effect.flip)
          expect(failure.gone).toBe(true)
        }),
      ))

    test("a session that does not exist refuses with DeliveryRefused naming it, as gone", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const run = using(probe)
          const id = yield* run((courier) => courier.newDelivery)
          const failure = yield* run((courier) => courier.deliver("ses_gone", id, letter)).pipe(Effect.flip)
          expect(failure._tag).toBe("DeliveryRefused")
          expect(failure.sessionID).toBe("ses_gone")
          expect(failure.gone).toBe(true)
          expect(failure.message).not.toBe("")
        }),
      ))
  })
