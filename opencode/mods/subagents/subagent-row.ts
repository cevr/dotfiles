// A subagent row: which role works on which unit on which model, how it
// stands and for how long, what it last said or did, and how long ago when
// that was a while; one per subagent of a session family.
//
//   ◐ implementor opus 5.5  Fix money parsing   editing src/money.ts · 1m 12s
//   ◷ verifier    sol 6.1   closure-flake r1    flock gate.lock ./gate.sh · 37m · updated 26m ago
//   ✓ planner     opus 5.5  Plan month padding  3 steps
//   ◇ verifier    sol 6.1   Check the export    pace · opens 14:30 · 2m 10s
//
// The role is the orchestrate step's role noun, as the skill and the agents
// name it: a worker whose call's description says `closure-flake verifier r1`
// reads `verifier` with the unit `closure-flake r1`.
//
// `rows(family, rootSessionID, now)` gives the rows worth showing at `now`;
// `format(row, width)` (line.ts) draws one as a line of coloured segments.
// Everything is read from the family's data: the child session's agent and
// run status, its running shells, its waiting permissions and questions, its
// messages, and the parent's subagent call and stop notice. Whether a row is
// live is the host's live state alone (works.ts, as the dock's count and the
// host's Subagents panel read it); the transcript only supplies the words.
// Nothing is guessed: a stopped row with no evidence of how it ended reads
// `idle`.
//
// Working and waiting are told apart so a row says whether anything moves:
// - working: its turn runs and it generates or runs a call that works;
// - waiting: its turn runs a call that only waits (a sleep or poll loop, or a
//   shell call whose description says it waits; shell.ts), or its turn ended
//   while a shell it started still runs (the host's shell registry lists it)
//   or a subagent under it works. The host wakes it when that work stops, and
//   only then hands its answer back, so it is not done. A shell the registry
//   no longer lists has stopped, stop notice or not.
// - latched: a held start (orchestrate's pace or the Sabbath) kept as a wake
//   of its parent's: its child is made and not yet prompted, and starts by
//   itself when the latch opens. Its row says what holds it and when it
//   opens, timed since it latched. A cancelled latch reads cancelled, a
//   failed one failed.
// The time is how long it has been in that state, not since it started.
import { described as stepOf } from "@dotfiles/opencode-orchestrate/described"
import { canonical, firstSentence, lastHeard, lastSentence, liveCall, running, runningUpdate, sayings, waiting, waits } from "./activity.ts"
import type { Call, Family, Latch, Message, Session } from "./family.ts"
import { modelName, type ModelName } from "./model.ts"
import { label } from "./shell.ts"
import { worksNow, type Works } from "./works.ts"

/**
 * How a subagent stands. `working`, `waiting` and `latched` are live (see
 * above), `blocked` waits on the owner; `idle` is a stopped one whose end the
 * data does not say.
 */
export type State = "working" | "waiting" | "blocked" | "latched" | "done" | "failed" | "cancelled" | "idle"

/** The states a row stays in view for, timed. A latched row is queued work, so it counts as live. */
export const live = (state: State) => state === "working" || state === "waiting" || state === "blocked" || state === "latched"

/** The colour family a role draws in: the orchestrate roles each have one, other agents share one. */
export type Tone = "planner" | "implementor" | "verifier" | "worker" | "general" | "other"

