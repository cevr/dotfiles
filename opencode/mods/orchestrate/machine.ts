// The batch machine one root runs, as the plugin sees it: the Machine
// aggregate, one per root session that starts role agents. The orchestrate
// skill's machine (SKILL.md, "The machine") fans implementors out, lands
// every ready unit as one batch on its cadence, and verifies each batch with
// one fresh verifier on its merged head. The audit of 2026-11-11 found roots
// that knew the rule and broke it after a compaction: a verifier per unit, a
// land of the one unit that just handed back. So the plugin keeps the
// machine's state from the calls it already sees (a role's start, its
// hand-back, a `rift` land) and refuses a call against it, in the skill's own
// words (`RULES`), naming what to do instead.
//
// The machine is a pipeline (SKILL.md, "The pipeline"): while batch N's
// verifier runs, batch N+1's implementors fan out, since no rule holds an
// implementor's start. Verdict N folds forward: each finding of it (read
// from the verifier's findings by the plugin, `<unit>/<id>`) goes into a unit
// of batch N+1, by that unit's implementor's start: its own unit's findings
// by themselves, others named in `(folds: …)`. Batch N+1 lands once verdict
// N is in, with every finding folded into a unit: one folded into a ready
// unit lands with it; one folded into a unit still implementing does not
// hold the other ready units, it rides with its unit's later land, whose
// verifier checks it as folded.
//
// A unit is `implement` (its implementor runs), `ended` (its implementor
// stopped without `ready`; a later `ready` or a land naming it moves it on),
// `ready`, `landed` (no verifier started for it yet) or `verify` (a verifier covering it runs). A verifier's verdict takes
// the units it covered out of the state and opens its findings; a unit's
// next round comes back in by its implementor's start. A `direct` unit closes
// when it lands.
//
// The rules, in the order they are checked:
//
//   VerifierPerUnit  a verifier whose name is not `batch-<k>`, while the root has any unit;
//   VerifierRunning  a verifier while one runs;
//   BatchNotDue      a verifier with nothing landed, or a land, while fewer than
//                    `cadence.ready` units are ready, the oldest has waited less
//                    than `cadence.waitMs`, and an implementor still runs (with
//                    none running there is nothing to wait for);
//   VerdictPending   a land while a landed batch has no verdict: no verifier
//                    started for it yet, or its verifier still runs. The
//                    batch and its verifier say so (`unverified`, the
//                    verifier's `units`), not a unit's slot, which a covered
//                    unit's next round takes over;
//   FindingUnfolded  a land while a finding of the last verdict is not folded
//                    into a unit, or is folded into a ready unit the land
//                    leaves out (one folded into a unit that stopped rides with
//                    its unit's later land), or while a `changes`
//                    verdict's report did not read (`unresolved`: its
//                    findings are not known, never none; the plugin reads
//                    it again before each start and land, `ReportRead`);
//   LandPartial      a land that leaves a ready unit out.
//
// A call that states why it goes against them (`departs`) passes, and records
// one `Departed` per rule it broke; a land that departs with a finding
// unfolded drops that finding. A verifier covers what is landed; with
// nothing landed, what is ready (a land by hand, which the plugin does not
// see, so the verifier's start stands for it, and the findings folded into
// those units go to the verifier as folded, as a land's would). A verdict
// closes the findings folded into a unit it took out of the state. A root that runs no unit is
// left alone.
//
// Pure: no file, no clock. The ledger (service.ts `Ledger`) keeps each root's
// events and refusals; the plugin feeds it (model.ts).
import { Effect, Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"
import { type Cadence, DEFAULT_CADENCE } from "./idle.ts"
import { described, STEPS } from "./described.ts"

export { type Cadence, DEFAULT_CADENCE }

// ── The rules ──

export const Rule = Schema.Literals(["VerifierPerUnit", "VerifierRunning", "BatchNotDue", "VerdictPending", "FindingUnfolded", "LandPartial"])
export type Rule = typeof Rule.Type

/**
 * Each rule's words, a sentence of SKILL.md word for word, and the name a
 * run's `Departs from <name>: <why>` line gives it (the section or the bold
 * lead the sentence sits under). git/machine-words.test.ts holds them to the
 * skill: a reworded sentence there reddens it.
 */
export const RULES: Readonly<Record<Rule, { readonly name: string; readonly words: string }>> = {
  VerifierPerUnit: { name: "Verify a batch", words: "One verifier per batch, fresh, in a clean checkout of the batch head" },
  VerifierRunning: { name: "Verify a batch", words: "never more than one runs on a machine at a time" },
  BatchNotDue: { name: "Batch cadence", words: "Land when 3 units are ready or the oldest ready unit has waited 30 minutes." },
  VerdictPending: { name: "The pipeline", words: "Batch N+1 lands only once batch N's verdict is in" },
  FindingUnfolded: { name: "The pipeline", words: "only with every finding of batch N folded into a unit of batch N+1" },
  LandPartial: { name: "Land a batch", words: "Land every ready unit at once when the cadence fires" },
}

/** A verifier named for a batch: `verifier batch-<k> r1`. */
export const BATCH = /^batch-/

// ── The commands ──

const Role = Schema.Literals(STEPS)

/**
 * A role agent's call: its role, the unit or batch its description names, the
 * round (1 when it names none), whether it ends `(direct)`, the findings it
 * folds into its unit (`(folds: auth/M1, billing)`: a finding, or every open
 * finding of a unit), and why it goes against the machine, when it says
 * (`(departs: <why>)`).
 */
export const Start = Schema.TaggedStruct("Start", {
  role: Role,
  name: Schema.String,
  round: Schema.Number,
  direct: Schema.Boolean,
  folds: Schema.optionalKey(Schema.Array(Schema.String)),
  departs: Schema.optionalKey(Schema.String),
  /** An implementor's Rift, as its description names it: `(rift: <path>)`. A land of that path is its unit's. */
  rift: Schema.optionalKey(Schema.String),
})
export interface Start extends Schema.Schema.Type<typeof Start> {}

/** What a role agent's hand-back line said; `none` when it ended with no hand-back. */
export const Verdict = Schema.Literals(["ready", "blocked", "accepted", "changes", "stuck", "none"])
export type Verdict = typeof Verdict.Type

/**
 * A verdict whose findings are not known: its report could not be read (the
 * hand-back named none, the file is missing, a unit's findings file it names
 * is missing). `report` is the path the hand-back named, `why` what failed.
 * It is never an empty set of findings: the next land waits for it.
 */
export const Unresolved = Schema.Struct({ report: Schema.optionalKey(Schema.String), why: Schema.String })
export interface Unresolved extends Schema.Schema.Type<typeof Unresolved> {}

/**
 * A hand-back. A verifier's `changes` carries its findings (`<unit>/<id>`) as
 * the plugin read them from its report, or `unread` when it could not: a
 * `changes` with neither is unresolved too (its report was never read).
 */
export const HandBack = Schema.TaggedStruct("HandBack", {
  role: Role,
  name: Schema.String,
  verdict: Verdict,
  findings: Schema.optionalKey(Schema.Array(Schema.String)),
  unread: Schema.optionalKey(Unresolved),
})
export interface HandBack extends Schema.Schema.Type<typeof HandBack> {}

/** An unresolved verdict's report, read since: its findings. */
export const ReportRead = Schema.TaggedStruct("ReportRead", { batch: Schema.String, findings: Schema.Array(Schema.String) })
export interface ReportRead extends Schema.Schema.Type<typeof ReportRead> {}

/**
 * One Rift a land names, as the land's input and the Rift itself say (never a brief):
 * - `rift`: the input's entry, a path, a Rift's name or a branch;
 * - `branch`: the branch checked out there, when the plugin read it;
 * - `unit`: the unit the input names it for (`rifts: [{ path, unit }]`).
 */
export const LandEntry = Schema.Struct({ rift: Schema.String, branch: Schema.optionalKey(Schema.String), unit: Schema.optionalKey(Schema.String) })
export interface LandEntry extends Schema.Schema.Type<typeof LandEntry> {}

/** A land's Rift: its entry as a string, or with what the plugin knows of it. */
export const LandTarget = Schema.Union([Schema.String, LandEntry])
export type LandTarget = typeof LandTarget.Type

/** A `rift` land about to run, with the Rifts it names. */
export const Land = Schema.TaggedStruct("Land", { rifts: Schema.Array(LandTarget), departs: Schema.optionalKey(Schema.String) })
export interface Land extends Schema.Schema.Type<typeof Land> {}

/** The Rifts a land answered green. */
export const Landed = Schema.TaggedStruct("Landed", { rifts: Schema.Array(LandTarget) })
export interface Landed extends Schema.Schema.Type<typeof Landed> {}

/** The session a started step runs in, once the plugin knows it: what the ledger checks is still alive. */
export const Spawned = Schema.TaggedStruct("Spawned", { role: Role, name: Schema.String, child: Schema.String })
export interface Spawned extends Schema.Schema.Type<typeof Spawned> {}

export const Command = Schema.Union([Start, HandBack, Land, Landed, Spawned, ReportRead])
export type Command = Start | HandBack | Land | Landed | Spawned | ReportRead

// ── The events ──

/** A unit's round started; `rift`, the Rift its description named, is the unit's as well as those it had. */
export const UnitStarted = Schema.TaggedStruct("UnitStarted", {
  unit: Schema.String,
  round: Schema.Number,
  direct: Schema.Boolean,
  rift: Schema.optionalKey(Schema.String),
  at: Schema.Number,
})
export interface UnitStarted extends Schema.Schema.Type<typeof UnitStarted> {}

/** An implementor's hand-back; `said`, its verdict, is absent from lines written before it was kept. */
export const UnitHandedBack = Schema.TaggedStruct("UnitHandedBack", { unit: Schema.String, ready: Schema.Boolean, said: Schema.optionalKey(Verdict), at: Schema.Number })
export interface UnitHandedBack extends Schema.Schema.Type<typeof UnitHandedBack> {}

export const BatchLanded = Schema.TaggedStruct("BatchLanded", { units: Schema.Array(Schema.String), at: Schema.Number })
export interface BatchLanded extends Schema.Schema.Type<typeof BatchLanded> {}

/** A verifier started over `units`, also checking `findings` of the batch before as folded (`<unit>/<id> → <into>`). */
export const VerifierStarted = Schema.TaggedStruct("VerifierStarted", {
  batch: Schema.String,
  units: Schema.Array(Schema.String),
  findings: Schema.optionalKey(Schema.Array(Schema.String)),
  at: Schema.Number,
})
export interface VerifierStarted extends Schema.Schema.Type<typeof VerifierStarted> {}

/** A verifier's verdict, with the findings it opened, or, for a `changes` whose report did not read, why its findings are unknown. */
export const VerifierEnded = Schema.TaggedStruct("VerifierEnded", {
  batch: Schema.String,
  verdict: Verdict,
  findings: Schema.optionalKey(Schema.Array(Schema.String)),
  unresolved: Schema.optionalKey(Unresolved),
  at: Schema.Number,
})
export interface VerifierEnded extends Schema.Schema.Type<typeof VerifierEnded> {}

/** An unresolved verdict's report read at last: its findings open. */
export const ReportResolved = Schema.TaggedStruct("ReportResolved", { batch: Schema.String, findings: Schema.Array(Schema.String), at: Schema.Number })
export interface ReportResolved extends Schema.Schema.Type<typeof ReportResolved> {}

/** A finding of a verdict went into `into`: a running implementor's round, or a new fix unit. */
export const FindingFolded = Schema.TaggedStruct("FindingFolded", { finding: Schema.String, into: Schema.String, at: Schema.Number })
export interface FindingFolded extends Schema.Schema.Type<typeof FindingFolded> {}

/** A call went against `rule`, saying `why`. */
export const Departed = Schema.TaggedStruct("Departed", { rule: Rule, why: Schema.String, at: Schema.Number })
export interface Departed extends Schema.Schema.Type<typeof Departed> {}

/** A step's session: an implementor's (`role` implementor, its unit) or the running verifier's. */
export const StepSpawned = Schema.TaggedStruct("StepSpawned", { role: Role, name: Schema.String, child: Schema.String, at: Schema.Number })
export interface StepSpawned extends Schema.Schema.Type<typeof StepSpawned> {}

export const Event = Schema.Union([UnitStarted, UnitHandedBack, BatchLanded, VerifierStarted, VerifierEnded, ReportResolved, FindingFolded, Departed, StepSpawned])
export type Event = UnitStarted | UnitHandedBack | BatchLanded | VerifierStarted | VerifierEnded | ReportResolved | FindingFolded | Departed | StepSpawned

/** The call went against `rule`; `message` quotes the rule and says what to do instead. */
export class Refused extends Schema.TaggedError<Refused>()("Refused", { rule: Rule, message: Schema.String }) {}

// ── The state ──

/**
 * The state's schema is the ledger's: a `Checkpoint` line (line.ts) decodes a root's state with it, so a field the
 * machine keeps is the field a compaction keeps. There is no second shape of a unit or a state.
 */
export const UnitState = Schema.Literals(["implement", "ended", "ready", "landed", "verify"])
export type UnitState = typeof UnitState.Type

export const Unit = Schema.Struct({
  state: UnitState,
  round: Schema.Number,
  /** When it entered its state (epoch ms). */
  since: Schema.Number,
  direct: Schema.Boolean,
  /** Its implementor's session, once known. */
  child: Schema.optionalKey(Schema.String),
  /** The Rifts its implementors were started on, by `(rift: <path>)` in their descriptions; absent when none named one. */
  rifts: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * What an `ended` unit's hand-back said (`blocked`, `stuck`, `none` for one that died): it may go on, so its
   * findings ride with it. Absent on a unit a ledger ended before this was kept: one the ledger lost track of.
   */
  said: Schema.optionalKey(Verdict),
})
export interface Unit extends Schema.Schema.Type<typeof Unit> {}

/** A finding of a verdict: the verifier's batch, and the unit it was folded into, once it was. */
export const Finding = Schema.Struct({ batch: Schema.String, into: Schema.optionalKey(Schema.String) })
export interface Finding extends Schema.Schema.Type<typeof Finding> {}

/** A finding folded into a unit that landed: its batch and that unit. */
const Carried = Schema.Struct({ batch: Schema.String, into: Schema.String })

export const MachineState = Schema.Struct({
  units: Schema.Record(Schema.String, Unit),
  /**
   * The running verifier: its batch, since when, the units it covers (as it
   * started; a covered unit's next round leaves its unit slot, not this),
   * and its session once known.
   */
  verifier: Schema.optionalKey(
    Schema.Struct({ batch: Schema.String, since: Schema.Number, units: Schema.optionalKey(Schema.Array(Schema.String)), child: Schema.optionalKey(Schema.String) }),
  ),
  /**
   * The units landed with no verifier started over them yet, whatever round
   * each has moved on to since; absent when none. With the verifier, it is
   * what makes a verdict pending: no unit's state says it.
   */
  unverified: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The last verdicts' findings not landed yet, by `<unit>/<id>`; absent when none. */
  findings: Schema.optionalKey(Schema.Record(Schema.String, Finding)),
  /** Findings folded into units that landed, for the next verifier to check as folded; absent when none. */
  carried: Schema.optionalKey(Schema.Record(Schema.String, Carried)),
  /** The `changes` verdicts whose findings are not known (their report did not read), by batch; absent when none. */
  unresolved: Schema.optionalKey(Schema.Record(Schema.String, Unresolved)),
})
export interface MachineState extends Schema.Schema.Type<typeof MachineState> {}

/** The units in any of `states`, in the order they entered the state record. */
export const unitsIn = (state: MachineState, ...states: ReadonlyArray<UnitState>): ReadonlyArray<string> =>
  Object.entries(state.units)
    .filter(([, unit]) => states.includes(unit.state))
    .map(([name]) => name)

/** The unit a finding is of: `auth` for `auth/M1`. */
export const unitOfFinding = (finding: string): string => finding.split("/")[0]!

/** The open findings, as `[key, finding]`. */
const openFindings = (state: MachineState): ReadonlyArray<readonly [string, Finding]> => Object.entries(state.findings ?? {})

/** A finding folded into a unit still implementing: it holds no land, and rides with its unit's. */
export const riding = (state: MachineState, finding: Finding): boolean => finding.into !== undefined && state.units[finding.into]?.state === "implement"

/**
 * A finding folded into a unit whose implementor stopped without a `ready` the plugin read (blocked, stuck, died):
 * it holds no land, and rides with its unit's later land, as one still implementing does.
 */
export const endedWith = (state: MachineState, finding: Finding): boolean => unitsIn(state, "ended").some((name) => name === finding.into)

/**
 * A finding folded into an ended unit with no hand-back on record: a ledger written before hand-backs were kept,
 * whose unit landed and was verified by a hand-back or a land it missed (the ledger of 2026-11-12, batches af-ai).
 * Its unit has ended, so it is never open again: the next land or verdict settles it.
 */
export const settled = (state: MachineState, finding: Finding): boolean =>
  Object.entries(state.units).some(([name, unit]) => name === finding.into && unit.state === "ended" && !("said" in unit))

/** A folded finding that holds no land: its unit still implements, or stopped (it rides), or ended long ago (settled). */
export const holdsNoLand = (state: MachineState, finding: Finding): boolean => riding(state, finding) || endedWith(state, finding)

/**
 * The open findings a land of `lands` would leave unfolded: none folded, or folded into a unit it
 * does not take that is neither still implementing (that one rides with its own land) nor ended.
 */
export const unfoldedOf = (state: MachineState, lands: ReadonlyArray<string>): ReadonlyArray<string> =>
  openFindings(state)
    .filter(([, finding]) => finding.into === undefined || (!lands.includes(finding.into) && !holdsNoLand(state, finding)))
    .map(([key]) => key)

/** The open findings an implementor's start folds into its unit: its own unit's, and those its `folds` name. */
export const foldsOf = (state: MachineState, start: Start): ReadonlyArray<string> =>
  openFindings(state)
    .filter(([key, finding]) => finding.into !== start.name && (unitOfFinding(key) === start.name || (start.folds ?? []).some((ref) => ref === key || ref === unitOfFinding(key))))
    .map(([key]) => key)

/** A state with its optional records, each left out when empty. */
const tidy = (state: MachineState): MachineState => {
  const { findings, carried, unresolved, unverified, ...rest } = state
  return {
    ...rest,
    ...(unverified === undefined || unverified.length === 0 ? {} : { unverified }),
    ...(findings === undefined || Object.keys(findings).length === 0 ? {} : { findings }),
    ...(carried === undefined || Object.keys(carried).length === 0 ? {} : { carried }),
    ...(unresolved === undefined || Object.keys(unresolved).length === 0 ? {} : { unresolved }),
  }
}

/** The verdicts whose findings are not known, as `[batch, unresolved]`. */
export const unresolvedOf = (state: MachineState): ReadonlyArray<readonly [string, Unresolved]> => Object.entries(state.unresolved ?? {})

/**
 * Whether a landed batch has no verdict yet: a verifier runs, or units landed
 * with none started over them. Read from the batch and its verifier, never
 * from a unit's slot alone, which its next round takes over; a unit `landed`
 * or `verify` counts too (a checkpoint from before `unverified` was kept).
 */
export const verdictPending = (state: MachineState): boolean =>
  state.verifier !== undefined || (state.unverified ?? []).length > 0 || unitsIn(state, "landed", "verify").length > 0

/** What a landed batch waiting for its verifier holds: the units landed with none started over them. */
const unverifiedOf = (state: MachineState): ReadonlyArray<string> => [...new Set([...(state.unverified ?? []), ...unitsIn(state, "landed")])]

/** The units the running verifier covers: as it started, else (an older checkpoint) those in `verify`. */
const coveredOf = (state: MachineState): ReadonlyArray<string> => state.verifier?.units ?? unitsIn(state, "verify")

// ── A land's Rifts and their units ──
//
// A unit is named by its role call's description (`implementor <unit> rN`). A Rift a land names is a unit's
// by what the land's input, the ledger and the Rift itself say, never by a brief: an implementor's prompt may
// name any Rift (a "do not touch" line, another unit's), so no prompt is read for workspaces. In order:
//
// 1. the unit the input names it for (`{ path, unit }`), when that is a unit; any other is no unit;
// 2. else the unit whose implementor was started on that Rift (`(rift: <path>)` in its description, kept
//    in the ledger across rounds): the entry is that path, or its last segment; two units on it is none;
// 3. else its branch, when the plugin read it from the Rift: `feat/<unit>`, or a later round's
//    `feat/<unit>-<n>` (any prefix: `<run>/<unit>` too), by the name rule on its last segment;
// 4. else the entry itself, by the name rule on its last segment: a unit's name, a branch, or a Rift's
//    path or name (`<unit>`, `<unit>-<n>`, workrift's `feat-<unit>`).
//
// The name rule reads a name every way it can: as a unit's exact name, and as `<name>-<n>`, unit `<name>`'s
// round (`feat-<name>…` read as `<name>…` too). Exactly one unit among the readings is that unit; none, or
// two (`db-2` when both `db` and `db-2` are units), is no unit. An entry that names no unit lands as none of
// the machine's: never another unit's.

/** A land's target as an entry. */
export const entryOf = (target: LandTarget): LandEntry => (typeof target === "string" ? { rift: target } : target)

/** A path or name with its trailing slashes dropped. */
const trimmed = (text: string) => text.trim().replace(/\/+$/, "")

/** The last `/` segment of a path or branch, trailing slashes dropped. */
const lastSegment = (text: string) => trimmed(text).split("/").at(-1) ?? ""

/** The unit `name` (a Rift's name, a branch's last segment) is, by the name rule; none when no reading or two disagree. */
export const unitOfName = (name: string, units: ReadonlyArray<string>): string | undefined => {
  const readings = name.startsWith("feat-") ? [name, name.slice("feat-".length)] : [name]
  const found = new Set(
    readings.flatMap((reading) => {
      const base = /^(.+)-\d+$/.exec(reading)?.[1]
      return [...(units.includes(reading) ? [reading] : []), ...(base !== undefined && units.includes(base) ? [base] : [])]
    }),
  )
  return found.size === 1 ? [...found][0] : undefined
}

/** Whether a land's entry names the Rift at `path`: the path itself, or a name that is its last segment. */
const namesRift = (entry: string, path: string) => entry === trimmed(path) || (!entry.includes("/") && lastSegment(path) === entry)

/**
 * The unit a land's entry is: by the unit the input names, else the Rift a unit's implementor was started on
 * (`rifts`: each unit's, from the ledger), else its branch, else its own name; none, never a wrong one.
 */
export const unitOfEntry = (target: LandTarget, units: ReadonlyArray<string>, rifts: Readonly<Record<string, ReadonlyArray<string>>> = {}): string | undefined => {
  const entry = entryOf(target)
  if (entry.unit !== undefined) return units.includes(entry.unit) ? entry.unit : undefined
  const owners = units.filter((unit) => (rifts[unit] ?? []).some((path) => namesRift(trimmed(entry.rift), path)))
  if (owners.length > 0) return owners.length === 1 ? owners[0] : undefined
  return unitOfName(lastSegment(entry.branch ?? entry.rift), units)
}

/** Each unit's Rifts, as its implementors' starts named them. */
const riftsIn = (state: MachineState): Readonly<Record<string, ReadonlyArray<string>>> =>
  Object.fromEntries(Object.entries(state.units).flatMap(([name, unit]) => (unit.rifts === undefined ? [] : [[name, unit.rifts]])))

/** A land's target as the root wrote it in the land's input: its entry, or `{ path, unit }`. */
const inputOf = (target: LandTarget): string => {
  const entry = entryOf(target)
  return entry.unit === undefined ? JSON.stringify(entry.rift) : `{ path: ${JSON.stringify(entry.rift)}, unit: ${JSON.stringify(entry.unit)} }`
}

/**
 * The units a land's `rifts` name that it lands: the ready ones, and the ended ones (an implementor's end the
 * ledger guessed, or a hand-back it did not read: the root's land is its word that the unit is ready).
 */
const named = (state: MachineState, rifts: ReadonlyArray<LandTarget>): ReadonlyArray<string> => {
  const all = Object.keys(state.units)
  const recorded = riftsIn(state)
  return unitsIn(state, "ready", "ended").filter((unit) => rifts.some((rift) => unitOfEntry(rift, all, recorded) === unit))
}

/** Why the ready units' batch is due now (`3 ready`, `alpha ready 42 min`), or none. */
export const dueOf = (state: MachineState, now: number, cadence: Cadence): string | undefined => {
  const ready = unitsIn(state, "ready")
  if (ready.length === 0) return undefined
  if (ready.length >= cadence.ready) return `${ready.length} ready`
  const oldest = ready.reduce((a, b) => (state.units[a]!.since <= state.units[b]!.since ? a : b))
  const waited = now - state.units[oldest]!.since
  return waited >= cadence.waitMs ? `${oldest} ready ${Math.floor(waited / 60_000)} min` : undefined
}

/** The machine says wait: units are ready, their batch is not due, and an implementor still runs. */
const waiting = (state: MachineState, now: number, cadence: Cadence) =>
  unitsIn(state, "ready").length > 0 && dueOf(state, now, cadence) === undefined && unitsIn(state, "implement").length > 0

/** What a batch verifier would cover now: what is landed and unverified (whatever round each unit is on since), else what is ready. */
export const coverOf = (state: MachineState): ReadonlyArray<string> => {
  const landed = unverifiedOf(state)
  return landed.length > 0 ? landed : unitsIn(state, "ready")
}

/** What a verifier's start covers: its own unit alone for a unit-named one that departed, else the batch (`coverOf`). */
const coverOfStart = (state: MachineState, start: Start): ReadonlyArray<string> => {
  const unit = state.units[start.name]
  return !BATCH.test(start.name) && unit !== undefined && (unit.state === "ready" || unverifiedOf(state).includes(start.name)) ? [start.name] : coverOf(state)
}

/**
 * The findings folded into a ready unit a verifier's start covers with no land seen (a land by hand): the start
 * stands for that land, so they go to the verifier as folded, as a land's would. Left open, they outlived the
 * verdict on a unit no longer in the state and held every later land (the ledger of 2026-11-12, batches j-l).
 */
const standInFindings = (state: MachineState, units: ReadonlyArray<string>): Readonly<Record<string, Required<Finding>>> => {
  const landed = state.unverified ?? []
  const standsIn = units.filter((name) => state.units[name]?.state === "ready" && !landed.includes(name))
  return Object.fromEntries(
    openFindings(state).flatMap(([key, finding]) => (finding.into !== undefined && standsIn.includes(finding.into) ? [[key, { batch: finding.batch, into: finding.into }]] : [])),
  )
}

/** What a verifier over `units` checks as folded: the findings landed with them, and those its start stands in the land for. */
const checkedOf = (state: MachineState, units: ReadonlyArray<string>): Readonly<Record<string, Required<Finding>>> => ({ ...state.carried, ...standInFindings(state, units) })

// ── The refusal's words ──

const list = (units: ReadonlyArray<string>) => (units.length === 0 ? "none" : units.join(", "))
const minutes = (ms: number) => Math.max(0, Math.ceil(ms / 60_000))

/** A finding with where it went: `auth/M1 → billing`, or `auth/M1 (not folded)`. */
const foldedLine = (state: MachineState, key: string) => {
  const into = state.findings?.[key]?.into ?? state.carried?.[key]?.into
  return into === undefined ? `${key} (not folded)` : `${key} → ${into}`
}

/** What the root does instead of the refused call. */
const instead = (state: MachineState, rule: Rule, call: Command, now: number, cadence: Cadence): string => {
  const ready = unitsIn(state, "ready")
  switch (rule) {
    case "VerifierPerUnit":
      return `Start one verifier for the batch: its description is \`verifier batch-<k> r1\`, and it covers ${list(coverOf(state))}.`
    case "VerifierRunning":
      return `Verifier ${state.verifier?.batch ?? "of the last batch"} still runs: wait for its hand-back, then start the next batch's.`
    case "BatchNotDue": {
      const oldest = Math.min(...ready.map((unit) => state.units[unit]!.since))
      return `Wait: the batch is due at ${cadence.ready} ready, or in ${minutes(cadence.waitMs - (now - oldest))} min, when the oldest ready unit has waited ${minutes(cadence.waitMs)} min; set a timer for it, or let the implementors' hand-backs wake you.`
    }
    case "VerdictPending":
      return state.verifier === undefined
        ? `Start \`verifier batch-<k> r1\` for ${list(coverOf(state))} first; the next batch lands once its verdict is in, with each of its findings folded into a unit (one folded into a unit still implementing rides with that unit's later land). Keep the next batch's implementors working meanwhile.`
        : `Verifier ${state.verifier.batch} still runs over ${list(coveredOf(state))}: keep the next batch's implementors working, fold its findings into them when its verdict comes, then land.`
    case "FindingUnfolded": {
      const lands = call._tag === "Land" ? named(state, call.rifts) : ready
      const unfolded = unfoldedOf(state, lands)
      const debts = unresolvedOf(state)
      return [
        ...debts.map(
          ([batch, debt]) =>
            `The findings of ${batch}'s \`changes\` are not known: ${debt.why}. Read its report${debt.report === undefined ? " (ask its verifier for the path, or write the batch findings file)" : ` at ${debt.report}`} and make it readable: the plugin reads it again at the next start or land, then fold each of its findings into a unit this land takes.`,
        ),
        ...(unfolded.length === 0
          ? []
          : [
              `Fold each finding into a unit this land takes: ${unfolded.map((key) => foldedLine(state, key)).join(", ")}.`,
              `A finding folded into a unit still implementing holds no land: it rides with that unit's later land, whose verifier checks it. One folded into a ready unit lands with it: take that unit too. One not folded goes to a running implementor that owns its files (a subagent call with its sessionID, description \`implementor <unit> r<N> (folds: ${unfolded[0]})\`), or to a new fix implementor (\`implementor ${unitOfFinding(unfolded[0]!)}-fix1 r1 (folds: ${unfolded[0]})\`).`,
            ]),
      ].join(" ")
    }
    case "LandPartial":
      return `Land every ready unit in one call, each Rift as { path, unit }: rift({ action: "land", rifts: [${ready
        .map((unit) => `{ path: ${JSON.stringify(state.units[unit]?.rifts?.at(-1) ?? "<its Rift>")}, unit: ${JSON.stringify(unit)} }`)
        .join(", ")}] }).`
  }
}

/** The refusal's message: the rule in the skill's words, the state, what to do instead, and how to go against it. */
export const refusalOf = (state: MachineState, rule: Rule, call: Command, now: number, cadence: Cadence): string => {
  const how =
    call._tag === "Land"
      ? `add departs: "<why>" to the land's input: rift({ action: "land", rifts: [${call.rifts.map(inputOf).join(", ")}], departs: "<why>" })`
      : call._tag === "Start"
        ? `end the call's description with (departs: <why>): description "${call.role} ${call.name} r${call.round} (departs: <why>)"`
        : "state (departs: <why>) in the call"
  const findings = openFindings(state)
  return [
    `orchestrate: refused by the machine (${RULES[rule].name}): "${RULES[rule].words}"`,
    `Now: ready ${list(unitsIn(state, "ready"))}; implementing ${list(unitsIn(state, "implement"))}; landed and not verified ${list(unverifiedOf(state))}${state.verifier === undefined ? "" : `; verifier ${state.verifier.batch} running`}${findings.length === 0 ? "" : `; findings ${findings.map(([key]) => foldedLine(state, key)).join(", ")}`}${unresolvedOf(state).length === 0 ? "" : `; findings not known: ${unresolvedOf(state).map(([batch]) => batch).join(", ")}`}.`,
    instead(state, rule, call, now, cadence),
    `To go against the rule on purpose (the owner asked, or the run's rules depart from it), make the same call again and ${how}. It then passes, and the plugin records the departure.`,
  ].join("\n")
}

// ── The aggregate ──

/** The machine with `cadence`: when a batch of ready units is due. */
export const machine = (cadence: Cadence = DEFAULT_CADENCE): Decider<MachineState, Command, Event, Refused> => ({
  initial: { units: {} },
  decide: (state, command, now) =>
    Effect.gen(function* () {
      /** Refuse by the first rule broken, unless the call departs: then one Departed per rule. */
      const guard = (rules: ReadonlyArray<Rule>, departs: string | undefined): Effect.Effect<ReadonlyArray<Event>, Refused> => {
        const first = rules[0]
        if (first !== undefined && departs === undefined) return Effect.fail(new Refused({ rule: first, message: refusalOf(state, first, command, now, cadence) }))
        return Effect.succeed(rules.map((rule) => Departed.make({ rule, why: departs ?? "", at: now })))
      }
      switch (command._tag) {
        case "Start": {
          if (command.role === "planner") return []
          // No rule holds an implementor: the next batch fans out while a verifier runs.
          if (command.role === "implementor")
            return [
              UnitStarted.make({ unit: command.name, round: command.round, direct: command.direct, ...(command.rift === undefined ? {} : { rift: command.rift }), at: now }),
              ...foldsOf(state, command).map((finding) => FindingFolded.make({ finding, into: command.name, at: now })),
            ]
          const batch = BATCH.test(command.name)
          const any = Object.keys(state.units).length > 0
          const rules: Array<Rule> = []
          if (!batch && any) rules.push("VerifierPerUnit")
          if (state.verifier !== undefined) rules.push("VerifierRunning")
          if (unverifiedOf(state).length === 0 && waiting(state, now, cadence)) rules.push("BatchNotDue")
          const departed = yield* guard(rules, command.departs)
          // A root that runs no unit is left alone: its reviewer is none of the machine's.
          if (!batch && !any) return departed
          // A unit-named verifier that departs covers its unit alone.
          const units = coverOfStart(state, command)
          const carried = Object.entries(checkedOf(state, units)).map(([key, finding]) => `${key} → ${finding.into}`)
          return [...departed, VerifierStarted.make({ batch: command.name, units, ...(carried.length === 0 ? {} : { findings: carried }), at: now })]
        }
        case "HandBack": {
          if (command.role === "implementor") {
            const was = state.units[command.name]?.state
            if (was === "implement") return [UnitHandedBack.make({ unit: command.name, ready: command.verdict === "ready", said: command.verdict, at: now })]
            return was === "ended" && command.verdict === "ready" ? [UnitHandedBack.make({ unit: command.name, ready: true, said: command.verdict, at: now })] : []
          }
          if (command.role === "verifier" && state.verifier?.batch === command.name) {
            if (command.verdict !== "changes") return [VerifierEnded.make({ batch: command.name, verdict: command.verdict, at: now })]
            // A `changes` whose findings were not read is unresolved, never an empty set.
            if (command.findings === undefined) {
              const unresolved = command.unread ?? { why: "the plugin read no findings report for it" }
              return [VerifierEnded.make({ batch: command.name, verdict: command.verdict, unresolved, at: now })]
            }
            const findings = command.findings
            return [VerifierEnded.make({ batch: command.name, verdict: command.verdict, ...(findings.length === 0 ? {} : { findings }), at: now })]
          }
          return []
        }
        case "ReportRead":
          return state.unresolved?.[command.batch] === undefined ? [] : [ReportResolved.make({ batch: command.batch, findings: command.findings, at: now })]
        case "Land": {
          const lands = named(state, command.rifts)
          // A land of nothing the machine holds is none of its business.
          if (lands.length === 0) return []
          const rules: Array<Rule> = []
          if (verdictPending(state)) rules.push("VerdictPending")
          if (unfoldedOf(state, lands).length > 0 || unresolvedOf(state).length > 0) rules.push("FindingUnfolded")
          if (unitsIn(state, "ready").some((unit) => !lands.includes(unit))) rules.push("LandPartial")
          if (waiting(state, now, cadence)) rules.push("BatchNotDue")
          return yield* guard(rules, command.departs)
        }
        case "Landed": {
          const units = named(state, command.rifts)
          return units.length === 0 ? [] : [BatchLanded.make({ units, at: now })]
        }
        case "Spawned": {
          const spawned = [StepSpawned.make({ role: command.role, name: command.name, child: command.child, at: now })]
          if (command.role === "implementor") return state.units[command.name]?.state === "implement" && state.units[command.name]?.child !== command.child ? spawned : []
          if (command.role === "verifier" && state.verifier?.batch === command.name && state.verifier.child !== command.child) return spawned
          return []
        }
      }
    }),
  evolve: (state, event) => {
    const units = { ...state.units }
    const findings: Record<string, Finding> = { ...state.findings }
    const carried: Record<string, Required<Finding>> = { ...state.carried }
    switch (event._tag) {
      case "UnitStarted": {
        // A covered unit's next round takes its slot: the batch it is in keeps it, even from a checkpoint
        // written before the verifier kept its cover.
        const prior = state.units[event.unit]?.state
        const verifier = prior === "verify" && state.verifier !== undefined && state.verifier.units === undefined ? { ...state.verifier, units: coveredOf(state) } : state.verifier
        const unverified = prior === "landed" ? [...new Set([...(state.unverified ?? []), event.unit])] : state.unverified
        // The unit keeps the Rifts of its earlier rounds: a land may name any of them.
        const rifts = [...new Set([...(state.units[event.unit]?.rifts ?? []), ...(event.rift === undefined ? [] : [event.rift])])]
        units[event.unit] = { state: "implement", round: event.round, since: event.at, direct: event.direct, ...(rifts.length === 0 ? {} : { rifts }) }
        return tidy({ ...state, units, ...(verifier === undefined ? {} : { verifier }), ...(unverified === undefined ? {} : { unverified }) })
      }
      case "UnitHandedBack": {
        const unit = units[event.unit]
        if (unit === undefined) return state
        const { child: _, said: __, ...rest } = unit
        if (event.ready || !("said" in event)) units[event.unit] = { ...rest, state: event.ready ? "ready" : "ended", since: event.at }
        else units[event.unit] = { ...rest, state: "ended", since: event.at, said: event.said }
        return { ...state, units }
      }
      case "BatchLanded": {
        const unverified = new Set(state.unverified ?? [])
        for (const name of event.units) {
          const unit = units[name]
          if (unit === undefined) continue
          if (unit.direct) delete units[name]
          else {
            const { said: _, ...rest } = unit
            units[name] = { ...rest, state: "landed", since: event.at }
            unverified.add(name)
          }
        }
        // Each finding folded into a unit that landed goes to the next verifier; one not folded, or not
        // known, was departed from; one folded into a unit with no hand-back on record that did not land is settled.
        for (const [key, finding] of Object.entries(findings)) {
          if (finding.into === undefined || (!event.units.includes(finding.into) && settled(state, finding))) delete findings[key]
          else if (event.units.includes(finding.into)) {
            carried[key] = { batch: finding.batch, into: finding.into }
            delete findings[key]
          }
        }
        return tidy({ ...state, units, unverified: [...unverified], findings, carried, unresolved: {} })
      }
      case "VerifierStarted": {
        const unverified = state.unverified ?? []
        for (const name of event.units) {
          const unit = units[name]
          // A covered unit's slot shows `verify` unless its next round took it over (a ready unit that is not the
          // landed one: with landed units to cover, only those are verified).
          if (unit !== undefined && (unit.state === "landed" || (unit.state === "ready" && !unverified.includes(name))))
            units[name] = { ...unit, state: "verify", since: event.at }
        }
        // The findings folded into a unit it stands in the land for go to it as folded, as a land's would.
        for (const [key, finding] of Object.entries(standInFindings(state, event.units))) {
          carried[key] = finding
          delete findings[key]
        }
        const left = unverified.filter((name) => !event.units.includes(name))
        // A second verifier (one that departed) takes over what the first one covered too: neither has a verdict yet.
        const covers = [...new Set([...(state.verifier === undefined ? [] : coveredOf(state)), ...event.units])]
        return tidy({ ...state, units, findings, carried, unverified: left, verifier: { batch: event.batch, since: event.at, units: covers } })
      }
      case "VerifierEnded": {
        const covered = coveredOf(state)
        for (const [name, unit] of Object.entries(units)) {
          if (unit.state !== "verify") continue
          // A verifier that died gave no verdict: its units are landed and unverified again.
          if (event.verdict === "none") units[name] = { ...unit, state: "landed", since: event.at }
          else delete units[name]
        }
        const { verifier: _, ...rest } = state
        // A dead verifier's units, whatever round each is on now, still wait for a verdict.
        if (event.verdict === "none") return tidy({ ...rest, units, unverified: [...new Set([...(state.unverified ?? []), ...covered])] })
        // The verdict is in: what it checked as folded is done, and its own findings open, or its debt when they did not read.
        // A finding folded into a unit no longer in the state was checked by a verdict already: a ledger written
        // before a verifier's start stood in for a land by hand kept it open (`standInFindings`), so it goes too.
        for (const [key, finding] of Object.entries(findings)) if (finding.into !== undefined && (units[finding.into] === undefined || settled(state, finding))) delete findings[key]
        for (const key of event.findings ?? []) findings[key] = { batch: event.batch }
        const unresolved = { ...state.unresolved, ...(event.unresolved === undefined ? {} : { [event.batch]: event.unresolved }) }
        return tidy({ ...rest, units, findings, carried: {}, unresolved })
      }
      case "ReportResolved": {
        const { [event.batch]: _, ...unresolved } = state.unresolved ?? {}
        for (const key of event.findings) findings[key] = { batch: event.batch }
        return tidy({ ...state, findings, unresolved })
      }
      case "FindingFolded": {
        const finding = findings[event.finding]
        if (finding === undefined) return state
        findings[event.finding] = { batch: finding.batch, into: event.into }
        return tidy({ ...state, findings, carried })
      }
      case "Departed":
        return state
      case "StepSpawned": {
        if (event.role === "verifier") return state.verifier === undefined ? state : { ...state, verifier: { ...state.verifier, child: event.child } }
        const unit = units[event.name]
        if (unit === undefined) return state
        units[event.name] = { ...unit, child: event.child }
        return { ...state, units }
      }
    }
  },
})

// ── What rides on a start's answer, and what a compacted root is told ──

/** Each key with where it went, joined. */
const foldedList = (state: MachineState, keys: ReadonlyArray<string>) => keys.map((key) => foldedLine(state, key)).join(", ")

/**
 * The notes a role's start answers with first. An implementor's or a
 * planner's: a due batch (once the last verdict is in and its findings are
 * folded), a landed batch with no verifier, the findings this start folds,
 * the findings still unfolded, a `folds` that names no open finding, and a
 * round past the third. A verifier's: the findings it also checks as folded.
 */
export const notesOf = (state: MachineState, command: Command, now: number, cadence: Cadence): ReadonlyArray<string> => {
  if (command._tag !== "Start") return []
  if (command.role === "verifier") {
    const checked = Object.entries(checkedOf(state, coverOfStart(state, command)))
    return checked.length === 0
      ? []
      : [`orchestrate: ${command.role} ${command.name} also checks these findings as folded: ${checked.map(([key, finding]) => `${key} → ${finding.into}`).join(", ")}; the plugin added them to its prompt.`]
  }
  const why = dueOf(state, now, cadence)
  const landed = unverifiedOf(state)
  const pending = verdictPending(state)
  const debts = unresolvedOf(state)
  const folds = command.role === "implementor" ? foldsOf(state, command) : []
  const after = Object.keys(state.findings ?? {}).filter((key) => !folds.includes(key) && state.findings![key]!.into === undefined)
  const open = Object.keys(state.findings ?? {})
  const unknown = (command.folds ?? []).filter((ref) => !open.includes(ref) && !open.some((key) => unitOfFinding(key) === ref))
  return [
    ...(why === undefined || pending || debts.length > 0 || unfoldedOf(state, unitsIn(state, "ready")).length > 0
      ? []
      : [`orchestrate: a batch is due (${why}): ${unitsIn(state, "ready").join(", ")}; land it, then start verifier batch-<k> r1.`]),
    ...(landed.length > 0 && state.verifier === undefined ? [`orchestrate: landed and not verified: ${landed.join(", ")}; start verifier batch-<k> r1.`] : []),
    ...(folds.length === 0 ? [] : [`orchestrate: folded into ${command.name}: ${folds.join(", ")}.`]),
    ...(unknown.length === 0 ? [] : [`orchestrate: no open finding is named ${unknown.join(", ")}; open: ${open.length === 0 ? "none" : open.join(", ")}.`]),
    ...(after.length === 0 ? [] : [`orchestrate: not folded yet: ${after.join(", ")}; fold each into a running implementor that owns its files, or a new fix implementor, before the next land.`]),
    ...debts.map(([batch, debt]) => `orchestrate: the findings of ${batch}'s changes are not known (${debt.why}); read ${debt.report ?? "its report"} and make it readable, then fold them: the next land waits for it.`),
    ...(command.role === "implementor" && command.round >= 4
      ? [`orchestrate: round ${command.round} of ${command.name}: at the third failed round a unit goes to decide, for a rewrite on a new spec (SKILL.md, rewrite).`]
      : []),
  ]
}

/**
 * What the plugin adds to a batch verifier's prompt: the findings of the
 * batch before, folded into this one, to check as folded. None when there
 * are none, or for any other call.
 */
export const verifierPromptOf = (state: MachineState, command: Command): string | undefined => {
  if (command._tag !== "Start" || command.role !== "verifier") return undefined
  const carried = Object.entries(checkedOf(state, coverOfStart(state, command)))
  if (carried.length === 0) return undefined
  return [
    "Findings of the batch before, folded into this batch (the orchestrate plugin's ledger). Prove each fixed in the unit it was folded into, as a finding of that unit:",
    ...carried.map(([key, finding]) => `- ${finding.batch} ${key} → ${finding.into}`),
  ].join("\n")
}

/** The order the brief names the states in. */
const BRIEF_ORDER: ReadonlyArray<UnitState> = ["implement", "ready", "landed", "verify", "ended"]

/**
 * The root's run as the ledger holds it, for a root that just compacted:
 * each state with its units (a ready unit with how long it has waited), the
 * batch verifying, the next batch (its units and the findings folded into
 * it), the findings not folded yet, and a due batch. Empty for a root that
 * runs no unit.
 */
export const briefOf = (state: MachineState, now: number, cadence: Cadence): string => {
  const findings = Object.entries(state.findings ?? {})
  const carried = Object.keys(state.carried ?? {})
  const debts = unresolvedOf(state)
  if (Object.keys(state.units).length === 0 && state.verifier === undefined && findings.length === 0 && carried.length === 0 && debts.length === 0 && unverifiedOf(state).length === 0)
    return ""
  const aged = (unit: string) => `${unit} (${Math.floor((now - state.units[unit]!.since) / 60_000)} min)`
  const why = dueOf(state, now, cadence)
  const next = unitsIn(state, "implement", "ready").map((unit) => `${unit} (${state.units[unit]!.state})`)
  const folded = findings.filter(([, finding]) => finding.into !== undefined).map(([key, finding]) => `${finding.batch} ${key} → ${finding.into}`)
  const unfolded = findings.filter(([, finding]) => finding.into === undefined).map(([key, finding]) => `${finding.batch} ${key}`)
  const rides = findings.filter(([, finding]) => riding(state, finding)).map(([key, finding]) => `${finding.batch} ${key} → ${finding.into}`)
  return [
    ...BRIEF_ORDER.flatMap((name) => {
      const units = unitsIn(state, name)
      return units.length === 0 ? [] : [`${name}: ${(name === "ready" ? units.map(aged) : units).join(", ")}`]
    }),
    ...(state.verifier === undefined ? [] : [`${state.verifier.batch} verifying: ${list(coveredOf(state))}${carried.length === 0 ? "" : `; checks as folded: ${foldedList(state, carried)}`}`]),
    ...(state.verifier === undefined && findings.length === 0
      ? []
      : [`next batch: units ${list(next)}; folded findings: ${folded.length === 0 ? "none" : folded.join(", ")}`]),
    ...(unfolded.length === 0 ? [] : [`not folded: ${unfolded.join(", ")} (the next batch lands once each is folded into a unit)`]),
    ...(rides.length === 0
      ? []
      : [`riding with a unit still implementing: ${rides.join(", ")} (holds no land; each lands with its unit, and that land's verifier must name it as folded)`]),
    ...debts.map(([batch, debt]) => `findings not known: ${batch} changes, ${debt.why}${debt.report === undefined ? "" : ` (${debt.report})`}; the next batch lands once its report reads and each finding is folded`),
    ...(state.verifier === undefined && carried.length > 0 ? [`landed with folded findings, for the next verifier: ${foldedList(state, carried)}`] : []),
    ...(why === undefined ? [] : [`a batch is due (${why})`]),
  ].join("\n")
}

// ── Reading a call ──

const DEPARTS = /\(departs:\s*([^()]*?)\s*\)/i
const FOLDS = /\(folds:\s*([^()]*?)\s*\)/i
const RIFT = /\(rift:\s*([^()\s]+?)\/*\s*\)/i
const DIRECT = /\(direct\)/i
const ROUND = /^r(\d+)$/i

/**
 * The machine's command for a role agent's call: `agent` is the role it runs
 * as, `description` names the step (`<role> <unit> r<N>`, described.ts), and
 * may end `(direct)`, `(folds: <finding>, …)`, `(rift: <path>)` (an
 * implementor's Rift, which a land then knows as its unit's) or
 * `(departs: <why>)`. None for a call that is no step of `agent`'s role.
 */
export const startOf = (agent: string, description: string | undefined): Start | undefined => {
  const text = description ?? ""
  const departs = DEPARTS.exec(text)?.[1]
  // The departure is read first and set aside: its words may hold anything.
  const rest = text.replace(DEPARTS, "")
  const folds = (FOLDS.exec(rest)?.[1] ?? "").split(/[\s,]+/).filter((ref) => ref !== "")
  const rift = RIFT.exec(rest)?.[1]
  const step = described(rest.replace(FOLDS, "").replace(RIFT, "").trim())
  if (step === undefined || step.role !== agent) return undefined
  const [name, ...words] = step.rest.split(" ")
  if (name === undefined || name === "" || ROUND.test(name)) return undefined
  const round = words.map((word) => ROUND.exec(word)?.[1]).find((n) => n !== undefined)
  return Start.make({
    role: step.role,
    name,
    round: round === undefined ? 1 : Number(round),
    direct: DIRECT.test(text),
    ...(folds.length === 0 ? {} : { folds }),
    ...(departs === undefined || departs === "" ? {} : { departs }),
    ...(rift === undefined || step.role !== "implementor" ? {} : { rift }),
  })
}

/** The hand-back line: `<role> <name> r<N>: <verdict> …`, maybe in backticks or bold. */
const HAND_BACK = /^[`*\s]*(planner|implementor|verifier) ([a-z0-9][a-z0-9._#/-]*) r\d+:\s*(ready|blocked|accepted|changes|stuck)\b/i

const firstLine = (text: string | undefined) => (text ?? "").split("\n").find((line) => line.trim() !== "") ?? ""

/** The hand-back a role's last answer opens with, for the role it runs as; none for any other answer. */
export const handBackOf = (agent: string, text: string | undefined): HandBack | undefined => {
  const match = HAND_BACK.exec(firstLine(text))
  if (match === null) return undefined
  const [, role, name, verdict] = match
  if (role === undefined || name === undefined || verdict === undefined || role.toLowerCase() !== agent) return undefined
  return HandBack.make({ role: role.toLowerCase() as Start["role"], name, verdict: verdict.toLowerCase() as Verdict })
}

/** The file a hand-back line names after its verdict (`… r1: changes /run/batch-1-findings.md`); none when it names no Markdown file. */
export const reportOf = (text: string | undefined): string | undefined => {
  const line = firstLine(text)
  const match = HAND_BACK.exec(line)
  if (match === null) return undefined
  return line
    .slice(match[0].length)
    .split(/\s+/)
    .map((word) => word.replace(/^[`*([<]+|[`*)\]>.,;:]+$/g, ""))
    .find((word) => word.endsWith(".md"))
}
