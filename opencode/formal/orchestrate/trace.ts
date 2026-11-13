// A machine.qnt trace (ITF) decoded into its steps: what each step fed the machine (`cmd`), what the model
// decided (`refused`), the machine state the model holds after it (`m`), the world's verdict on the pipeline
// rule (`ok`, `broke`), and the lands in flight.
import { Array as Arr, Data, Effect, Schema } from "effect"
import { Rule, Verdict } from "../../mods/orchestrate/machine.ts"
import { itfMap, itfSet, record, sortedSet } from "../itf.ts"

const Strings = itfSet(Schema.String)
const Unit = Schema.Struct({ state: Schema.String, said: Schema.String })
const Finding = Schema.Struct({ batch: Schema.String, into: Schema.String })

/** The kinds of command a step feeds the machine (machine.qnt `Cmd.kind`); `none` for a step of the world alone. */
export const Kind = Schema.Literals(["none", "ImplStart", "ImplHandBack", "VerifierStart", "VerifierHandBack", "ReportRead", "Drop", "Land", "Landed"])
export type Kind = typeof Kind.Type

const RawMachine = Schema.Struct({
  units: itfMap(Unit),
  verifierOn: Schema.Boolean,
  vBatch: Schema.String,
  vUnits: Strings,
  unverified: Strings,
  findings: itfMap(Finding),
  carried: itfMap(Finding),
  unresolved: Strings,
})

const RawCmd = Schema.Struct({
  kind: Kind,
  unit: Schema.String,
  units: Strings,
  verdict: Schema.Union([Verdict, Schema.Literal("")]),
  findings: Strings,
  folds: Strings,
  batch: Schema.String,
  unread: Schema.Boolean,
})

const RawState = Schema.Struct({
  m: RawMachine,
  g: Schema.Struct({ ok: Schema.Boolean, broke: Schema.String }),
  cmd: RawCmd,
  refused: Schema.Union([Rule, Schema.Literal("")]),
  calls: itfSet(Schema.Struct({ rifts: Strings, broke: Schema.String })),
  landing: Strings,
  landingOn: Schema.Boolean,
})

const RawTrace = Schema.Struct({ states: Schema.Array(RawState) })

/** The machine state as the model holds it, sets sorted and maps as records. */
export interface ModelMachine {
  readonly units: Readonly<Record<string, typeof Unit.Type>>
  readonly verifierOn: boolean
  readonly vBatch: string
  readonly vUnits: ReadonlyArray<string>
  readonly unverified: ReadonlyArray<string>
  readonly findings: Readonly<Record<string, typeof Finding.Type>>
  readonly carried: Readonly<Record<string, typeof Finding.Type>>
  readonly unresolved: ReadonlyArray<string>
}

/** What a step fed the machine. */
export interface Cmd {
  readonly kind: Kind
  readonly unit: string
  readonly units: ReadonlyArray<string>
  readonly verdict: Verdict | ""
  readonly findings: ReadonlyArray<string>
  readonly folds: ReadonlyArray<string>
  readonly batch: string
  readonly unread: boolean
}

/** One state of the trace: the step that led to it and what the model holds after it. */
export interface Step {
  readonly m: ModelMachine
  readonly ok: boolean
  readonly broke: string
  readonly cmd: Cmd
  readonly refused: Rule | ""
  readonly calls: ReadonlyArray<ReadonlyArray<string>>
  readonly landing: ReadonlyArray<string>
  readonly landingOn: boolean
}

export class TraceUnreadable extends Data.TaggedError("TraceUnreadable")<{ readonly why: string }> {}

const stepOf = (raw: typeof RawState.Type): Step => ({
  m: {
    units: record(raw.m.units),
    verifierOn: raw.m.verifierOn,
    vBatch: raw.m.vBatch,
    vUnits: sortedSet(raw.m.vUnits),
    unverified: sortedSet(raw.m.unverified),
    findings: record(raw.m.findings),
    carried: record(raw.m.carried),
    unresolved: sortedSet(raw.m.unresolved),
  },
  ok: raw.g.ok,
  broke: raw.g.broke,
  cmd: { ...raw.cmd, units: sortedSet(raw.cmd.units), findings: sortedSet(raw.cmd.findings), folds: sortedSet(raw.cmd.folds) },
  refused: raw.refused,
  calls: Arr.map(raw.calls["#set"], (call) => sortedSet(call.rifts)),
  landing: sortedSet(raw.landing),
  landingOn: raw.landingOn,
})

/** A machine.qnt trace file's text as its steps; the first is the initial state. */
export const decodeTrace = (text: string): Effect.Effect<ReadonlyArray<Step>, TraceUnreadable> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(RawTrace))(text).pipe(
    Effect.map((trace) => Arr.map(trace.states, stepOf)),
    Effect.mapError((cause) => new TraceUnreadable({ why: cause.message })),
  )
