// A tool input reads a model's numeric string as a number field's number and a
// JSON-array string as an array field's array, rejects anything else as the
// plain struct does, and shows the model exactly the plain struct's JSON Schema.
import { describe, expect, test } from "bun:test"
import { Schema, SchemaGetter } from "effect"
import { toolInput } from "./tool-input.ts"

const Tags = Schema.Union([
  Schema.Array(Schema.String),
  Schema.String.pipe(
    Schema.decodeTo(Schema.Array(Schema.String), {
      decode: SchemaGetter.transform((text: string) => text.split(",").map((tag) => tag.trim())),
      encode: SchemaGetter.transform((tags: ReadonlyArray<string>) => tags.join(", ")),
    }),
  ),
])

const Plain = Schema.Struct({
  id: Schema.Int.annotate({ description: "The note's id" }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 }))),
  seconds: Schema.optional(Schema.Finite),
  tags: Schema.optional(Tags),
  ids: Schema.optional(Schema.Array(Schema.String)),
  name: Schema.optional(Schema.String),
  target: Schema.optional(Schema.Union([Schema.Int, Schema.String])),
})
const Input = toolInput(Plain)
const decode = Schema.decodeUnknownSync(Input)
const failure = (input: unknown): string => {
  try {
    decode(input)
  } catch (error) {
    return (error as Error).message
  }
  throw new Error(`decoded ${JSON.stringify(input)}`)
}
const jsonSchema = (schema: Schema.Top) => Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })

describe("toolInput", () => {
  test("a numeric string in a number field decodes as its number", () => {
    expect(decode({ id: "16" })).toEqual({ id: 16 })
    expect(decode({ id: 16, limit: " 5 ", seconds: "1.5" })).toEqual({ id: 16, limit: 5, seconds: 1.5 })
  })

  test("a JSON-array string in an array field decodes as its array", () => {
    expect(decode({ id: 1, tags: '["preferences","reports"]' })).toEqual({ id: 1, tags: ["preferences", "reports"] })
    expect(decode({ id: 1, ids: '["a", "b"]' })).toEqual({ id: 1, ids: ["a", "b"] })
  })

  test("values already of the field's type decode as before", () => {
    expect(decode({ id: 1, tags: "tests, ci", name: "16", target: "16" })).toEqual({ id: 1, tags: ["tests", "ci"], name: "16", target: "16" })
    expect(decode({ id: 1, tags: ["a"], ids: [] })).toEqual({ id: 1, tags: ["a"], ids: [] })
  })

  test("anything else is refused with the struct's own message", () => {
    expect(failure({ id: "sixteen" })).toBe('Expected number\n  at ["id"]')
    expect(failure({ id: "" })).toBe('Expected number\n  at ["id"]')
    expect(failure({ id: "Infinity" })).toBe('Expected number\n  at ["id"]')
    expect(failure({ id: "1.5" })).toBe('Expected an integer\n  at ["id"]')
    expect(failure({ id: 1, limit: "99" })).toBe('Expected a value between 1 and 25\n  at ["limit"]')
    expect(failure({ id: 1, ids: '["a", 2]' })).toBe('Expected string\n  at ["ids"][1]')
    expect(failure({ id: 1, ids: "a,b" })).toBe('Expected array | undefined\n  at ["ids"]')
    expect(failure("16")).toBe('Expected object')
  })

  test("its JSON Schema is the plain struct's, with no string branch for a number", () => {
    expect(jsonSchema(Input)).toEqual(jsonSchema(Plain))
    const text = JSON.stringify(jsonSchema(Input))
    expect(text).not.toContain("Infinity")
    expect(jsonSchema(Input).schema).toMatchObject({ properties: { id: { type: "integer", description: "The note's id" }, seconds: { anyOf: [{ type: "number" }, { type: "null" }] } } })
    expect(JSON.stringify(jsonSchema(Input))).toBe(JSON.stringify(jsonSchema(Input)))
  })
})
