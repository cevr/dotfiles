// The fx-style tool-call group, without rendering: a step's run of calls
// reads as one header (`Read 3 files · ran 2 commands · 1 failed`) with one
// tree row per run of one tool under it.
import type { Plugin } from "@opencode/plugin/tui"
import type { SessionPart } from "@opencode/plugin/tui/context"
import { cellCalls, expand, operations, toolsInCode } from "./kernel"
import {
  editedFiles,
  toolInput,
  toolMetadata,
  toolOutput,
  toolPreview,
  subagentName,
  type EditedFile,
  type ToolPart,
} from "./view"

/** A session message, as the plugin API lists them. */
type SessionMessageInfo = ReturnType<Plugin.Context["data"]["session"]["message"]["list"]>[number]

/** Whether a part draws a transcript row: a call, or text or reasoning with words in it. */
function drawn(part: SessionPart) {
  if (part.type === "tool") return true
  if (!("text" in part) || typeof part.text !== "string") return false
  return part.text.replace("[REDACTED]", "").trim() !== ""
}

/** The longest pause between two subagent events that still reads as one burst. */
export const BURST_MS = 60_000

/**
 * Whether the transcript row just above a run is a call of another step. The
 * host gives each call its own row, so row gaps cannot tell two steps' groups
 * apart; the group's header adds the blank row between them itself.
 */
export function followsCall(messages: ReadonlyArray<SessionMessageInfo>, messageID: string, firstPartID: string): boolean {
  const at = messages.findIndex((message) => message.id === messageID)
  const message = messages[at]
  if (message?.type !== "assistant") return false
  const start = message.content.findIndex((part) => part.type === "tool" && part.id === firstPartID)
  const before = message.content.slice(0, Math.max(0, start)).filter(drawn).at(-1)
  if (before) return before.type === "tool"
  const previous = messages[at - 1]
  if (previous?.type !== "assistant") return false
  return previous.content.filter(drawn).at(-1)?.type === "tool"
}

/** How a call stands: still running (or streaming its input), ended well, ended with a warning, failed, or cut short. */
export type Outcome = "running" | "done" | "warning" | "failed" | "cancelled"

/** Whether a call that ended in error was cut short (the turn's interrupt, a cancel): the host's `aborted` errors. */
function cut(part: ToolPart) {
  if (part.state.status !== "error") return false
  const type = (part.state.error as { type?: unknown } | undefined)?.type
  return type === "aborted" || type === "tool.interrupted"
}

export function outcome(part: ToolPart): Outcome {
  if (part.state.status === "streaming" || part.state.status === "running") return "running"
  if (part.state.status === "error") return cut(part) ? "cancelled" : "failed"
  // A command that exits nonzero ended, but not well.
  const exit = toolMetadata(part).exit
  if (typeof exit === "number" && exit !== 0) return "warning"
  return "done"
}

/** The host's name for a tool, whatever the model called it (the host's `canonicalToolName`). */
export function canonical(name: string) {
  if (name === "bash") return "shell"
  if (name === "task") return "subagent"
  if (name === "apply_patch") return "patch"
  return name
}

/** A call with its canonical tool name. */
export type Call = { readonly tool: string; readonly part: ToolPart }

/** Whether a part ends a run: answer text with words in it. Reasoning and blank text do not. */
function answer(part: SessionPart) {
  return part.type === "text" && typeof part.text === "string" && part.text.replace("[REDACTED]", "").trim() !== ""
}

/**
 * The run of tool calls around `partID`, as fx draws one group: it spans the
 * steps of a turn, so reasoning and blank text between calls do not end it;
 * answer text, a message that is no step (a prompt, a notice) or a step that
 * only starts background agents (that burst is a group of its own) does. Each
 * kernel call stands as the calls its cell made (kernel.ts). Empty when
 * `partID` is no tool call of message `at`.
 */
