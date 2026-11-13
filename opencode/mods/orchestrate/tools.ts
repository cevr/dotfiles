// The `orchestrate` tool's domain, pure: its input (`OrchestrateInput`), its one description, which tells the
// loop `lane → implement → ready → land → verify → fold`, the input rule (which fields each action takes), the
// rule that names a unit's Rift, the one next call for a machine state (`nextOf`), and the words of every answer
// and refusal. The plugin (cmd/orchestrate/server.ts) runs it: the machine (machine.ts) decides a land and a
// verifier's start, and the rift plugin makes and lands the Rifts over its RPC.
import { Array as Arr, Match, Option, Predicate, Schema } from "effect"
import { toolInput } from "@dotfiles/decider/tool-input"
import {
  BATCH,
  type Cadence,
  coverOf,
  dueOf,
  entryOf,
  type LandTarget,
  type MachineState,
  unfoldedOf,
  unitOfEntry,
  unitOfFinding,
  unitsIn,
  unresolvedOf,
  verdictPending,
} from "./machine.ts"

/** The tool's name: a direct tool, its policy in the plugin's hooks. */
export const ORCHESTRATE = "orchestrate"

export const ACTIONS = ["status", "lane", "land", "verify"] as const
export type Action = (typeof ACTIONS)[number]

/** A unit whose Rift the plugin cannot name, with its Rift. */
export const UnitRift = Schema.Struct({ unit: Schema.String, path: Schema.String })
export interface UnitRift extends Schema.Schema.Type<typeof UnitRift> {}

/** A unit a land names: by name, or `{ unit, path }`. */
export const LandUnit = Schema.Union([Schema.String, UnitRift])
export type LandUnit = typeof LandUnit.Type

