// What a subagent is doing, in a few words.
import { describe, expect, test } from "bun:test"
import { activity, firstSentence, runningUpdate } from "./activity.ts"
import type { Call, Message, Part } from "./family.ts"

const call = (tool: string, input: Record<string, unknown>, status: Call["status"] = "completed"): Call => ({
  type: "call",
  tool,
  status,
  input,
  metadata: {},
})
const words = (text: string): Part => ({ type: "words", text })
const step = (...parts: Part[]): Message => ({ type: "assistant", parts })

describe("a call's activity", () => {
  test("its verb in the tense of its status, and its subject, as the transcript row says it", () => {
    expect(activity(call("bash", { command: "bun test money" }, "running"))).toBe("running bun test money")
    expect(activity(call("bash", { command: "ls" }))).toBe("ran ls")
    expect(activity(call("apply_patch", { patchText: "*** Update File: src/money.ts\n+x" }, "running"))).toBe("editing src/money.ts")
    expect(activity(call("read", { filePath: "src/csv.ts" }, "running"))).toBe("reading src/csv.ts")
    expect(activity(call("grep", { pattern: "parse", path: "src" }, "running"))).toBe("searching /parse/ in src")
    expect(activity(call("task", { description: "Check CSV" }, "running"))).toBe("running Check CSV")
    expect(activity(call("shell", { command: "bun test\nbun lint" }, "running"))).toBe("running bun test…")
  })

  test("a tool with no verb reads as its name and its fields", () => {
    expect(activity(call("todo", { item: "x", done: false }))).toBe("todo item=x, done=false")
  })

  test("a kernel cell reads as its first line, a leading comment's words when it opens with one", () => {
    expect(activity(call("kernel", { code: "\n// run the CSV tests\nawait tools.shell({})" }, "running"))).toBe("kernel: run the CSV tests")
    expect(activity(call("kernel", { code: "const x = 1" }, "running"))).toBe("kernel: const x = 1")
  })
})

describe("the update while it runs", () => {
  test("is the newest step's running call, the latest when several run", () => {
    expect(runningUpdate([step(words("Looking."), call("bash", { command: "a" }, "running"), call("bash", { command: "b" }, "running"))])).toBe(
      "running b",
    )
  })

  test("with no call running, the first sentence of the latest words", () => {
    expect(runningUpdate([step(words("Check the parser first. Then the tests."))])).toBe("Check the parser first.")
    expect(
      runningUpdate([
        step(words("Old thought."), call("bash", { command: "ls" })),
        step(words("Looking at\nthe money parser!  Next")),
        step(words("[REDACTED]")),
      ]),
    ).toBe("Looking at the money parser!")
  })

  test("with no words yet, the latest ended call; with nothing, starting", () => {
    expect(runningUpdate([step(call("bash", { command: "ls" }))])).toBe("ran ls")
    expect(runningUpdate([])).toBe("starting")
  })

  test("a first sentence ends at a stop that ends a word, not inside a name", () => {
    expect(firstSentence("Editing src/money.ts now. Then tests.")).toBe("Editing src/money.ts now.")
    expect(firstSentence("no stop here")).toBe("no stop here")
  })
})
