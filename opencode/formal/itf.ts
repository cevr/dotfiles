// The Informal Trace Format (ITF) that `quint run --out-itf` and `quint verify` write: a Quint set is
// `{ "#set": [...] }`, a map `{ "#map": [[key, value], ...] }`, an int `{ "#bigint": "3" }`, a record a plain
// object. A model's trace schema is built from these, so a trace decodes into typed values at the file's edge.
// https://apalache-mc.org/docs/adr/015adr-trace.html
import { Array as Arr, Order, Schema } from "effect"

/** A Quint set as ITF writes it. */
export const itfSet = <S extends Schema.Top>(item: S) => Schema.Struct({ "#set": Schema.Array(item) })

/** A Quint map with string keys as ITF writes it. */
export const itfMap = <S extends Schema.Top>(value: S) => Schema.Struct({ "#map": Schema.Array(Schema.Tuple([Schema.String, value])) })

/** A set of strings, sorted: Quint's sets have no order. */
export const sortedSet = (set: { readonly "#set": ReadonlyArray<string> }): ReadonlyArray<string> => Arr.sort(Arr.dedupe(set["#set"]), Order.String)

/** A map as a plain record. */
export const record = <V>(map: { readonly "#map": ReadonlyArray<readonly [string, V]> }): Readonly<Record<string, V>> => Object.fromEntries(map["#map"])
