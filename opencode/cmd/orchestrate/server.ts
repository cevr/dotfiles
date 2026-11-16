/**
 * The orchestrate rules as an OpenCode server plugin, the Claude Code hooks'
 * counterpart. The composition root: it decodes the options, builds the model
 * (`@dotfiles/opencode-orchestrate/model`) on its outside systems (its
 * `filestore/`, `opencode/` and `codex/` implementations), and answers
 * OpenCode's hooks with it.
 *
 * - Roles: the planner, implementor, verifier and worker agents, from
 *   agents.json (the orchestrate skill's prompts, written by `bun run agents`).
 * - Guard: a subagent call with no agent, or with the general agent, runs as the
 *   lean `worker`; a former role name (`orchestrate-*`, `orchestrate-reviewer`)
 *   runs as the role. A new role subagent runs at the role's reasoning effort,
 *   as a variant of the model it would run on, when that model has one. A
 *   worker asked or inheriting `#max` runs at its model's default effort
 *   unless its description ends `(mechanical)`, and its answer says so. Each
 *   call is a line in a JSONL log a status pane can read.
 * - Compaction: each role and each primary agent compacts at one fixed
 *   window, `WINDOW` in compaction.ts (400k tokens). The window is the
 *   agent's `request.settings.compactionWindow`, which the fork's automatic
 *   compaction reads. Every compaction keeps the files, the step and the
 *   user's instructions word for word.
 * - Sabbath: from Friday sunset to 30 minutes after Saturday's at the owner's
 *   place, no subagent starts and a running subagent's next tool call is
 *   refused so it ends its turn. The main session answers as always. A turn
 *   the server resumed after a restart in the rest makes no model request
 *   until the rest ends (restart-hold.ts).
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `log`: path of the call log, default `~/.cache/orchestrate/opencode-agents.jsonl`.
 * - `now`: a fixed time (ISO 8601) for the Sabbath clock, for tests.
 * - `place`: `{ name, lat, lon, timeZone }` for the Sabbath, default Knowlton, QC.
 * - `fullAgent`: true lets an untyped or general call run as asked.
 * - `codex`: `{ providers, script }`, the providers whose new subagents the
 *   Codex account's pace admits (default `["openai"]`) and the script run
 *   with `--codex --admit` (default the orchestrate skill's `budget.ts`, the
 *   one the Claude-side Codex bridge asks); `false` leaves them to the pool.
 *   With `pool: true` the pool answers first: when it paces the provider (its
 *   `paced` option), its answer is the ChatGPT account's own measure, counting
 *   every host and harness on the account, and the script answers only when
 *   the pool cannot. Without it the script alone answers.
 * - `unitLog`: the orchestrate skill's log.ts that writes each unit's moves,
 *   default `~/.claude/skills/orchestrate/scripts/log.ts`.
 * - `skill`: the orchestrate skill's dir, whose git history versions it,
 *   default `~/.claude/skills/orchestrate`.
 * - `fleet`: `{ dotfiles, fork }`, the checkouts `bun run daily` installs from.
 *   An accepted verdict whose verifier ran in a checkout of either records
 *   the verified target every host's update plugin installs
 *   (`refs/fleet/verified`, git/fleet.ts). Without it nothing is recorded.
 * - `planner`: `{ model }`, the planner's first model (`provider/id`, no
 *   variant; `bun run daily` writes the newest Fable). A new planner start
 *   that names no model of its own (or the role's) runs on it at the
 *   planner's effort; a follow-up keeps its model. One the host does not
 *   offer `model` for, or whose pace holds it, takes the role's chain (its
 *   own model, then Codex), and its line records `first: { model, fellBack }`.
 *   Over the Sabbath it latches on `model` as every role latches on its own,
 *   and its open takes the same chain. Only the planner has a first model. Absent,
 *   the planner starts on its own model like every role.
 *
 * - Skill drift: when a root that owns a run goes idle and the installed
 *   skill is newer than the version the run last saw (`<run dir>/skill-version`),
 *   the root gets one note: the commit subjects since, the run's "Departs
 *   from" lines, and to reconcile its rules files (mods/orchestrate/skill-drift.ts).
 *   Once per version per run; a run seen first records its version silently.
 *
 * - Unit logs: a role's start (planner, implementor, verifier, by its call's
 *   `<role> <unit> r<N>` description) and its hand-back (the first line of its
 *   last answer when its session goes idle) move its unit in
 *   `<run dir>/<unit>/log.md` through log.ts `--current`. The unit dir is the
 *   one a path in the prompt or the hand-back names, else the one
 *   `tmp/orchestrate/<run>/<unit>` in the session's checkout; none found, or a
 *   move already logged, writes nothing.
 *
 * - Latch: a new subagent the Sabbath or the pace holds latches instead of
 *   being refused. The call answers at once, as a background subagent's
 *   does, saying why it waits and when it opens; the wakes plugin keeps the
 *   latch (`latch` on its RPC) as a wake of the parent's, with the child
 *   session made and not prompted, so the parent's rows show it waiting. At
 *   its time the wakes ask this plugin's opener (`OPENER`) to decide it
 *   again: still held latches again, admitted starts the child in the
 *   background through the subagent tool's own execute, and its answer wakes
 *   the parent. A pace hold is decided again at least every two minutes,
 *   since a pace may open early. With no wakes plugin the held call is
 *   refused with the hold's reason and the time it opens.
 * - Opus first, Codex second: a new agent the pace holds on its own model
 *   (the newest Opus), that named no model (or named its own: dropped, `model-dropped`), starts at once on the newest
 *   Codex model for its role when the Codex pace has room: sol (the verifier
 *   at medium, the rest at high), or luna at max for a step whose description
 *   ends `(light)`, `(direct)` or `(mechanical)`. The call log's line says
 *   `fallback: <first model> held: <reason>`, and the parent reads that line
 *   first in the subagent call's result. Held on both, it latches on whichever
 *   opens first, and each open tries the first model before the fallback.
 *
 * - The `orchestrate` tool (mods/orchestrate/tools.ts): lane, land, verify
 *   and status for a root that runs units. The plugin keeps no state of a run:
 *   every answer is computed at the call from the run tables (the status
 *   plugin's RPC over the skill's status.ts) and the warm source's Rift list
 *   (the rift plugin's RPC), so a restart or another root session gets the
 *   same answer. No batch rule refuses a call; a land of a unit the run tables
 *   show in another state than `ready` lands with a warning. What still
 *   refuses: a subagent's lane, land or verify (merge and push are the
 *   root's), a malformed input, and what the rift plugin refuses. After a
 *   root's compaction it gets one message (no new turn): its status (or, when
 *   the run tables cannot be read, why and the units it started), its ledger
 *   (mods/orchestrate/ledger.ts: its queue not done, its subagents now with any
 *   unanswered hand-back, its wakes and jobs) and the re-read. An older config's `ledger`, `cadence`, `guard` and `drops`, and a
 *   call's `departs`, `(departs: …)` and `(folds: …)`, still decode and mean
 *   nothing.
 * - Fleet: a verifier's `accepted` hand-back records the verified target its
 *   batch file names (`fleet`), once per verdict, however often its session
 *   goes idle after. After a restart the same verdict may be read again: the
 *   ref already names its heads, so nothing is pushed (`Unchanged`).
 *
 * - Heavy footer: every implementor and verifier prompt the plugin starts (a
 *   new start, a follow-up, a latched start as it opens) ends with one footer
 *   (mods/orchestrate/heavy.ts): its heavy-check thread share, from the host's
 *   cores and the implementors and verifiers working on it then (the call
 *   log's, every root's), and that a round runs its spec's round gate only.
 *   No option turns it off.
 *
 * Each new subagent is told to the pool (`started`), which counts it on its
 * provider's pace, here and on the owner's other hosts, until its spend shows
 * in a reading.
 */
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { join } from "node:path"
import { Agent, Plugin, Tool } from "@opencode/plugin/effect"
import { Array as Arr, Clock, Context, Effect, Layer, Match, Option, Predicate, Schema, SchemaGetter, Stream } from "effect"
import { POOL_STATUS } from "@dotfiles/opencode-pool/status"
import { QUESTIONS } from "@dotfiles/opencode-questions/question"
import { QUEUE } from "@dotfiles/opencode-queue/queue"
import { STATUS } from "@dotfiles/opencode-status/status"
import { Latch, MARK_KEY, type Opened, OPENER } from "@dotfiles/opencode-wake/latch"
import { WAKES } from "@dotfiles/opencode-wake/wake"
import * as CodexAdmissionLive from "@dotfiles/opencode-orchestrate/codex/admission"
import { keepMessage, WINDOW } from "@dotfiles/opencode-orchestrate/compaction"
import * as CallLogLive from "@dotfiles/opencode-orchestrate/filestore/call-log"
import * as HeavyAgentsLive from "@dotfiles/opencode-orchestrate/filestore/heavy-agents"
import { footerFor, isHeavy, withFooter } from "@dotfiles/opencode-orchestrate/heavy"
import * as HeavyHostLive from "@dotfiles/opencode-orchestrate/node/heavy-host"
import * as StepLogLive from "@dotfiles/opencode-orchestrate/filestore/step-log"
import * as RunRecordsLive from "@dotfiles/opencode-orchestrate/filestore/run-records"
import * as GitFleet from "@dotfiles/opencode-orchestrate/git/fleet"
import * as GitMainLine from "@dotfiles/opencode-orchestrate/git/main-line"
import * as RunFilesLive from "@dotfiles/opencode-orchestrate/filestore/run-files"
import * as UnitLogsLive from "@dotfiles/opencode-orchestrate/filestore/unit-logs"
import * as SkillLive from "@dotfiles/opencode-orchestrate/git/skill"
import { Draft, IDLE, MARK, type Run as RunTable } from "@dotfiles/opencode-orchestrate/idle"
import * as Ledger from "@dotfiles/opencode-orchestrate/ledger"
import * as Model from "@dotfiles/opencode-orchestrate/model"
import { handBackOf } from "@dotfiles/opencode-orchestrate/unit-log"
import * as HoldsLive from "@dotfiles/opencode-orchestrate/opencode/holds"
import * as LatchesLive from "@dotfiles/opencode-orchestrate/opencode/latches"
import * as ModelsLive from "@dotfiles/opencode-orchestrate/opencode/models"
import * as PoolPaceLive from "@dotfiles/opencode-orchestrate/opencode/pool-pace"
import * as RunsLive from "@dotfiles/opencode-orchestrate/opencode/runs"
import * as SessionsLive from "@dotfiles/opencode-orchestrate/opencode/sessions"
import * as SteerLive from "@dotfiles/opencode-orchestrate/opencode/steer"
import type { PaceHeld } from "@dotfiles/opencode-orchestrate/pace"
import * as Tools from "@dotfiles/opencode-orchestrate/tools"
import { Created, LandAnswered, Listed, RIFT_RPC, workriftName } from "@dotfiles/opencode-work/rpc"
import { samePlace } from "@dotfiles/opencode-orchestrate/opencode/sessions"
import { definitions, ROLE_CACHE_TTL, ROLES } from "@dotfiles/opencode-orchestrate/role"
import { heldUntil } from "@dotfiles/opencode-orchestrate/restart-hold"
import { KNOWLTON, local, Place, rest, type SabbathRest } from "@dotfiles/opencode-orchestrate/sabbath"
import {
  type CallLog,
  type CodexAdmission,
  HeavyHost,
  type Latches,
  type LatchStart,
  MainLine,
  type Models,
  type PoolPace,
  Remind,
  RootHolds,
  type RunRecords,
  RunFiles,
  type Fleet,
  Runs,
  Sessions,
  type Skill,
  type Steer,
  StepLog,
  type Tell,
  UnitLogs,
} from "@dotfiles/opencode-orchestrate/service"
import type { CodexNeverImplements, Status, StillLatched } from "@dotfiles/opencode-orchestrate/tool-call"

