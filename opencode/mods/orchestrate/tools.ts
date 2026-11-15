// The `orchestrate` tool's domain, pure: its input (`OrchestrateInput`), its one description, which tells the
// loop `lane → implement → ready → land → verify`, the input rule (which fields each action takes), the rule that
// names a unit's Rift, and the words of every answer. The plugin (cmd/orchestrate/server.ts) runs it and keeps no
// state of a run: every answer is computed at the call from the run tables (the skill's status script, through the
// status plugin) and the warm source's Rift list (the rift plugin's RPC), so a restart or another root session gets
// the same answer. The rift plugin makes and lands the Rifts; nothing here refuses a land for a batch rule.
import { Array as Arr, Match, Option, Predicate, Schema } from "effect"
import { toolInput } from "@dotfiles/decider/tool-input"
import type { Run, RunUnit } from "./idle.ts"

/** The tool's name: a direct tool, its policy in the plugin's hooks. */
export const ORCHESTRATE = "orchestrate"

export const ACTIONS = ["status", "lane", "land", "verify"] as const
export type Action = (typeof ACTIONS)[number]

/** A unit with the Rift to land it from. */
export const UnitRift = Schema.Struct({ unit: Schema.String, path: Schema.String })
export interface UnitRift extends Schema.Schema.Type<typeof UnitRift> {}

/** A unit a land names: by name, or `{ unit, path }`. */
export const LandUnit = Schema.Union([Schema.String, UnitRift])
export type LandUnit = typeof LandUnit.Type

export const OrchestrateInput = toolInput(
  Schema.Struct({
    action: Schema.Literals(ACTIONS).annotate({
      description:
        "status: the run tables, each open unit's lane and the one next call. lane: the unit's Rift (made, or answered when it exists). land: the units named, or every ready unit with a lane. verify: a verifier's clean checkout and the subagent call that starts it.",
    }),
    unit: Schema.optional(Schema.String).annotate({ description: "lane: the unit, as its role calls name it (`implementor <unit> r1`)." }),
    run: Schema.optional(Schema.String).annotate({ description: "lane: the run, for the branch `<run>/<unit>`." }),
    branch: Schema.optional(Schema.String).annotate({ description: "lane: the branch, in place of `<run>/<unit>` or `feat/<unit>`." }),
    source: Schema.optional(Schema.String).annotate({ description: "lane: a directory of the repository whose warm source to use. Default: this session's directory." }),
    units: Schema.optional(Schema.Array(LandUnit)).annotate({
      description: "land: the units to land, by name, or { unit, path } to land the Rift at path as the unit. Default: every unit the run tables show ready that has a lane.",
    }),
    departs: Schema.optional(Schema.String).annotate({ description: "land: ignored; kept so an older call decodes." }),
    batch: Schema.optional(Schema.String).annotate({ description: "verify: what the verifier is named for: `batch-<k>`, a unit, or `main-<sha>`." }),
    head: Schema.optional(Schema.String).annotate({ description: "verify: the commit to verify at. Default: origin's default branch head, read then." }),
  }),
)
export type OrchestrateInput = typeof OrchestrateInput.Type

/** An input field other than `action`. */
export type Field = Exclude<keyof OrchestrateInput, "action">

/** The fields each action takes, and the ones it needs. */
export const FIELDS = {
  status: [],
  lane: ["unit", "run", "branch", "source"],
  land: ["units", "departs"],
  verify: ["batch", "head"],
} as const satisfies { readonly [A in Action]: ReadonlyArray<Field> }
export const REQUIRED = { status: [], lane: ["unit"], land: [], verify: ["batch"] } as const satisfies { readonly [A in Action]: ReadonlyArray<Field> }

const ALL_FIELDS: ReadonlyArray<Field> = ["unit", "run", "branch", "source", "units", "departs", "batch", "head"]

/** A unit's name: what a Rift's name and a role call's description can hold. A verify's name is one too. */
export const UNIT_NAME = /^[a-z0-9][a-z0-9._-]*$/

