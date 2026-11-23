// The family the rows read, from the TUI's own data: the root of the route's
// session and every session under it, each with its agent, run status, the
// shells the host's shell registry lists as running for it, waiting
// permissions and questions, assistant steps (a kernel call with the
// tools its cell called), and the stop notices its background subagents and
// shell commands sent it. Read inside a Solid computation, every read here is
// reactive.
import type { Call, Family, Message, OwnedRow, Part, Session, Shell } from "../family.ts"
import { envelopes } from "../envelope.ts"

/** A session as `context.data.session.get` returns it, narrowed to what a row reads. */
export type SessionInfo = {
  readonly id: string
  readonly parentID?: string | null
  readonly title?: string
  readonly agent?: string
  readonly model?: { readonly id: string }
  readonly outcome?: string
  readonly time?: { readonly created: number; readonly busy?: number; readonly idle?: number; readonly updated?: number }
  /** The session's metadata: a latched child's carries the wakes' `latch` mark. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** A shell command as `context.data.shell.list` returns it, narrowed to what a row reads. */
export type ShellInfo = {
  readonly id: string
  readonly status: string
  readonly command: string
  readonly metadata: Readonly<Record<string, unknown>>
}

/**
 * The reads the family needs from the TUI plugin's `context.data`, narrowed
 * so a test can supply them; `context.data` satisfies it. `Location` is the
 * host's location reference, which the shell registry is kept per.
 */
export interface Reads<Location = unknown> {
  readonly listen?: (handler: (event: { readonly details: object }) => void) => () => void
  readonly session: {
    get(sessionID: string): SessionInfo | undefined
    root(sessionID: string): string
    family(sessionID: string): ReadonlyArray<string>
    status(sessionID: string): "idle" | "running"
    readonly pending?: { list(sessionID: string): ReadonlyArray<PendingInput> }
    readonly message: { list(sessionID: string): ReadonlyArray<unknown> }
    readonly permission: {
      list(sessionID: string): ReadonlyArray<{ readonly action: string; readonly resources: ReadonlyArray<string> }> | undefined
    }
    readonly form: { list(sessionID: string): ReadonlyArray<{ readonly title: string }> | undefined }
  }
  /** The shell commands the host's registry holds for a location: only those in flight, each tagged with its session. */
  readonly shell: { list(location?: Location): ReadonlyArray<ShellInfo> }
}

type PendingInput = { readonly type: string; readonly payload: object }

const shellWakePending = (reads: Pick<Reads, "session">, id: string) =>
  reads.session.pending?.list(id).some(({ type, payload }) => {
    if (type !== "synthetic") return false
    const metadata = record(record(payload).metadata)
    return metadata.source === "shell" && Boolean(string(metadata.shellID))
  }) === true

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

/**
 * A part of an assistant message: its words, or a tool call; undefined for
 * any other part. `step` is when its message last moved (its end, else its
 * first output, else its start): a text part carries no time of its own.
 */
function part(value: unknown, step: number | undefined): Part | undefined {
  const fields = record(value)
  if (fields.type === "text" || fields.type === "reasoning") {
    const own = record(fields.time)
    const at = number(own.completed) ?? number(own.created) ?? step
    return { type: "words", text: string(fields.text) ?? "", ...(at === undefined ? {} : { at }) }
  }
  if (fields.type !== "tool") return undefined
  const state = record(fields.state)
  const status = STATUSES.find((known) => known === state.status)
  if (status === undefined) return undefined
  const error = string(record(state.error).message)
  const time = record(fields.time)
  const started = number(time.ran) ?? number(time.created)
  const completed = number(time.completed)
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
    ...(started === undefined ? {} : { started }),
    ...(completed === undefined ? {} : { completed }),
    ...(calls.length === 0 ? {} : { calls }),
  }
  return call
}

/**
 * An assistant step, a background subagent's stop notice, or a background
 * shell's stop notice; undefined for any other message.
 */
export function message(value: unknown): Message | undefined {
  const fields = record(value)
  if (fields.type === "assistant") {
    const agent = string(fields.agent)
    const time = record(fields.time)
    const step = number(time.completed) ?? number(time.streamed) ?? number(time.created)
    const parts = list(fields.content).flatMap((item) => part(item, step) ?? [])
    return { type: "assistant", ...(agent === undefined ? {} : { agent }), parts }
  }
  if (fields.type !== "synthetic") return undefined
  const metadata = record(fields.metadata)
  const state = string(metadata.state)
  const at = number(record(fields.time).created) ?? 0
  const text = string(fields.text) || ""
  const shellID = string(metadata.shellID)
  if (metadata.source === "shell" && shellID !== undefined && state !== undefined) return { type: "shell", shellID, state, at }
  const childID = string(metadata.childID)
  if (metadata.source === "subagent" && childID !== undefined && state !== undefined) return { type: "notice", childID, state, at, text }
  if (!metadata.source) return legacyNotice(text, at)
}

const legacyNotice = (text: string, at: number): Message | undefined => {
  // Only synthetic messages reach this legacy display fallback. Neither shape creates an outcome.
  const old = envelopes(text).find((item) => item.start === 0 && item.kind === "subagent")
  const oldChild = old?.attributes.sessionID
  const oldState = old?.attributes.state
  if (oldChild && oldState) return { type: "notice", childID: oldChild, state: oldState, at, text }
}

