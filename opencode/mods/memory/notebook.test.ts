import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { GOTCHA_SENTENCE, SAVE_DESCRIPTION, SaveInput } from "./notebook.ts"

const decode = Schema.decodeUnknownSync(SaveInput)

describe("memory_save's description", () => {
  test("names the gotcha a session recovered from by itself as a fix worth saving, right after the fixes it widens", () => {
    // The round-5 eval's lever (notes/memory-eval.md): moving or dropping it is a measured change, not a wording one.
    expect(SAVE_DESCRIPTION).toContain(`a fix that took real effort and its cause. ${GOTCHA_SENTENCE} Save it when the user asks you`)
    expect(GOTCHA_SENTENCE).toContain("failed and worked only once you ran it another way")
    expect(SAVE_DESCRIPTION.split(GOTCHA_SENTENCE)).toHaveLength(2)
  })
})

describe("memory_save's input", () => {
  test("takes tags as a list", () => {
    expect(decode({ text: "a fact", tags: ["tests", "ci"] }).tags).toEqual(["tests", "ci"])
  })

  test("takes tags as one comma-separated string: split, trimmed, empties dropped", () => {
    expect(decode({ text: "a fact", tags: "tests, ci,, gate ," }).tags).toEqual(["tests", "ci", "gate"])
    expect(decode({ text: "a fact", tags: "tests" }).tags).toEqual(["tests"])
    expect(decode({ text: "a fact", tags: " , " }).tags).toEqual([])
  })

  test("still refuses tags of another type", () => {
    expect(() => decode({ text: "a fact", tags: 3 })).toThrow()
  })

  test("its JSON Schema offers both shapes", () => {
    const document = Schema.toJsonSchemaDocument(SaveInput)
    const tags = (document.schema as { properties: { tags: { anyOf?: ReadonlyArray<{ type?: string }> } } }).properties.tags
    expect(tags.anyOf?.map((member) => member.type)).toEqual(expect.arrayContaining(["array", "string"]))
  })
})
