// What a subagent is doing, in a few words.
import { describe, expect, test } from "bun:test"
import { activity, firstSentence, lastHeard, runningUpdate, waiting } from "./activity.ts"
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
    expect(activity(call("shell", { command: "bun test\nbun lint" }, "running"))).toBe("running bun test …")
  })

  test("a shell call reads as its own description, a wait as what it waits on, never its whole one-liner", () => {
    const gate = "cd /w/effra && flock /home/x/.cache/gate.lock ./scripts/gate.sh"
    expect(activity(call("bash", { command: gate, description: "Run the gate under the lock" }, "running"))).toBe("Run the gate under the lock")
    expect(activity(call("bash", { command: gate }, "running"))).toBe("running flock gate.lock ./scripts/gate.sh")
    expect(activity(call("bash", { command: "for i in 1 2; do [ -s $D/gate.log ] && break; sleep 30; done" }, "running"))).toBe("polling gate.log")
  })

  test("a queue call reads as the item it says runs or waits", () => {
    expect(activity(call("queue", { upsert: [{ id: "a", text: "Gate queued behind pkg-lower's lock.", state: "waiting" }] }))).toBe(
      "Gate queued behind pkg-lower's lock.",
    )
  })

  test("a tool with no verb reads as its name and its fields", () => {
    expect(activity(call("todo", { item: "x", done: false }))).toBe("todo item=x, done=false")
  })

  test("a kernel cell reads as its description, else the tool it runs now", () => {
    const running = call("shell", { command: "sleep 600" }, "running")
    expect(activity({ ...call("kernel", { code: "x", description: "Wait out the gate" }, "running"), calls: [running] })).toBe("Wait out the gate")
    expect(activity({ ...call("kernel", { code: "x" }, "running"), calls: [call("read", { path: "a.ts" }), running] })).toBe("sleep 600")
  })

  test("a kernel cell reads as its first line, a leading comment's words when it opens with one", () => {
    expect(activity(call("kernel", { code: "\n// run the CSV tests\nawait tools.shell({})" }, "running"))).toBe("kernel: run the CSV tests")
    expect(activity(call("kernel", { code: "const x = 1" }, "running"))).toBe("kernel: const x = 1")
  })
})

describe("whether a running call only waits", () => {
  test("a sleep or poll loop, or a description that says wait, waits; work and ended calls do not", () => {
    expect(waiting(call("bash", { command: "sleep 30" }, "running"))).toBe(true)
    expect(waiting(call("bash", { command: "bun test", description: "Wait for the tests" }, "running"))).toBe(true)
    expect(waiting(call("bash", { command: "bun test" }, "running"))).toBe(false)
    expect(waiting(call("bash", { command: "sleep 30" }))).toBe(false)
    expect(waiting(call("read", { path: "sleep" }, "running"))).toBe(false)
  })

  test("a kernel cell waits while the tool it runs now waits", () => {
    const cell = (inner: Call) => ({ ...call("kernel", { code: "x" }, "running"), calls: [inner] })
    expect(waiting(cell(call("shell", { command: "sleep 30" }, "running")))).toBe(true)
    expect(waiting(cell(call("shell", { command: "bun test" }, "running")))).toBe(false)
  })
})

describe("the update while it runs", () => {
  test("a sentence written after the running call started wins over it", () => {
    expect(runningUpdate([step(call("bash", { command: "sleep 30" }, "running"), words("Gate is queued on the lock."))])).toBe(
      "Gate is queued on the lock.",
    )
    expect(runningUpdate([step(words("Queue the gate."), call("bash", { command: "sleep 30" }, "running"))])).toBe("sleep 30")
  })

  test("its latest queue item counts as a sentence, from a kernel cell too", () => {
    const queue = call("queue", { upsert: [{ id: "g", text: "Waiting on the shared gate lock", state: "waiting" }] })
    expect(runningUpdate([step(words("Old thought."), queue)])).toBe("Waiting on the shared gate lock")
    expect(runningUpdate([step(words("Old thought."), { ...call("kernel", { code: "x" }), calls: [queue] })])).toBe("Waiting on the shared gate lock")
  })

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

  test("when it was last heard from: the newest time among its words and calls", () => {
    expect(lastHeard([step({ type: "words", text: "a", at: 5 }, { ...call("bash", { command: "ls" }), started: 7, completed: 9 }), step({ type: "words", text: "b", at: 8 })])).toBe(9)
    expect(lastHeard([step(words("no time"))])).toBeUndefined()
  })

  test("a first sentence ends at a stop that ends a word, not inside a name", () => {
    expect(firstSentence("Editing src/money.ts now. Then tests.")).toBe("Editing src/money.ts now.")
    expect(firstSentence("no stop here")).toBe("no stop here")
  })
})