export function toolRun(messages: ReadonlyArray<SessionMessageInfo>, at: number, partID: string): Call[] {
  const message = messages[at]
  if (message?.type !== "assistant") return []
  const index = message.content.findIndex((part) => part.type === "tool" && part.id === partID)
  if (index < 0) return []
  const parts: ToolPart[] = []
  // Back to the start of the run, then forward to its end.
  back: for (let step = at, from = index; step >= 0; step--) {
    const current = messages[step]
    if (current?.type !== "assistant" || (step !== at && launches(current))) break
    const content = current.content
    for (let i = step === at ? from : content.length - 1; i >= 0; i--) {
      const part = content[i]!
      if (answer(part)) break back
      if (part.type === "tool") parts.unshift(part)
    }
  }
  forward: for (let step = at; step < messages.length; step++) {
    const current = messages[step]
    if (current?.type !== "assistant" || (step !== at && launches(current))) break
    const content = current.content
    for (let i = step === at ? index + 1 : 0; i < content.length; i++) {
      const part = content[i]!
      if (answer(part)) break forward
      if (part.type === "tool") parts.push(part)
    }
  }
  return parts.flatMap((part) => expand({ tool: canonical(part.name), part }, canonical))
}

/** Whether a message is a step that only starts background agents: every row it draws is such a launch. */
function launches(message: SessionMessageInfo | undefined): boolean {
  if (message?.type !== "assistant") return false
  const shown = message.content.filter(drawn)
  return (
    shown.length > 0 &&
    shown.every((part) => part.type === "tool" && canonical(part.name) === "subagent" && background(part))
  )
}

/** Whether `next` starts within the burst window of `previous` ending. */
function close(previous: SessionMessageInfo, next: SessionMessageInfo) {
  const end = "completed" in previous.time && typeof previous.time.completed === "number" ? previous.time.completed : previous.time.created
  return next.time.created - end <= BURST_MS
}

/** The stretch of messages around `at` that `joins` links pairwise. */
function stretch<T>(items: ReadonlyArray<T>, at: number, joins: (previous: T, next: T) => boolean) {
  let start = at
  while (start > 0 && joins(items[start - 1]!, items[start]!)) start--
  let end = at
  while (end < items.length - 1 && joins(items[end]!, items[end + 1]!)) end++
  return items.slice(start, end + 1)
}

/**
 * The calls a call's group draws: its step's run, or, for a step that only
 * starts background agents, every such step next to it in the transcript,
 * each starting within the burst window of the one before.
 */
export function groupRun(messages: ReadonlyArray<SessionMessageInfo>, messageID: string, partID: string): Call[] {
  const at = messages.findIndex((message) => message.id === messageID)
  const message = messages[at]
  if (message?.type !== "assistant") return []
  if (!launches(message)) return toolRun(messages, at, partID)
  if (toolRun(messages, at, partID).length === 0) return []
  return stretch(messages, at, (previous, next) => launches(previous) && launches(next) && close(previous, next)).flatMap(
    (step) =>
      step.type === "assistant"
        ? step.content.flatMap((part) => (part.type === "tool" ? [{ tool: canonical(part.name), part }] : []))
        : [],
  )
}

/** Whether a message is a subagent's notice that it finished well. */
function finished(message: SessionMessageInfo | undefined): boolean {
  if (message?.type !== "synthetic") return false
  return message.metadata?.source === "subagent" && message.metadata?.state === "completed"
}

/**
 * The finished-worker notices a notice folds with: the ones next to it, each
 * within the burst window of the one before. Empty for any other message.
 */
export function noticeBurst(messages: ReadonlyArray<SessionMessageInfo>, messageID: string): SessionMessageInfo[] {
  const at = messages.findIndex((message) => message.id === messageID)
  if (!finished(messages[at])) return []
  return stretch(messages, at, (previous, next) => finished(previous) && finished(next) && close(previous, next))
}

const titlecase = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)

/** A burst's line: the host's `↳ Worker finished · task` for one, a count of agents and every task for several. */
export function completionWords(burst: ReadonlyArray<SessionMessageInfo>) {
  const agent = (message: SessionMessageInfo) =>
    message.type === "synthetic" && typeof message.metadata?.agent === "string" ? message.metadata.agent : "subagent"
  const task = (message: SessionMessageInfo) =>
    message.type === "synthetic" ? (message.description ?? "").replace(/\s+/g, " ").trim() : ""
  const first = burst[0]
  if (!first) return { heading: "", suffix: "" }
  const suffix = burst.map(task).filter(Boolean).join(", ")
  if (burst.length === 1) return { heading: `↳ ${titlecase(agent(first))} finished`, suffix }
  // Counted as agents, as the launch group's header counts them.
  return { heading: `↳ ${burst.length} agents finished`, suffix }
}

type Kind = { readonly key: string; readonly past: string; readonly running: string; readonly unit: (count: number) => string }

