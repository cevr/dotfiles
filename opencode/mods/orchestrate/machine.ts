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
// A unit is `implement` (its implementor runs), `ended` (its implementor
// stopped without `ready`), `ready`, `landed` (no verifier started for it
// yet) or `verify` (a verifier covering it runs). A verifier's verdict takes
// the units it covered out of the state; a unit's next round comes back in by
// its implementor's start. A `direct` unit closes when it lands.
//
// The rules, in the order they are checked:
//
//   VerifierPerUnit  a verifier whose name is not `batch-<k>`, while the root has any unit;
//   VerifierRunning  a verifier while one runs;
//   BatchNotDue      a verifier with nothing landed, or a land, while fewer than
//                    `cadence.ready` units are ready, the oldest has waited less
//                    than `cadence.waitMs`, and an implementor still runs (with
//                    none running there is nothing to wait for);
//   LandPartial      a land that leaves a ready unit out;
//   BatchUnverified  a land while an earlier land's units have no verifier.
//
// A call that states why it goes against them (`departs`) passes, and records
// one `Departed` per rule it broke. A verifier covers what is landed; with
// nothing landed, what is ready (a land by hand, which the plugin does not
// see, so the verifier's start stands for it). A root that runs no unit is
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

export const Rule = Schema.Literals(["VerifierPerUnit", "VerifierRunning", "BatchNotDue", "LandPartial", "BatchUnverified"])
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
  LandPartial: { name: "Land a batch", words: "Land every ready unit at once when the cadence fires" },
  BatchUnverified: { name: "Verify the batch", words: "with one fresh verifier on the merged head" },
}

/** A verifier named for a batch: `verifier batch-<k> r1`. */
export const BATCH = /^batch-/

// ── The commands ──

const Role = Schema.Literals(STEPS)

/**
 * A role agent's call: its role, the unit or batch its description names, the
 * round (1 when it names none), whether it ends `(direct)`, and why it goes
 * against the machine, when it says (`(departs: <why>)`).
 */
export const Start = Schema.TaggedStruct("Start", {
  role: Role,
  name: Schema.String,
  round: Schema.Number,
  direct: Schema.Boolean,
  departs: Schema.optionalKey(Schema.String),
})
export interface Start extends Schema.Schema.Type<typeof Start> {}

/** What a role agent's hand-back line said; `none` when it ended with no hand-back. */
export const Verdict = Schema.Literals(["ready", "blocked", "accepted", "changes", "stuck", "none"])
export type Verdict = typeof Verdict.Type

export const HandBack = Schema.TaggedStruct("HandBack", { role: Role, name: Schema.String, verdict: Verdict })
export interface HandBack extends Schema.Schema.Type<typeof HandBack> {}

/** A `rift` land about to run, with the Rifts it names. */
export const Land = Schema.TaggedStruct("Land", { rifts: Schema.Array(Schema.String), departs: Schema.optionalKey(Schema.String) })
export interface Land extends Schema.Schema.Type<typeof Land> {}

/** The Rifts a land answered green. */
export const Landed = Schema.TaggedStruct("Landed", { rifts: Schema.Array(Schema.String) })
export interface Landed extends Schema.Schema.Type<typeof Landed> {}

/** The session a started step runs in, once the plugin knows it: what the ledger checks is still alive. */
export const Spawned = Schema.TaggedStruct("Spawned", { role: Role, name: Schema.String, child: Schema.String })
export interface Spawned extends Schema.Schema.Type<typeof Spawned> {}

export const Command = Schema.Union([Start, HandBack, Land, Landed, Spawned])
export type Command = Start | HandBack | Land | Landed | Spawned

// ── The events ──

export const UnitStarted = Schema.TaggedStruct("UnitStarted", { unit: Schema.String, round: Schema.Number, direct: Schema.Boolean, at: Schema.Number })
export interface UnitStarted extends Schema.Schema.Type<typeof UnitStarted> {}

export const UnitHandedBack = Schema.TaggedStruct("UnitHandedBack", { unit: Schema.String, ready: Schema.Boolean, at: Schema.Number })
export interface UnitHandedBack extends Schema.Schema.Type<typeof UnitHandedBack> {}

export const BatchLanded = Schema.TaggedStruct("BatchLanded", { units: Schema.Array(Schema.String), at: Schema.Number })
export interface BatchLanded extends Schema.Schema.Type<typeof BatchLanded> {}