export const DEFAULT_LOG = join(TuiDirs.dirs().home, ".cache/orchestrate/opencode-agents.jsonl")
/** The orchestrate skill's Codex admission: `admit: …` exit 0, `hold: …[; opens about <time>Z]` exit 1. */
export const CODEX_BUDGET = join(TuiDirs.dirs().home, ".claude/skills/orchestrate/scripts/budget.ts")
/** The orchestrate skill's log.ts, the units' logs' one writer. */
export const UNIT_LOG = join(TuiDirs.dirs().home, ".claude/skills/orchestrate/scripts/log.ts")
/** The orchestrate skill as installed: a link into the dotfiles checkout, whose history versions it. */
export const SKILL_DIR = join(TuiDirs.dirs().home, ".claude/skills/orchestrate")

const SUBAGENT = "subagent"

/** How many merges on the default branch a verify reads at most. */
const MERGES_READ = 1_000

/**
 * An option that takes `fallback` when absent. A present value must decode.
 * `undefined` counts as absent: a host passing options in-process leaves an
 * unset one undefined, and a JSON config cannot write it.
 */
const withDefault =
  <A>(fallback: A) =>
  <S extends Schema.Codec<A, any, never, never>>(schema: S) =>
    schema.pipe(Schema.withDecodingDefaultType(Effect.succeed(fallback)))

/** A time as ISO 8601, read as epoch ms. */
const Instant = Schema.String.pipe(
  Schema.decodeTo(Schema.Finite, {
    decode: SchemaGetter.transform((text: string) => Date.parse(text)),
    encode: SchemaGetter.transform((ms: number) => new Date(ms).toISOString()),
  }),
)

const CODEX_DEFAULT = { providers: ["openai"], script: CODEX_BUDGET }

const Codex = Schema.Struct({
  providers: Schema.Array(Schema.String).pipe(withDefault<ReadonlyArray<string>>(CODEX_DEFAULT.providers)),
  script: Schema.String.pipe(withDefault(CODEX_DEFAULT.script)),
  pool: Schema.optional(Schema.Boolean),
})

