// /answer over a stand-in host: the one form it opens in the session on
// screen, holding that session's questions and its subagents' as the server
// reads them at that moment; a second open while one is under way or shows
// makes nothing; a form whose questions all closed is cancelled, never shown.
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Random } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import type { FormInput } from "../form.ts"
import type { Question } from "../question.ts"
import { FormRefused, type FormHost, opener, type PendingForm, QuestionsUnread } from "./form.ts"

const TIMEOUT_MS = 10_000

const asked = (sessionID: string, id: string, askedAt: number): Question => ({ id, sessionID, question: `${sessionID} ${id}?`, assume: "no", askedAt })

interface Options {
  readonly open?: ReadonlyArray<Question>
  readonly unreadable?: boolean
  readonly failing?: boolean
  /** Each create waits until the test lets it through (`release`): a server too slow to answer before the next click. */
  readonly hold?: boolean
  readonly listed?: ReadonlyArray<PendingForm>
}

/** A stand-in host: `state.open` is what the server reads now; a made form is listed once `refresh` runs, as the TUI lists it after its read. */
const host = (options: Options) =>
  Effect.gen(function* () {
    const state = { open: options.open ?? [] }
    const made: Array<readonly [string, FormInput]> = []
    const listed: Array<PendingForm> = [...(options.listed ?? [])]
    const unlisted: Array<PendingForm> = []
    const cancelled: Array<string> = []
    const gate = { now: yield* Deferred.make<void>() }
    const view: FormHost = {
      pending: () => listed,
      read: (sessionID) => Effect.suspend(() => (options.unreadable === true ? Effect.fail(new QuestionsUnread({ sessionID })) : Effect.succeed(state.open))),
      create: (sessionID, input) =>
        Effect.gen(function* () {
          if (options.hold === true) yield* Deferred.await(gate.now)
          if (options.failing === true) return yield* new FormRefused({ sessionID })
          made.push([sessionID, input])
          unlisted.push({ id: `frm_${made.length}`, fields: input.fields })
        }),
      refresh: () => Effect.sync(() => void listed.push(...unlisted.splice(0))),
      cancel: (_sessionID, formID) =>
        Effect.sync(() => {
          cancelled.push(formID)
          listed.splice(0, listed.length, ...listed.filter((form) => form.id !== formID))
        }),
      asker: (sessionID) => (sessionID === "ses_child" ? "implementor auth r1" : sessionID),
    }
    /** Lets every held create through, and holds the next ones. */
    const release = Effect.gen(function* () {
      yield* Deferred.complete(gate.now, Effect.void)
      gate.now = yield* Deferred.make<void>()
    })
    /** The owner submits the form on screen: its questions close, and it leaves the list. */
    const submit = Effect.sync(() => {
      const keys = new Set(listed.splice(0, 1).flatMap((form) => form.fields.map((field) => field.key)))
      state.open = state.open.filter((question) => ![...keys].some((key) => key.endsWith(`:${question.id}`)))
      return keys
    })
    return { view, made, listed, cancelled, state, release, submit }
  })

const keys = (made: ReadonlyArray<readonly [string, FormInput]>) => made.map(([sessionID, input]) => [sessionID, input.fields.map((field) => field.key)])