export const VerifierStarted = Schema.TaggedStruct("VerifierStarted", { batch: Schema.String, units: Schema.Array(Schema.String), at: Schema.Number })
export interface VerifierStarted extends Schema.Schema.Type<typeof VerifierStarted> {}

export const VerifierEnded = Schema.TaggedStruct("VerifierEnded", { batch: Schema.String, verdict: Verdict, at: Schema.Number })
export interface VerifierEnded extends Schema.Schema.Type<typeof VerifierEnded> {}

/** A call went against `rule`, saying `why`. */
export const Departed = Schema.TaggedStruct("Departed", { rule: Rule, why: Schema.String, at: Schema.Number })
export interface Departed extends Schema.Schema.Type<typeof Departed> {}

/** A step's session: an implementor's (`role` implementor, its unit) or the running verifier's. */
export const StepSpawned = Schema.TaggedStruct("StepSpawned", { role: Role, name: Schema.String, child: Schema.String, at: Schema.Number })
export interface StepSpawned extends Schema.Schema.Type<typeof StepSpawned> {}

export const Event = Schema.Union([UnitStarted, UnitHandedBack, BatchLanded, VerifierStarted, VerifierEnded, Departed, StepSpawned])
export type Event = UnitStarted | UnitHandedBack | BatchLanded | VerifierStarted | VerifierEnded | Departed | StepSpawned

/** The call went against `rule`; `message` quotes the rule and says what to do instead. */
export class Refused extends Schema.TaggedError<Refused>()("Refused", { rule: Rule, message: Schema.String }) {}

// ── The state ──

export type UnitState = "implement" | "ended" | "ready" | "landed" | "verify"

export interface Unit {
  readonly state: UnitState
  readonly round: number
  /** When it entered its state (epoch ms). */
  readonly since: number
  readonly direct: boolean
  /** Its implementor's session, once known. */
  readonly child?: string
}

export interface MachineState {
  readonly units: Readonly<Record<string, Unit>>
  /** The running verifier: its batch, since when, and its session once known. */
  readonly verifier?: { readonly batch: string; readonly since: number; readonly child?: string }
}

/** The units in any of `states`, in the order they entered the state record. */
export const unitsIn = (state: MachineState, ...states: ReadonlyArray<UnitState>): ReadonlyArray<string> =>
  Object.entries(state.units)
    .filter(([, unit]) => states.includes(unit.state))
    .map(([name]) => name)

/**
 * The unit a land's entry names: by its name, its branch (`<run>/<unit>`,
 * `feat/<unit>`), its path (`…/.rifts/<repo>/<unit>`) or workrift's
 * directory (`<run>-<unit>`). The longest unit name that fits wins
 * (`fix-auth` over `auth`); an entry that is no unit's is none.
 */
export const unitOfRift = (rift: string, units: ReadonlyArray<string>): string | undefined => {
  const entry = rift.trim().replace(/\/+$/, "")
  return units.filter((unit) => entry === unit || entry.endsWith(`/${unit}`) || entry.endsWith(`-${unit}`)).sort((a, b) => b.length - a.length)[0]
}

/** The ready units a land's `rifts` name. */
const named = (state: MachineState, rifts: ReadonlyArray<string>): ReadonlyArray<string> => {
  const all = Object.keys(state.units)
  return unitsIn(state, "ready").filter((unit) => rifts.some((rift) => unitOfRift(rift, all) === unit))
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

/** What a batch verifier would cover now: what is landed, else what is ready. */
export const coverOf = (state: MachineState): ReadonlyArray<string> => {
  const landed = unitsIn(state, "landed")
  return landed.length > 0 ? landed : unitsIn(state, "ready")
}

// ── The refusal's words ──

const list = (units: ReadonlyArray<string>) => (units.length === 0 ? "none" : units.join(", "))
const minutes = (ms: number) => Math.max(0, Math.ceil(ms / 60_000))

/** What the root does instead of the refused call. */
const instead = (state: MachineState, rule: Rule, now: number, cadence: Cadence): string => {
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
    case "LandPartial":
      return `Land every ready unit in one call: rift({ action: "land", rifts: [${ready.map((unit) => JSON.stringify(unit)).join(", ")}] }) (each by its Rift's name, branch or path).`
    case "BatchUnverified":
      return `Start \`verifier batch-<k> r1\` for ${list(unitsIn(state, "landed"))} first; the next batch lands once it runs.`
  }
}