export const OrchestrateInput = toolInput(
  Schema.Struct({
    action: Schema.Literals(ACTIONS).annotate({
      description:
        "status: the run, its lanes and the one next call. lane: the unit's Rift (made, or answered when it exists). land: the batch, every ready unit by default. verify: the batch verifier's clean checkout and the subagent call that starts it.",
    }),
    unit: Schema.optional(Schema.String).annotate({ description: "lane: the unit, as its role calls name it (`implementor <unit> r1`)." }),
    run: Schema.optional(Schema.String).annotate({ description: "lane: the run, for the branch `<run>/<unit>`." }),
    branch: Schema.optional(Schema.String).annotate({ description: "lane: the branch, in place of `<run>/<unit>` or `feat/<unit>`." }),
    source: Schema.optional(Schema.String).annotate({ description: "lane: a directory of the repository whose warm source to use. Default: this session's directory." }),
    units: Schema.optional(Schema.Array(LandUnit)).annotate({
      description: "land: the units to land, by name, or { unit, path } for one whose Rift the plugin cannot name. Default: every ready unit.",
    }),
    departs: Schema.optional(Schema.String).annotate({ description: "land: why this land goes against the machine's rule; the machine records it." }),
    batch: Schema.optional(Schema.String).annotate({ description: "verify: the batch, `batch-<k>`." }),
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

/** A unit's name: what a Rift's name and a role call's description can hold. */
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

/** The land call: every ready unit with no `units`, else those named; with `departs` when given. */
export const landCallOf = (units: ReadonlyArray<LandUnit>, departs: Option.Option<string> = Option.none()): string =>
  callOf("land", [
    ...Arr.match(units, { onEmpty: () => [], onNonEmpty: (named) => [["units", `[${named.map(unitLiteral).join(", ")}]`] as const] }),
    ...Option.toArray(Option.map(departs, (why) => ["departs", quote(why)] as const)),
  ])

/**
 * A land's Rifts as the `orchestrate` land that departs on purpose names them (a refusal's way to go against its
 * rule): each Rift's unit by name, or `{ unit, path }` for one the input gave a path for; a Rift of no unit as
 * `{ unit: "<unit>", path }`.
 */
export const departingLandCallOf = (state: MachineState, rifts: ReadonlyArray<LandTarget>): string =>
  landCallOf(
    rifts.map((target) => {
      const entry = entryOf(target)
      return Option.match(Option.fromUndefinedOr(unitOfEntry(target, Object.keys(state.units), ownedOf(state))), {
        onNone: (): LandUnit => ({ unit: "<unit>", path: entry.rift }),
        onSome: (unit): LandUnit => Option.match(Option.fromUndefinedOr(entry.unit), { onNone: () => unit, onSome: () => ({ unit, path: entry.rift }) }),
      })
    }),
    Option.some("<why>"),
  )

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
export const STEP_ORDER = ["lane", "implement", "ready", "land", "verify", "fold"] as const

export const ORCHESTRATE_DESCRIPTION = [
  "The steps of an orchestrate run, for the root session that runs its units, in this order: lane → implement → ready → land → verify → fold. The orchestrate plugin's machine (its ledger of this root) decides each land and each verifier start in the orchestrate skill's words; status names the one next call.",
  `lane: ${callOf("lane", [["unit", quote("billing")], ["run", quote("pc")]])} makes the unit's Rift (an isolated workspace from the warm source), named for the unit, on branch \`branch\`, else \`<run>/<unit>\`, else \`feat/<unit>\`. A lane that exists is answered, never made again by hand. Make every lane of a batch in one step; each answer ends with the \`(rift: <path>)\` its implementor's description takes.`,
  'implement: a subagent call, not an action: subagent({ agent: "implementor", description: "implementor <unit> r1 (rift: <path>)", prompt, background: true }). The `(rift: <path>)` tells the machine the unit\'s Rift, so land finds it.',
  "ready: the implementor's hand-back, `implementor <unit> r<N>: ready <request path>`, which the machine reads when the implementor goes idle. Keep the next units implementing while a batch lands and verifies.",
  `land: ${landCallOf([])} lands the batch: the units' Rifts merged onto the default branch as one push, by their receipts, with one merge check. A land with no units lands every ready unit in one call. Name units only for a subset the machine allows, or as { unit, path } for a unit whose Rift the plugin cannot name. A land does not wait for the deep run or the post-land step: they run in the background and wake you. A refused land says why, in the skill's words, and the call to make instead; add departs only when the owner or the run's rules depart from the rule.`,
  `verify: ${verifyCallOf("batch-7")} makes the batch verifier's clean checkout, the Rift verify-<batch> detached at head (default: origin's default branch head, read then), and answers the one subagent call that starts it: subagent({ agent: "verifier", description: "verifier batch-<k> r1", prompt, background: true }). One verifier per batch, and one at a time.`,
  "fold: a verifier's changes verdict opens its findings. Fold each into a unit of the next batch by its implementor's start in that unit's lane, description `implementor <unit> r<N> (folds: <unit>/<id>)`. The next batch lands once the verdict is in and every finding is folded.",
  `status: ${STATUS_CALL} answers the run from the ledger: each unit's state, its lane with its unsaved work, and one next: line naming the call to make. Call it after a compaction, or whenever the next step is unclear.`,
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

/** Why a call that passes the input rule names no unit or no batch: a lane's unit that is no unit name, a verify's batch that is no batch. */
export const nameRefusal = (input: OrchestrateInput): Option.Option<string> => {
  const action = input.action
  if (action === "lane" && !UNIT_NAME.test(input.unit ?? ""))
    return Option.some(`orchestrate: ${quote(input.unit ?? "")} is no unit name: a unit is lowercase letters, digits, ., _ and -, as in ${EXAMPLES.lane}.`)
  if (action === "verify" && !BATCH.test(input.batch ?? ""))
    return Option.some(`orchestrate: ${quote(input.batch ?? "")} is no batch: a batch is named batch-<k>, as in ${EXAMPLES.verify}.`)
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

/** Each unit's Rifts as its implementors' starts named them (the ledger's `rifts`). */
const ownedOf = (state: MachineState) =>
  Object.fromEntries(Object.entries(state.units).flatMap(([name, unit]) => Option.toArray(Option.map(Option.fromUndefinedOr(unit.rifts), (rifts) => [name, rifts] as const))))

/**
 * The unit a Rift is, among `units`: the unit whose implementor was started on it (the ledger's `rifts`), else the
 * one its branch names, else the one its name names, by the machine's own rule (`unitOfEntry`); none, never two.
 */
export const unitOfLane = (lane: Lane, units: ReadonlyArray<string>, state: MachineState): Option.Option<string> => {
  const owned = ownedOf(state)
  return Option.orElse(
    Option.flatMap(Option.fromUndefinedOr(lane.branch), (branch) => Option.fromUndefinedOr(unitOfEntry({ rift: lane.path, branch }, units, owned))),
    () => Option.fromUndefinedOr(unitOfEntry({ rift: lane.path }, units, owned)),
  )
}

/** The Rifts of `lanes` that are `unit`'s, with `unit` counted among the machine's units. */
export const lanesOf = (unit: string, lanes: ReadonlyArray<Lane>, state: MachineState): ReadonlyArray<Lane> => {
  const units = Arr.dedupe([...Object.keys(state.units), unit])
  return lanes.filter((lane) => Option.contains(unitOfLane(lane, units, state), unit))
}

/** The last segment of a path. */
const baseOf = (path: string): string => Option.getOrElse(Arr.last(path.replace(/\/+$/, "").split("/")), () => path)

/**
 * The Rifts a lane of `unit` would answer instead of making one: the Rift of the name it makes (`name`: the unit on
 * the Mac, workrift's name for the branch on the workbox), else those that read as the unit (`lanesOf`).
 */
export const existingLanes = (unit: string, name: string, lanes: ReadonlyArray<Lane>, state: MachineState): ReadonlyArray<Lane> =>
  Arr.match(
    lanes.filter((lane) => baseOf(lane.path) === name),
    { onEmpty: () => lanesOf(unit, lanes, state), onNonEmpty: (named) => named },
  )

/** The Rift a verify makes for a batch: `verify-<batch>`. */
export const verifyLaneOf = (batch: string): string => `verify-${batch}`

/** The Rift of `name` among `lanes`, by its last segment. */
export const laneNamed = (name: string, lanes: ReadonlyArray<Lane>): Option.Option<Lane> => Arr.findFirst(lanes, (lane) => baseOf(lane.path) === name)

/** Two Rifts a lane would answer: refused, naming them. */
export const lanesRefusal = (unit: string, lanes: ReadonlyArray<Lane>): string =>
  `orchestrate: ${lanes.length} Rifts read as ${unit}: ${lanes.map((lane) => lane.path).join(", ")}. Remove the one that is not its lane with rift({ action: "remove", path }), or land it as ${landCallOf([{ unit, path: "<its Rift>" }])}.`

/** Where a land finds a unit's Rift: given, its implementor's (the ledger), or the one of the warm source's that reads as it. */
export type Found = { readonly found: UnitRift } | { readonly refused: string }

/**
 * A unit's Rift for a land, in order: the path the input gives, the Rift its implementor was started on (the
 * ledger's `rifts`, its last, when no other unit's start names it), else the one Rift of `lanes` that reads as the
 * unit. None, or two: refused, naming the unit, the Rifts and the `{ unit, path }` form.
 */
export const riftOfUnit = (asked: LandUnit, lanes: ReadonlyArray<Lane>, state: MachineState): Found => {
  if (!Predicate.isString(asked)) return { found: asked }
  const unit = asked
  // A unit the machine does not hold has no round to land: its land would pass by the machine, deciding nothing.
  if (Predicate.isUndefined(state.units[unit]))
    return { refused: `orchestrate: the machine holds no unit ${unit}: a unit is the machine's once its implementor starts. ${nowOf(state)}` }
  const owned = ownedOf(state)
  const started = Option.filter(Option.fromUndefinedOr(state.units[unit]?.rifts?.at(-1)), (path) =>
    Object.entries(owned).every(([other, rifts]) => other === unit || !rifts.includes(path)),
  )
  if (Option.isSome(started)) return { found: { unit, path: started.value } }
  return Arr.match(lanesOf(unit, lanes, state), {
    onEmpty: () => ({ refused: `orchestrate: no Rift of the warm source reads as ${unit}. ${nameItOf(unit, "<its Rift>")}` }),
    onNonEmpty: (found) =>
      Arr.match(Arr.drop(found, 1), {
        onEmpty: () => ({ found: { unit, path: Arr.headNonEmpty(found).path } }),
        onNonEmpty: () => ({ refused: `orchestrate: ${found.length} Rifts read as ${unit}: ${found.map((lane) => lane.path).join(", ")}. ${nameItOf(unit, Arr.headNonEmpty(found).path)}` }),
      }),
  })
}

const nameItOf = (unit: string, path: string) => `Name its Rift: ${landCallOf([{ unit, path }])}.`

/** The units a land takes: those named, else every ready unit. */
export const landUnitsOf = (input: OrchestrateInput, state: MachineState): ReadonlyArray<LandUnit> =>
  Option.getOrElse(Option.fromUndefinedOr(input.units), () => unitsIn(state, "ready"))

/** Each unit a land takes with its Rift, or the first refusal; `next`, the call a land of nothing names instead. */
export const resolveLand = (
  input: OrchestrateInput,
  lanes: ReadonlyArray<Lane>,
  state: MachineState,
  next: Next,
): { readonly rifts: ReadonlyArray<UnitRift> } | { readonly refused: string } => {
  const units = landUnitsOf(input, state)
  if (units.length === 0) return { refused: `orchestrate: no unit is ready to land. ${nowOf(state)} ${nextLine(next)}` }
  const rifts: Array<UnitRift> = []
  for (const unit of units) {
    const found = riftOfUnit(unit, lanes, state)
    if ("refused" in found) return found
    rifts.push(found.found)
  }
  return { rifts }
}

// ── The next call ──

/** The one next call: the action it is, its text, and why. */
export interface Next {
  readonly action: Action
  readonly call: string
  readonly why: string
}

const list = (units: ReadonlyArray<string>) => Arr.match(units, { onEmpty: () => "none", onNonEmpty: (named) => named.join(", ") })

/** The units in each state, said. */
const nowOf = (state: MachineState) =>
  `Now: ready ${list(unitsIn(state, "ready"))}; implementing ${list(unitsIn(state, "implement"))}; landed and not verified ${list(coverOf(state).filter((unit) => !unitsIn(state, "ready").includes(unit)))}.`

/**
 * The one call to make next in `state`: a running verifier's hand-back first, then a landed batch's verifier, then
 * the findings to fold, then a due batch's land, then the implementors' hand-backs, else a new lane. A land only
 * when a batch is due (`dueOf`) and nothing holds it; never while a verdict is pending.
 */
export const nextOf = (state: MachineState, now: number, cadence: Cadence): Next => {
  const verifier = Option.fromUndefinedOr(state.verifier)
  if (Option.isSome(verifier))
    return { action: "status", call: STATUS_CALL, why: `verifier ${verifier.value.batch} runs: its hand-back wakes you; call status then` }
  if (verdictPending(state)) return { action: "verify", call: verifyCallOf("batch-<k>"), why: `landed and not verified: ${list(coverOf(state))}; then its subagent call` }
  const debts = unresolvedOf(state)
  if (debts.length > 0)
    return { action: "status", call: STATUS_CALL, why: `the findings of ${debts.map(([batch]) => batch).join(", ")} are not known: read the report and make it readable, then fold them` }
  const unfolded = Arr.head(unfoldedOf(state, unitsIn(state, "ready")))
  if (Option.isSome(unfolded))
    return {
      action: "lane",
      call: laneCallOf(`${unitOfFinding(unfolded.value)}-fix1`),
      why: `fold ${unfolded.value}: start the lane's implementor with (folds: ${unfolded.value}), or fold it into a running implementor that owns its files`,
    }
  const due = Option.fromUndefinedOr(dueOf(state, now, cadence))
  if (Option.isSome(due)) return { action: "land", call: landCallOf([]), why: `a batch is due (${due.value}): ${list(unitsIn(state, "ready"))}` }
  const implementing = unitsIn(state, "implement")
  if (implementing.length > 0) return { action: "status", call: STATUS_CALL, why: `implementing ${list(implementing)}: their hand-backs wake you; call status then` }
  const ready = unitsIn(state, "ready")
  if (ready.length > 0) return { action: "status", call: STATUS_CALL, why: `ready ${list(ready)}, not due yet: the batch is due at ${cadence.ready} ready or when the oldest has waited ${Math.ceil(cadence.waitMs / 60_000)} min; set a timer for it` }
  return { action: "lane", call: laneCallOf("<unit>"), why: "start the next unit" }
}

/** The `next:` line of an answer. */
export const nextLine = (next: Next): string => `next: ${next.call} (${next.why}).`

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

/** A passed land's last line: the next call, this batch's verify. */
export const LAND_NEXT = `orchestrate: next: ${verifyCallOf("batch-<k>")}, this batch's verifier checkout, then the subagent call it answers.`

/** A land's answer: the rift land's own text, then the next call. */
export const landAnswer = (text: string): string => `${text}\n${LAND_NEXT}`

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

/** A verify with nothing landed awaiting a verifier. */
export const nothingToVerify = (state: MachineState, next: Next): string =>
  `orchestrate: verify has nothing to verify: no batch landed awaits a verifier. ${nowOf(state)} ${nextLine(next)}`

/** A root that runs no units, as status answers it. */
export const NO_UNITS = `orchestrate: this root runs no units; ${laneCallOf("<unit>")} starts one.`

/** Status: the machine's brief, each unit's lane with its unsaved work, and the next call. */
export const statusAnswer = (brief: string, lanes: ReadonlyArray<readonly [string, Option.Option<Lane>]>, next: Next): string =>
  [
    brief,
    ...Arr.match(lanes, {
      onEmpty: () => [],
      onNonEmpty: (each) => [
        "lanes:",
        ...each.map(([unit, lane]) =>
          Option.match(lane, { onNone: () => `- ${unit}: no Rift reads as it`, onSome: (found) => `- ${unit}: ${found.path} · head ${found.head} · ${found.state}` }),
        ),
      ],
    }),
    nextLine(next),
  ].join("\n")

/** Whether a root runs units: its machine holds a unit, a landed batch or a verifier. */
export const runsUnits = (state: MachineState): boolean => Object.keys(state.units).length > 0 || verdictPending(state)

/** The line a `rift` create or land in a root that runs units starts with: the `orchestrate` call to use. */
export const aliasLine = (action: "create" | "land"): string =>
  Match.value(action).pipe(
    Match.when("create", () => `orchestrate: this root runs units: make a unit's Rift with ${laneCallOf("<unit>")}, in place of rift create.`),
    Match.orElse(() => `orchestrate: this root runs units: land the batch with ${landCallOf([])}, in place of rift land.`),
  )

/** An `orchestrate` land whose execute finds no decision of the machine for its call: it never reaches the land. */
export const UNDECIDED = `orchestrate: this land has no decision of the machine; make the call again: ${landCallOf([])}.`
