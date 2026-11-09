import { describe, expect, test } from "bun:test"
import { modelLabel, modelName } from "./model.ts"

describe("modelName", () => {
  test.each([
    ["anthropic/claude-opus-5-5", "opus 5.5"],
    ["claude-opus-4-1-20250805", "opus 4.1"],
    ["claude-3-5-sonnet-20241022", "sonnet 3.5"],
    ["claude-sonnet-4-5", "sonnet 4.5"],
    ["claude-haiku-4-5:high", "haiku 4.5"],
    ["anthropic/claude-fable-5-2#high", "fable 5.2"],
    ["claude-fable-5", "fable 5"],
    ["openai/gpt-6.1-sol", "sol 6.1"],
    ["gpt-6.1-luna-max", "luna 6.1"],
    ["gpt-5.1-codex-max", "codex 5.1"],
    ["gpt-5-mini", "gpt 5"],
    ["gpt-sim-model", "gpt"],
    ["deepseek/deepseek-v3.2", "deepseek 3.2"],
    ["deepseek-reasoner", "deepseek"],
    ["gemini-2.5-pro", "gemini 2.5"],
    ["openrouter/qwen/qwen3-coder", "qwen3"],
    ["o3-mini", "o3"],
  ])("%s reads %s, never its provider or effort", (id, label) => {
    expect(modelLabel(modelName(id))).toBe(label)
  })

  test("the short label is the name alone", () => {
    expect(modelLabel(modelName("anthropic/claude-opus-5-5"), true)).toBe("opus")
    expect(modelLabel(modelName("gpt-6.1-sol"), true)).toBe("sol")
  })

  test("no id, no name", () => {
    expect(modelName(undefined)).toBeUndefined()
    expect(modelName("")).toBeUndefined()
    expect(modelLabel(undefined)).toBe("")
  })
})
