// An idle root with work to do: the IdleRoot aggregate, one per root
// session that owns an orchestrate run. When such a root ends its turn with
// nothing of its own still going (no subagent or shell running under it, no
// wake, monitor or latch set), while its runs hold units in plan, implement
// or verify, or units in `ready` whose batch is due (by each unit's cadence:
// its spec's `Batch cadence`, else its plan's, else `BATCH_SIZE` of them or
// the oldest in `ready` for `BATCH_WAIT_MS`, by its log.md time), it is
// steered once with one line (`lineOf`): `idle with units in plan, implement
// or verify: <units>; start them or name what you wait on.`, and for a due
// batch `… batch due (<why>): <units>; land it with rift({ action: "land",
// rifts: [...] }).`
//
// Once per idle period: after a nudge, the root is not nudged again until new
// input reaches it (the owner's prompt, a wake, a worker's notice; never the
// nudge itself). Never while the owner drafts a prompt to it (a composer
// holding text, as the orchestrate TUI plugin reports, `IDLE`), never while
// a question to the owner is open (a background question, or a `needs-you`
// item in its queue), and never once it has named what it waits on (a
// `waiting` item in its queue, which the sidebar shows). Over the Sabbath no
// agent starts, so none is nudged then. A draft that ends with no new input
// decides the idle period again.
//
// A root owns a run when it started a step (`<role> <unit> r<N>`, described.ts)
// of one of the run's units; the run's units and their states are the
// orchestrate skill's status script's, as the status mod reads them.
import { Effect, Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"

// ── The facts ──

/** The unit states a root moves on its own: a unit in one of them that nothing works on waits for the root. */
export const MOVING_STATES = ["plan", "implement", "verify"] as const

/** The state an accepted unit waits in until its batch lands. */
export const READY = "ready"

/** A batch is due once this many units are ready (the skill's default cadence). */
export const BATCH_SIZE = 3

/** Or once the oldest ready unit has waited this long. */
export const BATCH_WAIT_MS = 30 * 60_000

/**
 * A unit's batch cadence: its batch is due once `ready` units are ready, or
 * once it has waited `waitMs` in `ready`. The status script derives it from
 * the unit's spec.md `Batch cadence` line over the plan.md one over the
 * skill's default (`BATCH_SIZE`, `BATCH_WAIT_MS`).
 */
export const Cadence = Schema.Struct({ ready: Schema.Number, waitMs: Schema.Number })
export interface Cadence extends Schema.Schema.Type<typeof Cadence> {}

/** The skill's default cadence: 3 ready or 30 min. */
export const DEFAULT_CADENCE: Cadence = { ready: BATCH_SIZE, waitMs: BATCH_WAIT_MS }

/** One unit of a run the root owns, in a state the root moves. */
export const MovingUnit = Schema.Struct({ run: Schema.String, unit: Schema.String, state: Schema.String })
export interface MovingUnit extends Schema.Schema.Type<typeof MovingUnit> {}

/**
 * One unit of a run the root owns, in `ready`, with when it got there (epoch
 * ms; none when its log has no time that reads) and its cadence (none: the
 * default).
 */
export const ReadyUnit = Schema.Struct({ run: Schema.String, unit: Schema.String, since: Schema.optional(Schema.Number), cadence: Schema.optional(Cadence) })
export interface ReadyUnit extends Schema.Schema.Type<typeof ReadyUnit> {}

/**
 * One unit of an orchestrate run, as the status script derives it: `since` is
 * its log.md time for that state, `cadence` its batch cadence as the script
 * prints it (`3 ready or 30 min`).
 */
export interface RunUnit {
  readonly unit: string
  readonly state: string
  readonly since?: string
  readonly cadence?: string
}

/** One orchestrate run: its directory's name and its units. */
export interface Run {
  readonly name: string
  readonly units: ReadonlyArray<RunUnit>
}

/** The unit a step's description names: the first word after the role (described.ts's `rest`). */
export const unitOf = (rest: string): string | undefined => rest.trim().split(/\s+/)[0] || undefined

/** A log.md time (`2026-11-06T10:00Z`, as log.ts writes it; a time with no zone is UTC) in epoch ms, or none. */
export const sinceOf = (since: string | undefined): number | undefined => {
  if (since === undefined || since.trim() === "") return undefined
  const at = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(since.trim()) ? since.trim() : `${since.trim()}Z`)
  return Number.isNaN(at) ? undefined : at
}

