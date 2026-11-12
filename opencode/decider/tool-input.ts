// A tool's input as a model sends it. Models send a number as a numeric string
// (`{ "id": "16" }`) and a list as a JSON-array string (`{ "tags": "[\"a\"]" }`)
// often enough that a plain struct refuses calls whose meaning is clear.
// `toolInput` wraps a tool's input struct: its JSON Schema (what the model sees)
// is the struct's own, and decoding first reads such a string as what its field
// takes, then decodes with the struct, so anything else fails as before.
//
// Number fields take `Schema.Finite` or `Schema.Int`, never `Schema.Number`: the
// JSON Schema of `Schema.Number` adds a string branch (`"Infinity"`, `"NaN"`) that
// invites the model to send numbers as strings.
import { Predicate, Schema, SchemaAST, SchemaParser, SchemaTransformation } from "effect"

const NUMERIC = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/** A member that takes no value: `undefined`, `null` or `void`. */
const isAbsent = (ast: SchemaAST.AST) => Predicate.isTagged(ast, "Undefined") || Predicate.isTagged(ast, "Null") || Predicate.isTagged(ast, "Void")

/** The members a field's encoded side takes, unions flattened, `undefined` and `null` dropped. */
const kindsOf = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> =>
  ast._tag === "Union"
    ? ast.types.flatMap(kindsOf)
    : isAbsent(ast)
      ? []
      : [ast]

const jsonArray = (text: string): ReadonlyArray<unknown> | undefined => {
  if (!text.startsWith("[")) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * A field's value read as what the field takes: a JSON-array string as the array
 * when the field takes an array, a numeric string as its number when the field
 * takes only a number. Any other value is left as it is, for the field to judge.
 */
export const coerceField = (field: SchemaAST.AST, value: unknown): unknown => {
  if (typeof value !== "string") return value
  const kinds = kindsOf(SchemaAST.toEncoded(field))
  const text = value.trim()
  if (kinds.some((kind) => kind._tag === "Arrays")) {
    const array = jsonArray(text)
    if (array !== undefined) return array
  }
  if (kinds.length > 0 && kinds.every((kind) => kind._tag === "Number") && NUMERIC.test(text)) return Number(text)
  return value
}

/** An input object with each field read by `coerceField`; anything not an object is left as it is. */
export const coerceInput = (fields: Schema.Struct.Fields, input: unknown): unknown => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input
  const record = input as Record<string, unknown>
  let changed: Record<string, unknown> | undefined
  for (const [key, field] of Object.entries(fields)) {
    if (!Object.hasOwn(record, key)) continue
    const value = coerceField(field.ast, record[key])
    if (value === record[key]) continue
    changed ??= { ...record }
    changed[key] = value
  }
  return changed ?? input
}

/** The type `toolInput` gives: the struct's own `Type` and `Encoded`. */
export interface toolInput<S extends Schema.Struct<Schema.Struct.Fields>>
  extends Schema.declareConstructor<S["Type"], S["Encoded"], readonly [S]> {
  readonly "Rebuild": toolInput<S>
}

/**
 * A tool's input that reads a numeric string as a number field's number and a
 * JSON-array string as an array field's array before it decodes with `struct`.
 * Its JSON Schema is `struct`'s, unchanged.
 */
export const toolInput = <S extends Schema.Struct<Schema.Struct.Fields>>(struct: S): toolInput<S> =>
  Schema.declareConstructor<S["Type"], S["Encoded"]>()(
    [struct],
    ([codec]) =>
      (input, _ast, options) =>
        SchemaParser.decodeUnknownEffect(codec)(coerceInput(struct.fields, input), options),
    {
      expected: "object",
      toCodecJson: () => Schema.link<S["Type"]>()(struct, SchemaTransformation.passthrough({ strict: false })),
    },
  ) as toolInput<S>
