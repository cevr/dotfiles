// How far a root drifted from the batch machine, from its ledger lines alone
// (ledger.ts): one number per root (a run's orchestrator), 0 for a clean run,
// each kind of drift weighted by what it costs the owner.
//
//   unfolded land  6  a land dropped a finding of the last verdict, or a verdict
//                     whose findings were not known: a known Blocker or Major
//                     shipped with no fix and no verifier to catch it;
//   departed       4  a call went against VerdictPending, VerifierRunning or
//                     FindingUnfolded: a land over an unverified batch or an
//                     unfolded finding, or two verifiers at once;
//   verifier/unit  3  a verifier started for a unit, not a batch: one more
//                     verifier's spend for what one batch verifier covers;
//   off cadence    2  a land or verifier went against BatchNotDue or
//                     LandPartial: one more gate, land and verifier;
//   refused        1  the machine refused a call: a turn lost, nothing shipped;
//   stale          1  the machine refused a call, or a call departed from a
//                     rule, that the ledger as the machine keeps it now does
//                     not break: the ledger was wrong (2026-11-12: findings
//                     accepted in batches j-l held every later land), and
//                     the run lost a turn and its trust in the machine.
//
// A departing call (its `Departed` lines: one time, one why) counts each kind
// its rules fall under once. Whether a rule held is decided again on the
// root's state as the machine folds its lines now: a refused call is decided
// again; a departure is decided again as the refused call it answered (the
// last refusal since the last land or verifier start, of one of its rules),
// else by its rule alone (FindingUnfolded holds while a finding is folded
// into no unit, or into one that is neither ready nor implementing, or a
// verdict's findings are not known; any other rule held).
//
// A compaction (ledger.ts) folds a root's lines into one `Drift` line of its
// tally, so the score survives it: a tally line replaces what was counted
// before it.
import { Effect, Option, Schema } from "effect"
import { checkpointOf, eventOf, isRecord, type Line } from "./line.ts"
import { type Cadence, Command, machine, type MachineState, riding, type Rule, unresolvedOf } from "./machine.ts"

export const KINDS = ["unfoldedLand", "departed", "verifierPerUnit", "offCadence", "refused", "stale"] as const
export type Kind = (typeof KINDS)[number]

/** Each kind's weight: what one costs the owner. */
export const WEIGHTS: Readonly<Record<Kind, number>> = { unfoldedLand: 6, departed: 4, verifierPerUnit: 3, offCadence: 2, refused: 1, stale: 1 }

/** Each kind as a line names it. */
export const LABELS: Readonly<Record<Kind, string>> = {
  unfoldedLand: "unfolded land",
  departed: "departed",
  verifierPerUnit: "verifier per unit",
  offCadence: "off cadence",
  refused: "refused",
  stale: "stale ledger",
}

/** The kind a departure from `rule` counts as, when the rule held. */
const KIND_OF: Readonly<Record<Rule, Kind>> = {
  VerifierPerUnit: "verifierPerUnit",
  VerifierRunning: "departed",
  BatchNotDue: "offCadence",
  VerdictPending: "departed",
  FindingUnfolded: "departed",
  LandPartial: "offCadence",
}

/** The most departures, and dropped findings, a tally keeps: the newest. */
export const KEEP = 20

/** One departing call: when, the rules it went against, why it said, and which of them the ledger now says did not hold. */
export interface Departure {
  readonly at: number
  readonly rules: ReadonlyArray<Rule>
  readonly why: string
  readonly stale: ReadonlyArray<Rule>
}

/** A root's drift: how many of each kind, its departures and the findings its lands dropped (the newest `KEEP` of each). */
export interface Drift {
  readonly counts: Readonly<Record<Kind, number>>
  readonly departures: ReadonlyArray<Departure>
  readonly dropped: ReadonlyArray<string>
}

const Counts = Schema.Struct({
  unfoldedLand: Schema.Number,
  departed: Schema.Number,
  verifierPerUnit: Schema.Number,
  offCadence: Schema.Number,
  refused: Schema.Number,
  stale: Schema.Number,
})
const Tally = Schema.Struct({
  counts: Counts,
  departures: Schema.Array(Schema.Struct({ at: Schema.Number, rules: Schema.Array(Schema.String), why: Schema.String, stale: Schema.Array(Schema.String) })),
  dropped: Schema.Array(Schema.String),
})
const decodeTally = Schema.decodeUnknownOption(Tally)
const decodeCommand = Schema.decodeUnknownOption(Command)

export const CLEAN: Drift = { counts: { unfoldedLand: 0, departed: 0, verifierPerUnit: 0, offCadence: 0, refused: 0, stale: 0 }, departures: [], dropped: [] }

/** The score: each kind's count by its weight. 0 is a clean run. */
export const scoreOf = (drift: Drift): number => KINDS.reduce((total, kind) => total + drift.counts[kind] * WEIGHTS[kind], 0)

/** A root's tally as one line (ledger.ts keeps it through a compaction). */
export const lineOfDrift = (sessionID: string, at: number, drift: Drift): Line => ({ at: new Date(at).toISOString(), sessionID, kind: "Drift", ...drift })

/** The tally a `Drift` line holds; none for any other line. */
const tallyOf = (line: unknown): Drift | undefined =>
  isRecord(line) && line.kind === "Drift" ? (Option.getOrUndefined(decodeTally(line)) as Drift | undefined) : undefined