// ── The calls as the model reads them ──

/** A string as a call's literal. */
export const quote = (text: string): string => `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`

/** A land's unit as the call writes it. */
const unitLiteral = (unit: LandUnit): string =>
  Match.value(unit).pipe(
    Match.when(Predicate.isString, quote),
    Match.orElse((named) => `{ unit: ${quote(named.unit)}, path: ${quote(named.path)} }`),
  )

/** An `orchestrate` call as the model writes it: `orchestrate({ action: "lane", unit: "billing" })`. */
export const callOf = (action: Action, fields: ReadonlyArray<readonly [Field, string]> = []): string =>
  `${ORCHESTRATE}({ ${[`action: ${quote(action)}`, ...fields.map(([field, literal]) => `${field}: ${literal}`)].join(", ")} })`

/** The land call: every ready unit with a lane with no `units`, else those named. */
export const landCallOf = (units: ReadonlyArray<LandUnit>): string =>
  callOf("land", Arr.match(units, { onEmpty: () => [], onNonEmpty: (named) => [["units", `[${named.map(unitLiteral).join(", ")}]`] as const] }))

/** The lane call for a unit. */
export const laneCallOf = (unit: string): string => callOf("lane", [["unit", quote(unit)]])

/** The verify call for a batch. */
export const verifyCallOf = (batch: string): string => callOf("verify", [["batch", quote(batch)]])

export const STATUS_CALL = callOf("status")

/** Each action's call that decodes, as a refusal names it. */
const EXAMPLES = {
  status: STATUS_CALL,
  lane: laneCallOf("<unit>"),
  land: landCallOf([]),
  verify: verifyCallOf("batch-<k>"),
} as const satisfies { readonly [A in Action]: string }

// ── The description ──

/** The steps of the loop, in order: each heads one paragraph of the description. */
export const STEP_ORDER = ["lane", "implement", "ready", "land", "verify"] as const

export const ORCHESTRATE_DESCRIPTION = [
  "The steps of an orchestrate run, for the root session that runs its units, in this order: lane → implement → ready → land → verify. Every answer is read at the call from the run tables (the units' log.md files, as the skill's status script derives them) and the warm source's Rifts, so a restart or another root session gets the same answer; status names the one next call.",
  `lane: ${callOf("lane", [["unit", quote("billing")], ["run", quote("pc")]])} makes the unit's Rift (an isolated workspace from the warm source), named for the unit, on branch \`branch\`, else \`<run>/<unit>\`, else \`feat/<unit>\`. A lane that exists is answered, never made again by hand. Each answer ends with the \`(rift: <path>)\` its implementor's description takes.`,
  'implement: a subagent call, not an action: subagent({ agent: "implementor", description: "implementor <unit> r1 (rift: <path>)", prompt, background: true }). Its start and its hand-back move the unit in its log.md.',
  "ready: the implementor's hand-back, `implementor <unit> r<N>: ready <request path>`, which the plugin writes to the unit's log.md when the implementor goes idle.",
  `land: ${landCallOf([])} lands every unit the run tables show ready that has a lane: their Rifts merged onto the default branch as one push, by their receipts, with one merge check. Name units to land those instead, or { unit, path } to land a Rift the plugin cannot name. A named unit that is not ready lands with a warning. A land does not wait for the deep run or the post-land step: they run in the background and wake you.`,
  `verify: ${verifyCallOf("batch-7")} makes a verifier's clean checkout, the Rift verify-<batch> detached at head (default: origin's default branch head, read then), and answers the one subagent call that starts it: subagent({ agent: "verifier", description: "verifier <batch> r1", prompt, background: true }).`,
  `status: ${STATUS_CALL} answers the run tables, each open unit's lane, and one next: line naming the call to make. Call it after a compaction, or whenever the next step is unclear.`,
  "A subagent never lanes, lands or verifies: the root does. The rift tool is for a session that runs no units; in a root that runs units, lane replaces rift create and land replaces rift land.",
].join("\n\n")

