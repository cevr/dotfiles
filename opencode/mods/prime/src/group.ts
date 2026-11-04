// The fx-style tool-call group, without rendering: a step's run of calls
// reads as one header (`Read 3 files · ran 2 commands · 1 failed`) with one
// tree row per run of one tool under it.
import type { SessionPart } from "@opencode/plugin/tui/context"
import { editedFiles, errorName, toolInput, toolMetadata, toolPreview, subagentName, type ToolPart } from "./view"

/** How a call stands: still running (or streaming its input), ended well, ended with a warning, or failed. */
export type Outcome = "running" | "done" | "warning" | "failed"

export function outcome(part: ToolPart): Outcome {
  if (part.state.status === "streaming" || part.state.status === "running") return "running"
  if (part.state.status === "error") return "failed"
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

/** The run of tool calls next to each other in a message that holds `partID`; empty when it is not a tool call. */
export function toolRun(content: ReadonlyArray<SessionPart>, partID: string): Call[] {
  const at = content.findIndex((part) => part.type === "tool" && part.id === partID)
  if (at < 0) return []
  let start = at
  while (start > 0 && content[start - 1]!.type === "tool") start--
  let end = at
  while (end < content.length - 1 && content[end + 1]!.type === "tool") end++
  return (content.slice(start, end + 1) as ToolPart[]).map((part) => ({ tool: canonical(part.name), part }))
}

type Kind = { readonly key: string; readonly past: string; readonly running: string; readonly unit: (count: number) => string }

const plural = (word: string) => (count: number) => `${count} ${word}${count === 1 ? "" : "s"}`
const times = (word: string) => (count: number) => `${word} ${count}×`

/** What a tool does, in words: one kind per tool family, as gent's header names them. */
export function kind(tool: string): Kind {
  if (tool === "read") return { key: "read", past: "Read", running: "Reading", unit: plural("file") }
  if (tool === "grep" || tool === "glob")
    return { key: "search", past: "Searched", running: "Searching", unit: plural("pattern") }
  if (tool === "websearch") return { key: "websearch", past: "Searched", running: "Searching", unit: times("the web") }
  if (tool === "webfetch") return { key: "webfetch", past: "Fetched", running: "Fetching", unit: plural("page") }
  if (tool === "patch" || tool === "edit") return { key: "edit", past: "Edited", running: "Editing", unit: plural("file") }
  if (tool === "write") return { key: "write", past: "Wrote", running: "Writing", unit: plural("file") }
  if (tool === "shell") return { key: "shell", past: "Ran", running: "Running", unit: plural("command") }
  if (tool === "kernel") return { key: "kernel", past: "Ran", running: "Running", unit: plural("cell") }
  if (tool === "subagent") return { key: "subagent", past: "Ran", running: "Running", unit: plural("agent") }
  if (tool === "question") return { key: "question", past: "Asked", running: "Asking", unit: plural("question") }
  return { key: tool, past: "", running: "", unit: times(tool) }
}

/** How many units one call counts for: an edit counts its files. */
function units(tool: string, part: ToolPart) {
  if (kind(tool).key === "edit") return Math.max(1, editedFiles(part).length)
  return 1
}

/** One stretch of the header, with the tone it is drawn in. */
export type Run = { readonly text: string; readonly tone: "muted" | "error" }

/**
 * The header's words: ended kinds first, the largest count first (ties keep
 * the order they ran in), then the kinds still running, then the failures.
 * Only the first phrase is capitalised.
 */
export function headerRuns(calls: ReadonlyArray<Call>): Run[] {
  const counts = (running: boolean) => {
    const order: string[] = []
    const totals = new Map<string, { kind: Kind; count: number }>()
    for (const call of calls) {
      if ((outcome(call.part) === "running") !== running) continue
      const which = kind(call.tool)
      const entry = totals.get(which.key)
      if (entry) entry.count += units(call.tool, call.part)
      else {
        order.push(which.key)
        totals.set(which.key, { kind: which, count: units(call.tool, call.part) })
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
  const runs: Run[] = [{ text: phrases.join(" · "), tone: "muted" }]
  const failed = calls.filter((call) => outcome(call.part) === "failed").length
  if (failed) runs.push({ text: " · ", tone: "muted" }, { text: `${failed} failed`, tone: "error" })
  return runs
}

/** One tree row: a run of calls to one tool with one outcome, named by its first call. */
export type Row = {
  readonly tool: string
  readonly outcome: Outcome
  readonly calls: ReadonlyArray<ToolPart>
  /** The call the row is drawn under: its first. */
  readonly owner: string
}

/** The tree rows of a run: calls to one tool with one outcome fold into a row; a failure always stands alone. */
export function rows(calls: ReadonlyArray<Call>): Row[] {
  const result: Row[] = []
  for (const call of calls) {
    const state = outcome(call.part)
    const last = result.at(-1)
    if (last && last.tool === call.tool && last.outcome === state && state !== "failed" && state !== "warning")
      result[result.length - 1] = { ...last, calls: [...last.calls, call.part] }
    else result.push({ tool: call.tool, outcome: state, calls: [call.part], owner: call.part.id })
  }
  return result
}

/** A row's subject: what its calls touched, as one line. */
export function subject(row: Row): string {
  const first = row.calls[0]!
  if (row.tool === "read") return row.calls.map((part) => toolPreview("read", toolInput(part))).join(", ")
  if (row.tool === "grep") {
    const input = toolInput(first)
    const path = typeof input.path === "string" ? ` in ${input.path}` : ""
    return `/${String(input.pattern ?? "")}/${path}`
  }
  if (row.tool === "subagent") {
    const input = toolInput(first)
    const task = toolPreview("subagent", input)
    return task ? `${subagentName(input)} · ${task}` : subagentName(input)
  }
  return row.calls.map((part) => toolPreview(row.tool, toolInput(part))).join(", ")
}

/** The row's verb, in the tense of its outcome; empty for a tool with no verb. */
export function verb(row: Row) {
  const which = kind(row.tool)
  if (!which.past) return row.tool
  return row.outcome === "running" ? which.running : which.past
}

/** The edited files of an edit row, with their line counts. */
export function rowFiles(row: Row) {
  return row.calls.flatMap((part) => editedFiles(part))
}

/** Why a row ended badly, in a few words: the exit code, or the error's name. */
export function rowReason(row: Row): string | undefined {
  const part = row.calls[0]!
  const exit = toolMetadata(part).exit
  if (typeof exit === "number" && exit !== 0) return `exit ${exit}`
  return errorName(part)
}

/** The full error text of a failed call, for the lines under its row. */
export function errorText(part: ToolPart): string {
  if (part.state.status !== "error") return ""
  const error = part.state.error as { message?: unknown } | undefined
  return typeof error?.message === "string" ? error.message : ""
}