const plural = (word: string) => (count: number) => `${count} ${word}${count === 1 ? "" : "s"}`
const times = (word: string) => (count: number) => `${word} ${count}×`

/** Whether a subagent call runs in the background: it returns at once, and the agent's reply comes later. */
export function background(part: ToolPart) {
  return toolInput(part).background === true
}

/** What a call does, in words: one kind per tool family, as gent's header names them. */
export function kind(tool: string, part?: ToolPart): Kind {
  if (tool === "read") return { key: "read", past: "Read", running: "Reading", unit: plural("file") }
  if (tool === "grep" || tool === "glob")
    return { key: "search", past: "Searched", running: "Searching", unit: plural("pattern") }
  if (tool === "websearch") return { key: "websearch", past: "Searched", running: "Searching", unit: times("the web") }
  if (tool === "webfetch") return { key: "webfetch", past: "Fetched", running: "Fetching", unit: plural("page") }
  if (tool === "patch" || tool === "edit") return { key: "edit", past: "Edited", running: "Editing", unit: plural("file") }
  if (tool === "write") return { key: "write", past: "Wrote", running: "Writing", unit: plural("file") }
  if (tool === "shell") return { key: "shell", past: "Ran", running: "Running", unit: plural("command") }
  if (tool === "kernel") return { key: "kernel", past: "Ran", running: "Running", unit: plural("cell") }
  if (tool === "subagent" && part && background(part))
    return { key: "subagent-start", past: "Started", running: "Starting", unit: plural("agent") }
  if (tool === "subagent") return { key: "subagent", past: "Ran", running: "Running", unit: plural("agent") }
  if (tool === "question") return { key: "question", past: "Asked", running: "Asking", unit: plural("question") }
  return { key: tool, past: "", running: "", unit: times(tool) }
}

/** A cell whose code spells out no call it can name: `ran code`, never the code (gent's `CODE_KIND`). */
const CODE: Kind = {
  key: "code",
  past: "Ran",
  running: "Running",
  unit: (count) => (count === 1 ? "code" : `code ${count}×`),
}

/**
 * The kinds one call counts as, each with its units. A kernel call that
 * recorded no calls counts the calls its code spells out (`cellCalls`), else
 * `code`; the kernel call left after a recorded cell's calls counts as code
 * while it computes and only among the failures once it ends. An edit counts
 * its files.
 */
function tallies(call: Call): Array<{ readonly kind: Kind; readonly units: number }> {
  if (call.tool === "kernel") {
    if (operations(call.part).length > 0) return outcome(call.part) === "running" ? [{ kind: CODE, units: 1 }] : []
    const spelled = cellCalls(String(toolInput(call.part).code ?? ""))
    if (spelled.length === 0) return [{ kind: CODE, units: 1 }]
    return spelled.map((spell) => ({ kind: kind(canonical(spell.tool)), units: 1 }))
  }
  const which = kind(call.tool, call.part)
  return [{ kind: which, units: which.key === "edit" ? Math.max(1, editedFiles(call.part).length) : 1 }]
}

/** One stretch of the header or a row, with the tone it is drawn in. */
export type Run = { readonly text: string; readonly tone: "muted" | "error" | "warning" }

/** `text` cut to `width` columns, an ellipsis marking the cut. */
export function truncate(text: string, width: number) {
  if (text.length <= width) return text
  if (width <= 1) return text.slice(0, Math.max(0, width))
  return `${text.slice(0, width - 1)}…`
}

/**
 * The header's words, as gent's `activityHeaderRuns`: ended kinds first, the
 * largest count first (ties keep the order they ran in), then the kinds
 * still running, then the failures and the cancels. Only the first phrase is
 * capitalised. Wider than `width` columns, kinds drop from the right; the
 * first kind, the failures and the cancels stay.
 */