/** The status script's cadence (`3 ready or 30 min`) as a Cadence, or none when it prints none that reads. */
export const cadenceOf = (cadence: string | undefined): Cadence | undefined => {
  const match = cadence === undefined ? null : /^\s*(\d+) ready or (\d+) min\s*$/.exec(cadence)
  return match === null ? undefined : { ready: Math.max(1, Number(match[1])), waitMs: Number(match[2]) * 60_000 }
}

/** What the root's runs hold for it: units in a state it moves, and units in `ready`. */
export interface RootUnits {
  readonly moving: ReadonlyArray<MovingUnit>
  readonly ready: ReadonlyArray<ReadyUnit>
}

/**
 * The units of the runs `started` (the units whose steps the root started)
 * makes the root's, in the runs' order: those in a state the root moves, and
 * those in `ready`.
 */
export const unitsOf = (runs: ReadonlyArray<Run>, started: ReadonlyArray<string>): RootUnits => {
  const owned = runs.filter((run) => run.units.some((unit) => started.includes(unit.unit)))
  return {
    moving: owned.flatMap((run) =>
      run.units
        .filter((unit) => (MOVING_STATES as ReadonlyArray<string>).includes(unit.state))
        .map((unit) => ({ run: run.name, unit: unit.unit, state: unit.state })),
    ),
    ready: owned.flatMap((run) =>
      run.units
        .filter((unit) => unit.state === READY)
        .map((unit) => {
          const since = sinceOf(unit.since)
          const cadence = cadenceOf(unit.cadence)
          return { run: run.name, unit: unit.unit, ...(since === undefined ? {} : { since }), ...(cadence === undefined ? {} : { cadence }) }
        }),
    ),
  }
}

/**
 * Why the ready units' batch is due now (`3 ready`, `alpha ready 42 min`), or
 * none while it is not: some ready unit's cadence is met, by the count of
 * ready units or by how long it has waited (the longest-waiting such unit is
 * named).
 */
export const batchDue = (ready: ReadonlyArray<ReadyUnit>, now: number): string | undefined => {
  if (ready.some((unit) => ready.length >= (unit.cadence ?? DEFAULT_CADENCE).ready)) return `${ready.length} ready`
  const waited = ready.flatMap((unit) =>
    unit.since !== undefined && now - unit.since >= (unit.cadence ?? DEFAULT_CADENCE).waitMs ? [{ unit, since: unit.since }] : [],
  )
  const oldest = waited.reduce<(typeof waited)[number] | undefined>((min, next) => (min === undefined || next.since < min.since ? next : min), undefined)
  if (oldest === undefined) return undefined
  return `${oldest.unit.unit} ready ${Math.floor((now - oldest.since) / 60_000)} min`
}

/**
 * The Rift a ready unit lives in, as `rift({ action: "land" })` takes it: the
 * orchestrator makes each unit's Rift named after the unit, on branch
 * `<run>/<unit>` (SKILL.md, plan), and the tool finds a Rift by its name.
 */
export const riftOf = (unit: { readonly run: string; readonly unit: string }): string => unit.unit

/** What else holds the root, from the other plugins: wakes, questions to the owner, and its queue. */
export const Holds = Schema.Struct({
  /** Its alarms, monitors and latches. */
  wakes: Schema.Number,
  /** Its open background questions. */
  questions: Schema.Number,
  /** Its queue's `needs-you` items. */
  needsYou: Schema.Array(Schema.String),
  /** Its queue's `waiting` items: the waits it named. */
  waits: Schema.Array(Schema.String),
})
export interface Holds extends Schema.Schema.Type<typeof Holds> {}

/** No holds: what a root with no other plugin's state has. */
export const NO_HOLDS: Holds = { wakes: 0, questions: 0, needsYou: [], waits: [] }

