// One tool call as a transcript row reads it, without rendering: its tool
// under the host's canonical name, how it stands, the words that stand for
// it (its preview, its line counts, its time) and what it touched.
import { toolsInCode } from "./kernel.ts"
import type { Fields, ToolPart } from "./session.ts"

/**
 * A call with its canonical tool name, and, for a kernel cell's call or a
 * call the cell made, the cell's own description of what it does (kernel.ts).
 */
export type Call = { readonly tool: string; readonly part: ToolPart; readonly cell?: string }

/** The host's name for a tool, whatever the model called it (the host's `canonicalToolName`). */
export function canonical(name: string) {
  if (name === "bash") return "shell"
  if (name === "task") return "subagent"
  if (name === "apply_patch") return "patch"
  return name
}

function record(value: unknown): Fields {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

/** A call's input: empty while it still streams in. */
export function toolInput(part: ToolPart): Fields {
  return part.state.status === "streaming" ? {} : part.state.input
}

/** A call's final metadata: empty until it ends. */
export function toolMetadata(part: ToolPart): Fields {
  if (part.state.status === "streaming" || part.state.status === "running") return {}
  return part.state.metadata ?? {}
}

/** How a call stands: still running (or streaming its input), ended well, ended with a warning, failed, or cut short. */
export type Outcome = "running" | "done" | "warning" | "failed" | "cancelled"

/** Whether a call that ended in error was cut short (the turn's interrupt, a cancel): the host's `aborted` errors. */
function cut(part: ToolPart) {
  if (part.state.status !== "error") return false
  const type = part.state.error.type
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

/**
 * Whether the host moved a shell call to the background, by its time limit
 * or the reader's ctrl+b: its result came back while the command still ran.
 */
export function movedToBackground(part: ToolPart) {
  if (part.state.status !== "completed") return false
  const moved = toolMetadata(part).backgrounded
  return moved === "limit" || moved === "user"
}

/** Whether a subagent call runs in the background: it returns at once, and the agent's reply comes later. */
export function background(part: ToolPart) {
  return toolInput(part).background === true
}

/** The glyph and tone of the all level's one-call row: `✓` done, `✗` failed, a warning `✓`, `◆` while it runs or was cut. */
export function callGlyph(part: ToolPart): { readonly char: string; readonly tone: "success" | "error" | "warning" } {
  const state = outcome(part)
  if (state === "done") return { char: "✓", tone: "success" }
  if (state === "failed") return { char: "✗", tone: "error" }
  if (state === "warning") return { char: "✓", tone: "warning" }
  return { char: "◆", tone: "success" }
}

// The one input field that best stands for the call, as the row's preview
// and the source of the `↑` line count.
export function toolSource(tool: string, input: Fields) {
  if (tool === "shell") return text(input.command) ?? ""
  if (tool === "patch") return text(input.patchText) ?? ""
  if (tool === "read") return text(input.path) ?? text(input.filePath) ?? ""
  if (tool === "grep") return [text(input.pattern), text(input.path)].filter(Boolean).join(" in ")
  if (tool === "glob") return text(input.pattern) ?? ""
  if (tool === "subagent") return text(input.prompt) ?? text(input.description) ?? ""
  if (tool === "shell_read" || tool === "shell_kill") return text(input.id) ?? ""
  if (tool === "shell_list") return "shells"
  return Object.entries(input)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ")
}

/**
 * The words a call's row shows for it. A kernel cell is named by the tools
 * its code calls, never by its code: the calls it recorded draw in its place
 * when it has them (kernel.ts).
 */
export function toolPreview(tool: string, input: Fields) {
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

export function countLabel(counts: { up: number; down?: number | undefined }) {
  return counts.down === undefined ? `↑ ${counts.up} lines` : `↑ ${counts.up} ↓ ${counts.down} lines`
}

/** When a call started running: its start, else when it was made. */
export function startOf(part: ToolPart) {
  return part.time.ran ?? part.time.created
}

export function duration(part: ToolPart) {
  if (part.time.completed === undefined) return undefined
  return span(part.time.completed - startOf(part))
}

/** A stretch of time as a row's tail writes it: `12ms`, `4.2s`, `3m 05s`. */
export function span(time: number) {
  const ms = Math.max(0, time)
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`
}

/** The full error text of a failed call, for the lines under its row. */
export function errorText(part: ToolPart): string {
  if (part.state.status !== "error") return ""
  const message = part.state.error.message
  return typeof message === "string" ? message : ""
}

/**
 * The short error name shown in red at the end of a failed row: the head of
 * the message ("File not found"), or the error type when there is none.
 */
export function errorName(part: ToolPart) {
  if (part.state.status !== "error") return undefined
  const head = (errorText(part).split("\n")[0] ?? "").split(":")[0]?.trim() ?? ""
  if (head && head.length <= 40) return head
  return text(part.state.error.type)?.split(".").at(-1) ?? "error"
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

/** The name a subagent call shows: its short description, else the agent. */
export function subagentName(input: Fields) {
  return text(input.description) ?? text(input.agent) ?? "subagent"
}