describe("opening the questions form", () => {
  effectTest(
    "one form in the session on screen: its own questions first, then its subagents', each naming who asked",
    Effect.gen(function* () {
      const stand = yield* host({ open: [asked("ses_child", "q1", 1), asked("ses_root", "q2", 3), asked("ses_root", "q1", 2)] })
      expect(yield* opener(stand.view).open("ses_root")).toBe("opened")
      expect(stand.made.map(([sessionID, input]) => [sessionID, input.fields.map((field) => [field.key, field.description])])).toEqual([
        [
          "ses_root",
          [
            ["ask_user_async:q1", "ses_root q1?"],
            ["ask_user_async:q2", "ses_root q2?"],
            ["ask_user_async:ses_child:q1", "implementor auth r1 asks: ses_child q1?"],
          ],
        ],
      ])
    }),
    TIMEOUT_MS,
  )

  effectTest(
    "opens again while the first is under way (a slow server) make no second form, and once it shows neither does one more",
    Effect.gen(function* () {
      const stand = yield* host({ open: [asked("ses_root", "q1", 1)], hold: true })
      const forms = opener(stand.view)
      const first = yield* Effect.forkChild(forms.open("ses_root"))
      yield* Effect.yieldNow
      expect(yield* Effect.all([forms.open("ses_root"), forms.open("ses_root")])).toEqual(["already", "already"])
      yield* stand.release
      expect(yield* Fiber.join(first)).toBe("opened")
      expect(yield* forms.open("ses_root")).toBe("already")
      expect(keys(stand.made)).toEqual([["ses_root", ["ask_user_async:q1"]]])
    }),
    TIMEOUT_MS,
  )

  effectTest(
    "the form holds the questions open now, not those the caller last saw; with none open nothing opens",
    Effect.gen(function* () {
      const stand = yield* host({ open: [asked("ses_root", "q2", 2)] })
      expect(yield* opener(stand.view).open("ses_root")).toBe("opened")
      expect(keys(stand.made)).toEqual([["ses_root", ["ask_user_async:q2"]]])
      const none = yield* host({ open: [] })
      expect(yield* opener(none.view).open("ses_root")).toBe("none")
      expect(none.made).toEqual([])
    }),
    TIMEOUT_MS,
  )

  effectTest(
    "questions that cannot be read open nothing; a form the host refuses is named",
    Effect.gen(function* () {
      const unreadable = yield* host({ open: [asked("ses_root", "q1", 1)], unreadable: true })
      expect(yield* opener(unreadable.view).open("ses_root")).toBe("unread")
      expect(unreadable.made).toEqual([])
      const failing = yield* host({ open: [asked("ses_root", "q1", 1)], failing: true })
      expect(yield* opener(failing.view).open("ses_root")).toBe("failed")
    }),
    TIMEOUT_MS,
  )

  effectTest(
    "another form is not ours; one of ours whose questions all closed is cancelled and the questions open now get a form; a live one is only found",
    Effect.gen(function* () {
      const other = yield* host({ open: [asked("ses_root", "q1", 1)], listed: [{ id: "frm_tool", fields: [{ key: "q0" }] }] })
      expect(yield* opener(other.view).open("ses_root")).toBe("opened")
      const stale = yield* host({ open: [asked("ses_root", "q2", 2)], listed: [{ id: "frm_old", fields: [{ key: "ask_user_async:q1" }] }] })
      expect(yield* opener(stale.view).open("ses_root")).toBe("opened")
      expect(stale.cancelled).toEqual(["frm_old"])
      expect(keys(stale.made)).toEqual([["ses_root", ["ask_user_async:q2"]]])
      const gone = yield* host({ open: [], listed: [{ id: "frm_old", fields: [{ key: "ask_user_async:q1" }] }] })
      expect(yield* opener(gone.view).open("ses_root")).toBe("none")
      expect(gone.listed).toEqual([])
      const live = yield* host({ open: [asked("ses_root", "q1", 1)], listed: [{ id: "frm_live", fields: [{ key: "ask_user_async:q1" }] }] })
      expect(yield* opener(live.view).open("ses_root")).toBe("already")
      expect(live.cancelled).toEqual([])
    }),
    TIMEOUT_MS,
  )

  /** One generated run: opens (clicks), slow creates let through and submits, in a seeded order. */
  const run = (seed: number) =>
    Effect.gen(function* () {
      const stand = yield* host({ open: [asked("ses_root", "q1", 1), asked("ses_root", "q2", 2), asked("ses_child", "q3", 3)], hold: true })
      const answered = new Set<string>()
      // Each form as it is asked for: a key in it already answered then is a question shown again.
      const shownAgain: Array<string> = []
      const forms = opener({
        ...stand.view,
        create: (sessionID, input) =>
          Effect.suspend(() => {
            shownAgain.push(...input.fields.map((field) => field.key).filter((key) => answered.has(key)))
            return stand.view.create(sessionID, input)
          }),
      })
      const most = { pending: 0 }
      for (let step = 0; step < 12; step++) {
        const roll = yield* Random.next
        if (roll < 0.5) yield* Effect.forkChild(forms.open("ses_root"))
        else if (roll < 0.75) yield* stand.release
        else for (const key of yield* stand.submit) answered.add(key)
        yield* Effect.yieldNow
        most.pending = Math.max(most.pending, stand.listed.length)
      }
      yield* stand.release
      return { seed, most: most.pending, shownAgain }
    }).pipe(Effect.scoped, Random.withSeed(`questions-open:${seed}`))

  effectTest(
    "over generated runs of opens, slow creates and submits, at most one form of ours is ever pending, and none holds a question already answered",
    Effect.gen(function* () {
      const runs = yield* Effect.forEach(Array.from({ length: 200 }, (_, seed) => seed), run)
      expect(runs.filter((each) => each.most > 1 || each.shownAgain.length > 0)).toEqual([])
      // Not vacuous: forms were shown.
      expect(runs.some((each) => each.most === 1)).toBe(true)
    }),
    TIMEOUT_MS,
  )
})
