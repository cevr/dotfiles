// The family the rows read, from the TUI's own data: the root of the route's
// session and every session under it, each with its agent, run status,
// waiting permissions and questions, assistant steps (a kernel call with the
// tools its cell called), and the stop notices its background subagents and
// shell commands sent it. Read inside a Solid computation, every read here is
// reactive.
import type { Call, Family, Message, Part, Session } from "../family.ts"

/** A session as `context.data.session.get` returns it, narrowed to what a row reads. */
export type SessionInfo = {
  readonly id: string
  readonly parentID?: string | null
  readonly title?: string
  readonly agent?: string
  readonly outcome?: string
  readonly time?: { readonly created: number; readonly busy?: number; readonly idle?: number; readonly updated?: number }
}

/**
 * The reads the family needs from the TUI plugin's `context.data`, narrowed
 * so a test can supply them; `context.data` satisfies it.
 */
export interface Reads {
  readonly session: {
    get(sessionID: string): SessionInfo | undefined
    root(sessionID: string): string
    family(sessionID: string): ReadonlyArray<string>
    status(sessionID: string): "idle" | "running"
    readonly message: { list(sessionID: string): ReadonlyArray<unknown> }
    readonly permission: {
      list(sessionID: string): ReadonlyArray<{ readonly action: string; readonly resources: ReadonlyArray<string> }> | undefined
    }
    readonly form: { list(sessionID: string): ReadonlyArray<{ readonly title: string }> | undefined }
  }
}

type Fields = Readonly<Record<string, unknown>>

const record = (value: unknown): Fields =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
const string = (value: unknown) => (typeof value === "string" ? value : undefined)
const number = (value: unknown) => (typeof value === "number" ? value : undefined)
const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [])

const STATUSES = ["streaming", "running", "completed", "error"] as const

/** One tool a kernel cell called, from the kernel call's record (mods/kernel/operations.ts); undefined when it is not one. */
function operation(value: unknown): Call | undefined {
  const fields = record(value)
  const tool = string(fields.tool)
  const status = STATUSES.find((known) => known === fields.status)
  if (tool === undefined || status === undefined) return undefined
  const error = string(fields.error)
  return {
    type: "call",
    tool,
    status,
    input: record(fields.input),
    metadata: record(fields.metadata),
    ...(error === undefined ? {} : { error }),
  }
}

/** A part of an assistant message: its words, or a tool call; undefined for any other part. */
function part(value: unknown): Part | undefined {
  const fields = record(value)
  if (fields.type === "text" || fields.type === "reasoning") return { type: "words", text: string(fields.text) ?? "" }
  if (fields.type !== "tool") return undefined
  const state = record(fields.state)
  const status = STATUSES.find((known) => known === state.status)
  if (status === undefined) return undefined
  const error = string(record(state.error).message)
  const completed = number(record(fields.time).completed)
  // A streaming call has no metadata yet; a running one carries its live progress (a subagent's sessionID).
  const metadata = status === "streaming" ? {} : record(state.metadata)
  const calls = list(metadata.operations).flatMap((item) => operation(item) ?? [])
  const call: Call = {
    type: "call",
    tool: string(fields.name) ?? "",
    status,
    input: record(state.input),
    metadata,
    ...(error === undefined ? {} : { error }),
    ...(completed === undefined ? {} : { completed }),
    ...(calls.length === 0 ? {} : { calls }),
  }
  return call
}

/**
 * An assistant step, a background subagent's stop notice, or a background
 * shell's stop notice; undefined for any other message.
 */
function message(value: unknown): Message | undefined {
  const fields = record(value)
  if (fields.type === "assistant") {
    const agent = string(fields.agent)
    const parts = list(fields.content).flatMap((item) => part(item) ?? [])
    return { type: "assistant", ...(agent === undefined ? {} : { agent }), parts }
  }
  if (fields.type !== "synthetic") return undefined
  const metadata = record(fields.metadata)
  const state = string(metadata.state)
  const at = number(record(fields.time).created) ?? 0
  if (state === undefined) return undefined
  const shellID = string(metadata.shellID)
  if (metadata.source === "shell" && shellID !== undefined) return { type: "shell", shellID, state, at }
  const childID = string(metadata.childID)
  if (metadata.source !== "subagent" || childID === undefined) return undefined
  return { type: "notice", childID, state, at, text: string(fields.text) ?? "" }
}

function session(reads: Reads, id: string): Session {
  const info = reads.session.get(id)
  const time = info?.time
  return {
    id,
    ...(info?.parentID ? { parentID: info.parentID } : {}),
    ...(info?.title === undefined ? {} : { title: info.title }),
    ...(info?.agent === undefined ? {} : { agent: info.agent }),
    ...(info?.outcome === undefined ? {} : { outcome: info.outcome }),
    time: {
      created: time?.created ?? 0,
      ...(time?.busy === undefined ? {} : { busy: time.busy }),
      ...(time?.idle === undefined ? {} : { idle: time.idle }),
      ...(time?.updated === undefined ? {} : { updated: time.updated }),
    },
    running: reads.session.status(id) === "running",
    permissions: (reads.session.permission.list(id) ?? []).map((request) =>
      [request.action, request.resources[0]].filter(Boolean).join(" "),
    ),
    questions: (reads.session.form.list(id) ?? []).map((form) => form.title),
    messages: reads.session.message.list(id).flatMap((item) => message(item) ?? []),
  }
}

/** The family of `sessionID`: its root and every session in the root's family. */
export const read = (reads: Reads, sessionID: string): Family => {
  const root = reads.session.root(sessionID)
  const ids = reads.session.family(root)
  return { root, sessions: (ids.includes(root) ? ids : [root, ...ids]).map((id) => session(reads, id)) }
}
