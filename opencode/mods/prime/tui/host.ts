// What the Prime look reads from the host and asks of it, narrowed to what
// its rows use. The components own this contract; opencode/host.ts fills it
// from OpenCode's plugin context, handing the host's values over as they are,
// so every read stays reactive inside a Solid computation.
import type { Family } from "@dotfiles/opencode-subagents/family"
import type { RGBA } from "@opentui/core"
import type { JSX } from "solid-js"
import type { CurrentModel, Usage } from "../chrome.ts"
import type { Message, Part, Session } from "../session.ts"

/** The colours the look draws in: a narrowed copy of the host's resolved theme. */
export type Palette = {
  readonly text: {
    readonly base: RGBA
    readonly muted: RGBA
    readonly faint: RGBA
    readonly feedback: {
      readonly error: { readonly base: RGBA }
      readonly warning: { readonly base: RGBA }
      readonly success: { readonly base: RGBA }
      readonly info: { readonly base: RGBA }
    }
  }
  readonly hue: {
    readonly accent: { readonly 300: RGBA }
    readonly interactive: { readonly 300: RGBA }
  }
  readonly diff: {
    readonly text: { readonly added: RGBA; readonly removed: RGBA }
    readonly background: { readonly added: RGBA; readonly removed: RGBA; readonly context: RGBA }
  }
  readonly border: { readonly base: RGBA }
  readonly background: { readonly base: RGBA }
}

/** Where the reader is in a session's transcript: the input of the host's transcript overlay. */
export type Overlay = {
  readonly sessionID: string
  /** True while the transcript is scrolled away from its newest row. */
  readonly away: boolean
  /** Each mounted message's first row, relative to the viewport's top row (negative: above it). */
  readonly messages: ReadonlyArray<{ readonly messageID: string; readonly row: number }>
  /** Scrolls the transcript so the message's first row is the viewport's top row. */
  readonly reveal: (messageID: string) => void
}

export interface Host {
  /** The colours of the theme in use. */
  theme(): Palette
  /** The running OpenCode's version. */
  version(): string

  // Session data.
  session(sessionID: string): Session | undefined
  sessions(): ReadonlyArray<Session>
  messages(sessionID: string): ReadonlyArray<Message>
  message(sessionID: string, messageID: string): Message | undefined
  part(sessionID: string, messageID: string, partID: string): Part | undefined
  cost(sessionID: string): number
  status(sessionID: string): "idle" | "running"
  usage(sessionID: string): Usage | undefined
  /** Whether `/goal` set a goal on the session. */
  hasGoal(sessionID: string): boolean
  /** Every session of the session's family. */
  familyIDs(sessionID: string): ReadonlyArray<string>
  /** The session's family as the subagent rows read it. */
  subagents(sessionID: string): Family
  /** How many background shells the session started. */
  shells(sessionID: string): number

  // The frame.
  /** The model the prompt sends to. */
  model(): CurrentModel | undefined
  /** A directory as the host writes paths: `~/x`. */
  path(directory: string): string
  /** Whether the host shows the session's sidebar now. */
  sidebarShown(sessionID: string): boolean
  /** The session on screen, when the route is one. */
  route(): string | undefined
  /** Puts a session on screen. */
  open(sessionID: string): void
  /** Whether the reader has text selected: a drag that selected text is a copy, not a click. */
  selecting(): boolean
  /** Opens the host's Subagents picker, as Down on an empty prompt does. */
  openSubagents(): void

  /** The host's markdown renderer, for text that reads like the transcript. */
  readonly Markdown: (props: { readonly content: string; readonly streaming?: boolean }) => JSX.Element
  /** The host's code renderer, for source that reads like the transcript's. */
  readonly Code: (props: { readonly content: string; readonly path?: string }) => JSX.Element
}
