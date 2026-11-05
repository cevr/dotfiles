// The working label: what runs now, in a few words, for herdr's state label
// (`kernel: fetch the docs`, `shell: bun test`, `3 subagents`).

/** One running tool call: its name as the model called it, its input, and when it started (ms). */
export interface RunningTool {
  readonly tool: string
  readonly input: Readonly<Record<string, unknown>>
  readonly at: number
}

/** The longest label, in characters; herdr itself caps a label at 80. */
export const LABEL_LIMIT = 60

/** The host's name for a tool, whatever the model called it (the host's `canonicalToolName`). */
export const canonical = (name: string) => {
  if (name === "bash") return "shell"
  if (name === "task") return "subagent"
  if (name === "apply_patch") return "patch"
  return name
}

/** A C0 or C1 control character, which herdr strips or refuses. */
export const isControl = (char: string) => {
  const code = char.codePointAt(0) ?? 0
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
}

/** One line: control characters and runs of whitespace become one space. */
export const oneLine = (text: string) =>
  Array.from(text, (char) => (isControl(char) ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim()

/** `text` on one line in at most `limit` characters, cut with an ellipsis. */
export const clip = (text: string, limit: number = LABEL_LIMIT) => {
  const line = oneLine(text)
  const chars = Array.from(line)
  if (chars.length <= limit) return line
  return `${chars.slice(0, Math.max(0, limit - 1)).join("").trimEnd()}…`
}

/** The first line of source that says something, without a comment's markers. */
export const firstLine = (source: string) => {
  for (const raw of source.split("\n")) {
    const line = raw
      .trim()
      .replace(/^(\/\/+|\/\*+|\*+\/?|#+)\s*/, "")
      .replace(/\s*\*+\/$/, "")
      .trim()
    if (line) return line
  }
  return ""
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined)

/** What a call is about: the one input field that stands for it. */
const subject = (tool: string, input: Readonly<Record<string, unknown>>) => {
  if (tool === "kernel") return firstLine(text(input.code) ?? "")
  if (tool === "shell") return firstLine(text(input.command) ?? "")
  if (tool === "subagent") return text(input.description) ?? firstLine(text(input.prompt) ?? "")
  if (tool === "read" || tool === "write" || tool === "edit") return text(input.path) ?? text(input.filePath) ?? ""
  if (tool === "grep" || tool === "glob") return text(input.pattern) ?? ""
  if (tool === "webfetch") return text(input.url) ?? ""
  if (tool === "websearch") return text(input.query) ?? ""
  if (tool === "patch") {
    const files = [...(text(input.patchText) ?? "").matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => match[1])
    return files.join(", ")
  }
  return ""
}

/** One call's label: `<tool>: <what it is about>`, or the tool alone. */
export const toolLabel = (call: RunningTool, limit: number = LABEL_LIMIT) => {
  const tool = canonical(call.tool)
  const about = oneLine(subject(tool, call.input))
  return clip(about ? `${tool}: ${about}` : tool, limit)
}

const subagents = (count: number) => `${count} subagent${count === 1 ? "" : "s"}`

/**
 * The working label: the most recently started running call that is not a
 * subagent call, then how many subagents run (`kernel: x · 2 subagents`); a
 * count alone when only subagents run; nothing when nothing does (the model
 * is thinking or writing). A subagent call stands for its subagent, which the
 * count already shows. The call's words give way so the count always fits.
 */
export const workingLabel = (tools: ReadonlyArray<RunningTool>, runningSubagents: number): string | undefined => {
  const latest = tools
    .filter((call) => canonical(call.tool) !== "subagent")
    .reduce<RunningTool | undefined>((best, call) => (best === undefined || call.at >= best.at ? call : best), undefined)
  const count = runningSubagents > 0 ? subagents(runningSubagents) : undefined
  if (latest === undefined) return count
  if (count === undefined) return toolLabel(latest)
  const suffix = ` · ${count}`
  return `${toolLabel(latest, LABEL_LIMIT - suffix.length)}${suffix}`
}
