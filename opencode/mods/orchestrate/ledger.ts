// The ledger a compacted root is told with its status (cmd/orchestrate
// server.ts): what it had going before the summary, from the state the host
// and the other plugins already keep, one line each. Nothing here is stored.
//
// - Its queue's items that are not done (the queue plugin's).
// - Its subagents now, from the call log's lines (its starts, latches and
//   follow-ups) and each child's session: those running, those latched, and
//   each idle one whose hand-back no later call of the root answered (a
//   follow-up to that child, or a step of the unit its hand-back names),
//   flagged `not woken since`. A verifier's `accepted` asks for no answer; a
//   unit the run tables read closed (merged, dropped) or do not hold asks
//   none either. With the tables unread, every open hand-back is flagged.
// - Its wakes, monitors and latches (the wakes' `pending`), and its jobs
//   still running (the wakes' `jobs`).
//
// When the run tables cannot be read, the status gives way to the error and
// the units the root started steps of, so the root is never left without a
// note (`unreadTables`).
import { Array as Arr, DateTime, Option, Order, Schema } from "effect"
import { described } from "./described.ts"
import { unitOf } from "./idle.ts"
import type { HandBack } from "./unit-log.ts"

// ── The root's calls, from the call log ──

/** A subagent the root started or latched: its session, agent, description, when it was started and last called (epoch ms). */
export const Child = Schema.Struct({
  child: Schema.String,
  agent: Schema.String,
  description: Schema.Option(Schema.String),
  startedAt: Schema.Number,
  /** Its start, or the newest follow-up the root sent it. */
  calledAt: Schema.Number,
})
export interface Child extends Schema.Schema.Type<typeof Child> {}

/** The root's subagents, newest called first, and when it last started a step of each unit (epoch ms). */
export interface Calls {
  readonly children: ReadonlyArray<Child>
  readonly units: ReadonlyMap<string, number>
}

export const NO_CALLS: Calls = { children: [], units: new Map() }

/** A call log line, as far as the ledger reads it (call-line.ts writes it). */
const LogLine = Schema.Struct({
  kind: Schema.String,
  at: Schema.String,
  sessionID: Schema.String,
  callID: Schema.OptionFromOptionalKey(Schema.String),
  agent: Schema.OptionFromOptionalKey(Schema.String),
  child: Schema.OptionFromOptionalKey(Schema.String),
  description: Schema.OptionFromOptionalKey(Schema.String),
})
type LogLine = typeof LogLine.Type
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(LogLine))

/** A new start waiting for its child: what its call said. */
interface Waiting {
  readonly agent: string
  readonly description: Option.Option<string>
  readonly at: number
}

/** The reading so far, in the log's order. */
interface Reading {
  readonly children: Map<string, Child>
  readonly units: Map<string, number>
  readonly waiting: Map<string, Waiting>
}

const known = <A>(map: ReadonlyMap<string, A>, key: string): Option.Option<A> => Option.fromUndefinedOr(map.get(key))

/** The unit a step's description names, when it names one. */
const stepUnit = (description: Option.Option<string>): Option.Option<string> =>
  description.pipe(
    Option.flatMap((text) => Option.fromUndefinedOr(described(text))),
    Option.flatMap((step) => Option.fromUndefinedOr(unitOf(step.rest))),
  )

/** A `call` or `latched` line: the unit's newest step, and a start or follow-up of its child, or a start waiting for its child. */
const readCall = (reading: Reading, line: LogLine, at: number) => {
  Option.map(stepUnit(line.description), (unit) => reading.units.set(unit, Math.max(Option.getOrElse(known(reading.units, unit), () => 0), at)))
  const agent = Option.getOrElse(line.agent, () => "subagent")
  if (Option.isNone(line.child)) {
    reading.waiting.set(Option.getOrElse(line.callID, () => ""), { agent, description: line.description, at })
    return
  }
  const child = line.child.value
  reading.children.set(
    child,
    Option.match(known(reading.children, child), {
      onNone: () => ({ child, agent, description: line.description, startedAt: at, calledAt: at }),
      onSome: (seen) => ({ ...seen, calledAt: Math.max(seen.calledAt, at) }),
    }),
  )
}

/** A `done` line: the child of the start it answers, when that start waited for one. */
const readDone = (reading: Reading, line: LogLine) => {
  const callID = Option.getOrElse(line.callID, () => "")
  const call = known(reading.waiting, callID)
  const child = Option.filter(line.child, (id) => !reading.children.has(id))
  if (Option.isNone(call) || Option.isNone(child)) return
  reading.waiting.delete(callID)
  reading.children.set(child.value, { child: child.value, agent: call.value.agent, description: call.value.description, startedAt: call.value.at, calledAt: call.value.at })
}

const byCalled = Order.mapInput(Order.flip(Order.Number), (child: Child) => child.calledAt)

/**
 * The calls `sessionID` made, from the call log's text: each `call` or `latched` line with a child is a start or a
 * follow-up of it; one without (a new start, whose child the host names only as it answers) gets its child from
 * the `done` line of the same call after it. A line that does not read is skipped.
 */