// ── The input rule ──

/** The action that takes `field`. */
export const ownerOf = (field: Field): Action => Option.getOrElse(Arr.findFirst(ACTIONS, (action) => Arr.contains(FIELDS[action], field)), () => "status" as const)

/** The fields `input` carries. */
export const fieldsIn = (input: OrchestrateInput): ReadonlyArray<Field> => ALL_FIELDS.filter((field) => Predicate.isNotUndefined(input[field]))

/** Why `input` does not run, by the input rule: a field another action takes, or a field its action needs; none when it runs. */
export const inputRefusal = (input: OrchestrateInput): Option.Option<string> => {
  const action = input.action
  const stray = Arr.findFirst(fieldsIn(input), (field) => !Arr.contains(FIELDS[action], field))
  if (Option.isSome(stray)) {
    const owner = ownerOf(stray.value)
    return Option.some(
      `orchestrate: ${action} takes no ${stray.value}: ${stray.value} belongs to ${owner}, as in ${EXAMPLES[owner]}. ${action} takes ${takesOf(action)}: ${EXAMPLES[action]}.`,
    )
  }
  const missing = Arr.findFirst(REQUIRED[action], (field) => Predicate.isUndefined(input[field]))
  if (Option.isSome(missing)) return Option.some(`orchestrate: ${action} needs ${missing.value}: ${EXAMPLES[action]}.`)
  return Option.none()
}

/** Why a call that passes the input rule names no unit: a lane's unit, or a verify's batch, that is no unit name. */
export const nameRefusal = (input: OrchestrateInput): Option.Option<string> => {
  const action = input.action
  if (action === "lane" && !UNIT_NAME.test(input.unit ?? ""))
    return Option.some(`orchestrate: ${quote(input.unit ?? "")} is no unit name: a unit is lowercase letters, digits, ., _ and -, as in ${EXAMPLES.lane}.`)
  if (action === "verify" && !UNIT_NAME.test(input.batch ?? ""))
    return Option.some(`orchestrate: ${quote(input.batch ?? "")} is no batch: name it batch-<k>, a unit or main-<sha>, as in ${EXAMPLES.verify}.`)
  return Option.none()
}

const takesOf = (action: Action): string =>
  Arr.match(FIELDS[action], { onEmpty: () => "no field", onNonEmpty: (fields) => fields.join(", ") })

/** A subagent's call of an action only the root makes. */
export const parentRefusal = (action: Action): string =>
  `orchestrate: ${action} is the root's: a subagent never lanes, lands or verifies. Hand back to the root, which does. ${STATUS_CALL} answers here.`

// ── A unit's lane ──

/** A Rift as the tool reads it (the rift RPC's `Lane`): its directory, its branch (none when detached), its head and its unsaved work. */
export interface Lane {
  readonly path: string
  readonly branch?: string
  readonly head: string
  readonly state: string
}

/** The branch a lane is made on: `branch`, else `<run>/<unit>`, else `feat/<unit>`. */
export const laneBranchOf = (input: { readonly unit: string; readonly run?: string; readonly branch?: string }): string =>
  Option.getOrElse(Option.fromUndefinedOr(input.branch), () =>
    Option.match(Option.fromUndefinedOr(input.run), { onNone: () => `feat/${input.unit}`, onSome: (run) => `${run}/${input.unit}` }),
  )

/** The last segment of a path. */
const baseOf = (path: string): string => Option.getOrElse(Arr.last(path.replace(/\/+$/, "").split("/")), () => path)

/**
 * Whether `lane` is `unit`'s, by the exact name a lane gives it: its branch's last segment is the unit (`feat/<unit>`,
 * `<run>/<unit>`); or, on the Mac, where `rift create` names the Rift for the unit, its folder is. On the workbox
 * workrift names a Rift after its whole branch (`feat-y` for `feat/y`), so a folder name there is never a unit's: the
 * Rift `feat-y` of unit `y` is never unit `feat-y`'s (orch-tools r4 M1).
 */
