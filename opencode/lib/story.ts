// Stories: given events, when a command, then the events it records, its
// rejection, the aggregate's state or a view's. A story runs a Decider in
// memory and fails on any outcome it does not account for: an event no `then`
// asserts, or a rejection no `rejected` asserts.
//
//   const story = Story.make(Account)
//   it("refuses beyond the balance", () => Effect.runPromise(story(
//     Story.given(new Opened({ ... })),
//     Story.clock("2026-01-02T09:00:00Z"),
//     Story.when(new Withdraw({ amount: 100 })),
//     Story.rejected(new InsufficientFunds({ balance: 70, requested: 100 })),
//   )))
import { Data, Effect, Exit } from "effect"
import { fold, type Decider, type Fold } from "./decider.ts"

/** A story whose outcome differs from what its steps say. */
export class StoryFailed extends Data.TaggedError("StoryFailed")<{ readonly message: string }> {}

interface Given<E> {
  readonly _tag: "Given"
  readonly events: ReadonlyArray<E>
}
interface Clock {
  readonly _tag: "Clock"
  readonly now: number
}
interface When<C> {
  readonly _tag: "When"
  readonly command: C
}
interface Then<E> {
  readonly _tag: "Then"
  readonly events: ReadonlyArray<E>
}
interface Rejected<J> {
  readonly _tag: "Rejected"
  readonly rejection: J
}
interface State<S> {
  readonly _tag: "State"
  readonly state: S
}
interface View<E> {
  readonly _tag: "View"
  readonly check: (history: ReadonlyArray<E>) => string | undefined
}

export type Step<S, C, E, J> = Given<E> | Clock | When<C> | Then<E> | Rejected<J> | State<S> | View<E>

/** History the aggregate already has. It is asserted by being given. */
export const given = <E>(...events: ReadonlyArray<E>): Given<E> => ({ _tag: "Given", events })

/** The time the next commands are decided at: epoch ms or an ISO 8601 string. */
export const clock = (at: number | string): Clock => ({ _tag: "Clock", now: typeof at === "number" ? at : Date.parse(at) })

/** Decide a command against the history so far, at the story's clock. */
export const when = <C>(command: C): When<C> => ({ _tag: "When", command })

/** The events recorded since the last `then` or `given`, exactly; none asserts that nothing was recorded. */
export const then = <E>(...events: ReadonlyArray<E>): Then<E> => ({ _tag: "Then", events })

/** The last command's rejection. */
export const rejected = <J>(rejection: J): Rejected<J> => ({ _tag: "Rejected", rejection })

/** The aggregate's state after the history so far. */
export const state = <S>(expected: S): State<S> => ({ _tag: "State", state: expected })

/** A view's state after the history so far. */
export const view = <V, E>(model: Fold<V, E>, expected: V): View<E> => ({
  _tag: "View",
  check: (history) => {
    const actual = fold(model, history)
    return same(actual, expected) ? undefined : `view: expected ${show(expected)}, got ${show(actual)}`
  },
})

/** The story runner for one aggregate: run its steps in order, then check nothing went unasserted. */
export const make =
  <S, C, E, J>(decider: Decider<S, C, E, J>) =>
  (...steps: Array<Step<S, C, E, J>>): Effect.Effect<void, StoryFailed> =>
    Effect.gen(function* () {
      const history: E[] = []
      let pending: E[] = []
      let rejection: { readonly value: J } | undefined
      let now = 0
      const fail = (message: string) => Effect.fail(new StoryFailed({ message }))
      for (const step of steps) {
        switch (step._tag) {
          case "Given":
            history.push(...step.events)
            break
          case "Clock":
            if (!Number.isFinite(step.now)) return yield* fail("clock: not a time")
            if (step.now < now) return yield* fail(`clock: ${step.now} is before ${now}`)
            now = step.now
            break
          case "When": {
            if (rejection) return yield* fail(`when: the last rejection is unasserted: ${show(rejection.value)}`)
            const exit = yield* Effect.exit(decider.decide(fold(decider, history), step.command, now))
            if (Exit.isSuccess(exit)) {
              history.push(...exit.value)
              pending.push(...exit.value)
            } else {
              const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
              if (failure === undefined) return yield* Effect.die(exit.cause)
              rejection = { value: failure.error }
            }
            break
          }
          case "Then":
            if (!same(pending, step.events)) return yield* fail(`then: expected ${show(step.events)}, got ${show(pending)}`)
            pending = []
            break
          case "Rejected":
            if (!rejection) return yield* fail(`rejected: expected ${show(step.rejection)}, but the command was not rejected`)
            if (!same(rejection.value, step.rejection))
              return yield* fail(`rejected: expected ${show(step.rejection)}, got ${show(rejection.value)}`)
            rejection = undefined
            break
          case "State": {
            const actual = fold(decider, history)
            if (!same(actual, step.state)) return yield* fail(`state: expected ${show(step.state)}, got ${show(actual)}`)
            break
          }
          case "View": {
            const mismatch = step.check(history)
            if (mismatch !== undefined) return yield* fail(mismatch)
            break
          }
        }
      }
      if (pending.length > 0) return yield* fail(`unasserted events: ${show(pending)}`)
      if (rejection) return yield* fail(`unasserted rejection: ${show(rejection.value)}`)
    })

/** Structural equality over own enumerable keys, with the same prototype (so a rejection's class counts). */
export const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && same(left[key], right[key]))
}

const show = (value: unknown) => JSON.stringify(value, (_, item) => (item === undefined ? "<undefined>" : item))
