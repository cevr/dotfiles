// The ledger's lines and its decisions, over any store of lines (the
// filestore's JSONL file, memory's array): service.ts `Ledger`. A line is
// `{ at, sessionID, kind, ... }`: `kind` an event's tag (machine.ts `Event`)
// with the event's fields, `Refused` with the rule, the message and the call,
// or `Checkpoint` with a root's whole state. `at` is ISO 8601. A root's state
// is the fold of its lines from its last checkpoint; a line that does not
// read is skipped.
//
// One ledger per store, whoever opens it. A root is keyed by its session
// alone, never by a directory: the plugin has one copy per location, and a
// root that moves (a Rift's session_move) is decided by each copy in turn.
// So nothing is kept between decisions: each one reads the store afresh, and
// every ledger open on the same store (`Store.key`) in this process shares
// one lock, so its decisions apply one at a time, in the order asked.
//
// The store is bounded (`Retention`). After a decision that leaves it past
// its threshold, it is compacted: each root's lines become one checkpoint of
// its state (none when it holds nothing) and its last departures and
// refusals within the idle window; a root idle past the window is dropped, and
// only the most recently active roots are kept. The next threshold is twice
// what the compaction kept, and never less than `bytes`, so a compaction runs
// at most once per that many bytes written.
import { Effect, Option, Schema, Semaphore } from "effect"
import { type Cadence, type Command, Event, machine, type MachineState, Refused, Unresolved } from "./machine.ts"
import type { Decided, GuardMode } from "./service.ts"

/** One line as written. */
export type Line = Readonly<Record<string, unknown>> & { readonly at: string; readonly sessionID: string; readonly kind: string }

/** What a store keeps: its lines, read afresh, a line appended, all its lines replaced, and its size in bytes. */
export interface Store {
  /** The same for every opener of this store (its file's path, its array): they share one lock. */
  readonly key: unknown
  readonly read: () => Effect.Effect<ReadonlyArray<unknown>>
  readonly append: (line: Line) => Effect.Effect<void>
  readonly replace: (lines: ReadonlyArray<Line>) => Effect.Effect<void>
  readonly size: () => Effect.Effect<number>
}

/** How much the store keeps: see the header. */
export interface Retention {
  /** The store's size past which it is compacted, in bytes. */
  readonly bytes: number
  /** A root with no line for this long is dropped, and so is a departure or refusal older than it. */
  readonly idleMs: number
  /** The most roots kept: the most recently active. */
  readonly roots: number
  /** The most departures and refusals kept per root: the newest. */
  readonly audit: number
}

const DAY = 24 * 60 * 60_000

/** 256 KiB; a week; 64 roots; 20 departures and refusals each. */
export const DEFAULT_RETENTION: Retention = { bytes: 256 * 1024, idleMs: 7 * DAY, roots: 64, audit: 20 }

/** Why a call `warn` let pass: the departure the ledger records for it. */
export const WARNED = "warn mode: the plugin let it pass"

const iso = (ms: number) => new Date(ms).toISOString()

/** An event as its line. */
export const lineOfEvent = (sessionID: string, event: Event): Line => {
  const { _tag, at, ...fields } = event
  return { at: iso(at), sessionID, kind: _tag, ...fields }
}

/** A refusal as its line: the rule, its message, and the call it refused. */
export const lineOfRefusal = (sessionID: string, now: number, refused: Refused, call: Command): Line => ({
  at: iso(now),
  sessionID,
  kind: "Refused",
  rule: refused.rule,
  message: refused.message,
  call,
})

