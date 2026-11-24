// What one kernel call's cell did through `tools.*`, for the transcript: the
// call's `metadata.operations`. A cell's code says little about what it did
// (a helper defined in an earlier cell runs the commands), so the record is
// the calls themselves, in the order they started: each one's tool, its input,
// how it ended, the head of its output and the result metadata the transcript
// reads (an exit code, edited files, a subagent's session, a background
// shell's ID).
//
// The record is published while the call runs and kept as its result's
// metadata, so it is bounded: at most `MAX_OPERATIONS` operations, each
// string cut to its own cap. A journal closes when its call ends; a call the
// cell left running past that changes nothing, because the host refuses
// progress for a settled call.
//
// It also keeps when each call started and ended (`spans`), so a cell's
// overlap can be measured: a cell of two or more calls carries how many it
// made and the most that ran at once (`concurrency`).
import { Clock, Effect, Option } from "effect"
import { readLaunchStatus } from "./launch-status.ts"

/** The metadata key the record is kept under. */
export const OPERATIONS_KEY = "operations"
/** The most operations one call records; later ones are counted in `dropped`. */
export const MAX_OPERATIONS = 100
/** The longest input string kept (a command, a path, a prompt). */
export const MAX_INPUT_CHARS = 400
/** The longest output head kept. */
export const MAX_OUTPUT_CHARS = 2_000
/** The longest edited-file patch kept. */
export const MAX_PATCH_CHARS = 4_000

/** How an operation stands. */
export type OperationStatus = "running" | "completed" | "error"

/** One `tools.<name>(input)` call a cell made. */
export interface Operation {
  readonly tool: string
  readonly status: OperationStatus
  /** The input's scalar fields, strings cut to `MAX_INPUT_CHARS`. */
  readonly input: Record<string, string | number | boolean>
  /** The head of the result's text, cut to `MAX_OUTPUT_CHARS`. */
  readonly output?: string
  /** Why it failed. */
  readonly error?: string
  /** The result metadata the transcript reads: `exit`, `files` (patches cut), `sessionID`, `shellID`, a shell handle's `id`. */
  readonly metadata?: Record<string, unknown>
}

/** A tool result as the journal reads it. */
export interface Outcome {
  readonly content?: unknown
  readonly metadata?: Record<string, unknown>
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The input's scalar fields, as a row names the call by them. */
export const briefInput = (input: unknown): Operation["input"] => {
  if (!isRecord(input)) return {}
  const brief: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") brief[key] = cut(value, MAX_INPUT_CHARS)
    else if (typeof value === "number" || typeof value === "boolean") brief[key] = value
  }
  return brief
}

/** A result's text: a string, or the text items of its content. */
const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((item) => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []))
    .join("\n")
}

/** The result metadata the transcript reads, bounded. */
const briefMetadata = (tool: string, metadata: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(metadata)) return undefined
  const brief: Record<string, unknown> = {}
  if (typeof metadata.exit === "number") brief.exit = metadata.exit
  if (typeof metadata.sessionID === "string") brief.sessionID = metadata.sessionID
  // A shell command moved to the background names its shell, whose stop notice names it too.
  if (typeof metadata.shellID === "string") brief.shellID = metadata.shellID
  // A shell handle's ID: its result leads with the handle's header line, which the row drops.
  if (typeof metadata.id === "string" && metadata.id.startsWith("sh_")) brief.id = metadata.id
  // One the host moved there by its time limit or the reader's ctrl+b: the row says it moved.
  if (metadata.backgrounded === "limit" || metadata.backgrounded === "user") brief.backgrounded = metadata.backgrounded
  // Keep launch receipts separate from the kernel operation's own completion.
  if (tool === "subagent") {
    const launch = readLaunchStatus(metadata.status)
    if (Option.isSome(launch)) brief.status = launch.value
  }
  if (Array.isArray(metadata.files))
    brief.files = metadata.files.slice(0, 20).flatMap((file) => {
      if (!isRecord(file)) return []
      const kept: Record<string, unknown> = {}
      for (const key of ["relativePath", "file", "filePath", "additions", "deletions"] as const)
        if (typeof file[key] === "string" || typeof file[key] === "number") kept[key] = file[key]
      if (typeof file.patch === "string") kept.patch = cut(file.patch, MAX_PATCH_CHARS)
      return [kept]
    })
  return Object.keys(brief).length > 0 ? brief : undefined
}

const messageOf = (error: unknown): string => {
  if (isRecord(error) && typeof error.message === "string") return error.message
  return String(error)
}

/** The metadata key of how the cell's calls overlapped, kept when it made two or more. */
export const CONCURRENCY_KEY = "concurrency"