export function headerRuns(calls: ReadonlyArray<Call>, width = Number.POSITIVE_INFINITY): Run[] {
  const counts = (running: boolean) => {
    const order: string[] = []
    const totals = new Map<string, { kind: Kind; count: number }>()
    for (const call of calls) {
      if ((outcome(call.part) === "running") !== running) continue
      for (const tally of tallies(call)) {
        const entry = totals.get(tally.kind.key)
        if (entry) entry.count += tally.units
        else {
          order.push(tally.kind.key)
          totals.set(tally.kind.key, { kind: tally.kind, count: tally.units })
        }
      }
    }
    return order.map((key) => totals.get(key)!)
  }
  const phrase = (entry: { kind: Kind; count: number }, running: boolean, first: boolean) => {
    const verb = running ? entry.kind.running : entry.kind.past
    if (!verb) return entry.kind.unit(entry.count)
    return `${first ? verb : verb.toLowerCase()} ${entry.kind.unit(entry.count)}`
  }
  const ended = counts(false).toSorted((a, b) => b.count - a.count)
  const phrases = [
    ...ended.map((entry) => ({ entry, running: false })),
    ...counts(true).map((entry) => ({ entry, running: true })),
  ].map((item, index) => phrase(item.entry, item.running, index === 0))
  const failed = calls.filter((call) => outcome(call.part) === "failed").length
  const cancelled = calls.filter((call) => outcome(call.part) === "cancelled").length
  const tail: Run[] = [
    ...(failed ? [{ text: `${failed} failed`, tone: "error" as const }] : []),
    ...(cancelled ? [{ text: `${cancelled} cancelled`, tone: "warning" as const }] : []),
  ]
  const parts = (kept: number): Run[] => [
    ...(kept > 0 ? [{ text: phrases.slice(0, kept).join(" · "), tone: "muted" as const }] : []),
    ...tail,
  ]
  const text = (kept: number) => parts(kept).map((part) => part.text).join(" · ")
  let kept = phrases.length
  while (kept > 1 && text(kept).length > width) kept--
  return parts(kept).flatMap((part, index) => (index === 0 ? [part] : [{ text: " · ", tone: "muted" as const }, part]))
}

/** One tree row: a run of calls to one tool with one outcome, named by its first call. */
export type Row = {
  readonly tool: string
  readonly outcome: Outcome
  readonly calls: ReadonlyArray<ToolPart>
  /** The call the row is drawn under: its first. */
  readonly owner: string
}

/**
 * The tree rows of a run: calls to one tool with one outcome fold into a
 * row; a failure, a cancel, a nonzero exit or an agent always stands alone.
 */
export function rows(calls: ReadonlyArray<Call>): Row[] {
  const result: Row[] = []
  for (const call of calls) {
    const state = outcome(call.part)
    const last = result.at(-1)
    const same = last && last.tool === call.tool && kind(last.tool, last.calls[0]).key === kind(call.tool, call.part).key
    const alone = state === "failed" || state === "warning" || state === "cancelled"
    // Each agent keeps its own row: it is a worker to follow, not one of a batch of reads.
    if (last && same && last.outcome === state && !alone && call.tool !== "subagent")
      result[result.length - 1] = { ...last, calls: [...last.calls, call.part] }
    else result.push({ tool: call.tool, outcome: state, calls: [call.part], owner: call.part.id })
  }
  return result
}

/** A tree row's place: its connector (none for a row alone) and whether its body keeps the rail. */
export type Branch = { readonly connector?: "├" | "└"; readonly rail: boolean }

/**
 * Where row `index` of `count` sits in the tree: its connector, `├` while
 * rows follow and `└` on the last, and whether what hangs under it keeps the
 * tree's `│` rail, as fx's continuation rows do (`│ ` while rows follow,
 * blank past the last). A row `alone` is the group's line, behind the
 * group's glyph: no connector and no rail. Every level draws its rows by it.
 */
export function branch(index: number, count: number, alone: boolean): Branch {
  if (alone) return { rail: false }
  const last = index >= count - 1
  return { connector: last ? "└" : "├", rail: !last }
}

/**
 * What hangs under one call's row at the all level: each edited file's
 * whole diff, the agent's reply for a foreground subagent that finished, and
 * the output's tail (none for a patch, whose diff says it). Empty when the
 * row has nothing under it.
 */
export function callBody(call: Call): {
  readonly files: ReadonlyArray<EditedFile>
  readonly reply: boolean
  readonly output: string
} {
  return {
    files: editedFiles(call.part),
    reply: call.tool === "subagent" && call.part.state.status === "completed" && !background(call.part),
    output: call.tool === "patch" ? "" : toolOutput(call.part),
  }
}

/** Whether a call's all-level body draws anything. */
export function hasBody(body: ReturnType<typeof callBody>) {
  return body.files.length > 0 || body.reply || body.output !== ""
}

