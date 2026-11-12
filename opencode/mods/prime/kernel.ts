// A kernel call drawn as what its cell did: the `tools.*` calls the kernel
// records in the call's metadata (`operations`, mods/kernel/operations.ts),
// each as a call of its own tool, so the group's header and rows read as fx's
// do (`Ran 3 commands · read 2 files`, `├ Read a.ts, b.ts`) and the cell's code
// never shows. The calls keep the kernel call's part id: the host gives the
// kernel call one slot, and its rows draw there.
//
// A cell that ended never shows a tool still running: an interrupted cell, or
// one whose kernel stopped under it, leaves its record open, and the open call
// takes the cell's outcome.
//
// The kernel call itself stays in the group where the operations cannot stand
// for it: a cell that called no tool, a cell still computing with no tool
// running, and a cell that failed with no failed tool.
import type { Call } from "./call.ts"
import type { Fields, ToolContent, ToolPart, ToolState } from "./session.ts"

/** One recorded operation, as the kernel writes it. */
type Operation = {
  readonly tool: string
  readonly status: "running" | "completed" | "error"
  readonly input?: Fields
  readonly output?: string
  readonly error?: string
  readonly metadata?: Fields
}

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The operations a kernel call recorded so far: live while it runs, kept once it ends. */
export function operations(part: ToolPart): Operation[] {
  if (part.state.status === "streaming") return []
  const recorded = part.state.metadata?.operations
  if (!Array.isArray(recorded)) return []
  return recorded.flatMap((value): Operation[] => {
    if (!isRecord(value) || typeof value.tool !== "string") return []
    const status = value.status === "running" || value.status === "error" ? value.status : "completed"
    return [
      {
        tool: value.tool,
        status,
        ...(isRecord(value.input) ? { input: value.input } : {}),
        ...(typeof value.output === "string" ? { output: value.output } : {}),
        ...(typeof value.error === "string" ? { error: value.error } : {}),
        ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
      },
    ]
  })
}

/** An operation as a call of its own tool, in the kernel call's slot. */
function asPart(kernel: ToolPart, operation: Operation): ToolPart {
  const content: ReadonlyArray<ToolContent> = operation.output === undefined ? [] : [{ type: "text", text: operation.output }]
  const input = operation.input ?? {}
  const metadata = operation.metadata ?? {}
  // The error has a message and no type, so the row's error name is its head, else `error`.
  const state: ToolState =
    operation.status === "running"
      ? { status: "running", input, metadata }
      : operation.status === "error"
        ? { status: "error", input, metadata, content, error: { message: operation.error ?? "failed" } }
        : { status: "completed", input, metadata, content }
  return { ...kernel, name: operation.tool, state }
}

/** The kernel call's error message, for a tool it left running. */
function kernelError(part: ToolPart): string {
  const message = part.state.status === "error" ? part.state.error.message : undefined
  return typeof message === "string" && message ? message : "cancelled"
}

/**
 * The model's own words for what a cell does (the kernel input's optional
 * `description`), on one line; none while the input streams in, for a call
 * made without one, or for a blank one.
 */
export function cellDescription(part: ToolPart): string | undefined {
  if (part.state.status === "streaming") return undefined
  const given = part.state.input.description
  const line = typeof given === "string" ? given.replace(/\s+/g, " ").trim() : ""
  return line || undefined
}

/**
 * A call as the group draws it: a kernel call as the calls its cell made
 * (`canonical` names their tools), any other call as itself. Each call a
 * cell stands as carries the cell's description, for the group's header.
 */
