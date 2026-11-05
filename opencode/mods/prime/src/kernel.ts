// A kernel call drawn as what its cell did: the `tools.*` calls the kernel
// records in the call's metadata (`operations`, mods/kernel/operations.ts),
// each as a call of its own tool, so the group's header and rows read as fx's
// do (`Ran 3 commands · read 2 files`, `├ Read a.ts, b.ts`) and the cell's code
// never shows. The calls keep the kernel call's part id: the host gives the
// kernel call one slot, and its rows draw there.
//
// The kernel call itself stays in the group where the operations cannot stand
// for it: a cell that called no tool, a cell still computing with no tool
// running, and a cell that failed with no failed tool.
import type { Call } from "./group"
import type { ToolPart } from "./view"

/** One recorded operation, as the kernel writes it. */
type Operation = {
  readonly tool: string
  readonly status: "running" | "completed" | "error"
  readonly input?: Record<string, unknown>
  readonly output?: string
  readonly error?: string
  readonly metadata?: Record<string, unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The operations a kernel call recorded so far: live while it runs, kept once it ends. */
export function operations(part: ToolPart): Operation[] {
  if (part.state.status === "streaming") return []
  const recorded = isRecord(part.state.metadata) ? part.state.metadata.operations : undefined
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
  const content = operation.output === undefined ? [] : [{ type: "text", text: operation.output }]
  const state = {
    ...kernel.state,
    status: operation.status,
    input: operation.input ?? {},
    metadata: operation.metadata ?? {},
    content,
    ...(operation.status === "error" ? { error: { message: operation.error ?? "failed" } } : {}),
  }
  return { ...kernel, name: operation.tool, state } as unknown as ToolPart
}

/**
 * A call as the group draws it: a kernel call as the calls its cell made
 * (`canonical` names their tools), any other call as itself.
 */
export function expand(call: Call, canonical: (name: string) => string): Call[] {
  if (call.tool !== "kernel") return [call]
  const part = call.part
  const recorded = operations(part)
  if (recorded.length === 0) return [call]
  const calls = recorded.map((operation) => ({ tool: canonical(operation.tool), part: asPart(part, operation) }))
  const status = part.state.status
  const computing = (status === "running" || status === "streaming") && !recorded.some((operation) => operation.status === "running")
  const failedAlone = status === "error" && !recorded.some((operation) => operation.status === "error")
  return computing || failedAlone ? [...calls, call] : calls
}

/** The tools a cell's code calls by name (`tools.read(`), in order and once each: a kernel row's words when it recorded none. */
export function toolsInCode(code: string): string[] {
  const names = [...code.matchAll(/\btools\.([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]!)
  return [...new Set(names)]
}
