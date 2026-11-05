// The journal of a kernel call: what it records of each tool call a cell
// makes, what it publishes while the call runs, and its bounds.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { journal, MAX_INPUT_CHARS, MAX_OPERATIONS, OPERATIONS_KEY, type Operation } from "./operations.ts"

const recording = () => {
  const published: Array<ReadonlyArray<Operation>> = []
  const record = journal((metadata) =>
    Effect.sync(() => {
      published.push((metadata[OPERATIONS_KEY] as ReadonlyArray<Operation> | undefined) ?? [])
    }),
  )
  return { record, published }
}

describe("a kernel call's journal", () => {
  test("records each call as it starts and as it ends, with its input, output head and metadata", async () => {
    const { record, published } = recording()
    await Effect.runPromise(
      record.around("shell", { command: "git status", timeout: 5, nested: { no: 1 } }, Effect.succeed({ content: [{ type: "text", text: "clean" }], metadata: { exit: 0, secret: "x" } })),
    )
    expect(published).toEqual([
      [{ tool: "shell", status: "running", input: { command: "git status", timeout: 5 } }],
      [{ tool: "shell", status: "completed", input: { command: "git status", timeout: 5 }, output: "clean", metadata: { exit: 0 } }],
    ])
    expect(record.metadata()).toEqual({ [OPERATIONS_KEY]: published[1] })
  })

  test("a shell command moved to the background keeps its shell's ID, which its stop notice names", async () => {
    const { record } = recording()
    await Effect.runPromise(
      record.around("shell", { command: "sleep 2", background: true }, Effect.succeed({ content: "moved", metadata: { status: "running", shellID: "sh_1", truncated: false } })),
    )
    expect(record.metadata()[OPERATIONS_KEY]).toEqual([
      { tool: "shell", status: "completed", input: { command: "sleep 2", background: true }, output: "moved", metadata: { shellID: "sh_1" } },
    ])
  })

  test("a shell command the host moved to the background by its time limit keeps that, which its row says", async () => {
    const { record } = recording()
    await Effect.runPromise(
      record.around("shell", { command: "sleep 600" }, Effect.succeed({ content: "still running", metadata: { status: "running", shellID: "sh_2", backgrounded: "limit", truncated: false } })),
    )
    expect((record.metadata()[OPERATIONS_KEY] as ReadonlyArray<Operation>)[0]?.metadata).toEqual({ shellID: "sh_2", backgrounded: "limit" })
  })

  test("a latched subagent keeps its child and its latched status, which its row reads; a running one keeps only its child", async () => {
    const { record } = recording()
    await Effect.runPromise(record.around("subagent", { agent: "worker" }, Effect.succeed({ content: "latched", metadata: { sessionID: "ses_l", status: "latched", latch: { id: "w1" } } })))
    await Effect.runPromise(record.around("subagent", { agent: "worker" }, Effect.succeed({ content: "started", metadata: { sessionID: "ses_r", status: "running" } })))
    expect((record.metadata()[OPERATIONS_KEY] as ReadonlyArray<Operation>).map((operation) => operation.metadata)).toEqual([
      { sessionID: "ses_l", status: "latched" },
      { sessionID: "ses_r" },
    ])
  })

  test("a failed call is recorded with its reason and still fails the cell's call", async () => {
    const { record } = recording()
    const exit = await Effect.runPromiseExit(record.around("read", { path: "missing.ts" }, Effect.fail(new Error("File not found: missing.ts"))))
    expect(exit._tag).toBe("Failure")
    expect(record.metadata()[OPERATIONS_KEY]).toEqual([
      { tool: "read", status: "error", input: { path: "missing.ts" }, error: "File not found: missing.ts" },
    ])
  })

  test("a cell that calls no tool leaves no metadata", () => {
    expect(recording().record.metadata()).toEqual({})
  })

  test("nothing is published once the call has ended, though the record still changes", async () => {
    const { record, published } = recording()
    await Effect.runPromise(record.close)
    await Effect.runPromise(record.around("shell", { command: "late" }, Effect.succeed({})))
    expect(published).toEqual([])
    expect(record.metadata()[OPERATIONS_KEY]).toHaveLength(1)
  })

  test("long inputs are cut and calls past the cap are counted, not kept", async () => {
    const { record } = recording()
    for (let index = 0; index < MAX_OPERATIONS + 3; index++)
      await Effect.runPromise(record.around("shell", { command: "x".repeat(MAX_INPUT_CHARS * 2) }, Effect.succeed({})))
    const metadata = record.metadata()
    const operations = metadata[OPERATIONS_KEY] as ReadonlyArray<Operation>
    expect(operations).toHaveLength(MAX_OPERATIONS)
    expect(metadata.dropped).toBe(3)
    expect(String(operations[0]!.input.command)).toHaveLength(MAX_INPUT_CHARS + 1)
  })
})
