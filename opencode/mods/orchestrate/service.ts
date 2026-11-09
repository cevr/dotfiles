// The contracts the orchestrate model needs from outside, each with what its
// implementations owe (laws.ts). Implementations live in the folders named
// after their dependency: filestore/, opencode/, codex/ and memory/.
import { Context, type Effect, Schema } from "effect"
import type { CallLine } from "./call-line.ts"
import type { Holds, Run } from "./idle.ts"
import type { ModelRef, PaceReply } from "./pace.ts"
import type { Entry } from "./restart.ts"
import type { Relation } from "./skill-drift.ts"
import type { Hold } from "./tool-call.ts"
import type { Transition } from "./unit-log.ts"

/** Where the call log's lines go, in order. Appending never fails: a lost line costs the pane a row, not the call. */
export class CallLog extends Context.Service<
  CallLog,
  { readonly append: (line: CallLine) => Effect.Effect<void> }
>()("dotfiles-opencode/orchestrate/CallLog") {}

/**
 * The units' logs (each `<run dir>/<unit>/log.md`), written through the orchestrate skill's log.ts.
 * - `find`: the unit's dir: the first of `named` (paths the prompt or the hand-back named, maybe relative to
 *   `directory` or `~/`) that is a unit dir, else the one `<directory>/tmp/orchestrate/<run>/<unit>` unit dir
 *   there is. A unit dir is a directory that holds a `spec.md` or a `log.md`, or whose parent (its run dir)
 *   holds a `plan.md`; any other directory named for the unit (a Rift or a checkout called like it) is none,
 *   so no log.md lands in it. None when neither finds exactly one.
 * - `append`: move the unit as the transition says, from its current state; a move already logged, or one
 *   log.ts refuses, writes nothing. Never fails: a lost line costs the timing a row, not the call.
 */
export class UnitLogs extends Context.Service<
  UnitLogs,
  {
    readonly find: (input: { readonly unit: string; readonly named: ReadonlyArray<string>; readonly directory?: string }) => Effect.Effect<string | undefined>
    readonly append: (unitDir: string, transition: Transition) => Effect.Effect<void>
  }
>()("dotfiles-opencode/orchestrate/UnitLogs") {}

/** What the host knows about a session. A session it cannot read answers undefined. */
export class Sessions extends Context.Service<
  Sessions,
  {
    /** The session's parent: set for a subagent's session. */
    readonly parentOf: (sessionID: string) => Effect.Effect<string | undefined>
    /** The agent the session runs as. */
    readonly agentOf: (sessionID: string) => Effect.Effect<string | undefined>
    /** Whether the session has run a turn, or is running one. A session it cannot read has not. */
    readonly startedOf: (sessionID: string) => Effect.Effect<boolean>
    /** When the session, a latched child that will still open, opens (epoch ms); none once it opened, was cancelled or failed. */
    readonly latchOf: (sessionID: string) => Effect.Effect<number | undefined>
    /** The directory the session works in. */
    readonly directoryOf: (sessionID: string) => Effect.Effect<string | undefined>
    /** The text of the session's last answer: its newest assistant message's text parts, joined. */
    readonly lastWordsOf: (sessionID: string) => Effect.Effect<string | undefined>
  }
>()("dotfiles-opencode/orchestrate/Sessions") {}

/** A model the host offers: the variants it runs at, its family (such as `gpt-sol`), release (epoch ms) and status. */
export interface Offered extends ModelRef {
  readonly variants: ReadonlyArray<{ readonly id: string }>
  readonly family?: string
  readonly time?: { readonly released: number }
  readonly status?: string
}

/** The models a new subagent of a session could run on. Anything the host cannot answer is undefined. */
export class Models extends Context.Service<
  Models,
  {
    /**
     * The model an agent started from the session runs on, in the subagent
     * tool's order: the agent's own, else the session's, else the default.
     */
    readonly base: (sessionID: string, agentID: string) => Effect.Effect<ModelRef | undefined>
    /** That model at `variant` (`provider/id#variant`), when the model offers it. */
    readonly variant: (sessionID: string, agentID: string, variant: string) => Effect.Effect<string | undefined>
    /**
     * The newest model of `family` (such as `gpt-sol`) on one of `providers`
     * the session's host offers, as `provider/id#variant`, or `provider/id`
     * when it does not offer `variant`. Newest is the latest release; a
     * deprecated model is never one.
     */
    readonly newest: (sessionID: string, providers: ReadonlyArray<string>, family: string, variant: string) => Effect.Effect<string | undefined>
    /**
     * `model` (`provider/id`) at `variant` (`provider/id#variant`) when the
     * session's host offers both, the bare model when it offers the model
     * without that variant, and none when it does not offer the model.
     */
    readonly at: (sessionID: string, model: string, variant: string | undefined) => Effect.Effect<string | undefined>
  }
