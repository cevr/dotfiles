// Whether two readings of a value say the same, built field by field from a
// record that must name every field of the type: a field added to the type
// fails typecheck until it is given its comparison, so a kept memo never keeps
// a reading that differs in a field nobody listed (solid/reader.ts's
// `sameSession`, line.ts's `sameSegments`).

/** Whether two readings say the same. */
export type Same<A> = (a: A, b: A) => boolean

/** One comparison per field of `T`, an optional field included: none can be left out. */
export type Fields<T> = { readonly [K in keyof Required<T>]: Same<T[K]> }

/** `T` the same while each of its fields is, by that field's comparison in `each`. */
export function fields<T>(each: Fields<T>): Same<T> {
  return (a, b) => {
    if (a === b) return true
    for (const key in each) if (!each[key](a[key], b[key])) return false
    return true
  }
}

/** The same value, by `===`. */
export const is =
  <A>(): Same<A> =>
  (a, b) =>
    a === b

/** Two lists the same while they are as long and each item is the same as the one at its place. */
export const list =
  <A>(item: Same<A>): Same<ReadonlyArray<A>> =>
  (a, b) =>
    a === b || (a.length === b.length && a.every((value, index) => item(value, b[index])))

type Leaf = string | number | boolean

/**
 * Every field of `T` a reading can differ in, as a path (`time.idle`,
 * `shells[].command`), down through its objects and lists, for a test that
 * changes each one: a field added to `T` adds its path, and a record keyed by
 * `Paths<T>` fails typecheck until it changes that field too. A field named in
 * `Opaque` is one path, not opened (a list compared by identity).
 */
export type Paths<T, Opaque extends string = never, Prefix extends string = ""> = {
  readonly [K in keyof T & string]-?: K extends Opaque ? `${Prefix}${K}` : Path<NonNullable<T[K]>, Opaque, `${Prefix}${K}`>
}[keyof T & string]
type Path<V, Opaque extends string, At extends string> = V extends Leaf
  ? At
  : V extends ReadonlyArray<infer Item>
    ? At | (Item extends Leaf ? never : Paths<Item, Opaque, `${At}[].`>)
    : At | Paths<V, Opaque, `${At}.`>