const Planner = Schema.Struct({
  model: Schema.String.check(Schema.isPattern(/^[^/#\s]+\/[^#\s]+$/)),
})

/** The options. An older config's `ledger`, `cadence`, `guard` and `drops` are extra keys, ignored as any is. */
export const Options = Schema.Struct({
  log: Schema.String.pipe(withDefault(DEFAULT_LOG)),
  planner: Schema.optional(Planner),
  now: Schema.optional(Instant),
  place: Place.pipe(withDefault<Place>(KNOWLTON)),
  fullAgent: Schema.Boolean.pipe(withDefault(false)),
  codex: Schema.Union([Schema.Literal(false), Codex]).pipe(withDefault<false | typeof Codex.Type>(CODEX_DEFAULT)),
  unitLog: Schema.String.pipe(withDefault(UNIT_LOG)),
  skill: Schema.String.pipe(withDefault(SKILL_DIR)),
  fleet: Schema.optional(Schema.Struct({ dotfiles: Schema.String, fork: Schema.String })),
})
export type Options = typeof Options.Type

/** The outside systems the model runs on. */
export type Externals =
  | CallLog
  | Sessions
  | Models
  | PoolPace
  | CodexAdmission
  | Latches
  | UnitLogs
  | StepLog
  | Runs
  | RootHolds
  | Steer
  | Skill
  | RunRecords
  | Tell
  | Remind
  | Fleet
  | MainLine
  | RunFiles

/** How much background work a session keeps of its own, as its last idle listed it. */
export type Background = (sessionID: string) => number

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]
type SyntheticInput = Parameters<Plugin.Context["session"]["synthetic"]>[0]
type HostSession = Effect.Success<ReturnType<Plugin.Context["session"]["get"]>>
/** What the guard reads of the host's session record. */
export type StepHostSession = Pick<HostSession, "parentID" | "agent" | "outcome" | "metadata"> & {
  readonly time: Partial<Pick<HostSession["time"], "busy" | "idle">>
  readonly location: { readonly directory: string }
}

/** When the session went idle, while no turn runs: its `time.idle` at or after its `time.busy`. */
const idleSinceOf = (time: StepHostSession["time"]): Option.Option<number> => {
  const busy = Option.fromUndefinedOr(msOf(time.busy))
  return Option.filter(Option.fromUndefinedOr(msOf(time.idle)), (idle) => Option.match(busy, { onNone: () => true, onSome: (at) => at <= idle }))
}

/** A step's session as the guard reads it (SessionsLive): a stopped one is a session whose last turn was interrupted. */
export const stepSessionOf = (session: StepHostSession): SessionsLive.Session => ({
  ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
  ...(session.agent === undefined ? {} : { agent: session.agent }),
  started: session.time.busy !== undefined || session.outcome !== undefined,
  stopped: session.outcome === "interrupted",
  ...(session.metadata?.[MARK_KEY] === undefined ? {} : { latch: session.metadata[MARK_KEY] }),
  directory: session.location.directory,
  ...Option.match(idleSinceOf(session.time), { onNone: () => ({}), onSome: (idleSince) => ({ idleSince }) }),
})

/** The outside systems the filesystem and processes provide: the files the plugin keeps, git, the scripts it runs. */
export type Kept = CallLog | UnitLogs | CodexAdmission | StepLog | Skill | RunRecords | Fleet | MainLine | RunFiles

/**
 * Whether a session works: it runs a turn (its newest start is after its last end) or keeps background work of its
 * own. A session that cannot be read does not.
 */
const aliveOf =
  (ctx: Plugin.Context, background: Background) =>
  (sessionID: string): Effect.Effect<boolean> =>
    ctx.session.get({ sessionID: sessionID as SessionID }).pipe(
      Effect.map((session) => {
        const busy = msOf(session.time.busy)
        const idle = msOf(session.time.idle)
        return (busy !== undefined && (idle === undefined || busy > idle)) || background(sessionID) > 0
      }),
      Effect.orElseSucceed(() => background(sessionID) > 0),
    )

/**
 * The host the heavy-check footer reads: its cores and load from Node's `os`, its heavy agents working now from the
 * call log (every root's on the host), each counted while its session works.
 */
export const liveHeavy = (ctx: Plugin.Context, options: Options, background: Background): Layer.Layer<HeavyHost> =>
  HeavyHostLive.layer(HeavyAgentsLive.working(CallLogLive.read(options.log), aliveOf(ctx, background)))

/**
 * The outside systems as OpenCode, the filesystem and processes provide them;
 * `start` runs a latched child through the subagent tool.
 */
export const live = (ctx: Plugin.Context, options: Options, start: LatchesLive.Start, background: Background): Layer.Layer<Externals> =>
  Layer.merge(
    hosted(ctx, start, background),
    Layer.mergeAll(
      CallLogLive.layer(options.log),
      UnitLogsLive.layer(options.unitLog),
      CodexAdmissionLive.layer(options.codex === false ? CODEX_BUDGET : options.codex.script),
      StepLogLive.layer(options.log),
      SkillLive.layer(options.skill),
      RunRecordsLive.layer,
      GitFleet.layer(Option.fromNullishOr(options.fleet)),
      GitMainLine.layer,
      RunFilesLive.layer,
    ),
  )

/**
 * The outside systems OpenCode provides, on the plugin's context alone: its sessions, models and steering, and the
 * pool's, the wakes', the status's, the questions' and the queue's RPC. Any host that gives the context gives these
 * (the simulated one too: sim/plugins.ts); `start` runs a latched child through the subagent tool.
 */
export const hosted = (ctx: Plugin.Context, start: LatchesLive.Start, background: Background): Layer.Layer<Exclude<Externals, Kept>> =>
  Layer.mergeAll(
    SteerLive.remindLayer(synthetic(ctx)),
    SessionsLive.layer(
      (sessionID) => ctx.session.get({ sessionID: sessionID as SessionID }).pipe(Effect.map(stepSessionOf)),
      (sessionID) => ctx.session.context({ sessionID: sessionID as SessionID }),
    ),
    ModelsLive.layer({
      session: (sessionID) =>
        ctx.session.get({ sessionID: sessionID as SessionID }).pipe(
          Effect.map((session) => ({
            directory: session.location.directory,
            ...(session.model === undefined ? {} : { model: session.model }),
          })),
        ),
      agentModel: (agentID, directory) =>
        ctx.agent.get({ agentID: Agent.ID.make(agentID), location: { directory } }).pipe(Effect.map((agent) => agent.data.model)),
      defaultModel: (directory) => ctx.model.default({ location: { directory } }).pipe(Effect.map((answer) => answer.data)),
      offered: (directory) => ctx.model.list({ location: { directory } }).pipe(Effect.map((answer) => answer.data)),
    }),
    PoolPaceLive.layer(
      (input) => ctx.rpc(POOL_STATUS).pace(input),
      (input) => ctx.rpc(POOL_STATUS).started(input),
    ),
    LatchesLive.layer((ask) => ctx.rpc(WAKES).latch(ask), start),
    RunsLive.layer(() => ctx.rpc(STATUS).status({})),
    HoldsLive.layer({
      pending: (input) => ctx.rpc(WAKES).pending({ sessionIDs: [...input.sessionIDs] }),
      open: (input) => ctx.rpc(QUESTIONS).open({ sessionIDs: [...input.sessionIDs] }),
      queue: (input) => ctx.rpc(QUEUE).get(input),
      jobs: (input) => ctx.rpc(WAKES).jobs(input),
    }),
    SteerLive.layer(synthetic(ctx)),
    SteerLive.tellLayer(synthetic(ctx)),
  )

/** A host time (epoch ms, a Date or a DateTime) as epoch ms. */
const msOf = (time: unknown): number | undefined => {
  if (typeof time === "number") return time
  if (time instanceof Date) return time.getTime()
  if (isObject(time) && typeof time.epochMilliseconds === "number") return time.epochMilliseconds
  return undefined
}

/** A steered synthetic message, as the host's `session.synthetic` takes it. */
const synthetic = (ctx: Plugin.Context) => (input: SteerLive.Synthetic) =>
  ctx.session.synthetic({ ...input, sessionID: input.sessionID as SessionID, metadata: { ...input.metadata } } satisfies SyntheticInput)

/** A time as the model reads it: ISO 8601, and the owner's local time. */
const timeOf = (ms: number, place: Place) => `${new Date(ms).toISOString()} (${local(ms, place)} ${place.timeZone})`

const whoseOf = (whose: string | undefined) => (whose === "codex" ? "the Codex account's" : "the pool's")

/** What the model reads when a call is refused. */
const refusal = (tool: string, rejection: SabbathRest | PaceHeld | StillLatched | CodexNeverImplements, place: Place): Tool.Error => {
  if (rejection._tag === "CodexNeverImplements")
    return new Tool.Error({
      message: `orchestrate: Codex never implements. This ${rejection.agent} would run on ${rejection.model}, and the host offers no Opus model for it. Do not name another model: start it again once an Opus model is offered.`,
      error: rejection,
    })
  if (rejection._tag === "SabbathRest") {
    const then =
      tool === SUBAGENT
        ? "No agent starts now. Do not retry; start it again once work resumes."
        : "Stop now: end your turn with one line on where you stopped. Make no more tool calls."
    return new Tool.Error({ message: `${rejection.why} ${then}`, error: rejection })
  }
  if (rejection._tag === "StillLatched")
    return new Tool.Error({
      message: `orchestrate: subagent ${rejection.child} is latched and has not started; it starts by itself at ${timeOf(rejection.opensAt, place)}, and its result wakes you. Send it nothing until then, or cancel its latch with wake_cancel and start a new one.`,
      error: rejection,
    })
  return new Tool.Error({
    message: `orchestrate: ${whoseOf(rejection.whose)} pace holds this agent. ${rejection.reason}. It opens about ${timeOf(rejection.retryAt, place)}; no latch could be kept for it, so start it again after then. Do not poll.`,
    error: rejection,
  })
}

/** What a latched call answers, as the subagent tool's output: why it waits, when it opens, and that its result wakes the parent. */
const latchedResult = (latched: Model.LatchedStart, place: Place) => {
  const event = latched.latched
  const holds = event.hold === "sabbath" ? event.why : `${whoseOf(event.whose)} pace holds this agent: ${event.why}.`
  const latch = {
    id: latched.id,
    hold: event.hold,
    reason: event.why,
    opensAt: event.opensAt,
    opens: new Date(event.opensAt).toISOString(),
    local: local(event.opensAt, place),
  }
  const output = [
    `The subagent is latched (sessionID: ${latched.child}, latch ${latched.id}). ${holds}`,
    `It starts by itself in the background when the latch opens, about ${timeOf(event.opensAt, place)}${event.recheckAt < event.opensAt ? `, or sooner: it is decided again at ${new Date(event.recheckAt).toISOString()}` : ""}. You will be woken with its result, as for a background subagent.`,
    "Go on with other work, or end your turn. Do not start it again, poll or wait for it. wake_list shows the latch; wake_cancel cancels it.",
  ].join("\n")
  return {
    output: { sessionID: latched.child, status: "latched" as const, output, latch },
    content: output,
    metadata: { sessionID: latched.child, status: "latched", latch },
  }
}

/** The subagent tool's output, widened with the latched answer. */
const SubagentOutput = Schema.Struct({
  sessionID: Schema.String,
  status: Schema.Literals(["completed", "running", "latched"]),
  output: Schema.String,
  latch: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      hold: Schema.Literals(["pace", "sabbath"]),
      reason: Schema.String,
      opensAt: Schema.Number,
      opens: Schema.String,
      local: Schema.String,
    }),
  ),
})

