// A subagent row: which role works on which unit, how it stands, what it is
// doing now, and for how long; one per subagent of a session family.
//
//   ◆ implementor  Fix money parsing   ⠋ editing src/money.ts · 1m 12s
//   ✓ planner      Plan month padding  done · 3 steps
//
// `rows(family, rootSessionID, now)` gives the rows worth showing at `now`;
// `format(row, width)` (line.ts) draws one as a line of coloured segments.
// Everything is read from the family's data: the child session's agent and
// run status, its waiting permissions and questions, its messages, and the
// parent's subagent call and stop notice. Nothing is guessed: a stopped row
// with no evidence of how it ended reads `idle`.
//
// A subagent that ended its turn to wait on its own background work is not
// done: the host wakes it when that work stops, and only then hands its
// answer back. While it waits its row runs, saying what it waits on:
//
//   ◆ implementor  Fix money parsing   ⠋ waiting on bun test · 1m 12s
import { canonical, firstSentence, running, runningUpdate } from "./activity.ts"
import type { Call, Family, Message, Session } from "./family.ts"

/** How a subagent stands. `idle` is a stopped one whose end the data does not say. */
export type State = "running" | "blocked" | "done" | "failed" | "cancelled" | "idle"

/** The colour family a role draws in: the orchestrate roles each have one, other agents share one. */
export type Tone = "planner" | "implementor" | "verifier" | "worker" | "general" | "other"

export type Row = {
  /** The subagent's session. */
  readonly id: string
  /** 0 for a child of the root, 1 for its child, and so on. */
  readonly depth: number
  /** The child session's agent: planner, implementor, verifier, worker, general, or another agent. */
  readonly role: string
  readonly tone: Tone
  /** What the parent called the work: the subagent call's description, else the child's title. */
  readonly unit: string
  readonly state: State
  /** One short sentence of what it is doing now, or how it ended. */
  readonly update: string
  /** While it runs or waits: when this run started. */
  readonly since?: number
  /** Once it stopped: when, if the data says. */
  readonly ended?: number
  /** While it runs or waits: how long this run has taken at the `now` the rows were read at, in ms. */
  readonly elapsed?: number
}

const TONES: ReadonlyArray<Tone> = ["planner", "implementor", "verifier", "worker", "general"]

export function tone(role: string): Tone {
  return TONES.find((known) => known === role) ?? "other"
}

/**
 * Every subagent under `rootSessionID` in the order they started, depth first
 * (the order the Prime transcript's `Started` rows list them), siblings by
 * creation time. The root itself is not a subagent.
 */
export function order(family: Family, rootSessionID: string): ReadonlyArray<{ readonly session: Session; readonly depth: number }> {
  const children = new Map<string, Session[]>()
  for (const session of family.sessions.toSorted((a, b) => a.time.created - b.time.created))
    if (session.parentID) children.set(session.parentID, [...(children.get(session.parentID) ?? []), session])
  const walk = (id: string, path: ReadonlySet<string>, depth: number): Array<{ readonly session: Session; readonly depth: number }> =>
    (children.get(id) ?? []).flatMap((session) =>
      path.has(session.id) ? [] : [{ session, depth }, ...walk(session.id, new Set([...path, session.id]), depth + 1)],
    )
  return walk(rootSessionID, new Set([rootSessionID]), 0)
}

/** The parent's subagent call that runs `child`, and the parent's stop notice for it. */
function launch(parent: ReadonlyArray<Message>, child: string) {
  let call: Call | undefined
  let notice: Extract<Message, { type: "notice" }> | undefined
  for (const message of parent) {
    if (message.type === "assistant")
      for (const part of message.parts)
        if (part.type === "call" && canonical(part.tool) === "subagent" && part.metadata.sessionID === child) call ??= part
    if (message.type === "notice" && message.childID === child) notice = message
  }
  return { call, notice }
}

/** The short reason a failure gives: the first sentence of its message, past the host's envelope and prefix. */
function reason(text: string): string {
  const body = text.replace(/^<\/?subagent\b[^>]*>\n?/gm, "").trim()
  return firstSentence(body.split("\n")[0] ?? "").replace(/^Subagent failed( \(sessionID: [^)]*\))?:?\s*/, "")
}

/** Every call of some messages' steps, the tools a kernel call's cell called included. */
function calls(messages: ReadonlyArray<Message>): ReadonlyArray<Call> {
  return messages.flatMap((message) =>
    message.type === "assistant" ? message.parts.flatMap((part) => (part.type === "call" ? [part, ...(part.calls ?? [])] : [])) : [],
  )
}

const named = (value: unknown) => (typeof value === "string" ? value.split("\n")[0]?.trim() || undefined : undefined)

/**
 * What a session's own background work it still waits on: each shell command
 * it moved to the background (a shell call whose result names its shell)
 * with no stop notice for that shell yet, and each subagent it started in the
 * background with no stop notice for it yet; by command or description.
 */
