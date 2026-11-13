// Sessions as OpenCode reports them. A session it cannot read answers
// undefined: the guard then treats it as a main session with no agent.
// A latched child's state is the wakes' mark in its metadata (mods/wake
// latch.ts), which only the wakes write. A session's last words are its
// newest assistant message's text, from the host's model context.
import { Effect, Layer, Schema } from "effect"
import { Mark } from "@dotfiles/opencode-wake/latch"
import { Sessions } from "../service.ts"

/** What the guard reads of a session. */
export interface Session {
  readonly parentID?: string
  readonly agent?: string
  /** It has run a turn, or runs one: the host's `time.busy` or `outcome` is set. */
  readonly started?: boolean
  /** Its last turn was stopped: the host's `outcome` is `interrupted`. */
  readonly stopped?: boolean
  /** The wakes' latch mark, as the session's metadata carries it. */
  readonly latch?: unknown
  /** The directory it works in: the host's `location.directory`. */
  readonly directory?: string
}

/** Where a session runs, or which sessions a copy of the plugin serves. */
export interface Place {
  readonly directory: string
  readonly workspaceID?: string | undefined
}

const canonical = (directory: string) => (directory.length > 1 && directory.endsWith("/") ? directory.slice(0, -1) : directory)

/** Whether two places are one location, as the fork keys them. */
export const samePlace = (a: Place, b: Place) => canonical(a.directory) === canonical(b.directory) && (a.workspaceID ?? undefined) === (b.workspaceID ?? undefined)

/** OpenCode's session lookup, as the plugin calls it. */
export type Get = (sessionID: string) => Effect.Effect<Session, unknown>

/** OpenCode's session context: its messages, oldest first, as the host's `session.context` answers. */
export type Messages = (sessionID: string) => Effect.Effect<ReadonlyArray<unknown>, unknown>

const orNone = Effect.catchCause(() => Effect.succeed(undefined))
const markOf = Schema.decodeUnknownOption(Mark)

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** The newest assistant message's text parts, joined by a newline; none when it wrote no text. */
export const lastWords = (messages: ReadonlyArray<unknown>): string | undefined => {
  const last = messages.findLast((message) => isObject(message) && message.type === "assistant" && Array.isArray(message.content) && message.content.some(isText))
  if (!isObject(last) || !Array.isArray(last.content)) return undefined
  return last.content.filter(isText).map((part) => part.text).join("\n")
}

const isText = (part: unknown): part is { readonly text: string } => isObject(part) && part.type === "text" && typeof part.text === "string" && part.text.trim() !== ""

export const layer = (get: Get, messages: Messages) =>
  Layer.succeed(Sessions, {
    parentOf: Effect.fn("Sessions.parentOf")(function* (sessionID: string) {
      return (yield* get(sessionID)).parentID || undefined
    }, orNone),
    agentOf: Effect.fn("Sessions.agentOf")(function* (sessionID: string) {
      return (yield* get(sessionID)).agent || undefined
    }, orNone),
    startedOf: Effect.fn("Sessions.startedOf")(function* (sessionID: string) {
      return (yield* get(sessionID)).started === true
    }, Effect.catchCause(() => Effect.succeed(false))),
    stoppedOf: Effect.fn("Sessions.stoppedOf")(function* (sessionID: string) {
      return (yield* get(sessionID)).stopped === true
    }, Effect.catchCause(() => Effect.succeed(false))),
    latchOf: Effect.fn("Sessions.latchOf")(function* (sessionID: string) {
      const mark = markOf((yield* get(sessionID)).latch)
      if (mark._tag === "None" || mark.value.cancelledAt !== undefined || mark.value.failed !== undefined) return undefined
      return mark.value.opensAt
    }, orNone),
    directoryOf: Effect.fn("Sessions.directoryOf")(function* (sessionID: string) {
      return (yield* get(sessionID)).directory || undefined
    }, orNone),
    lastWordsOf: Effect.fn("Sessions.lastWordsOf")(function* (sessionID: string) {
      return lastWords(yield* messages(sessionID))
    }, orNone),
  })
