// The view Escape decides from, read from the TUI plugin's context: the
// session on screen, its newest prompt with text (as the host's
// `session.undo` picks it: before any staged revert), whether it still waits
// in the inbox, and what the focused text editor holds. The composer is the
// focused editor whenever Escape reaches the base keymap mode on a session
// (a dialog, the autocomplete popup, a form and the composer panel each push
// a mode of their own), so its text is the renderer's `currentFocusedEditor`
// text; an attachment sits in that text as its label. Ctrl+Enter reads the
// same view and, from the inbox, the prompts still waiting (`waiting`).
import type { Prompt, View } from "../escape.ts"
import type { Waiting } from "../send.ts"

/** One item of the session's inbox (`data.session.pending`), as far as the plugin reads it. */
export interface InboxItem {
  readonly id: string
  readonly type: string
  readonly delivery?: "steer" | "queue"
  readonly time?: { readonly created: number }
}

/**
 * The reads the view needs from the plugin's `context.data`, narrowed to what
 * it uses so a test can supply them; `context.data` satisfies it.
 */
export interface Reads {
  readonly session: {
    get(sessionID: string): { readonly parentID?: string; readonly revert?: { readonly messageID?: string } } | undefined
    family(sessionID: string): ReadonlyArray<string>
    status(sessionID: string): "idle" | "running"
    readonly pending: { list(sessionID: string): ReadonlyArray<InboxItem> }
    readonly permission: { list(sessionID: string): ReadonlyArray<unknown> | undefined }
    readonly form: { list(sessionID: string): ReadonlyArray<unknown> | undefined }
    readonly message: { list(sessionID: string): ReadonlyArray<Message> }
  }
}

/** A transcript message, as far as the view reads it. */
export interface Message {
  readonly id: string
  readonly type: string
  readonly text?: string
  readonly content?: ReadonlyArray<{ readonly type: string; readonly name?: string }>
  readonly time: { readonly created: number }
}

/** The focused text editor, as `context.renderer.currentFocusedEditor` gives it, with any other `Fields` a reader needs. */
export type Editor<Fields extends object = object> = ({ readonly plainText: string } & Fields) | null | undefined

/** The route the TUI shows, as `context.ui.router.current()` returns it. */
export type Route = { readonly type: "session"; readonly sessionID: string } | { readonly type: string }

const SHELL_TOOLS = new Set(["shell", "bash"])

const latestPrompt = (reads: Reads, sessionID: string): Prompt | undefined => {
  const all = reads.session.message.list(sessionID)
  const revert = reads.session.get(sessionID)?.revert?.messageID
  const cut = revert === undefined ? -1 : all.findIndex((message) => message.id === revert)
  const messages = cut === -1 ? all : all.slice(0, cut)
  const index = messages.findLastIndex((message) => message.type === "user" && !!message.text?.trim())
  const message = messages[index]
  if (message === undefined) return undefined
  const pending = reads.session.pending.list(sessionID).some((item) => item.type === "user" && item.id === message.id)
  const ranShell = messages
    .slice(index + 1)
    .some((later) => later.type === "assistant" && (later.content ?? []).some((part) => part.type === "tool" && SHELL_TOOLS.has(part.name ?? "")))
  return { id: message.id, created: message.time.created, pending, ranShell }
}

/** The view of the session `route` shows, or none off a session. */
export const read = (reads: Reads, route: Route, editor: Editor): View | undefined => {
  if (!("sessionID" in route) || route.type !== "session") return undefined
  const sessionID = route.sessionID
  const session = reads.session.get(sessionID)
  if (session === undefined) return undefined
  const subagent = session.parentID !== undefined
  // The host's own rule for a prompt that has the keyboard: a root sees its whole family's requests, a subagent only the global questions.
  const asking = subagent ? [] : new Set([sessionID, ...reads.session.family(sessionID)])
  const blocked = [...asking].some((id) => (reads.session.permission.list(id)?.length ?? 0) > 0 || (reads.session.form.list(id)?.length ?? 0) > 0)
  return {
    sessionID,
    subagent,
    busy: reads.session.status(sessionID) === "running",
    blocked,
    latest: latestPrompt(reads, sessionID),
    composer: editor === null || editor === undefined ? "none" : editor.plainText === "" ? "empty" : "draft",
  }
}

/**
 * The prompts the session's runner has not taken, oldest first: the user
 * items of its inbox (a program's synthetic note or a compaction is not the
 * reader's to send). An item with no delivery is read as a steer.
 */
export const waiting = (reads: Reads, sessionID: string): ReadonlyArray<Waiting> =>
  reads.session.pending
    .list(sessionID)
    .filter((item) => item.type === "user")
    .toSorted((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
    .map((item) => ({ id: item.id, delivery: item.delivery ?? "steer" }))
