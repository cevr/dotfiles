// An idle root with ready work: the IdleRoot aggregate, one per root
// session that owns an orchestrate run. When such a root ends its turn with
// nothing of its own still going (no subagent or shell running under it, no
// wake, monitor or latch set), while its runs hold units in plan, implement
// or verify, it is steered once with one line: `idle with units ready:
// <units>; start them or name what you wait on.` (`lineOf`).
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
export const READY_STATES = ["plan", "implement", "verify"] as const

/** One unit of a run the root owns, in a state the root moves. */
export const ReadyUnit = Schema.Struct({ run: Schema.String, unit: Schema.String, state: Schema.String })
export interface ReadyUnit extends Schema.Schema.Type<typeof ReadyUnit> {}

/** One unit of an orchestrate run, as the status script derives it. */
export interface RunUnit {
  readonly unit: string
  readonly state: string
}

/** One orchestrate run: its directory's name and its units. */
export interface Run {
  readonly name: string
  readonly units: ReadonlyArray<RunUnit>
}

/** The unit a step's description names: the first word after the role (described.ts's `rest`). */
export const unitOf = (rest: string): string | undefined => rest.trim().split(/\s+/)[0] || undefined

/**
 * The units of the runs `started` (the units whose steps the root started)
 * makes the root's, in a state the root moves, in the runs' order.
 */
export const readyUnits = (runs: ReadonlyArray<Run>, started: ReadonlyArray<string>): ReadonlyArray<ReadyUnit> =>
  runs
    .filter((run) => run.units.some((unit) => started.includes(unit.unit)))
    .flatMap((run) =>
      run.units
        .filter((unit) => (READY_STATES as ReadonlyArray<string>).includes(unit.state))
        .map((unit) => ({ run: run.name, unit: unit.unit, state: unit.state })),
    )

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
export const unitList = (units: ReadonlyArray<ReadyUnit>): string => {
  const runs = new Set(units.map((unit) => unit.run))
  const names = units.map((unit) => (runs.size > 1 ? `${unit.run}/${unit.unit}` : unit.unit))
  const listed = names.slice(0, LISTED).join(", ")
  return names.length > LISTED ? `${listed} and ${names.length - LISTED} more` : listed
}

/** The one line the root is steered with. */
export const lineOf = (units: ReadonlyArray<ReadyUnit>): string =>
  `idle with units ready: ${unitList(units)}; start them or name what you wait on.`

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

/** The root was steered with `line`, naming `units`. */
export const Nudged = Schema.TaggedStruct("Nudged", { units: Schema.Array(ReadyUnit), line: Schema.String })
export interface Nudged extends Schema.Schema.Type<typeof Nudged> {}

export type Event = WentIdle | Heard | DraftSeen | DraftCleared | Nudged

/** Why a root was not nudged, in the order they are checked. */
export const Why = Schema.Literals(["working", "nudged", "background", "drafting", "sabbath", "nothing-ready", "wake", "question", "wait-named"])
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

/** What holds the nudge back in what was gathered. */
const heldBy = (nudge: Nudge): NotNudged | undefined => {
  if (nudge.resting) return new NotNudged({ why: "sabbath", detail: "no agent starts over the Sabbath" })
  if (nudge.ready.length === 0) return new NotNudged({ why: "nothing-ready", detail: "no run of its holds a unit in plan, implement or verify" })
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
          const held = heldBack(state, now) ?? heldBy(command)
          if (held !== undefined) return yield* held
          return [Nudged.make({ units: command.ready, line: lineOf(command.ready) })]
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
