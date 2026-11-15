// The journal of a kernel call: what it records of each tool call a cell
// makes, what it publishes while the call runs, and its bounds.
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { CONCURRENCY_KEY, concurrencyOf, journal, MAX_INPUT_CHARS, MAX_OPERATIONS, OPERATIONS_KEY, type Operation } from "./operations.ts"

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

  test("a shell handle keeps its ID, which tells the row to drop the handle's header line", async () => {
    const { record } = recording()
    const metadata = { id: "sh_3", state: "exited", exitCode: 0, runtimeMs: 12, next: 3, truncated: false, status: "completed", exit: 0 }
    await Effect.runPromise(record.around("shell", { command: "ls" }, Effect.succeed({ content: [{ type: "text", text: "sh_3 · exited 0 · 0.0 s" }, { type: "text", text: "a\n" }], metadata })))
    const [operation] = record.metadata()[OPERATIONS_KEY] as ReadonlyArray<Operation>
    expect(operation?.metadata).toEqual({ exit: 0, id: "sh_3" })
    expect(operation?.output).toBe("sh_3 · exited 0 · 0.0 s\na\n")
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
    expect(record.spans().map((span) => Option.isSome(span.end))).toEqual([true])
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

  test("counts overlap from spans: a call that ends as another starts does not overlap it, one still running does", () => {
    const span = (start: number, end: Option.Option<number>) => ({ start, end })
    expect(concurrencyOf([])).toEqual({ calls: 0, maxInFlight: 0 })
    expect(concurrencyOf([span(0, Option.some(5)), span(5, Option.some(8))])).toEqual({ calls: 2, maxInFlight: 1 })
    const running = [span(0, Option.some(5)), span(1, Option.some(2)), span(3, Option.some(9)), span(4, Option.none())]
    expect(concurrencyOf(running)).toEqual({ calls: 4, maxInFlight: 3 })
  })

  test("a call that takes no time counts for itself: alone, beside one at the same instant, touching one, and inside one", () => {
    const span = (start: number, end: number) => ({ start, end: Option.some(end) })
    expect(concurrencyOf([span(3, 3)])).toEqual({ calls: 1, maxInFlight: 1 })
    expect(concurrencyOf([span(3, 3), span(3, 3)])).toEqual({ calls: 2, maxInFlight: 2 })
    expect(concurrencyOf([span(0, 3), span(3, 3)])).toEqual({ calls: 2, maxInFlight: 1 })
    expect(concurrencyOf([span(0, 5), span(3, 3)])).toEqual({ calls: 2, maxInFlight: 2 })
  })

  test("agrees with a brute-force count over every set of up to three spans on four instants", () => {
    // A span holds [start, end); one that takes no time holds its own instant; one still running holds every later one.
    const ends = (start: number) => [...Array.from({ length: 4 - start }, (_, at) => Option.some(start + at)), Option.none<number>()]
    const spans = Array.from({ length: 4 }, (_, start) => ends(start).map((end) => ({ start, end }))).flat()
    const holds = (span: (typeof spans)[number], at: number) =>
      Option.match(span.end, {
        onNone: () => span.start <= at,
        onSome: (end) => (end === span.start && at === span.start) || (span.start <= at && at < end),
      })
    const oracle = (set: ReadonlyArray<(typeof spans)[number]>) => Math.max(0, ...set.map((one) => set.filter((other) => holds(other, one.start)).length))
    const sets = [[], ...spans.map((a) => [a]), ...spans.flatMap((a) => spans.map((b) => [a, b])), ...spans.flatMap((a) => spans.flatMap((b) => spans.map((c) => [a, b, c])))]
    const wrong = sets.filter((set) => concurrencyOf(set).maxInFlight !== oracle(set))
    expect(sets.length).toBe(1 + 14 + 14 ** 2 + 14 ** 3)
    expect(wrong).toEqual([])
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
    // Every call has its span, the dropped ones too; one after another, none overlaps.
    expect(record.spans().every((span) => Option.isSome(span.end))).toBe(true)
    expect(metadata[CONCURRENCY_KEY]).toEqual({ calls: MAX_OPERATIONS + 3, maxInFlight: 1 })
  })
})