export const isLaneOf = (unit: string, lane: Lane, workrift: boolean): boolean =>
  Option.exists(Option.fromUndefinedOr(lane.branch), (branch) => baseOf(branch) === unit) || (!workrift && baseOf(lane.path) === unit)

/** The Rifts of `lanes` that are `unit`'s. */
export const lanesOf = (unit: string, lanes: ReadonlyArray<Lane>, workrift: boolean): ReadonlyArray<Lane> => lanes.filter((lane) => isLaneOf(unit, lane, workrift))

/** What a lane does: answers the Rift it finds, makes one of `name`, or is refused. */
export type LaneDecision = { readonly found: Lane } | { readonly make: string } | { readonly refused: string }

/**
 * A lane of `unit` on `branch`, where the Rift it makes is named `name`. On the workbox (`workrift`), workrift names a
 * Rift after its branch (`workspaceName`), so two branches can take one name (`feat/w` and `feat/w-` are both
 * `feat-w`): a Rift of that name on another branch is another lane's, and this one is refused rather than answered
 * it. On the Mac the name is the unit's own, so its Rift is the unit's on any branch.
 */
export const laneDecision = (unit: string, branch: string, name: string, workrift: boolean, lanes: ReadonlyArray<Lane>): LaneDecision => {
  const named = Arr.findFirst(lanes, (lane) => baseOf(lane.path) === name)
  if (Option.isSome(named) && workrift && named.value.branch !== branch)
    return {
      refused: `orchestrate: workrift names the Rift of branch ${branch} ${name}, and ${named.value.path} (${Option.getOrElse(
        Option.map(Option.fromUndefinedOr(named.value.branch), (other) => `branch ${other}`),
        () => `detached at ${named.value.head}`,
      )}) already has that name: it is another lane's. Lane ${unit} on a branch whose name is its own: ${callOf("lane", [
        ["unit", quote(unit)],
        ["branch", quote("<branch>")],
      ])}.`,
    }
  if (Option.isSome(named)) return { found: named.value }
  return Arr.match(lanesOf(unit, lanes, workrift), {
    onEmpty: (): LaneDecision => ({ make: name }),
    onNonEmpty: (found): LaneDecision =>
      Arr.match(Arr.drop(found, 1), { onEmpty: () => ({ found: Arr.headNonEmpty(found) }), onNonEmpty: () => ({ refused: lanesRefusal(unit, found) }) }),
  })
}

/** The Rift a verify makes for a batch: `verify-<batch>`. */
export const verifyLaneOf = (batch: string): string => `verify-${batch}`

/** The Rift of `name` among `lanes`, by its last segment. */
export const laneNamed = (name: string, lanes: ReadonlyArray<Lane>): Option.Option<Lane> => Arr.findFirst(lanes, (lane) => baseOf(lane.path) === name)

/** Two Rifts read as one unit: never one picked; the call names them and the form that picks. */
export const lanesRefusal = (unit: string, lanes: ReadonlyArray<Lane>): string =>
  `orchestrate: ${lanes.length} Rifts read as ${unit}: ${lanes.map((lane) => lane.path).join(", ")}. Name the one to land: ${landCallOf([{ unit, path: "<its Rift>" }])}.`

// ── The run tables ──

/** A unit's state that ends it: it has nothing left to land or verify. */
const CLOSED = /^(merged|dropped|done)\b/

/** Whether a unit is open: its state does not end it. */
export const isOpen = (unit: RunUnit): boolean => !CLOSED.test(unit.state)

/** The state the run tables show for `unit`, from the first run that holds it. */
export const stateOf = (unit: string, runs: ReadonlyArray<Run>): Option.Option<string> =>
  Arr.findFirst(runs, (run) => Option.map(Arr.findFirst(run.units, (each) => each.unit === unit), (each) => each.state))

/** The units the run tables show in `state`, once each, in the tables' order. */
const unitsIn = (runs: ReadonlyArray<Run>, state: string): ReadonlyArray<string> => Arr.dedupe(runs.flatMap((run) => run.units.filter((unit) => unit.state === state).map((unit) => unit.unit)))

