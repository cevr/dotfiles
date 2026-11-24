import { expect } from "bun:test"
import { Effect } from "effect"

/**
 * Required outcome coverage belongs to explicit cases, not the random run.
 * Spell the domain out first: dropping a case or adding a new kind without
 * its case is a type error. Run each returned case through the same property
 * as the random inputs, and assert the named outcome on that case.
 */
export const witnesses = <const Kind extends string, const Cases extends Readonly<Record<NoInfer<Kind>, unknown>>>(
  kinds: ReadonlyArray<Kind>,
  cases: Cases,
): ReadonlyArray<readonly [Kind, Cases[Kind]]> => kinds.map((kind) => [kind, cases[kind]])

/** The returned name records a completed pair, not a planned or registered test. */
const compared = <A>(name: string, expected: A, observed: A, withoutCause: A) => {
  const label = `W: ${name}`
  expect(observed, label).toEqual(expected)
  expect(() => expect(withoutCause, label).toEqual(expected), `${label}: removing the cause must fail the same observation`).toThrow()
  return name
}

/** Both runs finish before comparison: a broken harness cannot count as a red control. */
export const assertWitness = <A>(name: string, expected: A, run: (cause: boolean) => A) =>
  compared(name, expected, run(true), run(false))

export const assertEffectWitness = <A, E, R>(name: string, expected: A, run: (cause: boolean) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const observed = yield* run(true)
    const withoutCause = yield* run(false)
    return compared(name, expected, observed, withoutCause)
  })