/** The refusal's message: the rule in the skill's words, the state, what to do instead, and how to go against it. */
export const refusalOf = (state: MachineState, rule: Rule, call: Command, now: number, cadence: Cadence): string => {
  const how =
    call._tag === "Land"
      ? `add departs: "<why>" to the land's input: rift({ action: "land", rifts: [${call.rifts.map((rift) => JSON.stringify(rift)).join(", ")}], departs: "<why>" })`
      : call._tag === "Start"
        ? `end the call's description with (departs: <why>): description "${call.role} ${call.name} r${call.round} (departs: <why>)"`
        : "state (departs: <why>) in the call"
  return [
    `orchestrate: refused by the machine (${RULES[rule].name}): "${RULES[rule].words}"`,
    `Now: ready ${list(unitsIn(state, "ready"))}; implementing ${list(unitsIn(state, "implement"))}; landed and not verified ${list(unitsIn(state, "landed"))}${state.verifier === undefined ? "" : `; verifier ${state.verifier.batch} running`}.`,
    instead(state, rule, now, cadence),
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
          if (command.role === "implementor") return [UnitStarted.make({ unit: command.name, round: command.round, direct: command.direct, at: now })]
          const batch = BATCH.test(command.name)
          const any = Object.keys(state.units).length > 0
          const rules: Array<Rule> = []
          if (!batch && any) rules.push("VerifierPerUnit")
          if (state.verifier !== undefined) rules.push("VerifierRunning")
          if (unitsIn(state, "landed").length === 0 && waiting(state, now, cadence)) rules.push("BatchNotDue")
          const departed = yield* guard(rules, command.departs)
          // A root that runs no unit is left alone: its reviewer is none of the machine's.
          if (!batch && !any) return departed
          // A unit-named verifier that departs covers its unit alone.
          const unit = state.units[command.name]
          const units = !batch && unit !== undefined && (unit.state === "ready" || unit.state === "landed") ? [command.name] : coverOf(state)
          return [...departed, VerifierStarted.make({ batch: command.name, units, at: now })]
        }
        case "HandBack": {
          if (command.role === "implementor")
            return state.units[command.name]?.state === "implement" ? [UnitHandedBack.make({ unit: command.name, ready: command.verdict === "ready", at: now })] : []
          if (command.role === "verifier" && state.verifier?.batch === command.name) return [VerifierEnded.make({ batch: command.name, verdict: command.verdict, at: now })]
          return []
        }
        case "Land": {
          const lands = named(state, command.rifts)
          // A land of nothing the machine holds is none of its business.
          if (lands.length === 0) return []
          const rules: Array<Rule> = []
          if (unitsIn(state, "landed").length > 0 && state.verifier === undefined) rules.push("BatchUnverified")
          if (unitsIn(state, "ready").length > lands.length) rules.push("LandPartial")
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
    switch (event._tag) {
      case "UnitStarted":
        units[event.unit] = { state: "implement", round: event.round, since: event.at, direct: event.direct }
        return { ...state, units }
      case "UnitHandedBack": {
        const unit = units[event.unit]
        if (unit === undefined) return state
        const { child: _, ...rest } = unit
        units[event.unit] = { ...rest, state: event.ready ? "ready" : "ended", since: event.at }
        return { ...state, units }
      }
      case "BatchLanded":
        for (const name of event.units) {
          const unit = units[name]
          if (unit === undefined) continue
          if (unit.direct) delete units[name]
          else units[name] = { ...unit, state: "landed", since: event.at }
        }
        return { ...state, units }
      case "VerifierStarted":
        for (const name of event.units) {
          const unit = units[name]
          if (unit !== undefined) units[name] = { ...unit, state: "verify", since: event.at }
        }
        return { units, verifier: { batch: event.batch, since: event.at } }
      case "VerifierEnded":
        for (const [name, unit] of Object.entries(units)) {
          if (unit.state !== "verify") continue
          // A verifier that died gave no verdict: its units are landed and unverified again.
          if (event.verdict === "none") units[name] = { ...unit, state: "landed", since: event.at }
          else delete units[name]
        }
        return { units }
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

/**
 * The notes a planner's or implementor's start answers with first: a due
 * batch, a landed batch with no verifier, and a round past the third. None
 * for anything else.
 */
export const notesOf = (state: MachineState, command: Command, now: number, cadence: Cadence): ReadonlyArray<string> => {
  if (command._tag !== "Start" || command.role === "verifier") return []
  const why = dueOf(state, now, cadence)
  const landed = unitsIn(state, "landed")
  return [
    ...(why === undefined ? [] : [`orchestrate: a batch is due (${why}): ${unitsIn(state, "ready").join(", ")}; land it, then start verifier batch-<k> r1.`]),
    ...(landed.length > 0 && state.verifier === undefined ? [`orchestrate: landed and not verified: ${landed.join(", ")}; start verifier batch-<k> r1.`] : []),
    ...(command.role === "implementor" && command.round >= 4
      ? [`orchestrate: round ${command.round} of ${command.name}: at the third failed round a unit goes to decide, for a rewrite on a new spec (SKILL.md, rewrite).`]
      : []),
  ]
}

/** The order the brief names the states in. */
const BRIEF_ORDER: ReadonlyArray<UnitState> = ["implement", "ready", "landed", "verify", "ended"]

/**
 * The root's run as the ledger holds it, for a root that just compacted:
 * each state with its units (a ready unit with how long it has waited), the
 * running verifier, and a due batch. Empty for a root that runs no unit.
 */
export const briefOf = (state: MachineState, now: number, cadence: Cadence): string => {
  if (Object.keys(state.units).length === 0 && state.verifier === undefined) return ""
  const aged = (unit: string) => `${unit} (${Math.floor((now - state.units[unit]!.since) / 60_000)} min)`
  const why = dueOf(state, now, cadence)
  return [
    ...BRIEF_ORDER.flatMap((name) => {
      const units = unitsIn(state, name)
      return units.length === 0 ? [] : [`${name}: ${(name === "ready" ? units.map(aged) : units).join(", ")}`]
    }),
    ...(state.verifier === undefined ? [] : [`verifier running: ${state.verifier.batch}`]),
    ...(why === undefined ? [] : [`a batch is due (${why})`]),
  ].join("\n")
}

// ── Reading a call ──

const DEPARTS = /\(departs:\s*([^()]*?)\s*\)/i
const DIRECT = /\(direct\)/i
const ROUND = /^r(\d+)$/i

/**
 * The machine's command for a role agent's call: `agent` is the role it runs
 * as, `description` names the step (`<role> <unit> r<N>`, described.ts), and
 * may end `(direct)` or `(departs: <why>)`. None for a call that is no step
 * of `agent`'s role.
 */
export const startOf = (agent: string, description: string | undefined): Start | undefined => {
  const text = description ?? ""
  const departs = DEPARTS.exec(text)?.[1]
  // The departure is read first and set aside: its words may hold anything.
  const step = described(text.replace(DEPARTS, "").trim())
  if (step === undefined || step.role !== agent) return undefined
  const [name, ...rest] = step.rest.split(" ")
  if (name === undefined || name === "" || ROUND.test(name)) return undefined
  const round = rest.map((word) => ROUND.exec(word)?.[1]).find((n) => n !== undefined)
  return Start.make({
    role: step.role,
    name,
    round: round === undefined ? 1 : Number(round),
    direct: DIRECT.test(text),
    ...(departs === undefined || departs === "" ? {} : { departs }),
  })
}

/** The hand-back line: `<role> <name> r<N>: <verdict> …`, maybe in backticks or bold. */
const HAND_BACK = /^[`*\s]*(planner|implementor|verifier) ([a-z0-9][a-z0-9._#/-]*) r\d+:\s*(ready|blocked|accepted|changes|stuck)\b/i

/** The hand-back a role's last answer opens with, for the role it runs as; none for any other answer. */
export const handBackOf = (agent: string, text: string | undefined): HandBack | undefined => {
  const first = (text ?? "").split("\n").find((line) => line.trim() !== "") ?? ""
  const match = HAND_BACK.exec(first)
  if (match === null) return undefined
  const [, role, name, verdict] = match
  if (role === undefined || name === undefined || verdict === undefined || role.toLowerCase() !== agent) return undefined
  return HandBack.make({ role: role.toLowerCase() as Start["role"], name, verdict: verdict.toLowerCase() as Verdict })
}