/**
 * Subjects joined by commas, as many as fit `width` columns, then `+N`
 * counting the rest (gent's `formatActivityRow`). The first always shows.
 */
export function listed(subjects: ReadonlyArray<string>, width = Number.POSITIVE_INFINITY) {
  const text = (kept: number) => {
    const shown = subjects.slice(0, kept).join(", ")
    return kept < subjects.length ? `${shown} +${subjects.length - kept}` : shown
  }
  let kept = subjects.length
  while (kept > 1 && text(kept).length > width) kept--
  return text(kept)
}

/** A row's subject: what its calls touched, as one line of at most `width` columns' worth of subjects. */
export function subject(row: Row, width = Number.POSITIVE_INFINITY): string {
  const first = row.calls[0]!
  // Cells that recorded no calls (kernel.ts): their count, and the tools their code spells out, once each.
  if (row.tool === "kernel") {
    const names = [...new Set(row.calls.flatMap((part) => toolsInCode(String(toolInput(part).code ?? ""))))]
    const cells = row.calls.length === 1 ? "a cell" : `${row.calls.length} cells`
    return names.length > 0 ? `${cells} calling ${names.join(", ")}` : cells
  }
  if (row.tool === "grep") {
    const input = toolInput(first)
    const path = typeof input.path === "string" ? ` in ${input.path}` : ""
    return `/${String(input.pattern ?? "")}/${path}`
  }
  if (row.tool === "subagent") {
    const input = toolInput(first)
    // The description is the model's own short label for the task; the prompt is the brief behind it.
    if (typeof input.description === "string" && input.description.trim()) return input.description.trim()
    const task = toolPreview("subagent", input)
    return task ? `${subagentName(input)} · ${task}` : subagentName(input)
  }
  return listed(
    row.calls.map((part) => toolPreview(row.tool, toolInput(part))),
    width,
  )
}

/**
 * What a row says ended it, after gent's `failureWord`: a command's exit
 * status, `failed`, or `cancelled`, in its tone. None for a row that ran or
 * still runs.
 */
export function rowEnding(row: Row): Run | undefined {
  if (row.outcome === "cancelled") return { text: "cancelled", tone: "warning" }
  if (row.outcome !== "failed" && row.outcome !== "warning") return undefined
  const exit = toolMetadata(row.calls[0]!).exit
  if (typeof exit === "number" && exit !== 0) return { text: `exit ${exit}`, tone: "error" }
  return { text: "failed", tone: "error" }
}

/** The narrowest reason a failure line still draws: a word's start and the ellipsis. */
const MIN_REASON = 4

/**
 * A failure as the collapsed level's one line under the header, after gent's
 * `failureRowRuns`: `Read a.ts · failed · File not found: a.ts`, `Ran pytest
 * · exit 1`. Narrow, the reason is cut, then dropped; the verb and the ending
 * always show. `width` counts the columns after the connector.
 */
export function failureRuns(row: Row, width = Number.POSITIVE_INFINITY): Run[] {
  const ending = rowEnding(row)
  const head = `${verb(row)} ${subject(row)}`.trim()
  if (!ending) return [{ text: truncate(head, width), tone: "muted" }]
  const tail = ` · ${ending.text}`
  const reason = (errorText(row.calls[0]!).split("\n")[0] ?? "").trim()
  const room = width - head.length - tail.length - 3
  const shown: Run[] = [
    { text: truncate(head, Math.max(verb(row).length, width - tail.length)), tone: "muted" },
    { text: " · ", tone: "muted" },
    ending,
  ]
  if (reason && room >= Math.min(MIN_REASON, reason.length)) shown.push({ text: ` · ${truncate(reason, room)}`, tone: "muted" })
  return shown
}

/** The row's verb, in the tense of its outcome; empty for a tool with no verb. */
export function verb(row: Row) {
  const which = kind(row.tool, row.calls[0])
  if (!which.past) return row.tool
  return row.outcome === "running" ? which.running : which.past
}

/** The edited files of an edit row, with their line counts. */
export function rowFiles(row: Row) {
  return row.calls.flatMap((part) => editedFiles(part))
}

/** The full error text of a failed call, for the lines under its row. */
export function errorText(part: ToolPart): string {
  if (part.state.status !== "error") return ""
  const error = part.state.error as { message?: unknown } | undefined
  return typeof error?.message === "string" ? error.message : ""
}
