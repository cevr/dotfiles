// The contracts the orchestrate model needs from outside, each with what its
// implementations owe (laws.ts). Implementations live in the folders named
// after their dependency: filestore/, opencode/, codex/ and memory/.
import { Context, type Effect, type Option, Schema } from "effect"
import type { CallLine } from "./call-line.ts"
import type { FleetOutcome } from "./fleet.ts"
import type { HeavyReading } from "./heavy.ts"
import type { Holds, Run } from "./idle.ts"
import type { Calls, Held } from "./ledger.ts"
import type { ModelRef, PaceReply } from "./pace.ts"
import type { Relation } from "./skill-drift.ts"
import type { Hold } from "./tool-call.ts"
import type { HeadSeen } from "./lost.ts"
import type { Merge, UnitFiles, Verified } from "./tools.ts"
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
    /**
     * Whether the session's last turn was stopped (interrupted) rather than ended: its last words are then no
     * hand-back, whatever an earlier turn wrote. A session it cannot read was not.
     */
    readonly stoppedOf: (sessionID: string) => Effect.Effect<boolean>
    /** When the session, a latched child that will still open, opens (epoch ms); none once it opened, was cancelled or failed. */
    readonly latchOf: (sessionID: string) => Effect.Effect<number | undefined>
    /** The directory the session works in. */
    readonly directoryOf: (sessionID: string) => Effect.Effect<string | undefined>
    /** The text of the session's last answer: its newest assistant message's text parts, joined. */
    readonly lastWordsOf: (sessionID: string) => Effect.Effect<string | undefined>
    /** When the session's last turn ended (epoch ms), while no turn runs; none while it works, before it ran, or unread. */
    readonly idleSinceOf: (sessionID: string) => Effect.Effect<Option.Option<number>>
    /** The sessions whose directory is `directory` (one a lane's agent started in, or moved to); none when unread. */
    readonly inDirectory: (directory: string) => Effect.Effect<ReadonlyArray<string>>
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
    /**
     * `sessionID` is the session whose start would wait: the pool asks the
     * owner there (in its tree's root) when a reset could lift the hold.
     */
    readonly pace: (providerID: string, model?: string, sessionID?: string) => Effect.Effect<PaceReply>
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
 * description that names no step gives nothing. `calls`: the session's
 * subagents and when it last started a step of each unit (ledger.ts
 * `callsIn`); none likewise.
 */
export class StepLog extends Context.Service<
  StepLog,
  {
    readonly units: (sessionID: string) => Effect.Effect<ReadonlyArray<string>>
    readonly calls: (sessionID: string) => Effect.Effect<Calls>
  }
>()("dotfiles-opencode/orchestrate/StepLog") {}

/**
 * The orchestrate runs of the repository this plugin serves, each with its
 * units' states as the skill's status script derives them. Runs that cannot
 * be read are none: `list` answers them alone, `read` with why they could not
 * be read (`error`), so a reader tells no runs from unread ones.
 */
export class Runs extends Context.Service<
  Runs,
  {
    readonly list: Effect.Effect<ReadonlyArray<Run>>
    readonly read: Effect.Effect<{ readonly runs: ReadonlyArray<Run>; readonly error: Option.Option<string> }>
  }
>()("dotfiles-opencode/orchestrate/Runs") {}

/**
 * The default branch of a checkout, as git reads it there (local refs as they are). Never fails: what cannot be
 * read is none, or nothing.
 * - `tip`: the default branch's name (origin's `origin/HEAD`, else `main`, else `master`) and the commit `at` names
 *   (default: that branch's head); none outside a repository, with no default branch, or for a commit git does not know.
 * - `merges`: the first-parent merges of `head`, newest first, back to `base` (excluded; none: from the start), at most `limit`.
 * - `between`: every commit `head` holds and `base` does not (`git rev-list base..head`), full names: a merge's
 *   side commits too, so a unit landed by a merge and one landed by a fast-forward are both in it.
 * - `commitOf`: the full commit `rev` names in `checkout`.
 */