// ── The line ──

/** At most this many units are named; the rest are counted. */
export const LISTED = 8

/** The units as the line names them: `unit`, or `run/unit` when they come from more than one run. */
export const unitList = (units: ReadonlyArray<{ readonly run: string; readonly unit: string }>): string => {
  const runs = new Set(units.map((unit) => unit.run))
  const names = units.map((unit) => (runs.size > 1 ? `${unit.run}/${unit.unit}` : unit.unit))
  const listed = names.slice(0, LISTED).join(", ")
  return names.length > LISTED ? `${listed} and ${names.length - LISTED} more` : listed
}

/** What the root is steered to do: start the units it moves, and land a due batch (`why` it is due). */
export interface Due {
  readonly moving: ReadonlyArray<MovingUnit>
  readonly landing?: { readonly units: ReadonlyArray<ReadyUnit>; readonly why: string }
}

/** The land call for the batch: every ready unit's Rift, in the runs' order. */
export const landCall = (units: ReadonlyArray<ReadyUnit>): string =>
  `rift({ action: "land", rifts: [${units.map((unit) => JSON.stringify(riftOf(unit))).join(", ")}] })`

/** The one line the root is steered with. */
export const lineOf = ({ moving, landing }: Due): string => {
  const move = `units in plan, implement or verify: ${unitList(moving)}; start them or name what you wait on.`
  const land = landing === undefined ? "" : `batch due (${landing.why}): ${unitList(landing.units)}; land it with ${landCall(landing.units)}.`
  if (moving.length === 0) return `idle with a ${land}`
  return landing === undefined ? `idle with ${move}` : `idle with ${move} A ${land}`
}

/** The nudge's metadata key: a nudge carries it, so its arrival is not new input. */
export const MARK = "dotfiles-opencode.orchestrate.idle"

// ── The aggregate ──

/** Where the root is: working on input, idle since its last turn, or idle and nudged once already. */
export const Phase = Schema.Literals(["active", "idle", "nudged"])
export type Phase = typeof Phase.Type

export interface IdleRootState {
  readonly phase: Phase
  /** The background work still running when it last went idle: its subagents and shells, and its descendants'. */
  readonly background: number
  /** Each owner's TUI that reports a draft to this root, with when it last did (epoch ms). */
  readonly drafts: Readonly<Record<string, number>>
}

/** A draft not reported again within this has gone: a TUI that quit leaves no draft behind. */
export const DRAFT_TTL_MS = 30_000

/** The root ended its turn with no input pending; `background` is what still runs for it. */
export const GoIdle = Schema.TaggedStruct("GoIdle", { background: Schema.Number })
export interface GoIdle extends Schema.Schema.Type<typeof GoIdle> {}

/** New input reached the root: the owner's prompt, a wake, a notice. */
export const Hear = Schema.TaggedStruct("Hear", {})
export interface Hear extends Schema.Schema.Type<typeof Hear> {}

/** An owner's TUI says whether its composer holds a draft to the root. */
export const ReportDraft = Schema.TaggedStruct("ReportDraft", { client: Schema.String, drafting: Schema.Boolean })
export interface ReportDraft extends Schema.Schema.Type<typeof ReportDraft> {}

/** Steer the idle root, with what was gathered about it. */
export const Nudge = Schema.TaggedStruct("Nudge", {
  moving: Schema.Array(MovingUnit),
  ready: Schema.Array(ReadyUnit),
  holds: Holds,
  /** The Sabbath holds every agent start. */
  resting: Schema.Boolean,
})
export interface Nudge extends Schema.Schema.Type<typeof Nudge> {}

export type Command = GoIdle | Hear | ReportDraft | Nudge

export const WentIdle = Schema.TaggedStruct("WentIdle", { background: Schema.Number })
export interface WentIdle extends Schema.Schema.Type<typeof WentIdle> {}

export const Heard = Schema.TaggedStruct("Heard", {})
export interface Heard extends Schema.Schema.Type<typeof Heard> {}

export const DraftSeen = Schema.TaggedStruct("DraftSeen", { client: Schema.String, at: Schema.Number })
export interface DraftSeen extends Schema.Schema.Type<typeof DraftSeen> {}