export function waitingOn(messages: ReadonlyArray<Message>): ReadonlyArray<string> {
  const stopped = new Set(messages.flatMap((message) => (message.type === "shell" ? [message.shellID] : message.type === "notice" ? [message.childID] : [])))
  return calls(messages).flatMap((call) => {
    if (call.status !== "completed") return []
    const tool = canonical(call.tool)
    const shell = call.metadata.shellID
    if (tool === "shell" && typeof shell === "string" && !stopped.has(shell)) return [named(call.input.command) ?? "a shell command"]
    const child = call.metadata.sessionID
    if (tool === "subagent" && call.input.background === true && typeof child === "string" && !stopped.has(child))
      return [named(call.input.description) ?? named(call.input.agent) ?? "a subagent"]
    return []
  })
}

/** Whether the parent still waits on the subagent: its foreground call still runs, or its background one sent no stop notice yet. */
const pending = ({ call, notice }: ReturnType<typeof launch>) =>
  call !== undefined && notice === undefined && (call.input.background === true || running(call))

type Ending = { readonly state: State; readonly at?: number; readonly why?: string }

const when = (at: number | undefined) => (at === undefined ? {} : { at })

/** How a stopped subagent ended: its notice's verdict, else its foreground call's, else its session's outcome. */
function ending(session: Session, found: ReturnType<typeof launch>): Ending {
  const { call, notice } = found
  if (notice) {
    if (notice.state === "completed") return { state: "done", at: notice.at }
    if (notice.state === "error") return { state: "failed", at: notice.at, why: reason(notice.text) }
    return { state: "cancelled", at: notice.at }
  }
  if (call && call.input.background !== true && !running(call)) {
    if (call.status === "completed") return { state: "done", ...when(call.completed) }
    const message = call.error ?? ""
    if (message.startsWith("Subagent cancelled")) return { state: "cancelled", ...when(call.completed) }
    return { state: "failed", ...when(call.completed), why: reason(message) }
  }
  if (session.outcome === "succeeded") return { state: "done", ...when(session.time.idle) }
  if (session.outcome === "failed") return { state: "failed", ...when(session.time.idle) }
  if (session.outcome === "interrupted") return { state: "cancelled", ...when(session.time.idle) }
  return { state: "idle", ...when(session.time.updated) }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

/** Every subagent of the family as a row, in `order`, whatever its state. */
export function subagents(family: Family, rootSessionID: string): Row[] {
  const byID = new Map(family.sessions.map((session) => [session.id, session]))
  return order(family, rootSessionID).map(({ session, depth }): Row => {
    const parent = session.parentID ? (byID.get(session.parentID)?.messages ?? []) : []
    const found = launch(parent, session.id)
    const input = found.call?.input ?? {}
    const described = typeof input.description === "string" ? input.description.trim() : ""
    const role =
      session.agent ??
      session.messages.flatMap((message) => (message.type === "assistant" && message.agent ? [message.agent] : [])).at(-1) ??
      (typeof input.agent === "string" ? input.agent : "subagent")
    const base = { id: session.id, depth, role, tone: tone(role), unit: described || session.title || "subagent" }
    const since = session.time.busy ?? session.time.created
    const permission = session.permissions[0]
    if (permission !== undefined) return { ...base, state: "blocked", update: `waiting on permission: ${permission}`.trim(), since }
    const question = session.questions[0]
    if (question !== undefined) return { ...base, state: "blocked", update: `waiting on question: ${question}`, since }
    if (session.running) return { ...base, state: "running", update: runningUpdate(session.messages), since }
    const waits = waitingOn(session.messages)
    if (waits.length > 0 || pending(found)) {
      const what = waits.length > 1 ? `${waits[0]} +${waits.length - 1}` : waits[0]
      return { ...base, state: "running", update: what === undefined ? "waiting" : `waiting on ${what}`, since }
    }
    const end = ending(session, found)
    const steps = session.messages.filter((message) => message.type === "assistant").length
    const update =
      end.state === "done"
        ? `done · ${plural(steps, "step")}`
        : end.state === "failed"
          ? ["failed", end.why].filter(Boolean).join(" · ")
          : end.state
    return { ...base, state: end.state, update, ...(end.at === undefined ? {} : { ended: end.at }) }
  })
}

/** How long a stopped subagent's row stays after it stopped. */
export const LINGER_MS = 30_000

/**
 * The rows worth showing at `now`: every running or waiting one, with how
 * long it has run, and each stopped one for `LINGER_MS` after it stopped; a
 * stopped one whose end time the data does not say never shows. `current`
 * (the session the TUI shows, when it is a subagent) always shows.
 */
export function visible(
  all: ReadonlyArray<Row>,
  now: number,
  options: { readonly current?: string; readonly linger?: number } = {},
): Row[] {
  const linger = options.linger ?? LINGER_MS
  return all.flatMap((row) => {
    if (row.state === "running" || row.state === "blocked")
      return [row.since === undefined ? row : { ...row, elapsed: Math.max(0, now - row.since) }]
    if (row.id === options.current || (row.ended !== undefined && now - row.ended < linger)) return [row]
    return []
  })
}

/**
 * The subagent rows of `rootSessionID`'s family worth showing at `now`, in
 * the order they started: `visible(subagents(family, root), now, options)`.
 * Split the two to keep the subagents in a memo while a clock moves `now`.
 */
export function rows(
  family: Family,
  rootSessionID: string,
  now: number,
  options: { readonly current?: string; readonly linger?: number } = {},
): Row[] {
  return visible(subagents(family, rootSessionID), now, options)
}