/** When one call ran, in epoch ms (to the nanosecond) by the Effect clock; no `end` while it runs. */
export interface Span {
  readonly start: number
  readonly end: Option.Option<number>
}

/** Now, in epoch ms to the nanosecond, so calls made one after another rarely share an instant. */
const clockMs = Effect.map(Clock.currentTimeNanos, (nanos) => Number(nanos) / 1_000_000)

/** A kernel call's metadata: its operations, how many were dropped, and for two or more calls how they overlapped; empty when the cell called no tool. */
export type Metadata = { [OPERATIONS_KEY]?: ReadonlyArray<Operation>; dropped?: number; [CONCURRENCY_KEY]?: Concurrency }

/** How a cell's calls overlapped: how many it made, and the most that ran at once. */
export interface Concurrency {
  readonly calls: number
  readonly maxInFlight: number
}

/**
 * The most spans open at one instant. A span that ends as another starts does
 * not overlap it; a span that ends as it starts still counts for itself.
 */
export const concurrencyOf = (spans: ReadonlyArray<Span>): Concurrency => {
  const edges = spans.flatMap((span) => {
    const end = Option.getOrElse(span.end, () => Number.POSITIVE_INFINITY)
    // At one instant ends come first, starts next, then the ends of spans that took no time.
    return [
      { at: span.start, step: 1, order: 1 },
      { at: end, step: -1, order: 2 * Number(end === span.start) },
    ]
  })
  edges.sort((left, right) => left.at - right.at || left.order - right.order)
  let now = 0
  let most = 0
  for (const edge of edges) {
    now += edge.step
    most = Math.max(most, now)
  }
  return { calls: spans.length, maxInFlight: most }
}

/** One kernel call's record of its operations. */
export interface Journal {
  /** Runs `run` as the tool call `tool(input)`, recording its start and how it ended. */
  readonly around: <A extends Outcome, E, R>(tool: string, input: unknown, run: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** The record as the call's metadata; empty when the cell called no tool. */
  readonly metadata: () => Metadata
  /** When each call ran, in the order they started: every call, past `MAX_OPERATIONS` too. */
  readonly spans: () => ReadonlyArray<Span>
  /** Ends publishing: the call is about to settle. */
  readonly close: Effect.Effect<void>
}

/** A journal that records nothing: a call whose host shows no transcript. */
export const silent: Journal = {
  around: (_tool, _input, run) => run,
  metadata: () => ({}),
  spans: () => [],
  close: Effect.void,
}

/**
 * A journal that publishes the whole record through `publish` after each
 * change, while it is open. A publish that fails is ignored: the record is a
 * view, never a reason to fail a tool call.
 */
export const journal = (publish: (metadata: Record<string, unknown>) => Effect.Effect<void>): Journal => {
  const operations: Array<Operation> = []
  const spans: Array<Span> = []
  let dropped = 0
  let open = true
  const metadata = (): Metadata => {
    if (operations.length === 0 && dropped === 0) return {}
    const kept: Metadata = { [OPERATIONS_KEY]: [...operations] }
    if (dropped > 0) kept.dropped = dropped
    if (spans.length > 1) kept[CONCURRENCY_KEY] = concurrencyOf(spans)
    return kept
  }
  const published = Effect.suspend(() => (open ? publish(metadata()).pipe(Effect.ignoreCause) : Effect.void))
  const settle = (index: number, operation: Operation) =>
    Effect.suspend(() => {
      if (index >= 0) operations[index] = operation
      return published
    })
  return {
    around: (tool, input, run) =>
      Effect.flatMap(clockMs, (start) => {
        const started: Operation = { tool, status: "running", input: briefInput(input) }
        const index = operations.length < MAX_OPERATIONS ? operations.push(started) - 1 : -1
        if (index < 0) dropped++
        const span = spans.push({ start, end: Option.none() }) - 1
        const ended = Effect.map(clockMs, (end) => {
          spans[span] = { start, end: Option.some(end) }
        })
        return published.pipe(
          Effect.andThen(Effect.ensuring(run, ended)),
          Effect.tap((result) => {
            const output = textOf(result.content)
            const kept = briefMetadata(tool, result.metadata)
            return settle(index, {
              ...started,
              status: "completed",
              ...(output === "" ? {} : { output: cut(output, MAX_OUTPUT_CHARS) }),
              ...(kept === undefined ? {} : { metadata: kept }),
            })
          }),
          Effect.tapError((error) => settle(index, { ...started, status: "error", error: cut(messageOf(error), MAX_OUTPUT_CHARS) })),
        )
      }),
    metadata,
    spans: () => [...spans],
    close: Effect.sync(() => {
      open = false
    }),
  }
}