export const callsIn = (text: string, sessionID: string): Calls => {
  const reading: Reading = { children: new Map(), units: new Map(), waiting: new Map() }
  for (const raw of text.split("\n")) {
    const line = Option.filter(decodeLine(raw), (each) => each.sessionID === sessionID)
    const at = Option.map(Option.flatMap(line, (each) => DateTime.make(each.at)), DateTime.toEpochMillis)
    if (Option.isNone(line) || Option.isNone(at)) continue
    if (line.value.kind === "call" || line.value.kind === "latched") readCall(reading, line.value, at.value)
    if (line.value.kind === "done") readDone(reading, line.value)
  }
  return { children: Arr.sort([...reading.children.values()], byCalled), units: reading.units }
}

// ── What the other plugins hold ──

/** A queue item that is not done. */
export interface QueueItem {
  readonly text: string
  readonly state: string
  readonly detail: Option.Option<string>
}

/** A wake, monitor or latch the wakes keep for the root. */
export interface WakeItem {
  readonly kind: string
  readonly note: string
  /** Epoch ms: an alarm's due time, a monitor's deadline, when a latch opens. */
  readonly dueAt: number
}

/** A job of the root's that still runs. */
export interface JobItem {
  readonly note: string
  readonly state: string
}

/** What the queue and the wakes hold for the root now. */
export interface Held {
  readonly queue: ReadonlyArray<QueueItem>
  readonly wakes: ReadonlyArray<WakeItem>
  readonly jobs: ReadonlyArray<JobItem>
}

export const NOTHING_HELD: Held = { queue: [], wakes: [], jobs: [] }

// ── The subagents now ──

/** A subagent as the note shows it: running, latched, or idle after a hand-back the root has not answered. */
export const SubagentNow = Schema.TaggedUnion({
  Running: { child: Child },
  Latched: { child: Child, opensAt: Schema.Number },
  Unanswered: { child: Child, idleSince: Schema.Number, said: Schema.String },
})
export type SubagentNow = typeof SubagentNow.Type

/** At most this many of the root's newest-called subagents are read: an old one is either answered or long listed. */
export const CHILDREN_READ = 40

/**
 * Whether an idle child's hand-back waits on the root: it handed back (`handBack`), not a verifier's `accepted`, the
 * unit it names is open (`open`), and no call of the root came after it went idle (`idleSince`) to that child or for
 * a step of that unit.
 */
export const unanswered = (child: Child, idleSince: number, handBack: Option.Option<HandBack>, units: ReadonlyMap<string, number>, open: (unit: string) => boolean): boolean =>
  Option.match(
    Option.filter(handBack, (back) => back.verdict !== "accepted"),
    {
      onNone: () => false,
      onSome: (back) => child.calledAt <= idleSince && Option.getOrElse(known(units, back.unit), () => 0) <= idleSince && open(back.unit),
    },
  )

/** A unit the status script reads closed. */
export const closed = (state: string): boolean => state === "dropped" || /^merged\b/.test(state)

// ── The note ──

/** At most this many lines of each part; the rest are counted. */
export const LINES = 12

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms)).replace(/\.\d{3}Z$/, "Z")

const capped = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (lines.length <= LINES) return lines
  return [...lines.slice(0, LINES), `- and ${lines.length - LINES} more`]
}

/** A part: its heading (`none` when it has no lines, else `some`) and its lines. */
const part = (lines: ReadonlyArray<string>, none: string, some: string): ReadonlyArray<string> => {
  if (lines.length === 0) return [none]
  return [some, ...capped(lines)]
}

const named = (child: Child) => `${child.child} (${Option.getOrElse(child.description, () => child.agent)})`

const subagentLine = (now: SubagentNow): string =>
  SubagentNow.match(now, {
    Running: (running) => `- ${named(running.child)}: running`,
    Latched: (latched) => `- ${named(latched.child)}: latched, opens ${iso(latched.opensAt)}`,
    Unanswered: (idle) => `- ${named(idle.child)}: idle since ${iso(idle.idleSince)}, last said: ${idle.said}, not woken since`,
  })

const queueLine = (item: QueueItem) => `- [${item.state}] ${item.text}${Option.match(item.detail, { onNone: () => "", onSome: (detail) => ` (${detail})` })}`

/** The ledger's lines: the queue not done, the subagents now, the wakes and jobs; an empty part says none. */
export const ledgerText = (held: Held, subagents: ReadonlyArray<SubagentNow>): string =>
  [
    "Your ledger, as it stood at the compaction:",
    ...part(held.queue.map(queueLine), "Queue: nothing open.", "Queue, not done:"),
    ...part(subagents.map(subagentLine), "Subagents: none running, latched or waiting on you.", "Subagents now:"),
    ...part(
      [...held.wakes.map((wake) => `- ${wake.kind} ${wake.note}, due ${iso(wake.dueAt)}`), ...held.jobs.map((job) => `- job ${job.note}: ${job.state}`)],
      "Wakes, monitors and jobs: none.",
      "Wakes, monitors and jobs:",
    ),
  ].join("\n")

/** At most this many started units are named when the tables cannot be read: the newest started. */
export const UNITS_NAMED = 8

const earlierOf = (count: number) => {
  if (count === 0) return ""
  return ` and ${count} earlier`
}

/** The status a root is told when the run tables cannot be read: the error, and the units it started steps of. */
export const unreadTables = (error: string, started: ReadonlyArray<string>): string => {
  const newest = started.slice(-UNITS_NAMED)
  return [
    `orchestrate: the run tables could not be read: ${error}.`,
    `The units you started steps of: ${newest.join(", ")}${earlierOf(started.length - newest.length)}.`,
    "Read each one's log.md and newest request or findings in its unit dir before you act.",
  ].join("\n")
}
