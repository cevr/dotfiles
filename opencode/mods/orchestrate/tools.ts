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

/** A verify of main is due after this many merges on it since the last one… */
export const VERIFY_EVERY = 5
/** …or once the last one is this old, with at least one merge since. */
export const VERIFY_MAX_AGE_MS = 24 * 3_600_000

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
    batch: Schema.optional(Schema.String).annotate({
      description: "verify: what the verifier is named for: `batch-<k>`, a unit, or `main-<sha>`. Default: main since the last verify, with its batch file written.",
    }),
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
export const REQUIRED = { status: [], lane: ["unit"], land: [], verify: [] } as const satisfies { readonly [A in Action]: ReadonlyArray<Field> }

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

/** The verify of main since the last verify. */
export const VERIFY_CALL = callOf("verify")

export const STATUS_CALL = callOf("status")

/** Each action's call that decodes, as a refusal names it. */
const EXAMPLES = {
  status: STATUS_CALL,
  lane: laneCallOf("<unit>"),
  land: landCallOf([]),
  verify: VERIFY_CALL,
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
  `verify: ${VERIFY_CALL} verifies main since the last verify, every ${VERIFY_EVERY} merges or ${VERIFY_MAX_AGE_MS / 3_600_000} h: it writes the batch file (base, head, the merges and units between them) into the run dir, makes the verifier's clean checkout, the Rift verify-<batch> detached at head (default: origin's default branch head, read then), and answers the one subagent call that starts it: subagent({ agent: "verifier", description: "verifier <batch> r1", prompt, background: true }). ${verifyCallOf("batch-7")} names a batch you wrote yourself.`,
  `status: ${STATUS_CALL} answers the run tables, each open unit's lane, and one next: line naming the call to make. Call it after a compaction, or whenever the next step is unclear. A land's and a status's answer start with a warning line when a verify is due.`,
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
  if (action === "verify" && Option.exists(Option.fromUndefinedOr(input.batch), (batch) => !UNIT_NAME.test(batch)))
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

/** The commit a land pushed, as the rift land's answer names it first (`Landed <n> Rift(s) as one push: <sha> …`); none when it pushed nothing. */
export const pushedOf = (text: string): Option.Option<string> => Option.fromNullishOr(/^Landed \d+ Rift\(s\) as one push: ([0-9a-f]{7,40})\b/m.exec(text)?.[1])

/** The round the run tables show for `unit` (its log's, 1 when it shows none); none when no table holds it. */
export const roundIn = (unit: string, runs: ReadonlyArray<Run>): Option.Option<number> =>
  Arr.findFirst(runs, (run) =>
    Option.map(Arr.findFirst(run.units, (each) => each.unit === unit), (each) => Option.getOrElse(Option.filter(Option.map(Option.fromUndefinedOr(each.round), Number), (n) => Number.isInteger(n) && n > 0), () => 1)),
  )

/** A land's answer: its warnings, the rift land's own text, then the verify to make. */
export const landAnswer = (warnings: ReadonlyArray<string>, text: string): string => [...warnings, text, LAND_NEXT].join("\n")

/** A land's last line: the verify of main, when it is due. */
export const LAND_NEXT = `orchestrate: next: ${VERIFY_CALL} once a verify of main is due, at ${VERIFY_EVERY} merges or ${VERIFY_MAX_AGE_MS / 3_600_000} h after the last one (a warning line says when), then the subagent call it answers.`

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

/** The one next step: its line, and the call it names when it names one. */
export interface Next {
  readonly line: string
  readonly input: Option.Option<OrchestrateInput>
}

/**
 * The one next step, from the derived run tables, the lanes and the default branch since the last verify: a land of
 * the units ready with a lane; else the verify of main when it is due; else the wait for the units implementing;
 * else none.
 */
export const nextOf = (runs: ReadonlyArray<Run>, lanes: ReadonlyArray<Lane>, workrift: boolean, since: Option.Option<MainSince> = Option.none(), now = 0): Next => {
  const ready = readyWithLane(runs, lanes, workrift)
  if (ready.length > 0) return { line: `next: ${landCallOf([])} (ready with a lane: ${ready.join(", ")}).`, input: Option.some({ action: "land" }) }
  const due = Option.filter(since, (each) => isDue(each, now))
  if (Option.isSome(due)) return { line: `next: ${VERIFY_CALL} (${mergesWords(due.value.merges)} on ${due.value.branch} since the last verify).`, input: Option.some({ action: "verify" }) }
  const implementing = unitsIn(runs, "implement")
  if (implementing.length > 0) return { line: `next: wait for the hand-backs of ${implementing.join(", ")} (implementing).`, input: Option.none() }
  return { line: "next: none (no unit is ready with a lane or implementing, and no verify is due).", input: Option.none() }
}

/** The one next line (`nextOf`'s). */
export const nextLine = (runs: ReadonlyArray<Run>, lanes: ReadonlyArray<Lane>, workrift: boolean, since: Option.Option<MainSince> = Option.none(), now = 0): string =>
  nextOf(runs, lanes, workrift, since, now).line

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

/** Status: the verify-due line when one is due, each run's units with their states and, for an open one, its lane; then the one next call. */
export const statusAnswer = (runs: ReadonlyArray<Run>, lanes: ReadonlyArray<Lane>, workrift: boolean, since: Option.Option<MainSince> = Option.none(), now = 0): string => {
  const held = runs.filter((run) => run.units.length > 0)
  const due = Option.toArray(Option.flatMap(since, (each) => dueWarning(each, now)))
  // No open unit: a due verify is still the next call.
  if (held.length === 0) return [...due, NO_UNITS, ...due.map(() => nextLine([], [], workrift, since, now))].join("\n")
  return [
    ...due,
    ...held.flatMap((run) => [
      `orchestrate: run ${run.name}:`,
      ...run.units.map((unit) => [`- ${unit.unit}: ${unit.state}`, ...Arr.filter([unit], isOpen).map((open) => laneText(lanesOf(open.unit, lanes, workrift)))].join(" · ")),
    ]),
    nextLine(held, lanes, workrift, since, now),
  ].join("\n")
}

// ── Main since the last verify ──

/** A verify the run dirs record: its batch file, the head it names, and when its findings' verdict was written. */
export interface Verified {
  readonly file: string
  readonly head: string
  readonly at: number
}

/** A first-parent merge on the default branch: its commit, its first parent and its subject. */
export interface Merge {
  readonly sha: string
  readonly parent: string
  readonly subject: string
}

/** The default branch since the last verify: its name, the merges on it since (newest first), and the base they count from. */
export interface MainSince {
  readonly branch: string
  readonly head: string
  readonly base: string
  readonly merges: number
  /** The last verify; none: none is recorded, and the base is the fifth first-parent merge before the head. */
  readonly last: Option.Option<Verified>
}

/** How many first-parent merges back the first verify starts, with none recorded. */
export const FIRST_VERIFY_BACK = VERIFY_EVERY

/**
 * Where the default branch's verify counts from: the last verified head; with none, the fifth first-parent merge
 * before the head (`newest` holds the head's newest merges, newest first, at least `FIRST_VERIFY_BACK + 1` when it
 * has them), else the first parent of the oldest one, else the head itself.
 */
export const verifyBaseOf = (head: string, last: Option.Option<Verified>, newest: ReadonlyArray<Merge>): string =>
  Option.match(last, {
    onSome: (verified) => verified.head,
    onNone: () =>
      Option.getOrElse(
        Option.orElse(
          Option.map(Arr.get(newest, FIRST_VERIFY_BACK), (merge) => merge.sha),
          () => Option.map(Arr.last(newest), (merge) => merge.parent),
        ),
        () => head,
      ),
  })

/** Whether a verify of main is due: `VERIFY_EVERY` merges since the last one, or one merge and the last is `VERIFY_MAX_AGE_MS` old. */
export const isDue = (since: MainSince, now: number): boolean =>
  since.merges >= VERIFY_EVERY || (since.merges >= 1 && Option.exists(since.last, (last) => now - last.at >= VERIFY_MAX_AGE_MS))

/** `count` and its noun, singular for one. */
const counted = (count: number, noun: string): string => `${count} ${noun}${"s".repeat(Number(count !== 1))}`

const mergesWords = (count: number): string => counted(count, "merge")

/** The line a land's and a status's answer start with when a verify is due; none when it is not. */
export const dueWarning = (since: MainSince, now: number): Option.Option<string> =>
  Option.liftPredicate(since, (each) => isDue(each, now)).pipe(
    Option.map(
      (due) =>
        `orchestrate: ${mergesWords(due.merges)} on ${due.branch} since the last verify (${Option.match(due.last, {
          onNone: () => `none recorded; counted from ${due.base.slice(0, 7)}, the fifth merge back`,
          onSome: (last) => `${last.head.slice(0, 7)}, ${Math.floor(Math.max(0, now - last.at) / 3_600_000)} h ago`,
        })}): ${VERIFY_CALL}.`,
    ),
  )

// ── A unit's files ──

/** A unit's newest request and findings, as its dir holds them. */
export interface UnitFiles {
  readonly unit: string
  readonly dir: string
  readonly request: Option.Option<{ readonly round: number; readonly path: string; readonly head: Option.Option<string> }>
  readonly findings: Option.Option<{ readonly round: number; readonly path: string; readonly verdict: Option.Option<string> }>
}

/** The head commit a request names: `Head: <sha>`, or the right side of `<base>..<head>` (the skill's request.ts `headOf`). */
export const requestHeadOf = (request: string): Option.Option<string> =>
  Option.orElse(Option.fromNullishOr(/\bhead\b[^\n]*?\b([0-9a-f]{7,40})\b/i.exec(request)?.[1]), () =>
    Option.fromNullishOr(/\b[0-9a-f]{7,40}\.\.([0-9a-f]{7,40})\b/.exec(request)?.[1]),
  )

/** The verdict a findings file's first non-blank line states, lowercased (the skill's status.ts `verdictOf`). */
export const findingsVerdictOf = (text: string): Option.Option<string> =>
  Option.map(Option.fromNullishOr(/\b(accepted|changes|stuck)\b/i.exec(Option.getOrElse(Arr.findFirst(text.split("\n"), (line) => line.trim() !== ""), () => ""))?.[1]), (verdict) => verdict.toLowerCase())

/** Whether a verifier's findings hold a verdict line: `verifier <batch> r<N>: <verdict>`, `Verdict: <verdict>`, or the verdict alone. */
export const holdsVerdict = (text: string): boolean => /^[\s>*#`_-]*(?:verifier\s+\S+\s+r\d+:\s*|verdict:\s*)?[*`_]*(accepted|changes|stuck)\b/im.test(text)

/** The head a batch file names: its `Head: <sha>`. */
export const batchHeadOf = (text: string): Option.Option<string> => Option.fromNullishOr(/\bHead: ([0-9a-f]{7,40})\b/.exec(text)?.[1])

/** The newest `round-N-<kind>.md` among a unit dir's file names: its round and name. */
export const newestRound = (names: ReadonlyArray<string>, kind: "request" | "findings"): Option.Option<{ readonly round: number; readonly name: string }> => {
  const pattern = new RegExp(`^round-(\\d+)-${kind}\\.md$`)
  return Arr.reduce(names, Option.none<{ readonly round: number; readonly name: string }>(), (found, name) =>
    Option.match(Option.fromNullishOr(pattern.exec(name)?.[1]), {
      onNone: () => found,
      onSome: (round) => Option.orElse(Option.filter(found, (each) => each.round >= Number(round)), () => Option.some({ round: Number(round), name })),
    }),
  )
}

/** Whether a file name in a `verify-*` dir is a batch file: `batch-*.md`, not its findings. */
export const isBatchFile = (name: string): boolean => /^batch-.+\.md$/.test(name) && !name.endsWith("-findings.md")

/** The findings file beside a batch file. */
export const findingsBeside = (batch: string): string => batch.replace(/\.md$/, "-findings.md")

/** The newest of the verifies, by when their verdict was written. */
export const newestVerified = (verifies: ReadonlyArray<Verified>): Option.Option<Verified> =>
  Arr.reduce(verifies, Option.none<Verified>(), (found, each) => Option.orElse(Option.filter(found, (best) => best.at >= each.at), () => Option.some(each)))

/** The `changes` verdict a land of the unit leaves open: its newest findings say `changes` and are not older than its newest request. */
export const openChanges = (files: UnitFiles): Option.Option<string> =>
  Option.flatMap(files.findings, (findings) =>
    Option.liftPredicate(
      findings.path,
      () => Option.contains(findings.verdict, "changes") && findings.round >= Option.getOrElse(Option.map(files.request, (request) => request.round), () => 0),
    ),
  )

/** The warning a land of a unit with a `changes` verdict open starts with; it lands. */
export const changesWarningOf = (unit: string, round: number, path: string): string =>
  `orchestrate: warning: ${unit} lands with r${round}'s changes verdict open (${path}).`

/** The land's warnings for the open `changes` verdicts of the units' files. */
export const changesWarnings = (files: ReadonlyArray<UnitFiles>): ReadonlyArray<string> =>
  files.flatMap((each) =>
    Option.toArray(
      Option.flatMap(openChanges(each), (path) => Option.map(each.findings, (findings) => changesWarningOf(each.unit, findings.round, path))),
    ),
  )

// ── A verify of main ──

/** The batch a verify of main at `head` is: `batch-main-<short head>`, its verifier `verifier batch-main-<short> r1`. */
export const mainVerifyName = (head: string): string => `batch-main-${head.slice(0, 7)}`

/** A unit a verify's range holds: its dir, the round of its request, its spec and its request. */
export interface RangeUnit {
  readonly unit: string
  readonly dir: string
  readonly round: number
  readonly spec: string
  readonly request: string
}

/** What a verify of main covers: its name, base and head (full), the merges between them, its units, and the fleet's heads when set. */
export interface MainBatch {
  readonly name: string
  readonly base: string
  readonly head: string
  /** How the base was chosen: the last verified head, or the fifth merge back with none recorded. */
  readonly last: Option.Option<Verified>
  readonly merges: ReadonlyArray<Merge>
  readonly units: ReadonlyArray<RangeUnit>
  readonly heads: Option.Option<{ readonly dotfiles: string; readonly fork: string }>
}

/**
 * The batch file a verify of main writes: `<run dir>/verify-main-<short>/batch-main-<short>.md`, the `<batch>.md` beside its
 * findings that git/fleet.ts `batchFileOf` reads when the verdict is accepted.
 */
export const mainBatchPathOf = (runDir: string, name: string): string => `${runDir.replace(/\/+$/, "")}/verify-${name.replace(/^batch-/, "")}/${name}.md`

/** The findings its verifier writes beside it. */
export const mainFindingsPathOf = (batchFile: string): string => batchFile.replace(/\.md$/, "-findings.md")

/** The batch file's text: `Base:` and `Head:` full, the fleet's `Heads:` line when set, the merges between them, and each unit in the range. */
export const mainBatchText = (batch: MainBatch): string =>
  [
    `# ${batch.name}`,
    "",
    `Base: ${batch.base}`,
    `Head: ${batch.head}`,
    ...Option.toArray(Option.map(batch.heads, (heads) => `Heads: dotfiles=${heads.dotfiles} fork=${heads.fork}`)),
    "",
    Option.match(batch.last, {
      onSome: (last) => `The base is the last verified head (${last.file}).`,
      onNone: () => "No verify is recorded in the run dirs: the base is the fifth first-parent merge before the head.",
    }),
    "",
    `## Merges (${batch.merges.length}, first parent, newest first)`,
    "",
    ...Arr.match(batch.merges, { onEmpty: () => ["- none"], onNonEmpty: (merges) => merges.map((merge) => `- ${merge.sha.slice(0, 10)} ${merge.subject}`) }),
    "",
    `## Units (${batch.units.length})`,
    "",
    ...Arr.match(batch.units, {
      onEmpty: () => ["- none: no unit's request head is in the range"],
      onNonEmpty: (units) => units.map((unit) => `- ${unit.unit} r${unit.round}: unit dir ${unit.dir}, spec ${unit.spec}, request ${unit.request}`),
    }),
    "",
  ].join("\n")

/**
 * The run dir a verify of main writes into: the one that holds a unit in its range; with none or several, the first
 * run kept outside a checkout's `tmp/orchestrate` (an `orchestrate.dir`), else the first run.
 */
export const mainRunDirOf = (runDirs: ReadonlyArray<string>, units: ReadonlyArray<RangeUnit>): Option.Option<string> => {
  const holding = runDirs.filter((dir) => units.some((unit) => unit.dir.startsWith(`${dir.replace(/\/+$/, "")}/`)))
  if (holding.length === 1) return Arr.head(holding)
  return Option.orElse(
    Arr.findFirst(runDirs, (dir) => !dir.includes("/tmp/orchestrate/")),
    () => Arr.head(runDirs),
  )
}

/** A verify of main's answer: what it covers, where its batch file is, its Rift, and the one subagent call last. */
export const mainVerifyAnswer = (batch: MainBatch, file: Option.Option<string>, lane: Lane, made: boolean, chosen: HeadChosen): string =>
  [
    `orchestrate: verify ${batch.name}: main ${batch.base.slice(0, 7)}..${batch.head.slice(0, 7)} (${Option.match(batch.last, {
      onSome: (last) => `since the last verified head, ${last.file}`,
      onNone: () => "no verify recorded: from the fifth first-parent merge before the head",
    })}), ${mergesWords(batch.merges.length)}, ${counted(batch.units.length, "unit")}.`,
    Option.match(file, {
      onSome: (path) => `Batch file written: ${path}.`,
      onNone: () => "No run dir is known, so no batch file was written; the verifier reads the range above.",
    }),
    `Its checkout: ${lane.path}, detached at ${lane.head} (${Match.value(chosen).pipe(
      Match.when("given", () => "the head you gave"),
      Match.orElse(() => "origin's default branch head, read now"),
    )})${Match.value(made).pipe(
      Match.when(true, () => "; made now."),
      Match.orElse(() => "; it existed, so nothing was made."),
    )}`,
    `Start its verifier, in that checkout: subagent({ agent: "verifier", description: "verifier ${batch.name} r1", prompt: ${quote(
      Option.match(file, {
        onSome: (path) => `Verify ${batch.name}: the batch file ${path}. Write your findings beside it, ${mainFindingsPathOf(path)}.`,
        onNone: () => `Verify ${batch.name}: main ${batch.base}..${batch.head}.`,
      }),
    )}, background: true }).`,
  ].join("\n")

/** What a compacted root that runs units is told: its status, and to re-read the skill and its plan. */
export const compactedNote = (status: string): string =>
  [status, "Re-read ~/.claude/skills/orchestrate/SKILL.md and protocol.md, and your plan, before any other action."].join("\n\n")

/** The notice row the compaction note draws. */
export const COMPACTED_DESCRIPTION = "orchestrate: your run, after the compaction"
