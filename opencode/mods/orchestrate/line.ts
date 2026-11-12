// One ledger line and how it reads (ledger.ts keeps the lines, drift.ts
// scores them): `{ at, sessionID, kind, ... }`, `kind` an event's tag
// (machine.ts `Event`) with the event's fields, `Refused` with the rule, the
// message and the call, `Checkpoint` with a root's whole state, or `Drift`
// with the root's drift tally up to it (drift.ts). `at` is ISO 8601. A line
// that does not read is none of these.
import { Option, Schema } from "effect"
import { Event, MachineState } from "./machine.ts"

/** One line as written. */
export type Line = Readonly<Record<string, unknown>> & { readonly at: string; readonly sessionID: string; readonly kind: string }

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const decodeEvent = Schema.decodeUnknownOption(Event)
/** A checkpoint holds the machine's own state schema: whatever the machine keeps, a compaction keeps. */
const decodeState = Schema.decodeUnknownOption(MachineState)

/** A line's root and time; none for a line that does not read. */
export const headOf = (line: unknown): { readonly sessionID: string; readonly at: number } | undefined => {
  if (!isRecord(line) || typeof line.kind !== "string" || typeof line.at !== "string" || typeof line.sessionID !== "string") return undefined
  const at = Date.parse(line.at)
  return Number.isNaN(at) ? undefined : { sessionID: line.sessionID, at }
}

/** The event a line holds; none for a refusal, a checkpoint, a tally, or a line that does not read. */
export const eventOf = (line: unknown): Event | undefined => {
  if (!isRecord(line) || typeof line.kind !== "string" || typeof line.at !== "string") return undefined
  const { kind, at, sessionID: _, ...fields } = line
  const ms = Date.parse(at)
  if (Number.isNaN(ms)) return undefined
  return Option.getOrUndefined(decodeEvent({ ...fields, _tag: kind, at: ms }))
}

/** The state a checkpoint line holds; none for any other line. */
export const checkpointOf = (line: unknown): MachineState | undefined =>
  isRecord(line) && line.kind === "Checkpoint" ? Option.getOrUndefined(decodeState(line.state)) : undefined