export const DraftCleared = Schema.TaggedStruct("DraftCleared", { client: Schema.String })
export interface DraftCleared extends Schema.Schema.Type<typeof DraftCleared> {}

/** The root was steered with `line`, naming the units it moves and the batch it lands (none when not due). */
export const Nudged = Schema.TaggedStruct("Nudged", { moving: Schema.Array(MovingUnit), landing: Schema.Array(ReadyUnit), line: Schema.String })
export interface Nudged extends Schema.Schema.Type<typeof Nudged> {}

export type Event = WentIdle | Heard | DraftSeen | DraftCleared | Nudged

/** Why a root was not nudged, in the order they are checked. */
export const Why = Schema.Literals(["working", "nudged", "background", "drafting", "sabbath", "nothing-due", "wake", "question", "wait-named"])
export type Why = typeof Why.Type

/** The root is not nudged now, and why, with the evidence. */
export class NotNudged extends Schema.TaggedError<NotNudged>()("NotNudged", { why: Why, detail: Schema.String }) {}

/** Whether a TUI reports a draft to the root now. */
export const drafting = (state: IdleRootState, now: number): boolean => Object.values(state.drafts).some((at) => now - at < DRAFT_TTL_MS)

/**
 * What holds the nudge back on the root's own state alone, before anything is
 * gathered: it is working, was nudged this idle period, still has work
 * running, or its owner drafts a prompt to it.
 */
export const heldBack = (state: IdleRootState, now: number): NotNudged | undefined => {
  if (state.phase === "active") return new NotNudged({ why: "working", detail: "new input came after it went idle" })
  if (state.phase === "nudged") return new NotNudged({ why: "nudged", detail: "nudged once this idle period" })
  if (state.background > 0) return new NotNudged({ why: "background", detail: `${state.background} subagent or shell still running` })
  if (drafting(state, now)) return new NotNudged({ why: "drafting", detail: "the owner is writing to it" })
  return undefined
}

/** What the root is steered to do now, from what was gathered: nothing when no unit waits on it and no batch is due. */
export const dueOf = (nudge: Pick<Nudge, "moving" | "ready">, now: number): Due | undefined => {
  const why = batchDue(nudge.ready, now)
  if (nudge.moving.length === 0 && why === undefined) return undefined
  return why === undefined ? { moving: nudge.moving } : { moving: nudge.moving, landing: { units: nudge.ready, why } }
}

/** Why nothing is due: no unit to move, and the ready units (if any) short of the cadence. */
const nothingDue = (ready: ReadonlyArray<ReadyUnit>, now: number): NotNudged => {
  const base = "no run of its holds a unit in plan, implement or verify"
  if (ready.length === 0) return new NotNudged({ why: "nothing-due", detail: base })
  const times = ready.flatMap((unit) => (unit.since === undefined ? [] : [unit.since]))
  const oldest = times.length === 0 ? "" : `, the oldest for ${Math.floor((now - Math.min(...times)) / 60_000)} min`
  // The soonest any ready unit's cadence comes due: its smallest count and its shortest wait.
  const cadences = ready.map((unit) => unit.cadence ?? DEFAULT_CADENCE)
  const size = Math.min(...cadences.map((cadence) => cadence.ready))
  const wait = Math.min(...cadences.map((cadence) => cadence.waitMs))
  return new NotNudged({
    why: "nothing-due",
    detail: `${base}, and its batch is not due: ${ready.length} ready${oldest} (due at ${size} or ${wait / 60_000} min)`,
  })
}

/** What holds the nudge back in what was gathered. */
const heldBy = (nudge: Nudge, due: Due | undefined, now: number): NotNudged | undefined => {
  if (nudge.resting) return new NotNudged({ why: "sabbath", detail: "no agent starts over the Sabbath" })
  if (due === undefined) return nothingDue(nudge.ready, now)
  const { holds } = nudge
  if (holds.wakes > 0) return new NotNudged({ why: "wake", detail: `${holds.wakes} wake, monitor or latch set` })
  if (holds.questions > 0 || holds.needsYou.length > 0)
    return new NotNudged({ why: "question", detail: [...(holds.questions > 0 ? [`${holds.questions} open question`] : []), ...holds.needsYou].join("; ") })
  if (holds.waits.length > 0) return new NotNudged({ why: "wait-named", detail: holds.waits.join("; ") })
  return undefined
}