export class MainLine extends Context.Service<
  MainLine,
  {
    readonly tip: (checkout: string, at: Option.Option<string>) => Effect.Effect<Option.Option<{ readonly branch: string; readonly head: string }>>
    readonly merges: (checkout: string, head: string, base: Option.Option<string>, limit: number) => Effect.Effect<ReadonlyArray<Merge>>
    readonly between: (checkout: string, base: string, head: string) => Effect.Effect<ReadonlyArray<string>>
    readonly commitOf: (checkout: string, rev: string) => Effect.Effect<Option.Option<string>>
  }
>()("dotfiles-opencode/orchestrate/MainLine") {}

/** A file the run dirs could not take. */
export class RunFileUnwritten extends Schema.TaggedError<RunFileUnwritten>()("RunFileUnwritten", { path: Schema.String, message: Schema.String }) {}

/**
 * The runs' files, read on every call and never kept (tools.ts reads them):
 * - `verified`: the newest `<run dir>/verify-*\/batch-*.md` of `runDirs` whose findings beside it
 *   (`batch-*-findings.md`) hold a verdict line, by when that verdict was written: the head its `Head:` names.
 * - `units`: each unit dir of a run dir (one holding log.md), with its newest request and findings.
 * - `unit`: one unit dir's newest request and findings.
 * - `write`: the one file the plugin writes, a verify's batch file, its directory made.
 */
export class RunFiles extends Context.Service<
  RunFiles,
  {
    readonly verified: (runDirs: ReadonlyArray<string>) => Effect.Effect<Option.Option<Verified>>
    readonly units: (runDir: string) => Effect.Effect<ReadonlyArray<UnitFiles>>
    readonly unit: (unitDir: string) => Effect.Effect<UnitFiles>
    readonly write: (path: string, text: string) => Effect.Effect<void, RunFileUnwritten>
    /** When the file at `path` was last written (epoch ms); none when it is not there. */
    readonly writtenAt: (path: string) => Effect.Effect<Option.Option<number>>
  }
>()("dotfiles-opencode/orchestrate/RunFiles") {}

/**
 * Committed work and who is on it, as git, the files and the processes say at the call (lost.ts reads it). Never
 * fails, never fetches, never writes in a lane: what cannot be read is none, or nothing.
 * - `heads`: each of `heads` against the default branch `main` (a ref or commit) of `repo`, read in `repo` with the
 *   objects of `lanes` borrowed read-only (`GIT_ALTERNATE_OBJECT_DIRECTORIES`), so a lane's commits are seen without a
 *   fetch: on it, patch-equivalent, absent (its own commits not there) or unknown; and its commit time.
 * - `touchedAt`: when the lane's HEAD last moved (its HEAD reflog's last write; epoch ms).
 * - `held`: the paths of `lanes` some process has its working directory in, now.
 * - `lands`: the commit times of `main`'s first-parent line in `repo` (epoch ms), newest first, at most `limit`.
 */
export class WorkGit extends Context.Service<
  WorkGit,
  {
    readonly heads: (repo: string, main: string, lanes: ReadonlyArray<string>, heads: ReadonlyArray<string>) => Effect.Effect<ReadonlyMap<string, HeadSeen>>
    readonly touchedAt: (lane: string) => Effect.Effect<Option.Option<number>>
    readonly held: (lanes: ReadonlyArray<string>) => Effect.Effect<ReadonlySet<string>>
    readonly lands: (repo: string, main: string, limit: number) => Effect.Effect<ReadonlyArray<number>>
  }
>()("dotfiles-opencode/orchestrate/WorkGit") {}

/**
 * What the other plugins hold for a session: its wakes, its open questions
 * and its queue's `needs-you` and `waiting` items. A plugin that cannot be
 * asked holds nothing. `held`: the same plugins' items themselves, as a
 * compacted root's ledger lists them (ledger.ts `Held`): its queue's items
 * not done, its wakes, monitors and latches, and its jobs still running.
 */
export class RootHolds extends Context.Service<
  RootHolds,
  { readonly of: (sessionID: string) => Effect.Effect<Holds>; readonly held: (sessionID: string) => Effect.Effect<Held> }
>()("dotfiles-opencode/orchestrate/RootHolds") {}

/** The nudge could not reach the session. */
export class NudgeRefused extends Schema.TaggedError<NudgeRefused>()("NudgeRefused", { message: Schema.String }) {}