export type Row = {
  /** The subagent's session. */
  readonly id: string
  /** 0 for a child of the root, 1 for its child, and so on. */
  readonly depth: number
  /**
   * The orchestrate step it runs, else its agent: the child session's agent
   * (planner, implementor, verifier, worker, general, or another agent), or,
   * for a worker or general child whose call's description names a step in
   * the skill's form (`<role> <unit> r<N>`, `<unit> <role>[ rN]`), that role.
   */
  readonly role: string
  readonly tone: Tone
  /** The model it runs on, by its short name (model.ts), when the data says. */
  readonly model?: ModelName
  /**
   * What the parent called the work: the subagent call's description, without
   * the role word when it names the row's role, else the child's title.
   */
  readonly unit: string
  readonly state: State
  /** One short sentence of what it is doing now, or how it ended. */
  readonly update: string
  /** While live: when it entered its state. */
  readonly since?: number
  /** While live: when it last wrote or did anything, if the data says. */
  readonly heard?: number
  /** Once it stopped: when, if the data says. */
  readonly ended?: number
  /** While live: how long it has been in its state at the `now` the rows were read at, in ms. */
  readonly elapsed?: number
  /** While live: how long since it last wrote or did anything at that `now`, in ms. */
  readonly quiet?: number
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

/** A subagent call that does not hold its turn: a background one, or a latched one, which answers at once. */
const backgrounded = (call: Call) => call.input.background === true || call.metadata.status === "latched"

const firstLine = (value: unknown) => (typeof value === "string" ? value.split("\n")[0]?.trim() || undefined : undefined)

/** One piece of background work a session still waits on: what it is, and the step's call that started it (a kernel cell for its own calls). */
type Pending = { readonly what: string; readonly by?: Call }

/**
 * What a waiting session waits on, in the order it started it: each shell
 * the host's registry still lists as running for it, by its call's
 * description or in a few words (shell.ts), and each subagent under it that
 * works now, by its call's description. The transcript only names the work;
 * the host says whether it still runs. A running shell no call names (the
 * call's record lost) reads by the registry's own words; a working child no
 * call names, by its title.
 */
function pendingWork(session: Session, children: ReadonlyArray<Session>, works: (id: string) => Works | undefined): ReadonlyArray<Pending> {
  const shells = new Map(session.shells.map((shell) => [shell.id, shell]))
  const busy = new Map(children.filter((child) => works(child.id) !== undefined).map((child) => [child.id, child]))
  const named = new Set<string>()
  const of = (call: Call): string | undefined => {
    if (call.status !== "completed") return undefined
    const tool = canonical(call.tool)
    const shell = call.metadata.shellID
    if (tool === "shell" && typeof shell === "string" && shells.has(shell) && !named.has(shell)) {
      named.add(shell)
      return label(call.input) || "a shell command"
    }
    const child = call.metadata.sessionID
    if (tool === "subagent" && typeof child === "string" && busy.has(child) && !named.has(child)) {
      named.add(child)
      return firstLine(call.input.description) ?? firstLine(call.input.agent) ?? "a subagent"
    }
    return undefined
  }
  const called = session.messages.flatMap((message) =>
    message.type === "assistant"
      ? message.parts.flatMap((part): Pending[] =>
          part.type === "call"
            ? [part, ...(part.calls ?? [])].flatMap((call) => {
                const what = of(call)
                return what === undefined ? [] : [{ what, by: part }]
              })
            : [],
        )
      : [],
  )
  const unnamed = [
    ...session.shells.flatMap((shell) =>
      named.has(shell.id) ? [] : [{ what: label({ command: shell.command, description: shell.description }) || "a shell command" }],
    ),
    ...[...busy.values()].flatMap((child) => (named.has(child.id) ? [] : [{ what: firstLine(child.title) ?? "a subagent" }])),
  ]
  return [...called, ...unnamed]
}

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
  if (call && !backgrounded(call) && !running(call)) {
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

/** When a running turn last started working: its start, or the end of the latest wait call it ran since. */
function workingSince(messages: ReadonlyArray<Message>, busy: number): number {
  const ends = messages.flatMap((message) =>
    message.type === "assistant"
      ? message.parts.flatMap((part) => (part.type === "call" && !running(part) && waits(part) && part.completed !== undefined ? [part.completed] : []))
      : [],
  )
  return Math.max(busy, ...ends)
}

/**
 * What a subagent whose turn ended says while it waits: the latest sentence
 * it wrote after starting the work it waits on, else that work (`bun test`,
 * `Check the parser +1`), else its latest sentence.
 */
function waitingUpdate(messages: ReadonlyArray<Message>, pendings: ReadonlyArray<Pending>): string {
  const all = sayings(messages)
  const sentence = lastSentence(all)
  const started = Math.max(-1, ...pendings.map((item) => (item.by === undefined ? -1 : all.findIndex((said) => said.type === "call" && said.call === item.by))))
  const first = pendings[0]
  if (sentence?.type === "sentence" && (first === undefined || sentence.index > started)) return sentence.text
  if (first === undefined) return ""
  return `${first.what}${pendings.length > 1 ? ` +${pendings.length - 1}` : ""}`
}

/** A clock time, `14:30`, in `timeZone` (the host's own by default). */
const clock = (ms: number, timeZone: string | undefined) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone === undefined ? {} : { timeZone }) }).format(ms)
const day = (ms: number, timeZone: string | undefined) =>
  new Intl.DateTimeFormat("en-US", { weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", ...(timeZone === undefined ? {} : { timeZone }) }).format(ms)
const weekday = (ms: number, timeZone: string | undefined) =>
  new Intl.DateTimeFormat("en-US", { weekday: "short", ...(timeZone === undefined ? {} : { timeZone }) }).format(ms)

/**
 * What a latched row says: what holds it and when it opens, `pace · opens
 * 14:30`, or with its weekday when it opens on another day than it latched,
 * `Sabbath · opens Sat 18:12`.
 */
export function latchUpdate(latch: Latch, timeZone?: string): string {
  const what = latch.hold === "sabbath" ? "Sabbath" : latch.hold
  const sameDay = day(latch.opensAt, timeZone) === day(latch.at, timeZone)
  return `${what} · opens ${sameDay ? "" : `${weekday(latch.opensAt, timeZone)} `}${clock(latch.opensAt, timeZone)}`
}

/** The agents that run role work asked of no particular agent: the worker the guard routes it to, or the general agent under the full-agent escape. */
const LEAN = new Set(["worker", "general"])

/**
 * The row's role and unit: the step the description names, when the child
 * runs as that role or as the worker or general agent (a session started
 * before the guard routed by the description), with the role word dropped
 * from the unit; else the agent and the whole description.
 */
function roleAndUnit(agent: string, description: string): { readonly role: string; readonly unit?: string } {
  const step = stepOf(description)
  if (step && (step.role === agent || LEAN.has(agent))) return { role: step.role, unit: step.rest }
  return { role: agent, ...(description ? { unit: description } : {}) }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

/** How rows read times: `timeZone` for a latched row's opening time, the host's own by default. */
export type ReadOptions = { readonly timeZone?: string }

/** Every subagent of the family as a row, in `order`, whatever its state. */
export function subagents(family: Family, rootSessionID: string, options: ReadOptions = {}): Row[] {
  const byID = new Map(family.sessions.map((session) => [session.id, session]))
  const children = new Map<string, Session[]>()
  for (const session of family.sessions)
    if (session.parentID) children.set(session.parentID, [...(children.get(session.parentID) ?? []), session])
  const now = worksNow(family)
  return order(family, rootSessionID).map(({ session, depth }): Row => {
    const parent = session.parentID ? (byID.get(session.parentID)?.messages ?? []) : []
    const found = launch(parent, session.id)
    const input = found.call?.input ?? {}
    const described = typeof input.description === "string" ? input.description.trim() : ""
    const agent =
      session.agent ??
      session.messages.flatMap((message) => (message.type === "assistant" && message.agent ? [message.agent] : [])).at(-1) ??
      (typeof input.agent === "string" ? input.agent : "subagent")
    const { role, unit } = roleAndUnit(agent, described)
    const model = modelName(session.model)
    const base = {
      id: session.id,
      depth,
      role,
      tone: tone(role),
      ...(model === undefined ? {} : { model }),
      unit: unit || session.title || "subagent",
    }
    const busy = session.time.busy ?? session.time.created
    const heard = lastHeard(session.messages)
    const timed = (since: number) => ({ since, ...(heard === undefined ? {} : { heard }) })
    const works = now(session.id)
    const permission = session.permissions[0]
    if (permission !== undefined) return { ...base, state: "blocked", update: `permission: ${permission}`.trim(), ...timed(busy) }
    const question = session.questions[0]
    if (question !== undefined) return { ...base, state: "blocked", update: `question: ${question}`, ...timed(busy) }
    if (works === "running") {
      const call = liveCall(session.messages)
      const update = runningUpdate(session.messages)
      if (call && waiting(call)) return { ...base, state: "waiting", update, ...timed(call.started ?? busy) }
      return { ...base, state: "working", update, ...timed(workingSince(session.messages, busy)) }
    }
    // A latched child has never run: its latch says how it stands until it opens.
    const latch = session.latch
    if (works === "latched" && latch !== undefined) return { ...base, state: "latched", update: latchUpdate(latch, options.timeZone), since: latch.at }
    if (latch !== undefined && session.time.busy === undefined && session.outcome === undefined) {
      if (latch.cancelledAt !== undefined) return { ...base, state: "cancelled", update: "", ended: latch.cancelledAt }
      if (latch.failed !== undefined)
        return { ...base, state: "failed", update: firstSentence(latch.failed), ended: session.time.updated ?? latch.at }
    }
    if (works === "waiting") {
      const pendings = pendingWork(session, children.get(session.id) ?? [], now)
      const idle = session.time.idle
      const since = idle !== undefined && idle >= busy ? idle : (heard ?? busy)
      return { ...base, state: "waiting", update: waitingUpdate(session.messages, pendings), ...timed(since) }
    }
    const end = ending(session, found)
    const steps = session.messages.filter((message) => message.type === "assistant").length
    // The symbol says how it ended (line.ts); the words say only what more there is.
    const update = end.state === "done" ? plural(steps, "step") : end.state === "failed" ? (end.why ?? "") : ""
    return { ...base, state: end.state, update, ...(end.at === undefined ? {} : { ended: end.at }) }
  })
}

/** How long a stopped subagent's row stays after it stopped. */
export const LINGER_MS = 30_000

/**
 * The rows worth showing at `now`: every live one (working, waiting,
 * blocked), with how long it has been in its state and since it last said
 * anything, and each stopped one for `LINGER_MS` after it stopped; a stopped
 * one whose end time the data does not say never shows. `current` (the
 * session the TUI shows, when it is a subagent) always shows.
 */
export function visible(
  all: ReadonlyArray<Row>,
  now: number,
  options: { readonly current?: string; readonly linger?: number } = {},
): Row[] {
  const linger = options.linger ?? LINGER_MS
  return all.flatMap((row) => {
    if (live(row.state))
      return [
        {
          ...row,
          ...(row.since === undefined ? {} : { elapsed: Math.max(0, now - row.since) }),
          ...(row.heard === undefined ? {} : { quiet: Math.max(0, now - row.heard) }),
        },
      ]
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
