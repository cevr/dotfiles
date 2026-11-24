import { Option, Schema } from "effect"
import { agyAdapter } from "./agy.ts"

/** Supported external interactive CLI harnesses. */
export const HARNESSES = ["agy"] as const
export const Harness = Schema.Literals(HARNESSES)
export type Harness = typeof Harness.Type

/** Per-start command options passed to a harness adapter. */
export interface StartOptions {
  readonly binary?: string
  readonly dangerousSkipPermissions?: boolean
}

/** A prompt or confirmation waiting for the owner inside the pane. */
export interface NeedsInput {
  readonly summary: string
  readonly tail: string
}

/**
 * Contract for driving an unmodified interactive CLI in a Rex pane.
 * Adding another harness (Claude Code, Codex) implements this interface
 * without changing callers.
 */
export interface HarnessAdapter {
  readonly harness: Harness
  readonly command: (options: StartOptions) => ReadonlyArray<string>
  readonly readyForInput: (screen: string) => boolean
  readonly formatSubmit: (text: string) => ReadonlyArray<string>
  readonly turnEnded: (screen: string) => boolean
  readonly needsInput: (screen: string) => Option.Option<NeedsInput>
  readonly interruptSequence: string
  readonly readLastAnswer: (screen: string) => string
}

/** Look up the adapter for a harness. */
export const adapterFor = (harness: Harness): HarnessAdapter => {
  switch (harness) {
    case "agy":
      return agyAdapter
  }
}