/** What the parent reads first in a fallback agent's answer: where it ran, and why. */
const fallbackNote = (started: { readonly model?: string; readonly fallback?: string }) =>
  `orchestrate: this agent runs on ${started.model ?? "its fallback model"}, the Codex fallback (${started.fallback}).`

/** What the parent reads first in a lowered worker's answer: the effort it runs at, and why. */
const effortNote = (started: { readonly model?: string; readonly lowered?: string }) =>
  `orchestrate: this worker runs on ${started.model ?? "its model"} at the model's default effort, not ${started.lowered}: a worker runs at ${started.lowered} only when its description ends \`(mechanical)\`. Bulk model work (a critique of many images, a sweep) is a script, not a worker at ${started.lowered}.`

/** A started fallback's note, by the call it answers: a kernel cell's calls share one id, so the description is part of the key. */
const noteKey = (sessionID: string, callID: string, input: unknown) =>
  `${sessionID}/${callID}/${isObject(input) && typeof input.description === "string" ? input.description : ""}`

/** The subagent tool tells a new child this first; a latched child opens as a follow-up, so it is told here. */
const SPAWNED = "You are a subagent spawned by another session."

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** A rift RPC call that did not act, in the rift tool's words. */
interface RiftFailed {
  readonly outcome: "failed"
  readonly message: string
}
const isRiftFailed = (answer: { readonly outcome: string }): answer is RiftFailed => answer.outcome === "failed"

type Execute = Tool.Info["execute"]
type ToolContext = Parameters<Execute>[1]

/** How long a footer waits for the host's reading before it takes the host's cores alone. */
const HEAVY_READ = "2 seconds"

/** A subagent call's prompt, when its input has one. */
const decodePrompted = Schema.decodeUnknownOption(Schema.Struct({ prompt: Schema.String }))

/**
 * The plugin on `externals`: the live systems in OpenCode, test layers in the seam tests. `heavy` is the host the
 * heavy-check footer reads; the plugin OpenCode loads always has it (`liveHeavy`), and only the seam tests written
 * before the footer leave it out.
 */
