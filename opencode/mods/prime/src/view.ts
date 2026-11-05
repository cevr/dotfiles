// Pure helpers for the Prime look: what one transcript row says, without
// any rendering.
import type { SessionPart } from "@opencode/plugin/tui/context"
import { toolsInCode } from "./kernel"

/** One tool call of an assistant message. */
export type ToolPart = Extract<SessionPart, { type: "tool" }>

/** How much of each tool call the transcript shows; Ctrl+O cycles it. */
export type Detail = "overview" | "details" | "all"

export const details: readonly Detail[] = ["overview", "details", "all"]

export function nextDetail(current: Detail): Detail {
  return details[(details.indexOf(current) + 1) % details.length] ?? "overview"
}

export function detailHint(detail: Detail) {
  if (detail === "overview") return "Collapsed mode (Ctrl+O to expand)"
  if (detail === "details") return "Details mode (Ctrl+O to expand)"
  return "Expanded mode (Ctrl+O to collapse)"
}

export type ToolStatus = "queued" | "running" | "done" | "failed"

export function toolStatus(part: ToolPart): ToolStatus {
  if (part.state.status === "streaming") return "queued"
  if (part.state.status === "running") return "running"
  if (part.state.status === "error") return "failed"
  return "done"
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

export function toolInput(part: ToolPart) {
  return typeof part.state.input === "string" ? {} : record(part.state.input)
}

export function toolMetadata(part: ToolPart) {
  if (part.state.status === "streaming" || part.state.status === "running") return {}
  return record(part.state.metadata)
}

// The one input field that best stands for the call, as the row's preview
// and the source of the `↑` line count.
export function toolSource(tool: string, input: Record<string, unknown>) {
  if (tool === "shell") return text(input.command) ?? ""
  if (tool === "patch") return text(input.patchText) ?? ""
  if (tool === "read") return text(input.path) ?? text(input.filePath) ?? ""
  if (tool === "grep") return [text(input.pattern), text(input.path)].filter(Boolean).join(" in ")
  if (tool === "glob") return text(input.pattern) ?? ""
  if (tool === "subagent") return text(input.prompt) ?? text(input.description) ?? ""
  return Object.entries(input)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ")
}

export function toolPreview(tool: string, input: Record<string, unknown>) {
  // A cell is named by the tools its code calls, never by its code: the
  // calls it recorded draw in its place when it has them (kernel.ts).
  if (tool === "kernel") {
    const names = toolsInCode(text(input.code) ?? "")
    return names.length > 0 ? `cell calling ${names.join(", ")}` : "cell"
  }
  if (tool === "patch") {
    const files = [...toolSource(tool, input).matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(
      (match) => match[1],
    )
    if (files.length) return files.join(", ")
  }
  // One line: the first line of the source, with a trailing ellipsis when
  // more lines follow.
  const source = toolSource(tool, input).trim()
  const [first = "", ...rest] = source.split("\n")
  return rest.some((line) => line.trim()) ? `${first}…` : first
}

export function toolOutput(part: ToolPart) {
  if (part.state.status === "streaming" || part.state.status === "running") return ""
  const output = (part.state.content ?? []).flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
  // A subagent's answer arrives wrapped in a <subagent ...> envelope; show the message only.
  return output.replace(/^<\/?subagent\b[^>]*>\n?/gm, "")
}

function lines(value: string) {
  const trimmed = value.replace(/\n+$/, "")
  return trimmed ? trimmed.split("\n") : []
}

/** `↑` counts non-empty source lines; `↓` counts output lines, and is dropped for edits. */
export function lineCounts(tool: string, part: ToolPart) {
  const up = lines(toolSource(tool, toolInput(part))).filter((line) => line.trim()).length
  if (tool === "patch" || part.state.status !== "completed") return { up, down: undefined }
  return { up, down: lines(toolOutput(part)).length }
}

export function countLabel(counts: { up: number; down?: number }) {
  return counts.down === undefined ? `↑ ${counts.up} lines` : `↑ ${counts.up} ↓ ${counts.down} lines`
}

export function duration(part: ToolPart) {
  if (part.time.completed === undefined) return undefined
  const ms = Math.max(0, part.time.completed - (part.time.ran ?? part.time.created))
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`
}

/**
 * The short error name shown in red at the end of a failed row: the head of
 * the message ("File not found"), or the error type when there is none.
 */
export function errorName(part: ToolPart) {
  if (part.state.status !== "error") return undefined
  const error = record(part.state.error)
  const head = (text(error.message) ?? "").split("\n")[0]!.split(":")[0]!.trim()
  if (head && head.length <= 40) return head
  return text(error.type)?.split(".").at(-1) ?? "error"
}

export type EditedFile = { path: string; additions: number; deletions: number; patch: string }

export function editedFiles(part: ToolPart): EditedFile[] {
  const files = toolMetadata(part).files
  if (!Array.isArray(files)) return []
  return files.flatMap((value) => {
    const file = record(value)
    const path = text(file.relativePath) ?? text(file.file) ?? text(file.filePath)
    const patch = text(file.patch)
    if (!path || patch === undefined) return []
    return [
      {
        path,
        patch,
        additions: typeof file.additions === "number" ? file.additions : 0,
        deletions: typeof file.deletions === "number" ? file.deletions : 0,
      },
    ]
  })
}

export type DiffRow = { kind: "context" | "added" | "removed"; line: number; text: string } | { kind: "gap" }

/**
 * Unified-diff rows numbered the way Prime numbers them: a removed row by
 * its old line, every other row by its new line. `context` is how many
 * unchanged rows to keep around each change; Infinity keeps the whole hunk.
 */
export function diffRows(patch: string, context: number): DiffRow[] {
  const hunks: DiffRow[][] = []
  let oldLine = 0
  let newLine = 0
  let current: DiffRow[] | undefined
  for (const raw of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      current = []
      hunks.push(current)
      continue
    }
    if (!current || raw.startsWith("\\")) continue
    if (raw.startsWith("-") && !raw.startsWith("---"))
      current.push({ kind: "removed", line: oldLine++, text: raw.slice(1) })
    else if (raw.startsWith("+") && !raw.startsWith("+++"))
      current.push({ kind: "added", line: newLine++, text: raw.slice(1) })
    else if (raw.startsWith(" ") || raw === "") {
      current.push({ kind: "context", line: newLine, text: raw.slice(1) })
      oldLine++
      newLine++
    }
  }
  const trimmed = hunks.map((rows) => {
    // Drop the trailing empty context row a final newline leaves behind.
    while (rows.at(-1)?.kind === "context" && (rows.at(-1) as { text: string }).text === "") rows.pop()
    if (context === Infinity) return rows
    const changed = rows.flatMap((row, index) => (row.kind === "context" ? [] : [index]))
    return rows.filter((_, index) => changed.some((at) => Math.abs(at - index) <= context))
  })
  return trimmed.flatMap((rows, index) => (index === 0 ? rows : [{ kind: "gap" } as DiffRow, ...rows]))
}

/** Token counts the way Prime's tray shows them: `850`, `64k`, `1.2M`. */
export function compactTokens(tokens: number) {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

/** Whole seconds under a minute, then `1m 05s`. */
export function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
}

/** The name a subagent call shows: its short description, else the agent. */
export function subagentName(input: Record<string, unknown>) {
  return text(input.description) ?? text(input.agent) ?? "subagent"
}

/** What ended a step, as the host keeps it on the assistant message. */
export type StepEnd = {
  readonly error?: { readonly type: string; readonly message: string }
  readonly retry?: { readonly attempt: number; readonly at: number; readonly error: { readonly message: string } }
}

/** The lines a step's error keeps below All: a provider body can run long (gent's `ERROR_LINES`). */
export const ERROR_LINES = 4

/**
 * The row a step's end draws, after gent's session rows: `↻` a retry
 * (`Retrying in 3s · attempt 2 · Rate limit exceeded`, `Retrying now` once
 * due), `■` the reader's interrupt, `✗` an error that ended the turn (its
 * first `ERROR_LINES` lines below All, then the count of the rest). None for
 * a step that ended well.
 */
export function stepEndRow(
  end: StepEnd,
  now: number,
  detail: Detail,
): { readonly glyph: string; readonly tone: "muted" | "warning" | "error"; readonly text: string } | undefined {
  const firstLine = (text: string) => (text.split("\n")[0] ?? "").trim()
  if (end.retry) {
    const seconds = Math.ceil((end.retry.at - now) / 1000)
    const reason = firstLine(end.retry.error.message)
    const when = seconds > 0 ? `Retrying in ${seconds}s` : "Retrying now"
    return { glyph: "↻", tone: "muted", text: [when, `attempt ${end.retry.attempt}`, reason].filter(Boolean).join(" · ") }
  }
  if (!end.error) return undefined
  if (end.error.message === "Step interrupted") return { glyph: "■", tone: "warning", text: "Interrupted" }
  const lines = end.error.message.replace(/\s+$/, "").split("\n")
  const capped =
    detail === "all" || lines.length <= ERROR_LINES
      ? lines
      : [...lines.slice(0, ERROR_LINES), `… +${lines.length - ERROR_LINES} lines (ctrl+o)`]
  return { glyph: "✗", tone: "error", text: capped.join("\n") }
}