export const IdleRoot: Decider<IdleRootState, Command, Event, NotNudged> = {
  initial: { phase: "active", background: 0, drafts: {} },
  decide: (state, command, now) =>
    Effect.gen(function* () {
      switch (command._tag) {
        case "GoIdle":
          return [WentIdle.make({ background: command.background })]
        case "Hear":
          return state.phase === "active" ? [] : [Heard.make({})]
        case "ReportDraft":
          if (command.drafting) return [DraftSeen.make({ client: command.client, at: now })]
          return command.client in state.drafts ? [DraftCleared.make({ client: command.client })] : []
        case "Nudge": {
          const back = heldBack(state, now)
          if (back !== undefined) return yield* back
          const due = dueOf(command, now)
          const held = heldBy(command, due, now)
          if (held !== undefined) return yield* held
          if (due === undefined) return yield* nothingDue(command.ready, now)
          return [Nudged.make({ moving: due.moving, landing: due.landing?.units ?? [], line: lineOf(due) })]
        }
      }
    }),
  evolve: (state, event) => {
    switch (event._tag) {
      case "WentIdle":
        // Going idle again after a nudge stays nudged: only new input opens a new idle period.
        return { ...state, phase: state.phase === "nudged" ? "nudged" : "idle", background: event.background }
      case "Heard":
        return { ...state, phase: "active" }
      case "DraftSeen":
        return { ...state, drafts: { ...state.drafts, [event.client]: event.at } }
      case "DraftCleared": {
        const { [event.client]: _, ...drafts } = state.drafts
        return { ...state, drafts }
      }
      case "Nudged":
        return { ...state, phase: "nudged" }
    }
  },
}

// ── The RPC the TUI reports drafts over ──

/**
 * The idle roots' RPC.
 * - `draft({ sessionID, client, drafting })`: the owner's TUI `client` says
 *   whether its composer holds text while it shows the root `sessionID`;
 *   while it does, it says so again at least every `DRAFT_TTL_MS`.
 */
export const IDLE = {
  id: "dotfiles-opencode.orchestrate.idle",
  methods: {
    draft: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, client: { type: "string" }, drafting: { type: "boolean" } },
        required: ["sessionID", "client", "drafting"],
      },
      output: { type: "object" },
    },
  },
  events: {},
} as const

/** What `draft` takes. */
export const Draft = Schema.Struct({ sessionID: Schema.String, client: Schema.String, drafting: Schema.Boolean })
export type Draft = typeof Draft.Type

// ── What the TUI reports ──

/** While a draft stays, the TUI says so again this often: well within `DRAFT_TTL_MS`. */
export const HEARTBEAT_MS = 10_000

/** What the TUI last reported: the root its draft was to, and when. */
export interface Reported {
  readonly sessionID: string
  readonly at: number
}

/** What the TUI sees now: the root session on screen, if any, and whether its composer holds text. */
export interface Seen {
  readonly sessionID: string | undefined
  readonly drafting: boolean
}

/**
 * The reports the TUI sends now, given the draft it last reported (none when
 * it has no draft out) and what it sees: a draft that ended, or moved to
 * another root, is cleared; a new or lasting one is reported, again each
 * `HEARTBEAT_MS`. Nothing changed and not yet due sends nothing.
 */
export const reportsOf = (last: Reported | undefined, seen: Seen, now: number): ReadonlyArray<Omit<Draft, "client">> => {
  const target = seen.drafting ? seen.sessionID : undefined
  const clear = last !== undefined && last.sessionID !== target ? [{ sessionID: last.sessionID, drafting: false }] : []
  const due = target !== undefined && (last === undefined || last.sessionID !== target || now - last.at >= HEARTBEAT_MS)
  return due ? [...clear, { sessionID: target, drafting: true }] : clear
}