/** The units that are ready with exactly one lane: what a land with no units lands. */
export const readyWithLane = (runs: ReadonlyArray<Run>, lanes: ReadonlyArray<Lane>, workrift: boolean): ReadonlyArray<string> =>
  unitsIn(runs, "ready").filter((unit) => lanesOf(unit, lanes, workrift).length === 1)

// ── The land ──

/** A land's Rifts, each with its unit, and the warnings its answer starts with; or why it does not run. */
export type Resolved = { readonly rifts: ReadonlyArray<UnitRift>; readonly warnings: ReadonlyArray<string> } | { readonly refused: string } | { readonly nothing: string }

/** The warning a land of a unit the run tables show in another state than `ready` starts with; it lands. */
export const warningOf = (unit: string, state: string): string => `orchestrate: warning: ${unit} is ${state}, not ready; landed as asked.`

/** What a land with no units answers when no unit is ready with a lane. */
export const nothingToLand = (runs: ReadonlyArray<Run>): string =>
  `orchestrate: no unit is ready with a lane, so nothing landed. Name the units to land: ${landCallOf(["<unit>"])}, or { unit, path } for a Rift the plugin cannot name.${Arr.match(unitsIn(runs, "ready"), { onEmpty: () => "", onNonEmpty: (ready) => ` Ready with no lane or two: ${ready.join(", ")}.` })}`

/**
 * The Rifts a land takes: `{ unit, path }` as given; a name, its one lane (none or two: the call names them and the
 * `{ unit, path }` form, never picks); no units, every unit the run tables show ready with one lane. A named unit the
 * run tables show in another state than `ready` lands with a warning.
 */
export const resolveLand = (input: OrchestrateInput, runs: ReadonlyArray<Run>, lanes: ReadonlyArray<Lane>, workrift: boolean): Resolved => {
  const asked = Option.getOrElse(Option.filter(Option.fromUndefinedOr(input.units), Arr.isReadonlyArrayNonEmpty), () => [])
  if (asked.length === 0) {
    const ready = readyWithLane(runs, lanes, workrift)
    if (ready.length === 0) return { nothing: nothingToLand(runs) }
    return { rifts: ready.flatMap((unit) => lanesOf(unit, lanes, workrift).map((lane) => ({ unit, path: lane.path }))), warnings: [] }
  }
  const rifts: Array<UnitRift> = []
  for (const each of asked) {
    if (!Predicate.isString(each)) {
      rifts.push(each)
      continue
    }
    const found = lanesOf(each, lanes, workrift)
    if (found.length === 0) return { refused: `orchestrate: no Rift of the warm source reads as ${each}. Name its Rift: ${landCallOf([{ unit: each, path: "<its Rift>" }])}.` }
    if (found.length > 1) return { refused: lanesRefusal(each, found) }
    rifts.push({ unit: each, path: found[0]?.path ?? "" })
  }
  const warnings = rifts.flatMap((rift) => Option.toArray(Option.map(Option.filter(stateOf(rift.unit, runs), (state) => state !== "ready"), (state) => warningOf(rift.unit, state))))
  return { rifts, warnings }
}

// ── The answers ──

/** A lane's answer: the Rift, its branch, head and unsaved work, whether it was made, and the implementor's suffix last. */
export const laneAnswer = (unit: string, lane: Lane, made: boolean): string =>
  [
    `orchestrate: lane ${unit}: ${lane.path} · ${Option.getOrElse(Option.map(Option.fromUndefinedOr(lane.branch), (branch) => `branch ${branch}`), () => `detached at ${lane.head}`)} · head ${lane.head} · ${lane.state}${Match.value(made).pipe(
      Match.when(true, () => "; made now."),
      Match.orElse(() => "; it existed, so nothing was made."),
    )}`,
    `Start its implementor: subagent({ agent: "implementor", description: "implementor ${unit} r1 (rift: ${lane.path})", prompt, background: true }).`,
    `(rift: ${lane.path})`,
  ].join("\n")