/** One field of an object, read alone: a store proxy then tracks that field only. */
const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined

/** The model the latest assistant step ran on, by id: read from the newest item back, so older steps go unread. */
export const stepModel = (items: ReadonlyArray<unknown>): string | undefined => {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (field(item, "type") !== "assistant") continue
    const id = string(field(field(item, "model"), "id"))
    if (id) return id
  }
  return undefined
}

/** The running shells of the registry, by the session that started each. */
export function shellsBySession(listed: ReadonlyArray<ShellInfo>): ReadonlyMap<string, ReadonlyArray<Shell>> {
  const by = new Map<string, Shell[]>()
  for (const shell of listed) {
    const owner = string(shell.metadata.sessionID)
    if (shell.status !== "running" || owner === undefined) continue
    const description = string(shell.metadata.description)?.trim()
    by.set(owner, [...(by.get(owner) ?? []), { id: shell.id, command: shell.command, ...(description ? { description } : {}) }])
  }
  return by
}

/**
 * How `read` turns each of a session's message items into the family's
 * `Message`: `message` itself, or a caller's cache of it. A TUI passes one that
 * keeps each item's reading (`message(item)`) and reads it again only when that
 * item changes, so a token streamed into one message re-reads that message
 * alone, not every message of the family.
 */
export type Convert = (item: unknown) => Message | undefined

/** What a session's message items give its `Session`: each item read through `convert`, and the model its latest step ran on. */
export type Transcript = { readonly messages: ReadonlyArray<Message>; readonly model?: string }

/** A session's transcript from its message items. */
export const transcript = (items: ReadonlyArray<unknown>, convert: Convert): Transcript => {
  const model = stepModel(items)
  return { messages: items.flatMap((item) => convert(item) ?? []), ...(model ? { model } : {}) }
}

const OWNED_CHECKING = { kind: "checking", revision: 0, sinceReload: false, at: 0, waitingOn: "", diagnostic: false } as const
const ownedFields = (owner?: OwnedRow): Pick<Session, "execution" | "latch" | "lifecycle"> => {
  if (owner) {
    const { child: _child, ...phase } = owner
    return phase
  }
  return { lifecycle: OWNED_CHECKING }
}

/** Presentation inputs only; this function cannot read client lifecycle state. */
export function ownedSessionOf(id: string, told: Transcript, info?: SessionInfo, owner?: OwnedRow): Session {
  const model = told.model ?? info?.model?.id
  return {
    id,
    ...identityOf(model, info),
    time: { created: info?.time?.created || 0 },
    running: false, shells: [], permissions: [], questions: [],
    messages: told.messages,
    ...ownedFields(owner),
  }
}

const identityOf = (model?: string, info?: SessionInfo) => ({
  ...(info?.parentID ? { parentID: info.parentID } : {}),
  ...(info?.title === undefined ? {} : { title: info.title }),
  ...(info?.agent === undefined ? {} : { agent: info.agent }),
  ...(model ? { model } : {}),
})

/**
 * Session `id` from the host's reads, its messages and step model given as
 * `read` (`transcript`): a TUI keeps the transcript in a memo of its own, so
 * a change to the session's status or shells does not re-read its messages.
 */
export function sessionOf(
  reads: Pick<Reads, "session">,
  id: string,
  shells: ReadonlyArray<Shell>,
  { messages, model: stepped }: Transcript,
  owner?: OwnedRow,
): Session {
  const info = reads.session.get(id)
  const time = info?.time
  const model = stepped ?? info?.model?.id
  return {
    id,
    ...identityOf(model, info),
    ...(info?.outcome === undefined ? {} : { outcome: info.outcome }),
    time: {
      created: time?.created ?? 0,
      ...(time?.busy === undefined ? {} : { busy: time.busy }),
      ...(time?.idle === undefined ? {} : { idle: time.idle }),
      ...(time?.updated === undefined ? {} : { updated: time.updated }),
    },
    running: reads.session.status(id) === "running",
    wakePending: shellWakePending(reads, id),
    ...legacyFields(owner),
    shells,
    permissions: (reads.session.permission.list(id) ?? []).map((request) =>
      [request.action, request.resources[0]].filter(Boolean).join(" "),
    ),
    questions: (reads.session.form.list(id) ?? []).map((form) => form.title),
    messages,
  }
}
const legacyFields = (owner?: OwnedRow) => {
  if (owner) return ownedFields(owner)
  return {}
}

/** The sessions of `root`'s family, the root first when the host's family list leaves it out. */
export const familyOf = (reads: Pick<Reads, "session">, root: string): ReadonlyArray<string> => {
  const ids = reads.session.family(root)
  return ids.includes(root) ? ids : [root, ...ids]
}

/**
 * The family of `sessionID`: its root and every session in the root's family,
 * with the shells `location`'s registry runs for each (the host's default
 * location when none is given), each message item read through `convert`.
 */
export const read = <Location>(
  reads: Reads<Location>,
  sessionID: string,
  location?: Location,
  convert: Convert = message,
  ownerRows?: ReadonlyMap<string, OwnedRow>,
): Family => {
  const root = reads.session.root(sessionID)
  const shells = shellsBySession(reads.shell.list(location))
  return {
    root,
    sessions: familyOf(reads, root).map((id) =>
      sessionOf(reads, id, shells.get(id) ?? [], transcript(reads.session.message.list(id), convert), ownerRows?.get(id)),
    ),
  }
}
