import { describe, expect, test } from "bun:test"
import { partOf, type AssistantMessage } from "./session.ts"
import { contextUsage, type Metered } from "./usage.ts"

const model = { providerID: "anthropic", id: "opus" }
const tokens = (input: number) => ({ input, output: 200, reasoning: 0, cache: { read: 800, write: 0 } })
const step = (id: string, input: number): Metered => ({ id, type: "assistant", model, tokens: tokens(input) })
const window = (known: number | undefined) => () => known

describe("contextUsage", () => {
  test("counts the newest step's tokens against its model's window", () => {
    expect(contextUsage([step("a", 100), step("b", 1000)], window(8000))).toEqual({ tokens: 2000, percent: 25 })
  })

  test("has no percent while the window is unknown", () => {
    expect(contextUsage([step("a", 1000)], window(undefined))).toEqual({ tokens: 2000, percent: undefined })
  })

  test("reads nothing before a completed compaction, and stops at the revert point", () => {
    const compacted: ReadonlyArray<Metered> = [step("a", 1000), { id: "c", type: "compaction", status: "completed" }]
    expect(contextUsage(compacted, window(8000))).toBeUndefined()
    const running: ReadonlyArray<Metered> = [step("a", 1000), { id: "c", type: "compaction", status: "running" }]
    expect(contextUsage(running, window(8000))?.tokens).toBe(2000)
    expect(contextUsage([step("a", 100), step("b", 1000)], window(8000), "b")).toEqual({ tokens: 1100, percent: 14 })
    expect(contextUsage([step("a", 100)], window(8000), "gone")).toBeUndefined()
  })

  test("is undefined until a step reports tokens", () => {
    expect(contextUsage([{ id: "a", type: "assistant", model }], window(8000))).toBeUndefined()
    expect(contextUsage([], window(8000))).toBeUndefined()
  })
})

describe("partOf", () => {
  const message: AssistantMessage = {
    id: "msg_1",
    type: "assistant",
    time: { created: 1 },
    content: [
      { type: "reasoning", text: "Weighing" },
      { type: "text", text: "First" },
      { type: "tool", id: "call_1", name: "shell", state: { status: "pending", input: {} }, time: { created: 1 } } as never,
      { type: "text", text: "Second" },
    ],
  }

  test("finds a tool call by its id, text and thoughts by ordinal", () => {
    expect(partOf(message, "call_1")).toMatchObject({ type: "tool", id: "call_1" })
    expect(partOf(message, "text:1")).toEqual({ type: "text", text: "Second" })
    expect(partOf(message, "reasoning:0")).toEqual({ type: "reasoning", text: "Weighing" })
  })

  test("finds nothing outside an assistant step or past its parts", () => {
    expect(partOf(message, "text:2")).toBeUndefined()
    expect(partOf(message, "nope")).toBeUndefined()
    expect(partOf(undefined, "text:0")).toBeUndefined()
    expect(partOf({ id: "u", type: "user", time: { created: 1 }, text: "hi" }, "text:0")).toBeUndefined()
  })
})
