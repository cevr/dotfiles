// Antigravity in the pool plugin: the one boundary between the pool and the
// Antigravity code. The rows a pool_push status appends, the pool's
// `antigravity` RPC method and the `antigravity` tool all come from here, and
// every one of them is contained: whatever the Antigravity code does (a typed
// failure, a defect, a rejected promise in a double or the real thing), the
// pool's answer still comes, with a typed "unknown: <reason>" row in place of
// the rows. Nothing here runs at plugin start.
import { Data, Effect, Match, Option } from "effect"
import { reasonOf, type Source } from "./source.ts"
import { ANTIGRAVITY_DESCRIPTION, AntigravityToolInput, answer } from "./tool.ts"

/** The tool's name: the plugin registers `{ ...tool, name: TOOL_NAME }`, a name read without running it. */
export const TOOL_NAME = "antigravity"

/** The row in place of Antigravity's when its code failed. */
export const containedLine = (reason: string) => `antigravity · unknown: the Antigravity reader failed here (${reason})`

/**
 * What the pool has of Antigravity, each with its own true words: a source;
 * none because the pool's option is `false` (off); or none because building
 * the source failed here, with its reason (the option on).
 */
export type Availability = Data.TaggedEnum<{
  Present: { readonly source: Source }
  Off: {}
  Failed: { readonly reason: string }
}>
export const Availability = Data.taggedEnum<Availability>()

/** The row, and the tool's answer, when the source did not build: never "the option is off". */
export const failedLine = (reason: string) => `antigravity · unavailable: its source did not build on this host (${reason}); the antigravity option is on`

/**
 * The availability `root` gives: Present with a source, Off with none (the
 * root gives none only for the option `false`), Failed with the reason of any
 * failure or defect.
 */
export const availability = <R,>(root: Effect.Effect<Option.Option<Source>, never, R>): Effect.Effect<Availability, never, R> =>
  root.pipe(
    Effect.map(Option.match({ onNone: () => Availability.Off(), onSome: (source) => Availability.Present({ source }) })),
    Effect.catchCause((cause) => Effect.succeed(Availability.Failed({ reason: reasonOf(cause) }))),
  )

export interface Wiring {
  /** Antigravity's rows as stored; none with no source. Never fails. */
  readonly lines: Effect.Effect<ReadonlyArray<string>>
  /** A pool_push answer's text, with Antigravity's rows after it for a `status`. Never fails. */
  readonly pushText: (action: string, text: string) => Effect.Effect<string>
  /** The pool's `antigravity` RPC method's answer: `{ lines }`. Never fails. */
  readonly rpc: () => Effect.Effect<{ readonly lines: ReadonlyArray<string> }>
  /** The `antigravity` tool as the plugin adds it, under the name TOOL_NAME. Its execute never fails. */
  readonly tool: {
    readonly description: string
    readonly input: typeof AntigravityToolInput
    readonly options: { readonly codemode: false }
    readonly execute: (input: AntigravityToolInput) => Effect.Effect<{ readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }> }>
  }
}

export const wire = (agy: Availability): Wiring => {
  const lines = Availability.$match(agy, {
    Present: ({ source }) => source.lines,
    Off: () => Effect.succeed<ReadonlyArray<string>>([]),
    Failed: ({ reason }) => Effect.succeed([failedLine(reason)]),
  }).pipe(
    Effect.catchCause((cause) => Effect.succeed([containedLine(reasonOf(cause))])),
  )
  return {
    lines,
    pushText: (action, text) =>
      Match.value(action).pipe(
        Match.when("status", () => Effect.map(lines, (rows) => [text, ...rows].join("\n"))),
        Match.orElse(() => Effect.succeed(text)),
      ),
    rpc: () => Effect.map(lines, (rows) => ({ lines: rows })),
    tool: {
      description: ANTIGRAVITY_DESCRIPTION,
      input: AntigravityToolInput,
      options: { codemode: false },
      execute: (input) =>
        Availability.$match(agy, {
          Present: ({ source }) => answer(Option.some(source), input),
          Off: () => answer(Option.none(), input),
          Failed: ({ reason }) => Effect.succeed(failedLine(reason)),
        }).pipe(
          Effect.catchCause((cause) => Effect.succeed(containedLine(reasonOf(cause)))),
          Effect.map((text) => ({ content: [{ type: "text" as const, text }] })),
        ),
    },
  }
}