const Unit = Schema.Struct({
  state: Schema.Literals(["implement", "ended", "ready", "landed", "verify"]),
  round: Schema.Number,
  since: Schema.Number,
  direct: Schema.Boolean,
  child: Schema.optionalKey(Schema.String),
  workspaces: Schema.optionalKey(Schema.Array(Schema.String)),
})
const State = Schema.Struct({
  units: Schema.Record(Schema.String, Unit),
  verifier: Schema.optionalKey(
    Schema.Struct({ batch: Schema.String, since: Schema.Number, units: Schema.optionalKey(Schema.Array(Schema.String)), child: Schema.optionalKey(Schema.String) }),
  ),
  unverified: Schema.optionalKey(Schema.Array(Schema.String)),
  findings: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({ batch: Schema.String, into: Schema.optionalKey(Schema.String) }))),
  carried: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({ batch: Schema.String, into: Schema.String }))),
  unresolved: Schema.optionalKey(Schema.Record(Schema.String, Unresolved)),
})

/** A root's whole state as one line, stamped with its last line's time. */
export const lineOfCheckpoint = (sessionID: string, at: number, state: MachineState): Line => ({ at: iso(at), sessionID, kind: "Checkpoint", state })

const decodeEvent = Schema.decodeUnknownOption(Event)
const decodeState = Schema.decodeUnknownOption(State)
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** A line's root and time; none for a line that does not read. */
const headOf = (line: unknown): { readonly sessionID: string; readonly at: number } | undefined => {
  if (!isRecord(line) || typeof line.kind !== "string" || typeof line.at !== "string" || typeof line.sessionID !== "string") return undefined
  const at = Date.parse(line.at)
  return Number.isNaN(at) ? undefined : { sessionID: line.sessionID, at }
}

/** The event a line holds; none for a refusal, a checkpoint, or a line that does not read. */
export const eventOf = (line: unknown): Event | undefined => {
  if (!isRecord(line) || typeof line.kind !== "string" || typeof line.at !== "string") return undefined
  const { kind, at, sessionID: _, ...fields } = line
  const ms = Date.parse(at)
  if (Number.isNaN(ms)) return undefined
  return Option.getOrUndefined(decodeEvent({ ...fields, _tag: kind, at: ms }))
}

/** The state a checkpoint line holds; none for any other line. */
const checkpointOf = (line: unknown): MachineState | undefined =>
  isRecord(line) && line.kind === "Checkpoint" ? Option.getOrUndefined(decodeState(line.state)) : undefined

/** A root's state: the fold of `lines` (its own) from its last checkpoint. */
export const stateOf = (cadence: Cadence, lines: ReadonlyArray<unknown>): MachineState => {
  const decider = machine(cadence)
  let state = decider.initial
  for (const line of lines) {
    const checkpoint = checkpointOf(line)
    if (checkpoint !== undefined) state = checkpoint
    const event = checkpoint === undefined ? eventOf(line) : undefined
    if (event !== undefined) state = decider.evolve(state, event)
  }
  return state
}

const holds = (state: MachineState) =>
  Object.keys(state.units).length > 0 || state.verifier !== undefined || state.findings !== undefined || state.carried !== undefined || state.unverified !== undefined || state.unresolved !== undefined
const isAudit = (line: unknown) => isRecord(line) && (line.kind === "Departed" || line.kind === "Refused")

/**
 * What a compaction at `now` keeps of `lines`: for each root active within
 * the window, newest first and at most `retention.roots`, a checkpoint of
 * its state when it holds anything, then its newest departures and refusals
 * within the window. Every kept root's state is the one its lines folded to.
 */
export const compact = (cadence: Cadence, retention: Retention, now: number, lines: ReadonlyArray<unknown>): ReadonlyArray<Line> => {
  const roots = new Map<string, { last: number; lines: Array<unknown> }>()
  for (const line of lines) {
    const head = headOf(line)
    if (head === undefined) continue
    const root = roots.get(head.sessionID) ?? { last: head.at, lines: [] }
    root.last = Math.max(root.last, head.at)
    root.lines.push(line)
    roots.set(head.sessionID, root)
  }
  return [...roots.entries()]
    .filter(([, root]) => now - root.last <= retention.idleMs)
    .sort(([, a], [, b]) => b.last - a.last)
    .slice(0, retention.roots)
    .flatMap(([sessionID, root]): ReadonlyArray<Line> => {
      const state = stateOf(cadence, root.lines)
      const audit = root.lines.filter((line) => isAudit(line) && now - headOf(line)!.at <= retention.idleMs).slice(-retention.audit) as ReadonlyArray<Line>
      return holds(state) ? [lineOfCheckpoint(sessionID, root.last, state), ...audit] : audit
    })
}

