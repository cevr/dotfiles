// machine.qnt's traces, replayed through the real batch machine (mods/orchestrate/machine.ts `machine`): each
// step's command is decided and folded by the code, and the code must refuse what the model refuses, by the same
// rule, and hold the state the model holds. A step where they part is a red check: the model no longer describes
// the code (a change to machine.ts the model did not follow, or a bug the model's property guards against).
//
// Also the trace's story: each step in the code's words, for a reader who does not read Quint.
import { Array as Arr, Effect, Match, Option, Order } from "effect"
import type { Decider } from "@dotfiles/decider/decider"
import type * as Machine from "../../mods/orchestrate/machine.ts"
import type { Cmd, ModelMachine, Step } from "./trace.ts"

/** The machine module the replay drives: the real one, or a mutant of it (formal/check.ts `--mutants`). */
export type Real = Pick<typeof Machine, "Start" | "HandBack" | "ReportRead" | "Drop" | "Land" | "Landed" | "machine">

type MachineDecider = Decider<Machine.MachineState, Machine.Command, Machine.Event, Machine.Refused>

/** The replay's cadence: a batch is due at 1 ready unit, so `BatchNotDue` never fires (the model has no time). */
export const CADENCE: Machine.Cadence = { ready: 1, waitMs: 30 * 60_000 }

/** Where a unit's Rift is, in a land's `{ path, unit }`. */
const riftOf = (unit: string) => ({ rift: `/rifts/${unit}`, unit })

/** The step's verdict, when it carries one. */
const verdictOf = (cmd: Cmd): Option.Option<Machine.Verdict> => Option.liftPredicate(cmd.verdict, (verdict): verdict is Machine.Verdict => verdict !== "")

/** A verifier's hand-back: a `changes` carries its findings, or `unread` when its report did not read. */
const verifierHandBack = (real: Real, cmd: Cmd, verdict: Machine.Verdict): Machine.Command => {
  const base = { role: "verifier", name: cmd.batch, verdict } as const
  if (verdict !== "changes") return real.HandBack.make(base)
  if (cmd.unread) return real.HandBack.make({ ...base, unread: { why: "the findings file is missing" } })
  return real.HandBack.make({ ...base, findings: cmd.findings })
}

/** The machine command for the model's `cmd`, none for a step of the world alone. */
export const commandOf = (real: Real, cmd: Cmd): Option.Option<Machine.Command> =>
  Match.value(cmd.kind).pipe(
    Match.when("ImplStart", () => Option.some(real.Start.make({ role: "implementor", name: cmd.unit, round: 1, direct: false, folds: cmd.folds }))),
    Match.when("ImplHandBack", () => Option.map(verdictOf(cmd), (verdict) => real.HandBack.make({ role: "implementor", name: cmd.unit, verdict }))),
    Match.when("VerifierStart", () => Option.some(real.Start.make({ role: "verifier", name: cmd.batch, round: 1, direct: false }))),
    Match.when("VerifierHandBack", () => Option.map(verdictOf(cmd), (verdict) => verifierHandBack(real, cmd, verdict))),
    Match.when("ReportRead", () => Option.some(real.ReportRead.make({ batch: cmd.batch, findings: cmd.findings }))),
    Match.when("Drop", () => Option.some(real.Drop.make({ unit: cmd.unit }))),
    Match.when("Land", () => Option.some(real.Land.make({ rifts: Arr.map(cmd.units, riftOf) }))),
    Match.when("Landed", () => Option.some(real.Landed.make({ rifts: Arr.map(cmd.units, riftOf) }))),
    Match.orElse(() => Option.none()),
  )

const sorted = (items: ReadonlyArray<string>) => Arr.sort(Arr.dedupe(items), Order.String)
const got = <A>(value: Option.Option<A>, fallback: A): A => Option.getOrElse(value, () => fallback)
/** `yes` when `when` holds, else `no`. */
export const pick = <A>(when: boolean, yes: () => A, no: () => A): A =>
  Option.getOrElse(
    Option.map(
      Option.liftPredicate(when, (holds) => holds),
      yes,
    ),
    no,
  )

