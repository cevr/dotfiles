// What the Prime look reads from the host and asks of it, narrowed to what
// its rows use. The components own this contract; opencode/host.ts fills it
// from OpenCode's plugin context, handing the host's values over as they are,
// so every read stays reactive inside a Solid computation.
import type { FormInput as QueueForm } from "@dotfiles/opencode-queue/answer"
import type { Live } from "@dotfiles/opencode-queue/board"
import type { Item } from "@dotfiles/opencode-queue/item"
import type { Family } from "@dotfiles/opencode-subagents/family"
import type { RGBA } from "@opentui/core"
import type { Option } from "effect"
import type { Accessor, JSX } from "solid-js"
import type { CurrentModel, Usage } from "../chrome.ts"
import type { Goal } from "../goal.ts"
import type { Jobs } from "../jobs.ts"
import type { PendingItem, WaitingPrompt } from "../pending.ts"
import type { Starting } from "../starting.ts"
import type { UpstreamReading } from "../update.ts"
import type { ShellEntry } from "../shells.ts"
import type { Wakes } from "../wakes.ts"
import type { Message, Part, Session } from "../session.ts"

/** The colours the look draws in: a narrowed copy of the host's resolved theme. */
export type Palette = {
  readonly text: {
    readonly base: RGBA
    readonly muted: RGBA
    readonly faint: RGBA
    /** A list row's text, and the highlighted row's. */
    readonly action: { readonly primary: { readonly base: RGBA; readonly focused: RGBA } }
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
  readonly background: {
    readonly base: RGBA
    /** A list row's ground, and the highlighted row's. */
    readonly action: { readonly primary: { readonly base: RGBA; readonly focused: RGBA } }
  }
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

/** A root session's queue (the queue mod's), with the live state of each of its subagents, by session id. */
export type QueueReading = {
  readonly root: string
  readonly items: ReadonlyArray<Item>
  readonly live: ReadonlyMap<string, Live>
}

/** A key a composer tab binds: what it does, in the host's key syntax (`ctrl+d`). */
export type ComposerKey = { readonly title: string; readonly bind: string; readonly run: () => void }

export interface Host {
  /** The colours of the theme in use. */
  theme(): Palette
  /** The running OpenCode's version. */
  version(): string
  /** Whether this TUI runs an older build than its service, the newest installed (update.ts `updateAvailable`). */
  update(): boolean
  /** Upstream OpenCode against the installed build, as daily last counted it (update.ts `UpstreamReading`). */
  upstream(): UpstreamReading | undefined
  /** What the TUI waits for before a prompt can go, since when (starting.ts); none once nothing. */
  starting(): Option.Option<Starting>

  // Session data.
  session(sessionID: string): Session | undefined
  sessions(): ReadonlyArray<Session>
  messages(sessionID: string): ReadonlyArray<Message>
  message(sessionID: string, messageID: string): Message | undefined
  part(sessionID: string, messageID: string, partID: string): Part | undefined
  cost(sessionID: string): number
  status(sessionID: string): "idle" | "running"
  usage(sessionID: string): Usage | undefined
  /** The goal `/goal` set on the session, if any. */
  goal(sessionID: string): Goal | undefined
  /** The session's inbox: what was sent to it that the runner has not taken yet, in the host's order. */
  pending(sessionID: string): ReadonlyArray<PendingItem>
  /** Offers what the host's own pending rows offer for the prompt's kind (pending.ts `pendingActions`). */
  openPending(sessionID: string, prompt: WaitingPrompt): void
  /**
   * The wakes pending and notices unread for the session the accessor names,
   * kept current while the calling component lives; undefined until the
   * first reading, or with no session.
   */
  wakes(sessionID: Accessor<string | undefined>): Accessor<Wakes | undefined>
  /** Cancels one of the session's alarms or monitors, as `wake_cancel` does: why not, or undefined once it went. */
  cancelWake(sessionID: string, id: string): Promise<string | undefined>
  /**
   * The jobs (the wake mod's long commands) of the session the accessor
   * names, running and recently ended, kept current while the calling
   * component lives; none until the first reading, or with no session.
   */
  jobs(sessionID: Accessor<Option.Option<string>>): Accessor<Option.Option<Jobs>>
  /** Stops one of the session's running jobs; its end letter still wakes the session: why not, or none once asked. */
  killJob(sessionID: string, id: string): Promise<Option.Option<string>>
  /**
   * The queue of the root of the session the accessor names, kept current
   * while the calling component lives; none until the first reading, with no
   * session, or while no queue plugin answers.
   */
  queue(sessionID: Accessor<Option.Option<string>>): Accessor<Option.Option<QueueReading>>
  /** Whether a queue plugin has answered a queue read: the Queue tab and /queue exist from then on. */
  queueServed(): boolean
  /**
   * Opens the host's question form in the session for the owner's answer to a
   * queue item (the queue mod's `formOf`); its submit reaches the queue's
   * server plugin. Whether it opened, or one was pending already.
   */
  answerQueue(sessionID: string, form: QueueForm): Promise<"opened" | "already" | "failed">
  /** Every session of the session's family. */
  familyIDs(sessionID: string): ReadonlyArray<string>
  /** The session's family as the subagent rows read it. */
  subagents(sessionID: string): Family
  /** How many of the session's shell commands are running. */
  shells(sessionID: string): number
  /** The session's shell commands, from the same registry as the count. */
  shellList(sessionID: string): ReadonlyArray<ShellEntry>
  /** The tail of a shell command's output, for its last line; empty when it does not read. */
  shellTail(id: string): Promise<string>

  // The frame.
  /** The model the prompt sends to. */
  model(): CurrentModel | undefined
  /** A directory as the host writes paths: `~/x`. */
  path(directory: string): string
  /** The session on screen, when the route is one. */
  route(): string | undefined
  /** Puts a session on screen. */
  open(sessionID: string): void
  /** Whether the reader has text selected: a drag that selected text is a copy, not a click. */
  selecting(): boolean
  /** Opens the host's Subagents picker, as Down on an empty prompt does. */
  openSubagents(): void
  /**
   * Opens the composer panel on the tab `id`, or moves the open panel to it:
   * the panel's tab bar takes the request (`wantedTab`) and says when it did (`tookTab`).
   */
  openTab(id: string): void
  /** The tab `openTab` asked for that the panel has not shown yet. */
  wantedTab(): Option.Option<string>
  /** The panel shows the tab `openTab` asked for. */
  tookTab(): void
  /** Opens the list of the session's shell commands, where the reader can read or kill one. */
  openShells(sessionID: string): void
  /** Shows text in the host's alert dialog until the reader closes it. */
  showDetail(title: string, message: string): void
  /** A brief note at the screen's edge, as the host's toasts show. */
  notify(message: string, tone: "info" | "error"): void
  /**
   * Binds keys while the composer panel has the input, for as long as the
   * calling component lives: a composer tab's own keys.
   */
  composerKeys(commands: Accessor<ReadonlyArray<ComposerKey>>): void
  /** The first key bound to a keymap command, in the host's words (`ctrl+return`), or undefined when none is. */
  shortcut(commandID: string): string | undefined
  /**
   * The keys of a leader chord waiting for its next key, in the host's words
   * (`ctrl+x`), or none while none waits. Reactive.
   */
  leader(): Option.Option<string>

  /** The host's markdown renderer, for text that reads like the transcript. */
  readonly Markdown: (props: { readonly content: string; readonly streaming?: boolean }) => JSX.Element
  /** The host's code renderer, for source that reads like the transcript's. */
  readonly Code: (props: { readonly content: string; readonly path?: string }) => JSX.Element
}
