// Notices other programs put in the session, without rendering: a
// background worker's or shell's stop notice. Workers that finish together
// read as one line (`↳ 3 agents finished · fix-a, fix-b, fix-c`); the first
// notice of the burst draws it and the rest draw nothing.
import { close, stretch } from "./burst.ts"
import type { Message } from "./session.ts"

/** Whether a message is a subagent's notice that it finished well. */
function finished(message: Message | undefined): boolean {
  if (message?.type !== "synthetic") return false
  return message.metadata?.source === "subagent" && message.metadata?.state === "completed"
}

/**
 * The finished-worker notices a notice folds with: the ones next to it, each
 * within the burst window of the one before. Empty for any other message.
 */
export function noticeBurst(messages: ReadonlyArray<Message>, messageID: string): Message[] {
  const at = messages.findIndex((message) => message.id === messageID)
  if (!finished(messages[at])) return []
  return stretch(messages, at, (previous, next) => finished(previous) && finished(next) && close(previous, next))
}

const titlecase = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)

/** A burst's line: the host's `↳ Worker finished · task` for one, a count of agents and every task for several. */
export function completionWords(burst: ReadonlyArray<Message>) {
  const agent = (message: Message) =>
    message.type === "synthetic" && typeof message.metadata?.agent === "string" ? message.metadata.agent : "subagent"
  const task = (message: Message) =>
    message.type === "synthetic" ? (message.description ?? "").replace(/\s+/g, " ").trim() : ""
  const first = burst[0]
  if (!first) return { heading: "", suffix: "" }
  const suffix = burst.map(task).filter(Boolean).join(", ")
  if (burst.length === 1) return { heading: `↳ ${titlecase(agent(first))} finished`, suffix }
  // Counted as agents, as the launch group's header counts them.
  return { heading: `↳ ${burst.length} agents finished`, suffix }
}

/** The tone a completion line's heading is drawn in: a failure, a cancel, or the info colour. */
export type CompletionTone = "error" | "warning" | "info"

/** A notice's completion line, as the message that carries it draws it. */
export type Completion = {
  /** Whether this message draws the line: the first of its burst. */
  readonly drawn: boolean
  readonly heading: string
  readonly suffix: string
  readonly tone: CompletionTone
  /** The session a click opens: one finished worker's own. */
  readonly child?: string
}

/**
 * The line notice `messageID` draws: a notice outside any burst (a failure,
 * a shell) is its own burst of one, and says how it ended (`! Shell failed`,
 * `! Worker cancelled`, `↳ Worker finished`); a burst of several counts its
 * agents. None when the message is not in `messages`.
 */
export function completion(messages: ReadonlyArray<Message>, messageID: string): Completion | undefined {
  const message = messages.find((item) => item.id === messageID)
  if (!message) return undefined
  const metadata = message.type === "synthetic" ? (message.metadata ?? {}) : {}
  const folded = noticeBurst(messages, messageID)
  const burst = folded.length > 0 ? folded : [message]
  const own = completionWords(burst)
  const state = metadata.state
  const actor = metadata.source === "shell" ? "Shell" : own.heading.replace(/^↳ /, "").replace(/ finished$/, "")
  const heading =
    burst.length > 1
      ? own.heading
      : state === "error"
        ? `! ${actor} failed`
        : state === "cancelled"
          ? `! ${actor} cancelled`
          : `↳ ${actor} finished`
  const tone: CompletionTone = state === "error" ? "error" : state === "cancelled" ? "warning" : "info"
  const id = metadata.childID
  const child = burst.length === 1 && metadata.source === "subagent" && typeof id === "string" ? id : undefined
  return {
    drawn: burst[0]?.id === messageID,
    heading,
    suffix: own.suffix,
    tone,
    ...(child === undefined ? {} : { child }),
  }
}
