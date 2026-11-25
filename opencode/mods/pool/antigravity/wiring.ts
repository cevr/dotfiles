// Antigravity in the pool plugin: the one boundary between the pool and the
// Antigravity code. The rows a pool_push status appends, the pool's
// `antigravity` RPC method and the `antigravity` tool all come from here, and
// every one of them is contained: whatever the Antigravity code does (a typed
// failure, a defect, a rejected promise in a double or the real thing), the
// pool's answer still comes, with a typed "unknown: <reason>" row in place of
// the rows. Nothing here runs at plugin start.
import { Effect, Match, Option } from "effect"
import { reasonOf, type Source } from "./source.ts"
import { ANTIGRAVITY_DESCRIPTION, AntigravityToolInput, answer } from "./tool.ts"

/** The row in place of Antigravity's when its code failed. */
export const containedLine = (reason: string) => `antigravity · unknown: the Antigravity reader failed here (${reason})`

export interface Wiring {
  /** Antigravity's rows as stored; none with no source. Never fails. */
  readonly lines: Effect.Effect<ReadonlyArray<string>>
  /** A pool_push answer's text, with Antigravity's rows after it for a `status`. Never fails. */
  readonly pushText: (action: string, text: string) => Effect.Effect<string>
  /** The pool's `antigravity` RPC method's answer: `{ lines }`. Never fails. */
  readonly rpc: () => Effect.Effect<{ readonly lines: ReadonlyArray<string> }>
  /** The `antigravity` tool as the plugin adds it. Its execute never fails. */
  readonly tool: {
    readonly name: "antigravity"
    readonly description: string
    readonly input: typeof AntigravityToolInput
    readonly options: { readonly codemode: false }
    readonly execute: (input: AntigravityToolInput) => Effect.Effect<{ readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }> }>
  }
}

export const wire = (agy: Option.Option<Source>): Wiring => {
  const lines = Option.match(agy, { onNone: () => Effect.succeed<ReadonlyArray<string>>([]), onSome: (source) => source.lines }).pipe(
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
      name: "antigravity",
      description: ANTIGRAVITY_DESCRIPTION,
      input: AntigravityToolInput,
      options: { codemode: false },
      execute: (input) =>
        answer(agy, input).pipe(
          Effect.catchCause((cause) => Effect.succeed(containedLine(reasonOf(cause)))),
          Effect.map((text) => ({ content: [{ type: "text" as const, text }] })),
        ),
    },
  }
}
