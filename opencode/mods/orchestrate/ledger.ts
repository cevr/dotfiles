// The ledger's lines and its decisions, over any store of lines (the
// filestore's JSONL file, memory's array): service.ts `Ledger`. A line is
// `{ at, sessionID, kind, ... }`: `kind` an event's tag (machine.ts `Event`)
// with the event's fields, or `Refused` with the rule, the message and the
// call. `at` is ISO 8601. A root's state is the fold of its event lines; a
// line that does not read is skipped. Each root's state is read from the
// store once and kept; one process writes each root, under a lock of its own.
import { Effect, Option, Schema, Semaphore } from "effect"
import { fold } from "@dotfiles/decider/decider"
import { type Cadence, type Command, Event, machine, type MachineState, Refused } from "./machine.ts"
import type { Decided, GuardMode } from "./service.ts"

/** One line as written. */
export type Line = Readonly<Record<string, unknown>> & { readonly at: string; readonly sessionID: string; readonly kind: string }

/** What a store keeps: the lines of one root, read back, and a line appended. */
export interface Store {
  readonly read: (sessionID: string) => Effect.Effect<ReadonlyArray<unknown>>
  readonly append: (line: Line) => Effect.Effect<void>
}

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

const decodeEvent = Schema.decodeUnknownOption(Event)
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** The event a line holds; none for a refusal, another root's line, or a line that does not read. */
export const eventOf = (line: unknown): Event | undefined => {
  if (!isRecord(line) || typeof line.kind !== "string" || typeof line.at !== "string") return undefined
  const { kind, at, sessionID: _, ...fields } = line
  const ms = Date.parse(at)
  if (Number.isNaN(ms)) return undefined
  return Option.getOrUndefined(decodeEvent({ ...fields, _tag: kind, at: ms }))
}

/** A departure is stated on the call itself, so warn mode decides the same call with one. */
const departing = (command: Command): Command | undefined =>
  command._tag === "Start" || command._tag === "Land" ? { ...command, departs: WARNED } : undefined

/** The ledger's two methods over `store`, deciding with the machine at `cadence`. */
export const make = (store: Store, cadence: Cadence) =>
  Effect.gen(function* () {
    const decider = machine(cadence)
    const states = new Map<string, MachineState>()
    const locks = new Map<string, Semaphore.Semaphore>()
    const guard = yield* Semaphore.make(1)

    const lockOf = (sessionID: string) =>
      guard.withPermits(1)(
        Effect.gen(function* () {
          const found = locks.get(sessionID)
          if (found !== undefined) return found
          const made = yield* Semaphore.make(1)
          locks.set(sessionID, made)
          return made
        }),
      )

    const load = (sessionID: string) =>
      Effect.gen(function* () {
        const kept = states.get(sessionID)
        if (kept !== undefined) return kept
        const lines = yield* store.read(sessionID)
        const state = fold(decider, lines.flatMap((line) => eventOf(line) ?? []))
        states.set(sessionID, state)
        return state
      })

    const record = (sessionID: string, events: ReadonlyArray<Event>) => Effect.forEach(events, (event) => store.append(lineOfEvent(sessionID, event)), { discard: true })

    const state = (sessionID: string) => Effect.flatMap(lockOf(sessionID), (lock) => lock.withPermits(1)(load(sessionID)))

    const decide = <E, R>(
      sessionID: string,
      now: number,
      plan: (state: MachineState) => Effect.Effect<ReadonlyArray<Command>, E, R>,
      mode: GuardMode = "refuse",
    ): Effect.Effect<Decided, Refused | E, R> =>
      Effect.flatMap(lockOf(sessionID), (lock) =>
        lock.withPermits(1)(
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
              current = fold(decider, events, current)
              states.set(sessionID, current)
              all.push(...events)
            }
            return { events: all, state: current, ...(warned === undefined ? {} : { warned }) }
          }),
        ),
      )

    return { state, decide }
  })
