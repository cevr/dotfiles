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
import { expect } from "bun:test"

/** Both runs finish before comparison: a broken harness cannot count as a red control. */
export const assertWitness = <A>(name: string, expected: A, observed: A, withoutCause: A) => {
  expect(observed, name).toEqual(expected)
  expect(() => expect(withoutCause, name).toEqual(expected), `${name}: removing the cause must fail the same observation`).toThrow()
}
