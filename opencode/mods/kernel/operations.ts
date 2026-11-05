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
import { Effect } from "effect"

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
  /** The result metadata the transcript reads: `exit`, `files` (patches cut), `sessionID`, `shellID`. */
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
export const briefMetadata = (metadata: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(metadata)) return undefined
  const brief: Record<string, unknown> = {}
  if (typeof metadata.exit === "number") brief.exit = metadata.exit
  if (typeof metadata.sessionID === "string") brief.sessionID = metadata.sessionID
  // A shell command moved to the background names its shell, whose stop notice names it too.
  if (typeof metadata.shellID === "string") brief.shellID = metadata.shellID
  // One the host moved there by its time limit or the reader's ctrl+b: the row says it moved.
  if (metadata.backgrounded === "limit" || metadata.backgrounded === "user") brief.backgrounded = metadata.backgrounded
  // A latched subagent's call answers at once; its child starts when the latch opens (orchestrate).
  if (metadata.status === "latched") brief.status = "latched"
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

/** One kernel call's record of its operations. */
export interface Journal {
  /** Runs `run` as the tool call `tool(input)`, recording its start and how it ended. */
  readonly around: <A extends Outcome, E, R>(tool: string, input: unknown, run: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** The record as the call's metadata; empty when the cell called no tool. */
  readonly metadata: () => Record<string, unknown>
  /** Ends publishing: the call is about to settle. */
  readonly close: Effect.Effect<void>
}

/** A journal that records nothing: a call whose host shows no transcript. */
export const silent: Journal = {
  around: (_tool, _input, run) => run,
  metadata: () => ({}),
  close: Effect.void,
}

/**
 * A journal that publishes the whole record through `publish` after each
 * change, while it is open. A publish that fails is ignored: the record is a
 * view, never a reason to fail a tool call.
 */
export const journal = (publish: (metadata: Record<string, unknown>) => Effect.Effect<void>): Journal => {
  const operations: Array<Operation> = []
  let dropped = 0
  let open = true
  const metadata = (): Record<string, unknown> =>
    operations.length === 0 && dropped === 0 ? {} : { [OPERATIONS_KEY]: [...operations], ...(dropped > 0 ? { dropped } : {}) }
  const published = Effect.suspend(() => (open ? publish(metadata()).pipe(Effect.ignoreCause) : Effect.void))
  const settle = (index: number, operation: Operation) =>
    Effect.suspend(() => {
      if (index >= 0) operations[index] = operation
      return published
    })
  return {
    around: (tool, input, run) =>
      Effect.suspend(() => {
        const started: Operation = { tool, status: "running", input: briefInput(input) }
        const index = operations.length < MAX_OPERATIONS ? operations.push(started) - 1 : -1
        if (index < 0) dropped++
        return published.pipe(
          Effect.andThen(run),
          Effect.tap((result) => {
            const output = textOf(result.content)
            const kept = briefMetadata(result.metadata)
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
    close: Effect.sync(() => {
      open = false
    }),
  }
}