>()("dotfiles-opencode/orchestrate/Models") {}

/**
 * The account pool's pace for one new agent on a provider. No answer (no
 * pool, a timeout, a failure, an answer that is not a pace) is `FailedOpen`
 * with the cause, and the agent starts: it fails open.
 */
export class PoolPace extends Context.Service<
  PoolPace,
  {
    /**
     * Of `model`, when named (`claude-fable-5-2`, or `provider/id[#variant]`):
     * a window of that model's own (`7d:Fable`) holds only its starts.
     */
    readonly pace: (providerID: string, model?: string) => Effect.Effect<PaceReply>
    /** A new agent started on the provider: the pool counts it until its spend shows. Telling never fails. */
    readonly started: (providerID: string) => Effect.Effect<void>
  }
>()("dotfiles-opencode/orchestrate/PoolPace") {}

/**
 * The Codex account's pace for one new agent: the orchestrate skill's
 * admission script, asked with the model id and the role (`none` for a
 * non-role agent). Only the script's own answer holds; anything else is
 * `FailedOpen` with the cause, and fails open.
 */
export class CodexAdmission extends Context.Service<
  CodexAdmission,
  { readonly admit: (model: string, role: string) => Effect.Effect<PaceReply> }
>()("dotfiles-opencode/orchestrate/CodexAdmission") {}

/** A held subagent start, as the latch keeps it: the call as it was routed, what holds it, and when it is decided again. */
export interface LatchRequest {
  /** The parent: the session that made the call, whom the subagent's answer wakes. */
  readonly parent: string
  readonly from: string
  readonly messageID: string
  readonly callID: string
  readonly agent: string
  readonly description: string
  readonly prompt: string
  /** `provider/id#variant`: the model the child is made on and opened on. */
  readonly model?: string
  readonly hold: Hold
  readonly why: string
  /** Epoch ms on the system's clock, as the wakes keep time, even under a fixed `now`. */
  readonly opensAt: number
  /** Epoch ms on the system's clock, like `opensAt`. */
  readonly recheckAt: number
  /** Kept with the latch and handed back when it opens. */
  readonly context: { readonly [key: string]: Schema.Json }
}

/** A latched start, opening: the parent's call, and the child to prompt in the background. */
export interface LatchStart {
  readonly parent: string
  readonly from: string
  readonly messageID: string
  readonly callID: string
  readonly child: string
  readonly agent: string
  readonly description: string
  readonly prompt: string
  readonly model?: string
}

/** The latch could not be kept: no wakes to keep it, or they would not. */
export class LatchRefused extends Schema.TaggedError<LatchRefused>()("LatchRefused", { reason: Schema.String }) {}

/** The latched child could not be started. */
export class StartFailed extends Schema.TaggedError<StartFailed>()("StartFailed", { message: Schema.String }) {}

/**
 * Where a held start latches, and how a latched one starts.
 * - `latch`: keep the request as a latch of its parent, with its child
 *   session made and not prompted: the latch's id and child. The keeper
 *   decides it again at `recheckAt` through the orchestrate model's `openLatch`.
 * - `start`: prompt the latched child in the background with the request's
 *   prompt, as the subagent tool starts a background subagent; its answer
 *   wakes the parent.
 */
export class Latches extends Context.Service<
  Latches,
  {
    readonly latch: (request: LatchRequest) => Effect.Effect<{ readonly id: string; readonly child: string }, LatchRefused>
    readonly start: (start: LatchStart) => Effect.Effect<void, StartFailed>
  }
>()("dotfiles-opencode/orchestrate/Latches") {}

// ── An idle root's facts (idle.ts) ──

/**
 * The steps a session started, as the call log keeps them: the unit each
 * step's description names (`<role> <unit> r<N>`, described.ts), once each,
 * in the order first started. No log, a line that does not read, or a
 * description that names no step gives nothing.
 */
export class StepLog extends Context.Service<
  StepLog,
  { readonly units: (sessionID: string) => Effect.Effect<ReadonlyArray<string>> }
>()("dotfiles-opencode/orchestrate/StepLog") {}

/**
 * The orchestrate runs of the repository this plugin serves, each with its
 * units' states as the skill's status script derives them. Runs that cannot
 * be read are none.
 */
export class Runs extends Context.Service<Runs, { readonly list: Effect.Effect<ReadonlyArray<Run>> }>()("dotfiles-opencode/orchestrate/Runs") {}

