import { type Option, Schema } from "effect"

/** Supported external interactive CLI harnesses. */
export const HARNESSES = ["agy"] as const
export const Harness = Schema.Literals(HARNESSES)
export type Harness = typeof Harness.Type

/** Detected prompt waiting for human interaction in the pane. */
export interface NeedsInput {
  readonly summary: string
  readonly tail: string
}

/** Detected quota/usage limit frame waiting until `resetAt` (epoch ms). */
export interface UsageLimit {
  readonly resetAt: number
  readonly resetInMs: number
  readonly summary: string
}

/** Options for constructing the CLI start command. */
export interface StartOptions {
  readonly binary?: string
  readonly addDirs?: ReadonlyArray<string>
  readonly skipPermissions?: boolean
}

/** Options for resuming a stopped harness session in a fresh pane. */
export interface ResumeOptions {
  readonly binary?: string
  readonly addDirs?: ReadonlyArray<string>
  readonly skipPermissions?: boolean
  readonly initialPrompt: string
}

/**
 * Seam for driving an unmodified interactive CLI harness in a Rex pane.
 * New harnesses (e.g. Claude Code, Codex) implement this contract without changing callers.
 */
export interface HarnessAdapter {
  readonly harness: Harness
  /** Exact argv to launch the unmodified interactive CLI. */
  readonly command: (options: StartOptions) => ReadonlyArray<string>
  /** Exact argv to resume a stopped conversation in the same folder with an initial prompt. */
  readonly resumeCommand: (options: ResumeOptions) => ReadonlyArray<string>
  /** True once the CLI is at its interactive prompt ready to accept pasted input. */
  readonly readyForInput: (screen: string) => boolean
  /** Multi-line safe chunks to write to queue/submit a task (bracketed paste, then Enter). */
  readonly formatSubmit: (text: string) => ReadonlyArray<string>
  /** Multi-line safe chunks to steer/interrupt an active turn immediately (bracketed paste, then Alt+M). */
  readonly formatSteer: (text: string) => ReadonlyArray<string>
  /** True when the CLI shows its idle signature (active-turn footer gone, input box back). */
  readonly turnEnded: (screen: string) => boolean
  /** Some when the pane is waiting on a human (trust, sign-in, permission, question). */
  readonly needsInput: (screen: string) => Option.Option<NeedsInput>
  /** Some when the pane shows a provider usage/quota limit with a reset time. */
  readonly usageLimit: (screen: string, now: number) => Option.Option<UsageLimit>
  /** Escape sequence sent to interrupt an active turn. */
  readonly interruptSequence: string
  /** Extracts the last answer text from a completed screen capture. */
  readonly readLastAnswer: (screen: string) => string
  /** Extracts the last echoed prompt line above the input box (`> <prompt>`), if present. */
  readonly readLastPrompt: (screen: string) => Option.Option<string>
}

import { agyAdapter } from "./agy.ts"

const ADAPTERS: Readonly<Record<Harness, HarnessAdapter>> = {
  agy: agyAdapter,
}

export const adapterFor = (harness: Harness): HarnessAdapter => ADAPTERS[harness]