/** Steers a session with one line, marked as the nudge (`MARK`), which wakes it if idle. */
export class Steer extends Context.Service<Steer, { readonly nudge: (sessionID: string, line: string) => Effect.Effect<void, NudgeRefused> }>()(
  "dotfiles-opencode/orchestrate/Steer",
) {}

/**
 * Puts one message in a session's context for its next request, marked
 * `BRIEF_MARK`, without starting a turn: an idle session reads it with its
 * next input.
 */
export class Remind extends Context.Service<
  Remind,
  { readonly remind: (sessionID: string, note: { readonly text: string; readonly description: string }) => Effect.Effect<void, NudgeRefused> }
>()("dotfiles-opencode/orchestrate/Remind") {}

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
 * - `log`: append one line to the run's own log.md, the run being the one holding `near` (a verifier's report:
 *   `<run dir>/batch-<k>-findings.md`, or a unit's `<run dir>/<unit>/round-N-findings.md`, a unit dir being one
 *   that holds spec.md), relative to `directory` when not absolute (`~/` is home). Never fails: a path that
 *   names no directory writes nothing, and a lost line costs the run one drift reading.
 */
export class RunRecords extends Context.Service<
  RunRecords,
  {
    readonly seen: (runDir: string) => Effect.Effect<string | undefined>
    readonly see: (runDir: string, version: string) => Effect.Effect<void>
    readonly departures: (runDir: string) => Effect.Effect<ReadonlyArray<string>>
    readonly log: (input: { readonly near: string; readonly line: string; readonly directory?: string }) => Effect.Effect<void>
  }
>()("dotfiles-opencode/orchestrate/RunRecords") {}

/**
 * The fleet's verified target (mods/update/target.ts): what every host's update plugin installs.
 * - `record`: a batch was accepted, its verifier's `report` in the run dir: record the dotfiles and
 *   fork heads the batch file beside it (`<run dir>/<batch>.md`) names as verified at, both required,
 *   as the verified target. Never a checkout's HEAD, never a kept commit. Never fails: it answers
 *   the outcome (`fleet.ts`), and `Refused` with why when it records nothing (a batch file that does
 *   not name both heads, a commit the checkouts or origin lack, a head behind the current target, a
 *   push refused).
 * - `covers`: whether `directory` is a checkout of the repository the fleet publishes (its origin is the dotfiles
 *   checkout's origin), or none when its origin does not read (not a git checkout, gone): then the next folder asked
 *   decides. Another repository's batch (a Bite verifier's) is none of the fleet's: never recorded, never told. A
 *   host with no checkouts covers nothing.
 */
export class Fleet extends Context.Service<
  Fleet,
  {
    readonly record: (input: { readonly report: Option.Option<string>; readonly batch: string }) => Effect.Effect<FleetOutcome>
    readonly covers: (directory: string) => Effect.Effect<Option.Option<boolean>>
  }
>()("dotfiles-opencode/orchestrate/Fleet") {}

// ── The heavy-check footer (heavy.ts) ──

/** The host's load or its heavy agents could not be read. */
export class HostUnread extends Schema.TaggedError<HostUnread>()("HostUnread", { reason: Schema.String }) {}

/**
 * The host the agents run their heavy checks on.
 * - `cores`: its count of cores. Never fails.
 * - `read`: its load now, and the heavy agents (implementors and verifiers) working on it now, every root's on
 *   the host, `except` (the agent being prompted, by its session) not counted. A start whose session no longer
 *   works does not count, however its log reads.
 */
export class HeavyHost extends Context.Service<
  HeavyHost,
  {
    readonly cores: Effect.Effect<number>
    readonly read: (except: Option.Option<string>) => Effect.Effect<HeavyReading, HostUnread>
  }
>()("dotfiles-opencode/orchestrate/HeavyHost") {}

/** Steers a session with one note, marked `DRIFT_MARK`, which wakes it if idle. */
export class Tell extends Context.Service<
  Tell,
  { readonly tell: (sessionID: string, note: { readonly text: string; readonly description: string }) => Effect.Effect<void, NudgeRefused> }
>()("dotfiles-opencode/orchestrate/Tell") {}