/** The rules `call` breaks on `state` at `at`, as the machine decides now. */
const brokenBy = (decider: ReturnType<typeof machine>, state: MachineState, call: Command, at: number): ReadonlyArray<Rule> => {
  if (call._tag !== "Start" && call._tag !== "Land") return []
  const again = Effect.runSync(Effect.result(decider.decide(state, { ...call, departs: "drift: decided again" }, at)))
  return again._tag === "Success" ? again.success.flatMap((event) => (event._tag === "Departed" ? [event.rule] : [])) : []
}

/** Whether `rule` held on `state` with no call to decide again: FindingUnfolded by the findings, every other rule held. */
const heldAlone = (state: MachineState, rule: Rule): boolean => {
  if (rule !== "FindingUnfolded") return true
  if (unresolvedOf(state).length > 0) return true
  return Object.values(state.findings ?? {}).some((finding) => {
    if (riding(state, finding)) return false
    if (finding.into === undefined) return true
    const unit = state.units[finding.into]
    // Folded into a unit no longer in the state: a verdict checked it already; into a ready one: the land takes it.
    return unit !== undefined && unit.state !== "ready"
  })
}

const isRule = (value: unknown): value is Rule => typeof value === "string" && value in KIND_OF

/** The drift of one root's `lines`, in order, with the machine at `cadence`. */
export const driftOf = (cadence: Cadence, lines: ReadonlyArray<unknown>): Drift => {
  const decider = machine(cadence)
  let state = decider.initial
  const counts: Record<Kind, number> = { ...CLEAN.counts }
  let departures: Array<Departure> = []
  let dropped: Array<string> = []
  // The refused call a departure answers: the last since the last land or verifier start.
  let refusal: { readonly rule: Rule; readonly call: Command } | undefined
  let group: { at: string; why: string; rules: Array<Rule> } | undefined

  const close = () => {
    if (group === undefined) return
    const at = Date.parse(group.at)
    const call = refusal !== undefined && group.rules.includes(refusal.rule) ? refusal.call : undefined
    const now = call === undefined ? undefined : brokenBy(decider, state, call, at)
    const stale = group.rules.filter((rule) => (now === undefined ? !heldAlone(state, rule) : !now.includes(rule)))
    const kinds = new Set(group.rules.map((rule) => (stale.includes(rule) ? "stale" : KIND_OF[rule])))
    for (const kind of kinds) counts[kind] += 1
    departures = [...departures, { at, rules: group.rules, why: group.why, stale }].slice(-KEEP)
    group = undefined
  }

  for (const line of lines) {
    if (!isRecord(line) || typeof line.at !== "string") continue
    if (line.kind === "Departed" && isRule(line.rule)) {
      const why = typeof line.why === "string" ? line.why : ""
      if (group !== undefined && (group.at !== line.at || group.why !== why)) close()
      group ??= { at: line.at, why, rules: [] }
      group.rules.push(line.rule)
      continue
    }
    close()
    const tally = tallyOf(line)
    if (tally !== undefined) {
      Object.assign(counts, tally.counts)
      departures = [...tally.departures]
      dropped = [...tally.dropped]
      continue
    }
    const checkpoint = checkpointOf(line)
    if (checkpoint !== undefined) {
      state = checkpoint
      continue
    }
    if (line.kind === "Refused" && isRule(line.rule)) {
      const call = Option.getOrUndefined(decodeCommand(line.call))
      const held = call === undefined ? heldAlone(state, line.rule) : brokenBy(decider, state, call, Date.parse(line.at)).includes(line.rule)
      counts[held ? "refused" : "stale"] += 1
      if (call !== undefined) refusal = { rule: line.rule, call }
      continue
    }
    const event = eventOf(line)
    if (event === undefined) continue
    if (event._tag === "BatchLanded") {
      // What the land drops: a finding folded into no unit, and a verdict whose findings are not known.
      const lost = [
        ...Object.entries(state.findings ?? {}).flatMap(([key, finding]) => (finding.into === undefined ? [key] : [])),
        ...unresolvedOf(state).map(([batch]) => `${batch} (findings not known)`),
      ]
      if (lost.length > 0) {
        counts.unfoldedLand += 1
        dropped = [...dropped, ...lost].slice(-KEEP)
      }
    }
    if (event._tag === "BatchLanded" || event._tag === "VerifierStarted") refusal = undefined
    state = decider.evolve(state, event)
  }
  close()
  return { counts, departures, dropped }
}

/** The drift as one line: `drift 0 (clean)`, or `drift 13: 1 unfolded land ×6, 1 departed ×4, 3 refused ×1`. */
export const driftLine = (drift: Drift): string => {
  const score = scoreOf(drift)
  if (score === 0) return "drift 0 (clean)"
  const parts = KINDS.filter((kind) => drift.counts[kind] > 0).map((kind) => `${drift.counts[kind]} ${LABELS[kind]} ×${WEIGHTS[kind]}`)
  return `drift ${score}: ${parts.join(", ")}`
}

/** The newest `n` departures, each with its rules and why (a stale rule marked). */
export const departureLines = (drift: Drift, n = 3): ReadonlyArray<string> =>
  drift.departures.slice(-n).map((departure) => {
    const rules = departure.rules.map((rule) => (departure.stale.includes(rule) ? `${rule} (stale)` : rule)).join(", ")
    return `${new Date(departure.at).toISOString().slice(0, 16)}Z ${rules}: ${departure.why}`
  })
