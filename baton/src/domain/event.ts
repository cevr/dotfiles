// The facts a run records. Every view of a run, and every message baton
// sends, is derived from these: see `state.ts`.
import { Schema } from "effect"

/** A worker's seat in a track. The orchestrator is not a seat: it runs the run. */
export const Role = Schema.Literals(["impl", "rev", "ver"])
export type Role = typeof Role.Type

export const ReviewVerdict = Schema.Literals(["accepted", "changes", "stuck"])
export type ReviewVerdict = typeof ReviewVerdict.Type

export const VerifyVerdict = Schema.Literals(["pass", "fail", "stuck"])
export type VerifyVerdict = typeof VerifyVerdict.Type

export const AgentStatus = Schema.Literals(["idle", "working", "blocked", "done", "unknown"])
export type AgentStatus = typeof AgentStatus.Type

export const Agent = Schema.Struct({ name: Schema.String, pane: Schema.String })
export type Agent = typeof Agent.Type

/** Why a track stopped moving: its holder left, sits at a dialog, or went quiet. */
export const Stall = Schema.Literals(["gone", "dialog", "quiet"])
export type Stall = typeof Stall.Type

export const Event = Schema.TaggedUnion({
  /** An orchestrator took the run: the first start, or a new session resuming it. */
  RunStarted: { root: Schema.String, orchestrator: Agent },
  /** The orchestrator finished the run: its tracks are closed and its panes free. */
  RunEnded: {},
  /** A track's agents started; the implementor holds the baton, with the spec. */
  TrackOpened: {
    unit: Schema.String,
    cwd: Schema.String,
    tab: Schema.String,
    impl: Agent,
    rev: Agent,
    ver: Schema.OptionFromOptionalKey(Agent),
    spec: Schema.String,
    maxFailures: Schema.Int,
  },
  /** The implementor handed a round to review, at commit `head`. */
  RoundSubmitted: { unit: Schema.String, request: Schema.String, head: Schema.String },
  ReviewFiled: { unit: Schema.String, verdict: ReviewVerdict, findings: Schema.String },
  VerificationFiled: { unit: Schema.String, verdict: VerifyVerdict, report: Schema.String },
  /** A worker needs the orchestrator's decision before it can go on. */
  QuestionAsked: { unit: Schema.String, by: Role, note: Schema.String },
  /** The orchestrator told a worker something; that worker holds the baton. */
  NoteSent: { unit: Schema.String, to: Role, text: Schema.String },
  TrackClosed: { unit: Schema.String, merged: Schema.OptionFromOptionalKey(Schema.String) },
  /** herdr's agent states, recorded when they differ from the last record. */
  AgentsObserved: { statuses: Schema.Record(Schema.String, AgentStatus) },
  /** The watchdog found a track stuck at a step; `step` is that step's seq. */
  StallDetected: { unit: Schema.String, stall: Stall, step: Schema.Int },
  /** The message event `ref` implies is being sent. */
  DeliveryStarted: { ref: Schema.Int },
  /** That message reached its agent, or failed with herdr's reason. */
  DeliveryFinished: { ref: Schema.Int, failure: Schema.OptionFromOptionalKey(Schema.String) },
  /** Send a failed message again: the orchestrator asked, or herdr reported its recipient idle. */
  RedeliveryRequested: { ref: Schema.Int },
})
export type Event = typeof Event.Type

/** One recorded event: its place in the run's log and when it was recorded. */
export const Entry = Schema.Struct({ seq: Schema.Int, at: Schema.Int, event: Event })
export type Entry = typeof Entry.Type
