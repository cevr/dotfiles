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