/** The real state in the model's shape (machine.qnt `Machine`). */
export const modelOf = (state: Machine.MachineState): ModelMachine => {
  const verifier = Option.fromUndefinedOr(state.verifier)
  return {
    units: Object.fromEntries(Arr.map(Object.entries(state.units), ([name, unit]) => [name, { state: unit.state, said: got(Option.fromUndefinedOr(unit.said), "") }])),
    verifierOn: Option.isSome(verifier),
    vBatch: Option.match(verifier, { onNone: () => "", onSome: (running) => running.batch }),
    vUnits: sorted(Option.match(verifier, { onNone: () => [], onSome: (running) => got(Option.fromUndefinedOr(running.units), []) })),
    unverified: sorted(got(Option.fromUndefinedOr(state.unverified), [])),
    findings: Object.fromEntries(
      Arr.map(Object.entries(got(Option.fromUndefinedOr(state.findings), {})), ([key, finding]) => [key, { batch: finding.batch, into: got(Option.fromUndefinedOr(finding.into), "") }]),
    ),
    carried: Object.fromEntries(Arr.map(Object.entries(got(Option.fromUndefinedOr(state.carried), {})), ([key, finding]) => [key, { batch: finding.batch, into: finding.into }])),
    unresolved: sorted(Object.keys(got(Option.fromUndefinedOr(state.unresolved), {}))),
  }
}

const list = (items: ReadonlyArray<string>) => `[${items.join(", ")}]`
const entriesOf = <V>(entries: Readonly<Record<string, V>>) => Arr.sort(Object.entries(entries), Order.mapInput(Order.String, ([key]: readonly [string, V]) => key))
const findingsText = (findings: ModelMachine["findings"]) => list(Arr.map(entriesOf(findings), ([key, finding]) => `${key} of ${finding.batch} into ${finding.into || "none"}`))
const unitText = ([name, unit]: readonly [string, ModelMachine["units"][string]]) => `${name} ${unit.state}${pick(unit.said === "", () => "", () => ` (${unit.said})`)}`

/** A machine state in words, the same for equal states: what the replay compares and prints. */
export const machineText = (m: ModelMachine): string =>
  [
    `units ${list(Arr.map(entriesOf(m.units), unitText))}`,
    `verifier ${pick(m.verifierOn, () => `${m.vBatch} over ${list(m.vUnits)}`, () => "none")}`,
    `unverified ${list(m.unverified)}`,
    `findings ${findingsText(m.findings)}`,
    `carried ${findingsText(m.carried)}`,
    `unresolved ${list(m.unresolved)}`,
  ].join("; ")

/** Where the code and the model parted, in words. */
export interface Divergence {
  readonly step: number
  readonly what: string
}

const took = (rule: string) => pick(rule === "", () => "takes it", () => `refuses it (${rule})`)

/** One command decided and folded by `decider`: the rule it refused by ("" when it took it), and the state after. */
const decided = (decider: MachineDecider, state: Machine.MachineState, command: Machine.Command, now: number) =>
  decider.decide(state, command, now).pipe(
    Effect.match({
      onFailure: (refused) => ({ rule: refused.rule, state }),
      onSuccess: (events) => ({ rule: "", state: Arr.reduce(events, state, decider.evolve) }),
    }),
  )

/** Replays one trace through `real`'s machine; the first step where the code parts from the model, or none. */
export const replay = Effect.fn("Formal.replay")(function* (real: Real, steps: ReadonlyArray<Step>) {
  const decider = real.machine(CADENCE)
  let state = decider.initial
  for (const [at, step] of steps.entries()) {
    const command = Option.filter(commandOf(real, step.cmd), () => at > 0)
    if (Option.isSome(command)) {
      const after = yield* decided(decider, state, command.value, 1_000_000 + at * 1_000)
      if (after.rule !== step.refused)
        return Option.some<Divergence>({ step: at, what: `${sentenceOf(step.cmd)}: the model ${took(step.refused)}, machine.ts ${took(after.rule)}` })
      state = after.state
    }
    const actual = machineText(modelOf(state))
    const wanted = machineText(step.m)
    if (actual !== wanted) return Option.some<Divergence>({ step: at, what: `after ${sentenceOf(step.cmd)}, machine.ts holds ${actual}; the model holds ${wanted}` })
  }
  return Option.none<Divergence>()
})