/** Each store's one lock and its next compaction threshold, shared by every ledger on it in this process. */
interface Shared {
  readonly lock: Semaphore.Semaphore
  threshold: number
}
const SHARED = Symbol.for("dotfiles-opencode.orchestrate.ledger")
const registry = ((globalThis as { [SHARED]?: Map<unknown, Shared> })[SHARED] ??= new Map<unknown, Shared>())

const sharedOf = (key: unknown, retention: Retention): Shared => {
  const found = registry.get(key)
  if (found !== undefined) return found
  const made: Shared = { lock: Semaphore.makeUnsafe(1), threshold: retention.bytes }
  registry.set(key, made)
  return made
}

const isOf = (sessionID: string) => (line: unknown) => isRecord(line) && line.sessionID === sessionID

/** A departure is stated on the call itself, so warn mode decides the same call with one. */
const departing = (command: Command): Command | undefined =>
  command._tag === "Start" || command._tag === "Land" ? { ...command, departs: WARNED } : undefined

/** The ledger's two methods over `store`, deciding with the machine at `cadence`, keeping it within `retention`. */
export const make = (store: Store, cadence: Cadence, retention: Retention = DEFAULT_RETENTION) =>
  Effect.sync(() => {
    const decider = machine(cadence)
    const shared = sharedOf(store.key, retention)

    const load = (sessionID: string) => Effect.map(store.read(), (lines) => stateOf(cadence, lines.filter(isOf(sessionID))))

    const compactIfDue = (now: number) =>
      Effect.gen(function* () {
        if ((yield* store.size()) <= shared.threshold) return
        yield* store.replace(compact(cadence, retention, now, yield* store.read()))
        shared.threshold = Math.max(retention.bytes, 2 * (yield* store.size()))
      })

    const record = (sessionID: string, events: ReadonlyArray<Event>) => Effect.forEach(events, (event) => store.append(lineOfEvent(sessionID, event)), { discard: true })

    const state = (sessionID: string) => shared.lock.withPermits(1)(load(sessionID))

    const decide = <E, R>(
      sessionID: string,
      now: number,
      plan: (state: MachineState) => Effect.Effect<ReadonlyArray<Command>, E, R>,
      mode: GuardMode = "refuse",
    ): Effect.Effect<Decided, Refused | E, R> =>
      shared.lock.withPermits(1)(
        Effect.gen(function* () {
          let current = yield* load(sessionID)
          const all: Array<Event> = []
          let warned: Refused | undefined
          for (const command of yield* plan(current)) {
            const outcome = yield* Effect.result(decider.decide(current, command, now))
            let events: ReadonlyArray<Event>
            if (outcome._tag === "Success") events = outcome.success
            else {
              const again = mode === "warn" ? departing(command) : undefined
              const passed = again === undefined ? undefined : yield* Effect.option(decider.decide(current, again, now))
              if (passed === undefined || Option.isNone(passed)) {
                yield* store.append(lineOfRefusal(sessionID, now, outcome.failure, command))
                return yield* outcome.failure
              }
              warned = outcome.failure
              events = passed.value
            }
            yield* record(sessionID, events)
            for (const event of events) current = decider.evolve(current, event)
            all.push(...events)
          }
          return { events: all, state: current, ...(warned === undefined ? {} : { warned }) }
        }).pipe(Effect.ensuring(compactIfDue(now))),
      )

    return { state, decide }
  })