/** A land's answer: its warnings, the rift land's own text, then the verify to make. */
export const landAnswer = (warnings: ReadonlyArray<string>, text: string): string => [...warnings, text, LAND_NEXT].join("\n")

/** A land's last line: a verifier over what landed. */
export const LAND_NEXT = `orchestrate: next: a verifier over what landed: ${verifyCallOf("<unit>")}, then the subagent call it answers.`

/** How a verify's head was chosen. */
export type HeadChosen = "given" | "origin"

/** A verify's answer: its Rift at the commit, how the commit was chosen, and the subagent call to make last. */
export const verifyAnswer = (batch: string, lane: Lane, made: boolean, chosen: HeadChosen): string =>
  [
    `orchestrate: verify ${batch}: ${lane.path}, detached at ${lane.head} (${Match.value(chosen).pipe(
      Match.when("given", () => "the head you gave"),
      Match.orElse(() => "origin's default branch head, read now"),
    )})${Match.value(made).pipe(
      Match.when(true, () => "; made now."),
      Match.orElse(() => "; it existed, so nothing was made."),
    )}`,
    `Start its verifier, in that checkout: subagent({ agent: "verifier", description: "verifier ${batch} r1", prompt, background: true }).`,
  ].join("\n")

/** A repository whose run tables hold no unit, as status answers it. */
export const NO_UNITS = `orchestrate: no run of this repository holds a unit; ${laneCallOf("<unit>")} starts one.`

/** The one next call, from the run tables and the lanes. */
export const nextLine = (runs: ReadonlyArray<Run>, lanes: ReadonlyArray<Lane>, workrift: boolean): string => {
  const ready = readyWithLane(runs, lanes, workrift)
  if (ready.length > 0) return `next: ${landCallOf([])} (ready with a lane: ${ready.join(", ")}).`
  const implementing = unitsIn(runs, "implement")
  if (implementing.length > 0) return `next: wait for the hand-backs of ${implementing.join(", ")} (implementing).`
  return "next: none (no unit is ready with a lane or implementing)."
}

/** A unit's lane as status says it. */
const laneText = (found: ReadonlyArray<Lane>): string =>
  Arr.match(found, {
    onEmpty: () => "no lane",
    onNonEmpty: (each) =>
      Arr.match(Arr.drop(each, 1), {
        onEmpty: () => {
          const lane = Arr.headNonEmpty(each)
          return `lane ${lane.path} (${Option.getOrElse(Option.map(Option.fromUndefinedOr(lane.branch), (branch) => `branch ${branch}`), () => `detached at ${lane.head}`)})`
        },
        onNonEmpty: () => `${each.length} lanes: ${each.map((lane) => lane.path).join(", ")}`,
      }),
  })

/** Status: each run's units with their states and, for an open one, its lane; then the one next call. */
export const statusAnswer = (runs: ReadonlyArray<Run>, lanes: ReadonlyArray<Lane>, workrift: boolean): string => {
  const held = runs.filter((run) => run.units.length > 0)
  if (held.length === 0) return NO_UNITS
  return [
    ...held.flatMap((run) => [
      `orchestrate: run ${run.name}:`,
      ...run.units.map((unit) => [`- ${unit.unit}: ${unit.state}`, ...Arr.filter([unit], isOpen).map((open) => laneText(lanesOf(open.unit, lanes, workrift)))].join(" · ")),
    ]),
    nextLine(held, lanes, workrift),
  ].join("\n")
}

/** What a compacted root that runs units is told: its status, and to re-read the skill and its plan. */
export const compactedNote = (status: string): string =>
  [status, "Re-read ~/.claude/skills/orchestrate/SKILL.md and protocol.md, and your plan, before any other action."].join("\n\n")

/** The notice row the compaction note draws. */
export const COMPACTED_DESCRIPTION = "orchestrate: your run, after the compaction"