export function expand(kernel: Call, canonical: (name: string) => string): Call[] {
  if (kernel.tool !== "kernel") return [kernel]
  const part = kernel.part
  const described = cellDescription(part)
  const cell = described === undefined ? {} : { cell: described }
  const call: Call = { ...kernel, ...cell }
  const status = part.state.status
  // A cell that ended (interrupted, or its kernel stopped under it) may never close its record:
  // a tool it left running ends as the cell did.
  const recorded = operations(part).map((operation): Operation =>
    operation.status !== "running" || status === "running" || status === "streaming"
      ? operation
      : status === "error"
        ? { ...operation, status: "error", error: kernelError(part) }
        : { ...operation, status: "completed" },
  )
  if (recorded.length === 0) return [call]
  const calls = recorded.map((operation): Call => ({ tool: canonical(operation.tool), part: asPart(part, operation), ...cell }))
  const computing = (status === "running" || status === "streaming") && !recorded.some((operation) => operation.status === "running")
  const failedAlone = status === "error" && !recorded.some((operation) => operation.status === "error")
  return computing || failedAlone ? [...calls, call] : calls
}

/** A call a cell's code spells out: the tool it stands for, and its argument when the code names one. */
export type CellCall = { readonly tool: string; readonly detail: string }

const quoted = `["'\`]([^"'\`]+)["'\`]`

/** `["a", "b"]` as the words `a b`. */
const argv = (list: string) => Array.from(list.matchAll(/["'`]([^"'`]*)["'`]/g), (match) => match[1] ?? "").join(" ")

/** A command's first words, before any pipe or chain. */
const shellHead = (command: string) => (command.split(/\n|\||&&|;/)[0] ?? "").trim().split(/\s+/).slice(0, 3).join(" ")

/**
 * The calls a cell's code spells out, after fx's cell intent: `tools.<name>(` and `tools["<name>"](`, Bun's shell and spawn,
 * file reads and writes, globs and fetches. The tool names are the host's
 * (`shell`, `read`, `write`, `glob`, `webfetch`).
 */
const CELL_PATTERNS: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => CellCall]> = [
  [/\btools\.([A-Za-z_$][\w$]*)\s*\(/g, (match) => ({ tool: match[1] ?? "", detail: "" })],
  [new RegExp(`\\btools\\[\\s*${quoted}\\s*\\]\\s*\\(`, "g"), (match) => ({ tool: match[1] ?? "", detail: "" })],
  [/Bun\.\$`([^`]*)`/g, (match) => ({ tool: "shell", detail: shellHead(match[1] ?? "") })],
  [
    /Bun\.spawn(?:Sync)?\(\s*(?:\{\s*cmd:\s*)?\[\s*((?:["'`][^"'`]*["'`]\s*,?\s*)+)\]/g,
    (match) => ({ tool: "shell", detail: shellHead(argv(match[1] ?? "")) }),
  ],
  [new RegExp(`Bun\\.file\\(\\s*${quoted}`, "g"), (match) => ({ tool: "read", detail: match[1] ?? "" })],
  [new RegExp(`Bun\\.write\\(\\s*${quoted}`, "g"), (match) => ({ tool: "write", detail: match[1] ?? "" })],
  [new RegExp(`new Bun\\.Glob\\(\\s*${quoted}`, "g"), (match) => ({ tool: "glob", detail: match[1] ?? "" })],
  [new RegExp(`\\bfetch\\(\\s*${quoted}`, "g"), (match) => ({ tool: "webfetch", detail: match[1] ?? "" })],
]

/** The calls a cell's code spells out, in source order: a kernel call's words when it recorded none. */
export function cellCalls(code: string): CellCall[] {
  const found: Array<{ readonly index: number; readonly call: CellCall }> = []
  for (const [pattern, toCall] of CELL_PATTERNS)
    for (const match of code.matchAll(pattern)) {
      const call = toCall(match)
      if (call.tool) found.push({ index: match.index, call })
    }
  return found.toSorted((a, b) => a.index - b.index).map((entry) => entry.call)
}

/** The tools a cell's code spells out (`cellCalls`), in order and once each. */
export function toolsInCode(code: string): string[] {
  return [...new Set(cellCalls(code).map((call) => call.tool))]
}
