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
 *   refused so it ends its turn. The main session answers as always.
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
 * - `experiment`: `{ role, model, share }`, the model experiment
 *   (mods/orchestrate/experiment.ts): `share` of the role's units, by a hash
 *   of the unit's name, start on `model` at the role's effort (the trial arm),
 *   the rest on the role's own (control). Only a new start that names no model
 *   of its own (or the role's) is in an arm; a follow-up keeps its model. A
 *   trial start the host does not offer `model` for, or whose pace holds it,
 *   takes the normal chain (the role's model, then Codex). Each start's line
 *   records `experiment: { arm, model[, fellBack] }`. Absent, no experiment.
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
 * - Batch machine: the plugin keeps each root's machine (mods/orchestrate/
 *   machine.ts) in a ledger, one JSONL line per event or refusal (keyed by
 *   the root session alone, read afresh by every location's copy, compacted
 *   past 256 KiB), from the
 *   role starts, hand-backs and `rift` lands it sees, and refuses a call
 *   against its six rules in the skill's words: a verifier not named for a
 *   batch, a second verifier, a land or verifier before the cadence while an
 *   implementor runs, a land before the last batch's verdict, a land with a
 *   finding of it not folded into a ready unit, a land that leaves a ready
 *   unit out. The machine is a pipeline: implementors start while a verifier
 *   runs; a verifier's findings (read from its report) fold into the next
 *   batch by an implementor's start, and the next batch verifier's prompt
 *   lists them. `(departs: <why>)` in a description, or `departs` in a
 *   land's input, lets the call through and records it. A step whose session
 *   no longer works is handed back as `none` first. After a root's
 *   compaction, it gets one message (no new turn): SKILL.md's machine section
 *   and its run from the ledger (the brief).
 *   Options: `ledger` (default `~/.cache/orchestrate/machine.jsonl`),
 *   `cadence: { ready, waitMs }` (default 3 and 30 minutes), `guard`:
 *   `refuse` (default) or `warn` (the call passes, its answer carries the
 *   rule's words, the ledger records the departure).
 *
 * Each new subagent is told to the pool (`started`), which counts it on its
 * provider's pace, here and on the owner's other hosts, until its spend shows
 * in a reading.
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { Agent, Plugin, Tool } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Option, Schema, SchemaGetter, Stream } from "effect"
import { POOL_STATUS } from "@dotfiles/opencode-pool/status"
import { QUESTIONS } from "@dotfiles/opencode-questions/question"
import { QUEUE } from "@dotfiles/opencode-queue/queue"
import { STATUS } from "@dotfiles/opencode-status/status"
import { Latch, MARK_KEY, type Opened, OPENER } from "@dotfiles/opencode-wake/latch"
import { WAKES } from "@dotfiles/opencode-wake/wake"
import * as CodexAdmissionLive from "@dotfiles/opencode-orchestrate/codex/admission"
import { keepMessage, WINDOW } from "@dotfiles/opencode-orchestrate/compaction"
import * as CallLogLive from "@dotfiles/opencode-orchestrate/filestore/call-log"
import * as LedgerLive from "@dotfiles/opencode-orchestrate/filestore/ledger"
import * as FindingsLive from "@dotfiles/opencode-orchestrate/filestore/findings"
import * as StepLogLive from "@dotfiles/opencode-orchestrate/filestore/step-log"
import * as RunRecordsLive from "@dotfiles/opencode-orchestrate/filestore/run-records"
import * as UnitLogsLive from "@dotfiles/opencode-orchestrate/filestore/unit-logs"
import * as SkillLive from "@dotfiles/opencode-orchestrate/git/skill"
import { Draft, IDLE, MARK } from "@dotfiles/opencode-orchestrate/idle"
import * as Model from "@dotfiles/opencode-orchestrate/model"
import * as HoldsLive from "@dotfiles/opencode-orchestrate/opencode/holds"
import * as LatchesLive from "@dotfiles/opencode-orchestrate/opencode/latches"
import * as ModelsLive from "@dotfiles/opencode-orchestrate/opencode/models"
import * as PoolPaceLive from "@dotfiles/opencode-orchestrate/opencode/pool-pace"
import * as RunsLive from "@dotfiles/opencode-orchestrate/opencode/runs"
import * as SessionsLive from "@dotfiles/opencode-orchestrate/opencode/sessions"
import * as SteerLive from "@dotfiles/opencode-orchestrate/opencode/steer"
import type { PaceHeld } from "@dotfiles/opencode-orchestrate/pace"
import { DEFAULT_CADENCE, type Refused } from "@dotfiles/opencode-orchestrate/machine"
import { samePlace } from "@dotfiles/opencode-orchestrate/opencode/sessions"
import { definitions, MACHINE_BLOCK, ROLE_CACHE_TTL, ROLES } from "@dotfiles/opencode-orchestrate/role"
import { KNOWLTON, local, Place, type SabbathRest } from "@dotfiles/opencode-orchestrate/sabbath"
import {
  type CallLog,
  type CodexAdmission,
  type GuardMode,
  type Latches,
  type Findings,
  type Ledger,
  Liveness,
  type LatchStart,
  type Models,
  type PoolPace,
  type Remind,
  type RootHolds,
  type RunRecords,
  type Runs,
  type Sessions,
  type Skill,
  type Steer,
  type StepLog,
  type Tell,
  type UnitLogs,
} from "@dotfiles/opencode-orchestrate/service"
import type { Status, StillLatched } from "@dotfiles/opencode-orchestrate/tool-call"

export const DEFAULT_LOG = join(homedir(), ".cache/orchestrate/opencode-agents.jsonl")
/** The batch machine's ledger: one line per event or refusal, of every root. */
export const DEFAULT_LEDGER = join(homedir(), ".cache/orchestrate/machine.jsonl")
/** The orchestrate skill's Codex admission: `admit: …` exit 0, `hold: …[; opens about <time>Z]` exit 1. */
export const CODEX_BUDGET = join(homedir(), ".claude/skills/orchestrate/scripts/budget.ts")
/** The orchestrate skill's log.ts, the units' logs' one writer. */
export const UNIT_LOG = join(homedir(), ".claude/skills/orchestrate/scripts/log.ts")
/** The orchestrate skill as installed: a link into the dotfiles checkout, whose history versions it. */
export const SKILL_DIR = join(homedir(), ".claude/skills/orchestrate")

const SUBAGENT = "subagent"

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

const Experiment = Schema.Struct({
  role: Schema.Literals(ROLES),
  model: Schema.String.check(Schema.isPattern(/^[^/#\s]+\/[^#\s]+$/)),
  share: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
})

const Cadence = Schema.Struct({
  ready: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  waitMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})

export const Options = Schema.Struct({
  log: Schema.String.pipe(withDefault(DEFAULT_LOG)),
  ledger: Schema.String.pipe(withDefault(DEFAULT_LEDGER)),
  cadence: Cadence.pipe(withDefault<typeof Cadence.Type>(DEFAULT_CADENCE)),
  guard: Schema.Literals(["refuse", "warn"]).pipe(withDefault<GuardMode>("refuse")),
  experiment: Schema.optional(Experiment),
  now: Schema.optional(Instant),
  place: Place.pipe(withDefault<Place>(KNOWLTON)),
  fullAgent: Schema.Boolean.pipe(withDefault(false)),
  codex: Schema.Union([Schema.Literal(false), Codex]).pipe(withDefault<false | typeof Codex.Type>(CODEX_DEFAULT)),
  unitLog: Schema.String.pipe(withDefault(UNIT_LOG)),
  skill: Schema.String.pipe(withDefault(SKILL_DIR)),
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
  | Ledger
  | Liveness
  | Remind
  | Findings

/** How much background work a session keeps of its own, as its last idle listed it. */
export type Background = (sessionID: string) => number

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]
type SyntheticInput = Parameters<Plugin.Context["session"]["synthetic"]>[0]

/**
 * The outside systems as OpenCode, the filesystem and processes provide them;
 * `start` runs a latched child through the subagent tool.
 */
export const live = (ctx: Plugin.Context, options: Options, start: LatchesLive.Start, background: Background): Layer.Layer<Externals> =>
  Layer.mergeAll(
    LedgerLive.layer(options.ledger, options.cadence),
    FindingsLive.layer,
    SteerLive.remindLayer(synthetic(ctx)),
    // A step's session works while it runs a turn (its newest start is after its last end) or keeps background
    // work of its own; a session that cannot be read does not.
    Layer.succeed(Liveness, {
      alive: (sessionID) =>
        ctx.session.get({ sessionID: sessionID as SessionID }).pipe(
          Effect.map((session) => {
            const busy = msOf(session.time.busy)
            const idle = msOf(session.time.idle)
            return (busy !== undefined && (idle === undefined || busy > idle)) || background(sessionID) > 0
          }),
          Effect.orElseSucceed(() => background(sessionID) > 0),
        ),
    }),
    CallLogLive.layer(options.log),
    SessionsLive.layer(
      (sessionID) =>
        ctx.session.get({ sessionID: sessionID as SessionID }).pipe(
          Effect.map((session) => ({
            ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
            ...(session.agent === undefined ? {} : { agent: session.agent }),
            started: session.time.busy !== undefined || session.outcome !== undefined,
            ...(session.metadata?.[MARK_KEY] === undefined ? {} : { latch: session.metadata[MARK_KEY] }),
            directory: session.location.directory,
          })),
        ),
      (sessionID) => ctx.session.context({ sessionID: sessionID as SessionID }),
    ),
    UnitLogsLive.layer(options.unitLog),
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
    CodexAdmissionLive.layer(options.codex === false ? CODEX_BUDGET : options.codex.script),
    LatchesLive.layer((ask) => ctx.rpc(WAKES).latch(ask), start),
    StepLogLive.layer(options.log),
    RunsLive.layer(() => ctx.rpc(STATUS).status({})),
    HoldsLive.layer({
      pending: (input) => ctx.rpc(WAKES).pending({ sessionIDs: [...input.sessionIDs] }),
      open: (input) => ctx.rpc(QUESTIONS).open({ sessionIDs: [...input.sessionIDs] }),
      queue: (input) => ctx.rpc(QUEUE).get(input),
    }),
    SteerLive.layer(synthetic(ctx)),
    SteerLive.tellLayer(synthetic(ctx)),
    SkillLive.layer(options.skill),
    RunRecordsLive.layer,
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
  ctx.session.synthetic({ ...input, sessionID: input.sessionID as SessionID, metadata: { ...input.metadata } } as SyntheticInput)

/** A time as the model reads it: ISO 8601, and the owner's local time. */
const timeOf = (ms: number, place: Place) => `${new Date(ms).toISOString()} (${local(ms, place)} ${place.timeZone})`

const whoseOf = (whose: string | undefined) => (whose === "codex" ? "the Codex account's" : "the pool's")

/** What the model reads when a call is refused. */
const refusal = (tool: string, rejection: SabbathRest | PaceHeld | StillLatched, place: Place): Tool.Error => {
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

/** The rift tool, whose `land` the machine decides. */
const RIFT = "rift"

/** A `rift` land's Rifts and its stated departure; none for any other call. */
const landOf = (tool: string, input: unknown): { readonly rifts: ReadonlyArray<string>; readonly departs?: string } | undefined => {
  if (tool !== RIFT || !isObject(input) || input.action !== "land" || !Array.isArray(input.rifts)) return undefined
  const rifts = input.rifts.filter((rift): rift is string => typeof rift === "string")
  return typeof input.departs === "string" && input.departs.trim() !== "" ? { rifts, departs: input.departs.trim() } : { rifts }
}

const callKey = (sessionID: string, callID: string) => `${sessionID}/${callID}`

/** What the root reads when the machine refuses its call: the refusal's own message. */
const refusedError = (refused: Refused) => new Tool.Error({ message: refused.message, error: refused })

/** The text a tool's result shows the model. */
const textOf = (result: Tool.Result): string =>
  typeof result.content === "string"
    ? result.content
    : Array.isArray(result.content)
      ? result.content.map((part: unknown) => (isObject(part) && typeof part.text === "string" ? part.text : "")).join("\n")
      : ""

/** `result` with `note` first in what the model reads. */
const prepend = (result: Tool.Result, note: string): Tool.Result => ({
  ...result,
  content:
    typeof result.content === "string"
      ? `${note}\n${result.content}`
      : Array.isArray(result.content)
        ? [{ type: "text" as const, text: note }, ...result.content]
        : result.content,
})

/** A latched call's answer with the machine's notes first. */
const withNotes = (answer: ReturnType<typeof latchedResult>, said: ReadonlyArray<string>): ReturnType<typeof latchedResult> => {
  if (said.length === 0) return answer
  const output = `${said.join("\n")}\n${answer.output.output}`
  return { ...answer, output: { ...answer.output, output }, content: output }
}

/** One Rift's line in a checked land's answer (mods/rift land.ts `checkedText`): `- <branch> (<path>): green|red|pending`. */
const OUTCOME = /^- (\S+) \((.+)\): (green|red|pending)\b/

/**
 * The Rifts a completed land landed: in a checked land (`rift.push` false), each Rift answered green or
 * pending (its gate passed), by its branch and path; in a pushed one, every Rift it was asked to land.
 */
export const greenOf = (rifts: ReadonlyArray<string>, text: string): ReadonlyArray<string> => {
  const outcomes = text.split("\n").flatMap((line) => {
    const match = OUTCOME.exec(line.trim())
    return match === null ? [] : [{ branch: match[1]!, path: match[2]!, verdict: match[3]! }]
  })
  if (outcomes.length === 0) return rifts
  return outcomes.filter((outcome) => outcome.verdict !== "red").flatMap((outcome) => [outcome.branch, outcome.path])
}

type Execute = Tool.Info["execute"]
type ToolContext = Parameters<Execute>[1]

/** The plugin on `externals`: the live systems in OpenCode, test layers in the seam tests. */
export const make = (
  externals: (ctx: Plugin.Context, options: Options, start: LatchesLive.Start, background: Background) => Layer.Layer<Externals>,
) =>
  Plugin.define({
    id: "dotfiles-opencode.orchestrate",
    effect: Effect.fn("Orchestrate.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.orchestrate: invalid options: ${error.message}`)),
        Effect.orDie,
      )
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
      const start: LatchesLive.Start = (request) => run(request, `${SPAWNED}\n${request.prompt}`)
      const config = {
        place: options.place,
        fullAgent: options.fullAgent,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.codex === false ? {} : { codex: { providers: options.codex.providers, ...(options.codex.pool === undefined ? {} : { pool: options.codex.pool }) } }),
        ...(options.experiment === undefined ? {} : { experiment: options.experiment }),
      }
      // Each session's background work of its own, as its last idle listed it: a step that went idle with a
      // shell still running has not ended.
      const backgrounds = new Map<string, number>()
      const ownBackground: Background = (sessionID) => backgrounds.get(sessionID) ?? 0
      const services = yield* Layer.build(
        Layer.mergeAll(
          Model.layer(config),
          Model.machineLayer({ cadence: options.cadence, mode: options.guard, fullAgent: options.fullAgent, block: MACHINE_BLOCK }),
          Model.idleLayer({ place: options.place, ...(options.now === undefined ? {} : { now: options.now }) }),
          Model.driftLayer({ place: options.place, ...(options.now === undefined ? {} : { now: options.now }) }),
        ).pipe(Layer.provideMerge(externals(ctx, options, start, ownBackground))),
      )
      const orchestrate = Context.get(services, Model.Orchestrate)
      const machines = Context.get(services, Model.Machines)
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
      yield* ctx.session.hook("experimental.idle", (event) => background(event.sessionID, idleRoots.idle(event.sessionID, event.background.length)))

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
      // A root that compacted is told the machine and its run, once per compaction, by this location's copy only.
      const told = new Set<string>()
      const briefLogged = (sessionID: string) => (outcome: Model.BriefOutcome) =>
        outcome._tag === "Told"
          ? Effect.logInfo("orchestrate: told a compacted root its machine and run").pipe(Effect.annotateLogs({ sessionID }))
          : outcome._tag === "Refused"
            ? Effect.logWarning("orchestrate: the brief did not reach the root").pipe(Effect.annotateLogs({ sessionID, message: outcome.message }))
            : Effect.logDebug("orchestrate: no brief").pipe(Effect.annotateLogs({ sessionID, why: outcome.why }))
      const compacted = (id: string, sessionID: string) => {
        if (told.has(id)) return Effect.void
        told.add(id)
        return ctx.session.get({ sessionID: sessionID as SessionID }).pipe(
          Effect.flatMap((session) =>
            samePlace(
              { directory: session.location.directory, workspaceID: session.location.workspaceID },
              { directory: ctx.location.directory, workspaceID: ctx.location.workspaceID },
            )
              ? machines.compacted(sessionID).pipe(Effect.flatMap(briefLogged(sessionID)))
              : Effect.void,
          ),
          Effect.ignoreCause,
          Effect.forkIn(scope),
          Effect.asVoid,
        )
      }
      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: ["session.inbox.enqueued", "session.deleted", "session.compaction.ended"] }).pipe(
          Stream.runForEach((event) => {
            if (event.type === "session.compaction.ended") return compacted(event.id, event.data.sessionID)
            if (event.type === "session.deleted")
              return Effect.sync(() => void backgrounds.delete(event.data.sessionID)).pipe(Effect.andThen(idleRoots.forget(event.data.sessionID)))
            const item = event.data.item
            // New input: the owner's prompt or another plugin's message; never the nudge or the brief.
            const heard =
              item.type === "user" ||
              (item.type === "synthetic" && item.payload.metadata?.[MARK] === undefined && item.payload.metadata?.[SteerLive.BRIEF_MARK] === undefined)
            return heard ? idleRoots.heard(event.data.sessionID) : Effect.void
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
      // A land's note under `warn` (the rule it broke), by its call, put first in the rift tool's answer.
      const landNotes = new Map<string, string>()
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

      yield* ctx.tool.hook("execute.before", (event) => {
        const call = { sessionID: event.sessionID, callID: event.id }
        if (event.tool !== SUBAGENT) {
          const used = orchestrate.useTool({ call, tool: event.tool }).pipe(Effect.mapError((rejection) => refusal(event.tool, rejection, options.place)))
          const land = landOf(event.tool, event.input)
          if (land === undefined) return used
          // A land is decided on the root's machine before it runs; a refused one never reaches the rift tool.
          return used.pipe(
            Effect.andThen(machines.land({ root: event.sessionID, ...land }).pipe(Effect.mapError(refusedError))),
            Effect.map((passed) => {
              if (passed.notes.length > 0) landNotes.set(callKey(event.sessionID, event.id), passed.notes.join("\n"))
            }),
          )
        }
        const key = noteKey(event.sessionID, event.id, event.input)
        // The machine decides first: a refused step starts, latches and counts nothing.
        return machines.start({ root: event.sessionID, key, input: event.input }).pipe(
          Effect.mapError(refusedError),
          Effect.flatMap((passed) =>
            orchestrate.startSubagent({ call, from: event.agent, messageID: event.messageID, input: event.input }).pipe(
              Effect.mapError((rejection) => refusal(event.tool, rejection, options.place)),
              // Refused by the Sabbath or the pace: the step did not start.
              Effect.tapError(() => machines.started({ root: event.sessionID, key })),
              Effect.map((outcome) => ({ outcome, passed })),
            ),
          ),
          Effect.flatMap(({ outcome, passed }) => {
            if (Option.isSome(outcome) && outcome.value._tag === "LatchedStart")
              return machines.started({ root: event.sessionID, key, child: outcome.value.child }).pipe(Effect.as({ outcome, passed }))
            return Effect.succeed({ outcome, passed })
          }),
          Effect.map(({ outcome, passed }) => {
            // A batch verifier's prompt ends with the findings it checks as folded.
            if (passed.prompt !== undefined && isObject(event.input) && typeof event.input.prompt === "string")
              event.input = { ...event.input, prompt: `${event.input.prompt}\n\n${passed.prompt}` }
            if (Option.isNone(outcome) || !isObject(event.input)) return
            const routed = outcome.value._tag === "LatchedStart" ? outcome.value.latched : outcome.value
            // Run the call as the guard routed it, on the role's model when one was chosen.
            const input: Record<string, unknown> = { ...event.input, agent: routed.agent }
            if (routed.model !== undefined) input.model = routed.model
            // A named model was dropped (the role's own, or a Codex model an implementor named): with no variant chosen,
            // the role runs on its own model, a follow-up on its child's.
            else if (routed.reason === "model-dropped" || routed.dropped !== undefined) delete input.model
            // A fallback's answer tells the parent where it ran and why; a lowered worker's, at what effort and why.
            // The machine's notes go first.
            if (outcome.value._tag === "SubagentStarted") {
              const said = [
                ...passed.notes,
                ...(outcome.value.fallback === undefined ? [] : [fallbackNote(outcome.value)]),
                ...(outcome.value.lowered === undefined ? [] : [effortNote(outcome.value)]),
              ]
              if (said.length > 0) notes.set(key, said.join("\n"))
            }
            // A latched call names its child, whose answer the subagent tool gives back at once.
            if (outcome.value._tag === "LatchedStart") {
              latched.set(outcome.value.child, withNotes(latchedResult(outcome.value, options.place), passed.notes))
              input.sessionID = outcome.value.child
            }
            event.input = input
          }),
        )
      })

      // A role's subagent that goes idle may have handed back: its unit moves in the run's log.
      yield* ctx.session.hook("experimental.idle", (event) =>
        Effect.gen(function* () {
          // What still runs of its own: a step idle with its shell or subagent running has not ended.
          backgrounds.set(event.sessionID, event.background.filter((work) => work.sessionID === event.sessionID).length)
          yield* orchestrate.handBack({ sessionID: event.sessionID })
          // Its hand-back moves its unit, or ends its verifier, on its root's machine.
          yield* machines.handBack(event.sessionID)
        }),
      )
      yield* ctx.tool.hook("execute.after", (event) => {
        if (event.tool !== SUBAGENT) {
          const land = landOf(event.tool, event.input)
          if (land === undefined) return Effect.void
          const said = landNotes.get(callKey(event.sessionID, event.id))
          landNotes.delete(callKey(event.sessionID, event.id))
          if (event.status !== "completed") return Effect.void
          if (said !== undefined) event.result = prepend(event.result, said)
          return machines.landed({ root: event.sessionID, rifts: greenOf(land.rifts, textOf(event.result)) })
        }
        const metadata = event.status === "completed" ? event.result.metadata : undefined
        const child = isObject(metadata) && typeof metadata.sessionID === "string" ? metadata.sessionID : undefined
        const status: Status =
          event.status === "error"
            ? "error"
            : isObject(metadata) && (metadata.status === "running" || metadata.status === "latched")
              ? metadata.status
              : "completed"
        return Effect.all(
          [
            orchestrate.finishSubagent({
              call: { sessionID: event.sessionID, callID: event.id },
              ...(child === undefined ? {} : { child }),
              status,
            }),
            machines.started({ root: event.sessionID, key: noteKey(event.sessionID, event.id, event.input), ...(child === undefined ? {} : { child }) }),
          ],
          { discard: true },
        )
      })
    }),
  })

export default make(live)
