// The subscription's model rule: the GPT Sol models OpenCode lists for
// `openai`, newest first, each once, down to the fallback.
import { describe, expect, test } from "bun:test"
import { type Listed, solModels } from "./models.ts"
import { FALLBACK_MODEL } from "./request.ts"

const sol = (modelID: string, released: number, more: Partial<Listed> = {}): Listed => ({
  providerID: "openai",
  modelID,
  family: "gpt-sol",
  deprecated: false,
  released,
  ...more,
})

describe("the subscription's models", () => {
  test("run from the newest Sol down to the fallback, each model once, its variants folded in", () => {
    expect(solModels([sol("gpt-6-sol", 1), sol("gpt-6.1-sol", 2), sol("gpt-6.1-sol", 2), sol("gpt-5.6-sol", 0)])).toEqual(["gpt-6.1-sol", "gpt-6-sol"])
  })

  test("leave out another provider's, another family's, a deprecated one and a name that is no Sol", () => {
    expect(
      solModels([
        sol("gpt-8-sol", 9, { providerID: "other" }),
        sol("gpt-7-sol", 8, { deprecated: true }),
        sol("gpt-7-luna", 7, { family: "gpt-luna" }),
        sol("gpt-6.2-sol-fast", 6),
        sol("gpt-6.1-sol", 5),
      ]),
    ).toEqual(["gpt-6.1-sol", FALLBACK_MODEL])
  })

  test("are the fallback alone when OpenCode lists none", () => {
    expect(solModels([])).toEqual([FALLBACK_MODEL])
  })
})