export const make = (
  externals: (ctx: Plugin.Context, options: Options, start: LatchesLive.Start, background: Background) => Layer.Layer<Externals>,
  heavy?: (ctx: Plugin.Context, options: Options, background: Background) => Layer.Layer<HeavyHost>,
) =>
  Plugin.define({
    id: "dotfiles-opencode.orchestrate",
    effect: Effect.fn("Orchestrate.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.orchestrate: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      // Each session's background work of its own, as its last idle listed it: a step that went idle with a
      // shell still running has not ended.
      const backgrounds = new Map<string, number>()
      const ownBackground: Background = (sessionID) => backgrounds.get(sessionID) ?? 0
      // The footer of a heavy role's prompt (heavy.ts), its share read from the host as the prompt goes; `self`, the
      // agent's own session when it has one, is not counted. A reading that fails or is slow takes the host's cores
      // with no other agent working: the prompt never waits on it and the start is never refused for it.
      const host = yield* Option.match(Option.fromNullishOr(heavy), {
        onNone: () => Effect.succeedNone,
        onSome: (layer) => Layer.build(layer(ctx, options, ownBackground)).pipe(Effect.map((built) => Option.some(Context.get(built, HeavyHost)))),
      })
      const footerNow = (agent: string, self: Option.Option<string>): Effect.Effect<Option.Option<string>> =>
        Option.match(
          Option.filter(host, () => isHeavy(agent)),
          {
            onNone: () => Effect.succeedNone,
            onSome: (heavyHost) =>
              heavyHost.read(self).pipe(
                Effect.map((reading) => ({ cores: reading.host.cores, working: reading.working })),
                Effect.timeout(HEAVY_READ),
                Effect.catchCause(() => heavyHost.cores.pipe(Effect.map((cores) => ({ cores, working: 0 })))),
                Effect.map(({ cores, working }) => footerFor(agent, cores, working)),
              ),
          },
        )
      /** `prompt` with the footer of `agent`'s role at its end, when it has one. */
      const footed = (agent: string, self: Option.Option<string>, prompt: string) =>
        footerNow(agent, self).pipe(Effect.map(Option.match({ onNone: () => prompt, onSome: (footer) => withFooter(prompt, footer) })))
      // The subagent tool's own execute, as the last tool transform saw it: a latched child starts through it,
      // in the background on the existing child.
      let subagent: Execute | undefined
      const run = (request: LatchStart, prompt: string) =>
        Effect.suspend(() => {
          if (subagent === undefined) return Effect.fail(new Error("the subagent tool is not loaded"))
          const context: ToolContext = {
            sessionID: request.parent as ToolContext["sessionID"],
            agent: request.from as ToolContext["agent"],
            messageID: request.messageID as ToolContext["messageID"],
            id: request.callID as ToolContext["id"],
            progress: () => Effect.void,
          }
          return subagent(
            {
              agent: request.agent,
              description: request.description,
              prompt,
              ...(request.model === undefined ? {} : { model: request.model }),
              sessionID: request.child,
              background: true,
            },
            context,
          ).pipe(Effect.asVoid)
        })
      // A latched child's prompt gets its footer as it opens, with the share of that moment.
      const start: LatchesLive.Start = (request) =>
        footed(request.agent, Option.some(request.child), `${SPAWNED}\n${request.prompt}`).pipe(Effect.flatMap((prompt) => run(request, prompt)))
      const config = {
        place: options.place,
        fullAgent: options.fullAgent,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.codex === false ? {} : { codex: { providers: options.codex.providers, ...(options.codex.pool === undefined ? {} : { pool: options.codex.pool }) } }),
        ...(options.planner === undefined ? {} : { planner: options.planner }),
      }
      const services = yield* Layer.build(
        Layer.mergeAll(
          Model.layer(config),
          Model.verdictLayer,
          Model.idleLayer({ place: options.place, ...(options.now === undefined ? {} : { now: options.now }) }),
          Model.driftLayer({ place: options.place, ...(options.now === undefined ? {} : { now: options.now }) }),
        ).pipe(Layer.provideMerge(externals(ctx, options, start, ownBackground))),
      )
      const orchestrate = Context.get(services, Model.Orchestrate)
      const verdicts = Context.get(services, Model.Verdicts)
      const idleRoots = Context.get(services, Model.IdleRoots)
      const scope = yield* Effect.scope

      // An idle root with ready work is steered once per idle period (idle.ts). The decision runs on
      // the plugin's scope, so the session goes idle at once; the nudge wakes it.
      const logged = (sessionID: string) => (outcome: Model.IdleOutcome | undefined) =>
        outcome === undefined
          ? Effect.void
          : outcome._tag === "Nudged"
            ? Effect.logInfo("orchestrate: nudged an idle root").pipe(Effect.annotateLogs({ sessionID, line: outcome.line }))
            : outcome._tag === "Refused"
              ? Effect.logWarning("orchestrate: the nudge did not reach the root").pipe(Effect.annotateLogs({ sessionID, message: outcome.message }))
              : Effect.logDebug("orchestrate: no nudge").pipe(Effect.annotateLogs({ sessionID, why: outcome.why, detail: outcome.detail }))
      const background = (sessionID: string, work: Effect.Effect<Model.IdleOutcome | undefined>) =>
        work.pipe(Effect.flatMap(logged(sessionID)), Effect.ignoreCause, Effect.forkIn(scope), Effect.asVoid)
      yield* ctx.session.hook("experimental.idle", (event) =>
        idleRoots.idle(event.sessionID, event.background.length).pipe(Effect.flatMap((decide) => background(event.sessionID, decide))),
      )

      // A root whose run saw an older skill is told once what changed, and to reconcile the run's rules files.
      const drifts = Context.get(services, Model.SkillDrifts)
      const driftLogged = (sessionID: string) => (outcome: Model.DriftOutcome) =>
        outcome._tag === "Told"
          ? Effect.logInfo("orchestrate: told a root its runs' skill changed").pipe(Effect.annotateLogs({ sessionID, runs: outcome.runs.join(", ") }))
          : outcome._tag === "Refused"
            ? Effect.logWarning("orchestrate: the skill note did not reach the root").pipe(Effect.annotateLogs({ sessionID, message: outcome.message }))
            : Effect.logDebug("orchestrate: no skill note").pipe(Effect.annotateLogs({ sessionID, why: outcome.why }))
      yield* ctx.session.hook("experimental.idle", (event) =>
        drifts.idle(event.sessionID).pipe(Effect.flatMap(driftLogged(event.sessionID)), Effect.ignoreCause, Effect.forkIn(scope), Effect.asVoid),
      )
      // The `orchestrate` tool's reads (mods/orchestrate/tools.ts), at each call: the run tables (the status plugin's
      // RPC, through `Runs`) and the warm source's Rifts (the rift plugin's RPC). Its lanes, its verify checkout and
      // its land go to this location's rift plugin over the rift RPC (`@dotfiles/opencode-work/rpc`). Nothing of a
      // run is kept between calls.
      const riftRpc = () => ctx.rpc(RIFT_RPC)
      const sessions = Context.get(services, Sessions)
      const runs = Context.get(services, Runs)
      const remind = Context.get(services, Remind)
      const failWith = (message: string) => Effect.fail(new Tool.Error({ message }))
      const unanswered = () => new Tool.Error({ message: "orchestrate: the rift plugin did not answer over its RPC; it is loaded with this plugin in every location." })
      /** A rift RPC answer, or its failure's words. */
      const answeredOr = <A extends { readonly outcome: string }>(answer: A | RiftFailed): Effect.Effect<A, Tool.Error> => {
        if (isRiftFailed(answer)) return failWith(answer.message)
        return Effect.succeed(answer)
      }
      /** The warm source's Rifts, as the rift plugin lists them for the session. */
      const listLanes = (sessionID: string, source: Option.Option<string>) =>
        riftRpc().list(Option.match(source, { onNone: () => ({ sessionID }), onSome: (directory) => ({ sessionID, source: directory }) })).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Listed)),
          Effect.mapError(unanswered),
          Effect.flatMap(answeredOr),
        )
      /** The Rifts as status reads them: none when the rift plugin does not answer, so status still answers the tables. */
      const lanesNow = (sessionID: string): Effect.Effect<{ readonly rifts: ReadonlyArray<Tools.Lane>; readonly workrift: boolean }> =>
        Effect.suspend(() => listLanes(sessionID, Option.none())).pipe(Effect.catchCause(() => Effect.succeed({ rifts: [], workrift: false })))
      // The default branch and the runs' files (tools.ts `MainSince`, `UnitFiles`), read at each call in this
      // location's checkout: nothing of them is kept between calls.
      const mainLine = Context.get(services, MainLine)
      const runFiles = Context.get(services, RunFiles)
      const unitLogs = Context.get(services, UnitLogs)
      const checkout = ctx.location.directory
      /** The run dirs the run tables name, once each. */
      const runDirsOf = (tables: ReadonlyArray<RunTable>): ReadonlyArray<string> => Arr.dedupe(tables.flatMap((run) => Option.toArray(Option.fromUndefinedOr(run.dir))))
      /**
       * The units of the run dirs whose newest request's head `head` holds and `base` does not, by one read of the
       * range's commits: what a verify of main covers, landed by a merge or a fast-forward alike.
       */
      const unitsBetween = (dirs: ReadonlyArray<string>, base: string, head: string) =>
        Effect.all([Effect.forEach(dirs, (dir) => runFiles.units(dir)), mainLine.between(checkout, base, head)]).pipe(
          Effect.map(([each, commits]) =>
            each.flat().flatMap((unit): ReadonlyArray<Tools.RangeUnit> =>
              Option.toArray(
                Option.flatMap(unit.request, (request) =>
                  Option.map(
                    Option.filter(request.head, (commit) => Tools.inRange(commits, commit)),
                    () => ({ unit: unit.unit, dir: unit.dir, round: request.round, spec: `${unit.dir}/spec.md`, request: request.path }),
                  ),
                ),
              ),
            ),
          ),
        )
      /**
       * The last verify the run dirs record, the base a verify of main at `head` takes from it (with none, from the
       * newest merges), and the first-parent merges since that base.
       */
      const rangeOf = (dirs: ReadonlyArray<string>, head: string) =>
        Effect.gen(function* () {
          const last = yield* runFiles.verified(dirs)
          const newest = yield* Option.match(last, {
            onNone: () => mainLine.merges(checkout, head, Option.none(), Tools.FIRST_VERIFY_BACK + 1),
            onSome: () => Effect.succeed<ReadonlyArray<Tools.Merge>>([]),
          })
          const base = Tools.verifyBaseOf(head, last, newest)
          const merges = yield* mainLine.merges(checkout, head, Option.some(base), MERGES_READ)
          return { last, base, merges }
        })
      /** The default branch since the last verify the run dirs record, its lands counted (`landsOf`); none with no run dir or no default branch. */
      const mainSince = (tables: ReadonlyArray<RunTable>, at: Option.Option<string>) =>
        Effect.gen(function* () {
          const dirs = runDirsOf(tables)
          if (dirs.length === 0) return Option.none<Tools.MainSince>()
          const tip = yield* mainLine.tip(checkout, at)
          if (Option.isNone(tip)) return Option.none()
          const { last, base, merges } = yield* rangeOf(dirs, tip.value.head)
          const units = yield* unitsBetween(dirs, base, tip.value.head)
          return Option.some({ branch: tip.value.branch, head: tip.value.head, base, lands: Tools.landsOf(merges.length, units.length), last })
        })
      /** The unit's dir: the one a run dir of the tables holds, else the one the unit logs find under the checkout. */
      const unitDirOf = (unit: string, tables: ReadonlyArray<RunTable>) =>
        unitLogs.find({ unit, named: runDirsOf(tables).map((dir) => `${dir}/${unit}`), directory: checkout }).pipe(Effect.map(Option.fromUndefinedOr))
      /** Status: the verify-due line, the run tables, each open unit's lane and the next call. */
      const status = (sessionID: string) =>
        Effect.gen(function* () {
          const tables = yield* runs.list
          const since = yield* mainSince(tables, Option.none())
          const now = yield* Clock.currentTimeMillis
          if (!tables.some((run) => run.units.length > 0)) return Tools.statusAnswer([], [], false, since, now)
          const listed = yield* lanesNow(sessionID)
          return Tools.statusAnswer(tables, listed.rifts, listed.workrift, since, now)
        })

      // A root that compacted is told its status, its ledger and the re-read, once per compaction, by this location's
      // copy only, when it runs units: it started a step of a unit (the call log's steps, as the idle steer reads
      // them), whatever the run tables say. Tables that cannot be read give way to the error and the units it started
      // (Ledger.unreadTables), never to silence. A subagent, and a root that started no step, are told nothing.
      const told = new Set<string>()
      const stepLog = Context.get(services, StepLog)
      const holds = Context.get(services, RootHolds)
      /** A subagent of the root as the ledger shows it, read from its session; none when it is neither running, latched nor waiting on the root. */
      const subagentNow = (child: Ledger.Child, units: Ledger.Calls["units"], open: (unit: string) => boolean): Effect.Effect<Option.Option<Ledger.SubagentNow>> =>
        Effect.gen(function* () {
          const opensAt = Option.fromUndefinedOr(yield* sessions.latchOf(child.child))
          if (Option.isSome(opensAt)) return Option.some(Ledger.SubagentNow.cases.Latched.make({ child, opensAt: opensAt.value }))
          const idleSince = Option.filter(yield* sessions.idleSinceOf(child.child), () => ownBackground(child.child) === 0)
          if (Option.isNone(idleSince)) {
            const started = yield* sessions.startedOf(child.child)
            return Option.map(Option.liftPredicate(child, () => started), (running) => Ledger.SubagentNow.cases.Running.make({ child: running }))
          }
          const said = Option.getOrElse(Option.fromUndefinedOr(yield* sessions.lastWordsOf(child.child)), () => "")
          const handBack = Option.fromUndefinedOr(handBackOf(child.agent, said))
          const first = Option.getOrElse(Arr.findFirst(said.split("\n"), (line) => line.trim() !== ""), () => "").trim()
          return Option.map(
            Option.liftPredicate(child, () => Ledger.unanswered(child, idleSince.value, handBack, units, open)),
            (waiting) => Ledger.SubagentNow.cases.Unanswered.make({ child: waiting, idleSince: idleSince.value, said: first }),
          )
        })
      const ledgerOf = (sessionID: string, tables: ReadonlyArray<RunTable>, unread: boolean) =>
        Effect.gen(function* () {
          const calls = yield* stepLog.calls(sessionID)
          const open = (unit: string) => unread || tables.some((run) => run.units.some((each) => each.unit === unit && !Ledger.closed(each.state)))
          const now = yield* Effect.forEach(calls.children.slice(0, Ledger.CHILDREN_READ), (child) => subagentNow(child, calls.units, open), { concurrency: 4 })
          const held = yield* holds.held(sessionID)
          return Ledger.ledgerText(held, now.flatMap(Option.toArray))
        })
      const tellCompacted = Effect.fn("Orchestrate.compacted")(function* (sessionID: string) {
        const skipped = (why: string) => Effect.logInfo(`orchestrate: no compaction note: ${why}`).pipe(Effect.annotateLogs({ sessionID }))
        if (Predicate.isNotUndefined(yield* sessions.parentOf(sessionID))) return yield* skipped("a subagent")
        const started = yield* stepLog.units(sessionID)
        if (started.length === 0) return yield* skipped("it started no unit's step")
        const read = yield* runs.read
        const status = yield* Option.match(read.error, {
          onSome: (error) =>
            Effect.logWarning("orchestrate: the run tables did not read; the compaction note gives the error and the root's units").pipe(
              Effect.annotateLogs({ sessionID, error }),
              Effect.as(Ledger.unreadTables(error, started)),
            ),
          onNone: () => lanesNow(sessionID).pipe(Effect.map((listed) => Tools.statusAnswer(read.runs, listed.rifts, listed.workrift))),
        })
        const ledger = yield* ledgerOf(sessionID, read.runs, Option.isSome(read.error))
        yield* remind.remind(sessionID, { text: Tools.compactedNote(`${status}\n\n${ledger}`), description: Tools.COMPACTED_DESCRIPTION }).pipe(
          Effect.andThen(Effect.logInfo("orchestrate: told a compacted root its status").pipe(Effect.annotateLogs({ sessionID }))),
          Effect.catch((refused) => Effect.logWarning("orchestrate: the compaction note did not reach the root").pipe(Effect.annotateLogs({ sessionID, message: refused.message }))),
        )
      })
      const compacted = (id: string, sessionID: string) => {
        if (told.has(id)) return Effect.void
        told.add(id)
        return ctx.session.get({ sessionID: sessionID as SessionID }).pipe(
          Effect.flatMap((session) =>
            samePlace(
              { directory: session.location.directory, workspaceID: session.location.workspaceID },
              { directory: ctx.location.directory, workspaceID: ctx.location.workspaceID },
            )
              ? tellCompacted(sessionID)
              : Effect.void,
          ),
          Effect.ignoreCause,
          Effect.forkIn(scope),
          Effect.asVoid,
        )
      }
      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: ["session.inbox.enqueued", "session.inbox.delivered", "session.inbox.cancelled", "session.deleted", "session.compaction.ended"] }).pipe(
          Stream.runForEach((event) => {
            if (event.type === "session.compaction.ended") return compacted(event.id, event.data.sessionID)
            if (event.type === "session.deleted")
              return Effect.sync(() => void backgrounds.delete(event.data.sessionID)).pipe(Effect.andThen(idleRoots.forget(event.data.sessionID)))
            // Delivered or cancelled, the item no longer waits in the inbox.
            if (event.type === "session.inbox.delivered" || event.type === "session.inbox.cancelled") return idleRoots.ended(event.data.sessionID, event.data.inboxID)
            const item = event.data.item
            // New input: the owner's prompt or another plugin's message; never the nudge or the brief.
            const heard =
              item.type === "user" ||
              (item.type === "synthetic" && item.payload.metadata?.[MARK] === undefined && item.payload.metadata?.[SteerLive.BRIEF_MARK] === undefined)
            return heard ? idleRoots.heard(event.data.sessionID, event.data.inboxID) : Effect.void
          }),
          Effect.ignoreCause,
        ),
        { startImmediately: true },
      )
      yield* ctx.rpc
        .register(IDLE, {
          draft: (input) =>
            Schema.decodeUnknownEffect(Draft)(input).pipe(
              Effect.tap((draft) => background(draft.sessionID, idleRoots.draft(draft))),
              Effect.as({ ok: true }),
              Effect.orElseSucceed(() => ({ ok: false })),
            ),
        })
        .pipe(Effect.orDie)

      // The roles, defined as OpenCode's own plugins define build and general: before the
      // config's agent files, so a file in the owner's config still overrides a role's fields.
      // Each role and each primary agent compacts at `WINDOW`. Config agent files
      // cannot set a window, and the config's agents arrive after this, so a primary agent
      // defined only in a config file keeps the model's ceiling.
      yield* ctx.agent.transform((editor) => {
        for (const agent of editor.list()) {
          if (agent.mode === "subagent" || agent.hidden) continue
          editor.update(agent.id, (item) => {
            item.request.settings.compactionWindow = WINDOW
          })
        }
        for (const role of ROLES) {
          const definition = definitions[role]
          editor.update(role, (item) => {
            item.description = definition.description
            item.system = definition.system
            item.mode = definition.mode
            item.permissions.push(...definition.permissions.map((rule) => ({ ...rule })))
            item.request.settings.compactionWindow = WINDOW
            item.request.settings.cacheTTL = ROLE_CACHE_TTL
          })
        }
      })

      // A turn the server resumed after a restart inside the Sabbath rest (a crash, a restart by hand) makes no
      // model request until the rest ends (restart-hold.ts); any other request, and every one outside it, goes at once.
      const sabbathClock = Option.match(Option.fromNullishOr(options.now), { onNone: () => Clock.currentTimeMillis, onSome: Effect.succeed })
      yield* ctx.session.hook("model.request", (event) =>
        Effect.gen(function* () {
          const at = yield* sabbathClock
          if (!rest(at, options.place).on) return
          const messages: ReadonlyArray<unknown> = yield* ctx.session.context({ sessionID: event.sessionID }).pipe(Effect.orElseSucceed(() => []))
          const until = heldUntil(messages, at, options.place)
          if (Option.isNone(until)) return
          yield* Effect.logInfo(`orchestrate: ${event.sessionID}'s turn, resumed after a restart in the Sabbath, waits until ${local(until.value, options.place)}`)
          yield* Effect.sleep(until.value - at)
        }),
      )

      // The keep-list goes after the conversation as its own user message, which the host's summary prompt follows,
      // so the compaction request keeps the conversation's cached prefix (system, tools and messages as the normal
      // request sends them). An addition to `system` would sit before every message and cost the whole cache. The
      // host's history fallback (a conversation too large to send whole) drops what follows the kept tail, so on that
      // path the summary goes without the keep-list.
      yield* ctx.session.hook("compaction", (event) =>
        Effect.sync(() => {
          event.messages.push(keepMessage())
        }),
      )

      // A latched call's answer, by its child: the call's input names the child, and the
      // subagent tool answers it from here instead of starting it. A kernel cell's calls
      // share one call id, so the child, not the call, is the key.
      const latched = new Map<string, ReturnType<typeof latchedResult>>()
      // A fallback agent's note, by its call (noteKey), put first in the subagent tool's answer.
      const notes = new Map<string, string>()
      yield* ctx.tool.transform((editor) =>
        editor.update(SUBAGENT, (tool) => {
          const execute = tool.execute
          subagent = execute
          tool.output = SubagentOutput
          tool.execute = (input, context) => {
            const child = isObject(input) && typeof input.sessionID === "string" ? input.sessionID : undefined
            const answer = child === undefined ? undefined : latched.get(child)
            const key = noteKey(context.sessionID, context.id, input)
            const note = notes.get(key)
            if (note !== undefined) {
              notes.delete(key)
              return execute(input, context).pipe(
                Effect.map((result) => ({
                  ...result,
                  output: isObject(result.output) && typeof result.output.output === "string" ? { ...result.output, output: `${note}\n${result.output.output}` } : result.output,
                  content: typeof result.content === "string" ? `${note}\n${result.content}` : result.content,
                })),
              )
            }
            if (child === undefined || answer === undefined) return execute(input, context)
            latched.delete(child)
            return Effect.succeed(answer)
          }
        }),
      )

      // The wakes ask here when a latch's time comes.
      yield* ctx.rpc
        .register(OPENER, {
          open: (input) =>
            Schema.decodeUnknownEffect(Latch)(input).pipe(
              Effect.flatMap(
                (latch): Effect.Effect<Opened> =>
                  orchestrate.openLatch({
                    parent: latch.sessionID,
                    from: latch.subagent.from,
                    messageID: latch.subagent.messageID,
                    callID: latch.subagent.callID,
                    child: latch.child,
                    agent: latch.subagent.agent,
                    description: latch.subagent.description,
                    prompt: latch.subagent.prompt,
                    ...(latch.subagent.model === undefined ? {} : { model: latch.subagent.model }),
                    context: latch.context,
                  }),
              ),
              Effect.catch((error) => Effect.succeed<Opened>({ outcome: "failed", message: `not a latch: ${error.message}` })),
            ),
        })
        .pipe(Effect.orDie)

      // The `orchestrate` tool (mods/orchestrate/tools.ts): the run's steps for a root that runs units, one direct
      // tool, every answer computed at the call (above). No batch rule refuses it: a land of a unit the run tables show
      // in another state than `ready` lands with a warning first.
      /** A new Rift, made by the rift plugin's create. */
      const createRift = (ask: { readonly sessionID: string; readonly branch: string; readonly name: string; readonly source?: string; readonly at?: string }) =>
        riftRpc().create(ask).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Created)), Effect.mapError(unanswered), Effect.flatMap(answeredOr))
      /** Whether a session is a subagent's: the root lanes, lands and verifies. */
      const isChild = (sessionID: string) => Effect.map(sessions.parentOf(sessionID), Predicate.isNotUndefined)
      /** Why a call does not run: the input rule, then its names. */
      const refusedInput = (input: Tools.OrchestrateInput) => Option.orElse(Tools.inputRefusal(input), () => Tools.nameRefusal(input))

      /** A lane: the unit's Rift, answered when one is its own, else made. */
      const lane = (input: Tools.OrchestrateInput, sessionID: string) =>
        Effect.gen(function* () {
          const unit = input.unit ?? ""
          const branch = Tools.laneBranchOf({ ...input, unit })
          const source = Option.fromUndefinedOr(input.source)
          const listed = yield* listLanes(sessionID, source)
          // On the workbox, workrift names a Rift after its branch; elsewhere it is the unit's.
          const name = Option.getOrElse(Option.liftPredicate(workriftName(branch), () => listed.workrift), () => unit)
          const decided = Tools.laneDecision(unit, branch, name, listed.workrift, listed.rifts)
          if ("refused" in decided) return yield* failWith(decided.refused)
          if ("found" in decided) return Tools.laneAnswer(unit, decided.found, false)
          const ask = { sessionID, branch, name: decided.make }
          const created = yield* createRift(Option.match(source, { onNone: () => ask, onSome: (directory) => ({ ...ask, source: directory }) }))
          return Tools.laneAnswer(unit, created.rift, true)
        })

      /** A verify's clean checkout: the Rift `verify-<batch>` detached at `at`, answered when it exists, else made. */
      const verifyLane = (sessionID: string, batch: string, at: string) =>
        Effect.gen(function* () {
          const name = Tools.verifyLaneOf(batch)
          const listed = yield* listLanes(sessionID, Option.none())
          const found = Tools.laneNamed(name, listed.rifts)
          if (Option.isSome(found)) return { lane: found.value, made: false }
          const created = yield* createRift({ sessionID, branch: name, name, at })
          return { lane: created.rift, made: true }
        })

      /** A verify of a batch the root names: the verifier's clean checkout at the head, and the subagent call that starts it. */
      const verifyBatch = (batch: string, input: Tools.OrchestrateInput, sessionID: string) =>
        Effect.gen(function* () {
          const chosen = Option.match(Option.fromUndefinedOr(input.head), { onNone: () => "origin" as const, onSome: () => "given" as const })
          const { lane, made } = yield* verifyLane(sessionID, batch, input.head ?? "origin/HEAD")
          return Tools.verifyAnswer(batch, lane, made, chosen)
        })



      /** The fleet's heads for a verify at `head`: the dotfiles commit of `head` and the fork's checked-out commit, each by `git rev-parse`; none unless both resolve. */
      const fleetHeads = (head: string) =>
        Option.match(Option.fromNullishOr(options.fleet), {
          onNone: () => Effect.succeedNone,
          onSome: (fleet) =>
            Effect.all([mainLine.commitOf(fleet.dotfiles, head), mainLine.commitOf(fleet.fork, "HEAD")]).pipe(
              Effect.map(([dotfiles, fork]) => Option.zipWith(dotfiles, fork, (d, f) => ({ dotfiles: d, fork: f }))),
            ),
        })

      /**
       * A verify of main (no batch): named `main-<short head>`, from the last verified head (else the fifth merge back) to
       * `head` (else origin's default branch head, read now); its batch file written into the run dir, its clean
       * checkout, and the subagent call that starts its verifier.
       */
      const verifyMain = (input: Tools.OrchestrateInput, sessionID: string) =>
        Effect.gen(function* () {
          const asked = Option.fromUndefinedOr(input.head)
          const tables = yield* runs.list
          const tip = yield* mainLine.tip(checkout, asked)
          if (Option.isNone(tip))
            return yield* failWith(
              `orchestrate: verify: ${Option.match(asked, { onNone: () => "no default branch (origin/HEAD, main or master) reads here", onSome: (head) => `${head} is no commit here` })}, so main cannot be verified. Name a batch you wrote: ${Tools.verifyCallOf("batch-<k>")}.`,
            )
          const head = tip.value.head
          const name = Tools.mainVerifyName(head)
          const dirs = runDirsOf(tables)
          const { last, base, merges } = yield* rangeOf(dirs, head)
          const units = yield* unitsBetween(dirs, base, head)
          const batch: Tools.MainBatch = { name, base, head, last, merges, units, heads: yield* fleetHeads(head) }
          const file = Option.map(Tools.mainRunDirOf(dirs, units), (dir) => Tools.mainBatchPathOf(dir, name))
          yield* Effect.forEach(Option.toArray(file), (path) => runFiles.write(path, Tools.mainBatchText(batch)), { discard: true }).pipe(
            Effect.catchTag("RunFileUnwritten", (unwritten) => failWith(`orchestrate: verify ${name}: the batch file ${unwritten.path} could not be written: ${unwritten.message}`)),
          )
          const { lane, made } = yield* verifyLane(sessionID, name, head)
          return Tools.mainVerifyAnswer(batch, file, lane, made, Option.match(asked, { onNone: () => "origin" as const, onSome: () => "given" as const }))
        })

      /** A verify: of the batch named, else of main since the last verify. */
      const verify = (input: Tools.OrchestrateInput, sessionID: string) =>
        Option.match(Option.fromUndefinedOr(input.batch), { onNone: () => verifyMain(input, sessionID), onSome: (batch) => verifyBatch(batch, input, sessionID) })

      /** A land: the units resolved to their Rifts from the run tables and the Rift list, landed by the rift plugin's land. */
      const land = (input: Tools.OrchestrateInput, sessionID: string) =>
        Effect.gen(function* () {
          const tables = yield* runs.list
          const listed = yield* listLanes(sessionID, Option.none())
          const resolved = Tools.resolveLand(input, tables, listed.rifts, listed.workrift)
          if ("refused" in resolved) return yield* failWith(resolved.refused)
          if ("nothing" in resolved) return resolved.nothing
          const rifts = resolved.rifts.map((rift) => ({ path: rift.path, unit: rift.unit }))
          // The warnings, read before the land: a verify due on main, each unit's open `changes` verdict, each unit not ready.
          const [since, dirs] = yield* Effect.all([mainSince(tables, Option.none()), Effect.forEach(rifts, (rift) => unitDirOf(rift.unit, tables))])
          const files = yield* Effect.forEach(Arr.getSomes(dirs), (dir) => runFiles.unit(dir))
          const now = yield* Clock.currentTimeMillis
          const due = Option.toArray(Option.flatMap(since, (read) => Tools.dueWarning(read, now)))
          const landed = yield* riftRpc()
            .land({ sessionID, rifts })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(LandAnswered)), Effect.mapError(unanswered), Effect.flatMap(answeredOr))
          // The log follows the land: each unit the land pushed, whose dir is known and whose run table holds it, moves to
          // `merged <pushed commit>`. A missed line changes no answer: status.ts reads git.
          yield* Effect.forEach(Option.toArray(Tools.pushedOf(landed.text)), (pushed) =>
            Effect.forEach(
              rifts.flatMap((rift, at) =>
                Option.toArray(Option.zipWith(Option.flatten(Arr.get(dirs, at)), Tools.roundIn(rift.unit, tables), (dir, round) => ({ dir, unit: rift.unit, round }))),
              ),
              (move) => unitLogs.append(move.dir, { unit: move.unit, to: "merged", round: move.round, note: pushed }),
              { discard: true },
            ),
          { discard: true })
          return Tools.landAnswer([...due, ...Tools.changesWarnings(files), ...resolved.warnings], landed.text)
        })

      yield* ctx.tool.transform((editor) =>
        editor.add({
          name: Tools.ORCHESTRATE,
          description: Tools.ORCHESTRATE_DESCRIPTION,
          input: Tools.OrchestrateInput,
          options: { codemode: false },
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.action !== "status" && (yield* isChild(context.sessionID))) return yield* failWith(Tools.parentRefusal(input.action))
              const refused = refusedInput(input)
              if (Option.isSome(refused)) return yield* failWith(refused.value)
              const text = yield* Match.value(input.action).pipe(
                Match.when("status", () => status(context.sessionID)),
                Match.when("lane", () => lane(input, context.sessionID)),
                Match.when("verify", () => verify(input, context.sessionID)),
                Match.when("land", () => land(input, context.sessionID)),
                Match.exhaustive,
              )
              return { content: [{ type: "text" as const, text }], metadata: { action: input.action } }
            }),
        }),
      )

      yield* ctx.tool.hook("execute.before", (event) => {
        const call = { sessionID: event.sessionID, callID: event.id }
        if (event.tool !== SUBAGENT) return orchestrate.useTool({ call, tool: event.tool }).pipe(Effect.mapError((rejection) => refusal(event.tool, rejection, options.place)))
        const key = noteKey(event.sessionID, event.id, event.input)
        return orchestrate.startSubagent({ call, from: event.agent, messageID: event.messageID, input: event.input }).pipe(
          Effect.mapError((rejection) => refusal(event.tool, rejection, options.place)),
          Effect.map((outcome) => {
            if (Option.isNone(outcome) || !isObject(event.input)) return outcome
            const routed = outcome.value._tag === "LatchedStart" ? outcome.value.latched : outcome.value
            // Run the call as the guard routed it, on the role's model when one was chosen.
            const input: Record<string, unknown> = { ...event.input, agent: routed.agent }
            if (routed.model !== undefined) input.model = routed.model
            // A named model was dropped (the role's own, or a Codex model an implementor named): with no variant chosen,
            // the role runs on its own model, a follow-up on its child's.
            else if (routed.reason === "model-dropped" || routed.dropped !== undefined) delete input.model
            // A fallback's answer tells the parent where it ran and why; a lowered worker's, at what effort and why.
            if (outcome.value._tag === "SubagentStarted") {
              const said = [
                ...(outcome.value.fallback === undefined ? [] : [fallbackNote(outcome.value)]),
                ...(outcome.value.lowered === undefined ? [] : [effortNote(outcome.value)]),
              ]
              if (said.length > 0) notes.set(key, said.join("\n"))
            }
            // A latched call names its child, whose answer the subagent tool gives back at once.
            if (outcome.value._tag === "LatchedStart") {
              latched.set(outcome.value.child, latchedResult(outcome.value, options.place))
              input.sessionID = outcome.value.child
            }
            event.input = input
            return outcome
          }),
          // A heavy role's started prompt ends with its footer: a new start's and a follow-up's alike. A latched
          // start's gets its own when it opens (`start`).
          Effect.flatMap((outcome) => {
            const input = event.input
            const asked = decodePrompted(input)
            if (Option.isNone(outcome) || outcome.value._tag !== "SubagentStarted" || Option.isNone(asked) || !isObject(input)) return Effect.void
            return footed(outcome.value.agent, Option.fromNullishOr(outcome.value.child), asked.value.prompt).pipe(
              Effect.map((prompt) => {
                event.input = { ...input, prompt }
              }),
            )
          }),
        )
      })

      // A role's subagent that goes idle may have handed back: its unit moves in the run's log, and a verifier's
      // `accepted` records the fleet target (once per verdict, off the idle path: the record reads git).
      yield* ctx.session.hook("experimental.idle", (event) =>
        Effect.gen(function* () {
          // What still runs of its own: a step idle with its shell or subagent running has not ended.
          backgrounds.set(event.sessionID, event.background.filter((work) => work.sessionID === event.sessionID).length)
          yield* orchestrate.handBack({ sessionID: event.sessionID })
          yield* verdicts.handBack(event.sessionID).pipe(Effect.ignoreCause, Effect.forkIn(scope))
        }),
      )
      yield* ctx.tool.hook("execute.after", (event) => {
        if (event.tool !== SUBAGENT) return Effect.void
        const metadata = event.status === "completed" ? event.result.metadata : undefined
        const child = isObject(metadata) && typeof metadata.sessionID === "string" ? metadata.sessionID : undefined
        const status: Status =
          event.status === "error"
            ? "error"
            : isObject(metadata) && (metadata.status === "running" || metadata.status === "latched")
              ? metadata.status
              : "completed"
        return orchestrate.finishSubagent({
          call: { sessionID: event.sessionID, callID: event.id },
          ...(child === undefined ? {} : { child }),
          status,
        })
      })
    }),
  })

export default make(live, liveHeavy)
