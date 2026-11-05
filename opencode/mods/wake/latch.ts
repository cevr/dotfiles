// Latches: a subagent start that orchestrate's pace or the Sabbath holds,
// kept as a wake of its own kind. The latch is the parent's: it lists and
// cancels with the parent's other wakes and survives a restart or downtime
// the way an alarm does. Its child session is made when it latches, with no
// prompt, so the parent's rows show it waiting. At its time the wakes ask the
// opener (orchestrate, over `OPENER`) to decide the start again: still held
// re-latches with the new reason and time, admitted starts the subagent in
// the background, and its answer wakes the parent as any background
// subagent's does. The wakes write the child's `latch` metadata (`Mark`),
// which the subagent rows read; nothing else writes it.
import { Schema } from "effect"

/** What holds the start: an account's pace, or the Sabbath. */
export const Hold = Schema.Literals(["pace", "sabbath"])
export type Hold = typeof Hold.Type

/** The subagent call as it was routed when it latched, and the call that asked for it. */
export const Ask = Schema.Struct({
  agent: Schema.String,
  description: Schema.String,
  prompt: Schema.String,
  /** `provider/id#variant`, when the call runs on a model of its own. */
  model: Schema.optional(Schema.String),
  /** The agent that made the call. */
  from: Schema.String,
  messageID: Schema.String,
  callID: Schema.String,
})
export type Ask = typeof Ask.Type

export const Latch = Schema.Struct({
  kind: Schema.Literal("latch"),
  /** `w` and six base-36 characters, as every wake's. */
  id: Schema.String,
  /** The parent: the session that asked, whose wakes list it and whom the subagent's answer wakes. */
  sessionID: Schema.String,
  /** The directory whose server arms it. */
  directory: Schema.String,
  /** Epoch ms: when it latched. */
  setAt: Schema.Number,
  /** The child session made for it, not yet prompted. */
  child: Schema.String,
  subagent: Ask,
  hold: Hold,
  /** Why it is held, in the hold's own words. */
  reason: Schema.String,
  /** Epoch ms: when the hold says it opens. The OS backstop is set for it. */
  opensAt: Schema.Number,
  /** Epoch ms: when it is decided again; at or before `opensAt` (a pace that may open early is asked sooner). */
  recheckAt: Schema.Number,
  /** The opener's own, kept as it gave it and handed back on each open. */
  context: Schema.Record(Schema.String, Schema.Json),
})
export type Latch = typeof Latch.Type

/** The child session's metadata key the wakes keep a latch's state under. */
export const MARK_KEY = "latch"

/**
 * A latched child's state, as its session's metadata carries it under
 * `MARK_KEY`: what holds it, why, when it opens, when it latched, and, once
 * it will not open, when it was cancelled or why it failed. A child that
 * opened carries none.
 */
export const Mark = Schema.Struct({
  hold: Hold,
  reason: Schema.String,
  opensAt: Schema.Number,
  at: Schema.Number,
  cancelledAt: Schema.optional(Schema.Number),
  failed: Schema.optional(Schema.String),
})
export type Mark = typeof Mark.Type

export const markOf = (latch: Latch): Mark => ({ hold: latch.hold, reason: latch.reason, opensAt: latch.opensAt, at: latch.setAt })

// ── Latching ──

/** What the opener asks the wakes to latch: the parent, the call, the hold and its times, and its own context. */
export const LatchAsk = Schema.Struct({
  sessionID: Schema.String,
  subagent: Ask,
  hold: Hold,
  reason: Schema.String,
  opensAt: Schema.Number,
  recheckAt: Schema.Number,
  context: Schema.Record(Schema.String, Schema.Json),
})
export type LatchAsk = typeof LatchAsk.Type

/** What `latch` answers: the latch's id and child, or why the wakes would not keep it. */
export const Latched = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("latched"), id: Schema.String, child: Schema.String }),
  Schema.Struct({ outcome: Schema.Literal("refused"), reason: Schema.String }),
])
export type Latched = typeof Latched.Type

// ── Opening ──

/**
 * What an open decided: `opened` (the subagent started, or had started
 * before), `held` (still held: the new hold, reason and times), or `failed`
 * (it cannot start; `message` says why).
 */
export const Opened = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("opened") }),
  Schema.Struct({ outcome: Schema.Literal("held"), hold: Hold, reason: Schema.String, opensAt: Schema.Number, recheckAt: Schema.Number }),
  Schema.Struct({ outcome: Schema.Literal("failed"), message: Schema.String }),
])
export type Opened = typeof Opened.Type

/**
 * The opener's RPC, which the wakes call and the opener serves (orchestrate
 * registers it). `open(Latch)`: decide the latched start again and, admitted,
 * start it; answers `Opened`. Opening a child that already started answers
 * `opened` and prompts nothing.
 */
export const OPENER = {
  id: "dotfiles-opencode.wake.opener",
  methods: {
    open: { input: { type: "object" }, output: { type: "object" } },
  },
  events: {},
} as const