const none = (items: ReadonlyArray<string>) => pick(items.length === 0, () => "none", () => items.join(", "))

/** What a verifier's hand-back said, in words. */
const verdictText = (cmd: Cmd) =>
  Match.value(cmd).pipe(
    Match.when({ verdict: "changes", unread: true }, () => "changes (its findings file does not read)"),
    Match.when({ verdict: "changes" }, () => `changes with findings ${none(cmd.findings)}`),
    Match.orElse(() => cmd.verdict),
  )

/** A model command in the code's words. */
export const sentenceOf = (cmd: Cmd): string =>
  Match.value(cmd.kind).pipe(
    Match.when("ImplStart", () => `implementor ${cmd.unit} starts${pick(cmd.folds.length === 0, () => "", () => ` (folds: ${cmd.folds.join(", ")})`)}`),
    Match.when("ImplHandBack", () => `implementor ${cmd.unit} hands back ${cmd.verdict}`),
    Match.when("VerifierStart", () => `verifier ${cmd.batch} r1 starts`),
    Match.when("VerifierHandBack", () => `verifier ${cmd.batch} hands back ${verdictText(cmd)}`),
    Match.when("ReportRead", () => `the plugin reads ${cmd.batch}'s findings again: ${none(cmd.findings)}`),
    Match.when("Drop", () => `the root drops ${cmd.unit}`),
    Match.when("Land", () => `the root calls rift land on ${cmd.units.join(", ")} (Machines.land checks it)`),
    Match.when("Landed", () => `the land of ${cmd.units.join(", ")} pushes (Machines.landed records it)`),
    Match.orElse(() => "the start"),
  )

/** Each way the world breaks the pipeline rule (machine.qnt `breakOf`), in words. */
const BREAKS = [
  ["VerdictMissing", "a batch lands while the batch before it has no verdict"],
  ["FindingLeft", "a batch lands with a finding of the last verdict folded into no unit it takes (nor one still implementing or stopped)"],
] as const

const breakText = (broke: string) =>
  got(
    Option.map(Arr.findFirst(BREAKS, ([name]) => name === broke), ([, words]) => words),
    broke,
  )

/** A step of the world alone: the rift tool claims or refuses a call, or a land goes red. */
const worldSentence = (before: Step, step: Step): string => {
  const left = Arr.map(step.calls, (call) => call.join(", "))
  const gone = Arr.head(Arr.filter(Arr.map(before.calls, (call) => call.join(", ")), (call) => !left.includes(call)))
  return Option.match(gone, {
    onNone: () => `the land of ${before.landing.join(", ")} goes red: nothing pushed, nothing recorded`,
    onSome: (call) =>
      pick(
        before.landingOn,
        () => `the rift tool refuses the land of ${call}: its integration Rift is busy`,
        () => `the rift tool claims its integration Rift for ${call} and merges`,
      ),
  })
}

/** What a step that fed the machine did, and its refusal. */
const callSentence = (step: Step) => `${sentenceOf(step.cmd)}${pick(step.refused === "", () => "", () => `: refused (${step.refused})`)}`

/** One step's lines: what happened, and the break when the pipeline rule broke at it. */
const linesOf = (before: Step, step: Step, at: number): ReadonlyArray<string> => [
  `${at}. ${pick(step.cmd.kind === "none", () => worldSentence(before, step), () => callSentence(step))}`,
  ...Arr.filter([`   PIPELINE BROKEN (${step.broke}): ${breakText(step.broke)}.`], () => before.ok && !step.ok),
]

/** A trace as numbered steps in the code's words, ending at the pipeline's break when it has one. */
export const storyOf = (steps: ReadonlyArray<Step>): ReadonlyArray<string> =>
  Arr.flatten(Arr.map(Arr.zip(steps, Arr.drop(steps, 1)), ([before, step], at) => linesOf(before, step, at + 1)))
