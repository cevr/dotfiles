// Notices other programs put in the session, without rendering: a
// background worker's or shell's stop notice, drawn in the tool-call group's
// grammar: a header (`● Worker finished · Fix money parsing`) over a `├`/`└`
// tree holding what it answered, folded below All as a call's output is.
// Workers that finish together read as one group (`● 3 agents finished`, a
// node per worker); the first notice of the burst draws it and the rest draw
// nothing.
import { close, stretch } from "./burst.ts"
import type { Detail } from "./detail.ts"
import type { LeadTone, Run } from "./group.ts"
import type { Message, SyntheticMessage } from "./session.ts"

/** Whether a message is a subagent's notice that it finished well. */
function finished(message: Message | undefined): boolean {
  if (message?.type !== "synthetic") return false
  return message.metadata?.source === "subagent" && message.metadata?.state === "completed"
}

/** Whether a message is a stop notice the completion slot draws: a subagent's or a shell's. */
function stopNotice(message: Message | undefined): message is SyntheticMessage {
  if (message?.type !== "synthetic") return false
  return message.metadata?.source === "subagent" || message.metadata?.source === "shell"
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

/** What a notice says the program answered: the text inside its `<subagent …>`/`<shell …>` envelope, else all of it. */
export function noticeResult(text: string): string {
  const inside = /<(subagent|shell)\b[^>]*>\n?([\s\S]*?)\n?<\/\1>/.exec(text)
  return (inside?.[2] ?? text).trim()
}

/** One node of a notice's tree: a worker (named in a burst, unnamed alone, the header names it) and what it answered. */
export type NoticeNode = {
  readonly label?: string
  readonly lines: ReadonlyArray<string>
  /** The session a click on the node opens. */
  readonly child?: string
}

/** A notice's group, as the message that carries it draws it. */
export type NoticeGroup = {
  /** Whether this message draws the group: the first of its burst. */
  readonly drawn: boolean
  readonly glyph: { readonly char: string; readonly tone: LeadTone }
  readonly header: ReadonlyArray<Run>
  readonly nodes: ReadonlyArray<NoticeNode>
  /** Whether a failure or a cancel ended it: the overview keeps its reason. */
  readonly bad: boolean
  /** The session a click on the header opens: one finished worker's own. */
  readonly child?: string
}

const lines = (text: string) => (text ? text.split("\n").map((line) => line.trimEnd()) : [])

/**
 * The group notice `messageID` draws. A notice outside any burst (a failure,
 * a shell) is its own burst of one, and says how it ended in its tone, as a
 * group's glyph and tail do: `● Worker finished`, `✗ Shell failed` (error),
 * `● Worker cancelled` (warning), then ` · ` and its task; its one node is
 * what it answered. A burst of several counts its agents
 * (`● 3 agents finished`), a node per agent with its task. None when the
 * message is not in `messages`.
 */
export function noticeGroup(messages: ReadonlyArray<Message>, messageID: string): NoticeGroup | undefined {
  const message = messages.find((item) => item.id === messageID)
  if (!message || message.type !== "synthetic") return undefined
  const folded = noticeBurst(messages, messageID)
  const burst = (folded.length > 0 ? folded : [message]).filter((item) => item.type === "synthetic")
  const metadata = message.metadata ?? {}
  const state = metadata.state
  const task = (item: SyntheticMessage) => (item.description ?? "").replace(/\s+/g, " ").trim()
  const childOf = (item: SyntheticMessage) =>
    item.metadata?.source === "subagent" && typeof item.metadata.childID === "string" ? item.metadata.childID : undefined
  const result = (item: SyntheticMessage) => lines(noticeResult(item.text))
  const drawn = burst[0]?.id === messageID
  if (burst.length > 1)
    return {
      drawn,
      glyph: { char: "●", tone: "muted" },
      // Counted as agents, as the launch group's header counts them.
      header: [{ text: `${burst.length} agents finished`, tone: "muted" }],
      nodes: burst.map((item) => {
        const child = childOf(item)
        return { label: task(item), lines: result(item), ...(child === undefined ? {} : { child }) }
      }),
      bad: false,
    }
  const actor =
    metadata.source === "shell" ? "Shell" : titlecase(typeof metadata.agent === "string" ? metadata.agent : "subagent")
  const ending =
    state === "error"
      ? { word: "failed", tone: "error" as const, glyph: { char: "✗", tone: "error" as const } }
      : state === "cancelled"
        ? { word: "cancelled", tone: "warning" as const, glyph: { char: "●", tone: "warning" as const } }
        : { word: "finished", tone: "muted" as const, glyph: { char: "●", tone: "muted" as const } }
  const described = task(message)
  const child = childOf(message)
  return {
    drawn,
    glyph: ending.glyph,
    header: [
      { text: `${actor} `, tone: "muted" },
      { text: ending.word, tone: ending.tone },
      ...(described ? [{ text: ` · ${described}`, tone: "muted" as const }] : []),
    ],
    nodes: [{ lines: result(message) }],
    bad: state === "error" || state === "cancelled",
    ...(child === undefined ? {} : { child }),
  }
}

/** Lines of a lone notice's answer that show below All, as a call's output head shows. */
export const NOTICE_HEAD = 5

/** One line of a notice's tree: what leads it (a connector, the tree's rail, or blank) and its words. */
export type NoticeLine = {
  readonly lead: "├" | "└" | "│" | " "
  readonly runs: ReadonlyArray<Run>
  /** The session a click on the line opens. */
  readonly child?: string
}

/**
 * The tree under a notice's header at a level, as fx hangs a call's output:
 * a node's first line behind its connector, the rest past it beside the
 * tree's rail while nodes follow. Below All a lone notice shows the head of
 * its answer and counts the rest (`… +N lines (ctrl+o)`), and a burst one line
 * per worker (`├ Fix money parsing · <first line>`); All shows every line.
 * The overview shows only a failure's or a cancel's first line.
 */
export function noticeLines(group: NoticeGroup, detail: Detail): NoticeLine[] {
  if (detail === "overview" && !group.bad) return []
  const count = group.nodes.length
  return group.nodes.flatMap((node, index): NoticeLine[] => {
    const last = index === count - 1
    const connector = last ? "└" : "├"
    const rail = last ? " " : "│"
    const [first = "", ...rest] = node.lines
    const click = node.child === undefined ? {} : { child: node.child }
    const head: NoticeLine = {
      lead: connector,
      runs:
        node.label === undefined
          ? [{ text: first, tone: "muted" }]
          : [{ text: node.label, tone: "muted" }, ...(first ? [{ text: ` · ${first}`, tone: "faint" as const }] : [])],
      ...click,
    }
    if (detail === "overview") return [head]
    // A named node is one line below All; a lone notice's answer shows its head.
    const room = detail === "all" ? rest.length : node.label === undefined ? NOTICE_HEAD - 1 : 0
    const shown = rest.slice(0, room)
    const hidden = rest.length - shown.length
    const tone = node.label === undefined ? ("muted" as const) : ("faint" as const)
    return [
      head,
      ...shown.map((line): NoticeLine => ({ lead: rail, runs: [{ text: line, tone }] })),
      ...(hidden > 0 && node.label === undefined
        ? [{ lead: rail, runs: [{ text: `… +${hidden} lines (ctrl+o)`, tone: "faint" as const }] } satisfies NoticeLine]
        : []),
    ]
  })
}

/**
 * Whether the notice group of `messageID` opens with a blank row: when the
 * message just above its burst is another stop notice's, whose group it
 * would otherwise touch (the host stacks notices tight, so a folded notice
 * adds no row).
 */
export function noticeApart(messages: ReadonlyArray<Message>, messageID: string): boolean {
  const folded = noticeBurst(messages, messageID)
  const first = folded[0]?.id ?? messageID
  const at = messages.findIndex((message) => message.id === first)
  return at > 0 && stopNotice(messages[at - 1])
}