/**
 * What the other plugins hold for a session: its wakes, its open questions
 * and its queue's `needs-you` and `waiting` items. A plugin that cannot be
 * asked holds nothing.
 */
export class RootHolds extends Context.Service<RootHolds, { readonly of: (sessionID: string) => Effect.Effect<Holds> }>()(
  "dotfiles-opencode/orchestrate/RootHolds",
) {}

/** The nudge could not reach the session. */
export class NudgeRefused extends Schema.TaggedError<NudgeRefused>()("NudgeRefused", { message: Schema.String }) {}

/** Steers a session with one line, marked as the nudge (`MARK`), which wakes it if idle. */
export class Steer extends Context.Service<Steer, { readonly nudge: (sessionID: string, line: string) => Effect.Effect<void, NudgeRefused> }>()(
  "dotfiles-opencode/orchestrate/Steer",
) {}

// ── A run's skill drift (skill-drift.ts) ──

/**
 * The orchestrate skill as installed, read from the git checkout it lives in.
 * - `version`: the newest commit that touched the skill; none when it cannot
 *   be read (no checkout, no git).
 * - `relation`: how `installed` stands to `seen`, with the subjects of the
 *   commits between them, newest first; none when it cannot be read.
 */
export class Skill extends Context.Service<
  Skill,
  {
    readonly version: Effect.Effect<string | undefined>
    readonly relation: (seen: string, installed: string) => Effect.Effect<Relation | undefined>
  }
>()("dotfiles-opencode/orchestrate/Skill") {}

/**
 * What a run dir keeps about the skill.
 * - `seen`: the skill version the run last saw (`SEEN_FILE`); none when never recorded.
 * - `see`: record it. Never fails: a lost record costs one repeated note.
 * - `departures`: the "Departs from" lines in the run's own top-level Markdown files, `<file>:<line>: <text>`.
 */
export class RunRecords extends Context.Service<
  RunRecords,
  {
    readonly seen: (runDir: string) => Effect.Effect<string | undefined>
    readonly see: (runDir: string, version: string) => Effect.Effect<void>
    readonly departures: (runDir: string) => Effect.Effect<ReadonlyArray<string>>
  }
>()("dotfiles-opencode/orchestrate/RunRecords") {}

/** Steers a session with one note, marked `DRIFT_MARK`, which wakes it if idle. */
export class Tell extends Context.Service<
  Tell,
  { readonly tell: (sessionID: string, note: { readonly text: string; readonly description: string }) => Effect.Effect<void, NudgeRefused> }
>()("dotfiles-opencode/orchestrate/Tell") {}

/** A session as the restart reads it: its parent, title (a subagent's is its call's description) and agent. */
export interface SessionCard {
  readonly id: string
  readonly parentID?: string
  readonly title?: string
  readonly agent?: string
}

/** A session and its context's messages, as the restart reads them (restart.ts `Entry`). */
export interface Transcript {
  readonly session: SessionCard
  readonly entries: ReadonlyArray<Entry>
}

/** A cut child to resume: the parent's call it answers to, and the prompt it is resumed with. */
export interface ResumeStart {
  readonly parent: string
  /** The agent the parent's call ran under. */
  readonly from: string
  readonly messageID: string
  readonly callID: string
  readonly child: string
  /** The agent the child runs as, kept as it is. */
  readonly agent: string
  readonly description: string
  readonly prompt: string
}

/** A notice to a parent: what its transcript shows, and whether it wakes an idle parent. */
export interface ParentNotice {
  readonly parent: string
  readonly text: string
  readonly description: string
  readonly wake: boolean
  /** The children it names, kept with it so a later start tells no child twice. */
  readonly children: ReadonlyArray<string>
}

/**
 * What the restart reads and does, for the sessions of this plugin's
 * location (the host runs one copy of the plugin per location).
 * - `children`: the subagent sessions active since `since` (epoch ms);
 *   none when the host cannot list them.
 * - `transcript`: a session and its context; none when it cannot be read.
 * - `resume`: prompt the child, as the subagent tool continues a background
 *   subagent: its result wakes the parent.
 * - `tell`: a notice to the parent as a steered synthetic message. Telling
 *   never fails: a lost notice costs the parent a line, not the resume.
 */
export class Restarts extends Context.Service<
  Restarts,
  {
    readonly children: (since: number) => Effect.Effect<ReadonlyArray<SessionCard>>
    readonly transcript: (sessionID: string) => Effect.Effect<Transcript | undefined>
    readonly resume: (start: ResumeStart) => Effect.Effect<void, StartFailed>
    readonly tell: (notice: ParentNotice) => Effect.Effect<void>
  }
>()("dotfiles-opencode/orchestrate/Restarts") {}
