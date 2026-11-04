/**
 * The orchestrate rules as an OpenCode server plugin, the Claude Code hooks'
 * counterpart. The composition root: it decodes the options, builds the model
 * (domain/Orchestrate.model.ts) on its outside systems (host/), and answers
 * OpenCode's hooks with it.
 *
 * - Roles: the planner, implementor, verifier and worker agents, from
 *   agents.json (the orchestrate skill's prompts, written by `bun run agents`).
 * - Guard: a subagent call with no agent, or with the general agent, runs as the
 *   lean `worker`; a former role name (`orchestrate-*`, `orchestrate-reviewer`)
 *   runs as the role. A new role subagent runs at the role's reasoning effort,
 *   as a variant of the model it would run on, when that model has one. Each
 *   call is a line in a JSONL log a status pane can read.
 * - Compaction: each role compacts at its own window, and the primary agents
 *   at root's, from the orchestrate tuner's compact.json, else the defaults.
 *   The window is the agent's `request.settings.compactionWindow`, which the
 *   fork's automatic compaction reads. Every compaction keeps the files, the
 *   step and the user's instructions word for word.
 * - Sabbath: from Friday sunset to 30 minutes after Saturday's at the owner's
 *   place, no subagent starts and a running subagent's next tool call is
 *   refused so it ends its turn. The main session answers as always.
 *
 * Options (all optional; a value of the wrong shape counts as absent):
 * - `windows`: path of compact.json, default `~/.cache/orchestrate/compact.json`.
 * - `log`: path of the call log, default `~/.cache/orchestrate/opencode-agents.jsonl`.
 * - `now`: a fixed time (ISO 8601) for the Sabbath clock, for tests.
 * - `place`: `{ name, lat, lon, timeZone }` for the Sabbath, default Knowlton, QC.
 * - `fullAgent`: true lets an untyped or general call run as asked.
 * - `codex`: `{ providers, script }`, the providers whose new subagents the
 *   Codex account's pace admits (default `["openai"]`) and the script run
 *   with `--codex --admit` (default the orchestrate skill's `budget.ts`, the
 *   one the Claude-side Codex bridge asks); `false` leaves them to the pool.
 */
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { Agent, Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Option, Schema, SchemaGetter } from "effect"
import { POOL_STATUS } from "../../pool/src/protocol.ts"
import { CompactionWindows } from "./domain/Agents/CompactionWindows.external.ts"
import { KEEP, ROOT } from "./domain/Compaction.ts"
import * as Model from "./domain/Orchestrate.model.ts"
import { definitions, ROLES } from "./domain/Role.ts"
import { KNOWLTON, Place } from "./domain/Sabbath.ts"
import type { CallLog } from "./domain/ToolCall/CallLog.external.ts"
import type { CodexAdmission } from "./domain/ToolCall/CodexAdmission.external.ts"
import type { Status } from "./domain/ToolCall/FinishSubagent.command.ts"
import type { Models } from "./domain/ToolCall/Models.external.ts"
import type { PoolPace } from "./domain/ToolCall/PoolPace.external.ts"
import type { SabbathRest } from "./domain/ToolCall/SabbathRest.rejection.ts"
import type { Sessions } from "./domain/ToolCall/Sessions.external.ts"
import type { PaceHeld } from "./domain/ToolCall/StartSubagent.command.ts"
import * as CallLogLive from "./host/CallLog.ts"
import * as CodexAdmissionLive from "./host/CodexAdmission.ts"
import * as CompactionWindowsLive from "./host/CompactionWindows.ts"
import * as ModelsLive from "./host/Models.ts"
import * as PoolPaceLive from "./host/PoolPace.ts"
import * as SessionsLive from "./host/Sessions.ts"

export const DEFAULT_WINDOWS = join(homedir(), ".cache/orchestrate/compact.json")
export const DEFAULT_LOG = join(homedir(), ".cache/orchestrate/opencode-agents.jsonl")
/** The orchestrate skill's Codex admission: `admit: …` exit 0, `hold: …[; opens about <time>Z]` exit 1. */
export const CODEX_BUDGET = join(homedir(), ".claude/skills/orchestrate/scripts/budget.ts")

const SUBAGENT = "subagent"

/** A value `schema` decodes, else (absent or of another shape) `fallback`. */
const lenient = <S extends Schema.Codec<any, any, never, never>>(schema: S, fallback: S["Type"]) => {
  const decode = Schema.decodeUnknownOption(schema)
  return Schema.optionalKey(Schema.Unknown).pipe(
    Schema.decodeTo(Schema.toType(schema), {
      decode: SchemaGetter.transformOptional((value) =>
        Option.some(Option.getOrElse(Option.flatMap(value, decode), () => fallback)),
      ),
      encode: SchemaGetter.passthrough(),
    }),
  )
}

/** A time as ISO 8601, read as epoch ms. */
const Instant = Schema.String.pipe(
  Schema.decodeTo(Schema.Finite, {
    decode: SchemaGetter.transform((text: string) => Date.parse(text)),
    encode: SchemaGetter.transform((ms: number) => new Date(ms).toISOString()),
  }),
)

/** Provider ids, each read as a string. */
const Providers = Schema.Array(Schema.Unknown).pipe(
  Schema.decodeTo(Schema.Array(Schema.String), {
    decode: SchemaGetter.transform((items: ReadonlyArray<unknown>) => items.map(String)),
    encode: SchemaGetter.transform((items: ReadonlyArray<string>) => items),
  }),
)

const CODEX_DEFAULT = { providers: ["openai"], script: CODEX_BUDGET }

const Codex = Schema.Struct({
  providers: lenient(Providers, CODEX_DEFAULT.providers),
  script: lenient(Schema.String, CODEX_DEFAULT.script),
})

export const Options = Schema.Struct({
  windows: lenient(Schema.String, DEFAULT_WINDOWS),
  log: lenient(Schema.String, DEFAULT_LOG),
  now: lenient(Schema.UndefinedOr(Instant), undefined),
  place: lenient(Place, KNOWLTON),
  fullAgent: lenient(Schema.Boolean, false),
  codex: lenient(Schema.Union([Schema.Literal(false), Codex]), CODEX_DEFAULT),
})
export type Options = typeof Options.Type

/** The outside systems the model runs on. */
export type Externals = CallLog | Sessions | Models | PoolPace | CodexAdmission | CompactionWindows

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]

/** The outside systems as OpenCode, the filesystem and processes provide them. */
export const live = (ctx: Plugin.Context, options: Options): Layer.Layer<Externals> =>
  Layer.mergeAll(
    CallLogLive.layer(options.log),
    SessionsLive.layer((sessionID) =>
      ctx.session.get({ sessionID: sessionID as SessionID }).pipe(
        Effect.map((session) => ({
          ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
          ...(session.agent === undefined ? {} : { agent: session.agent }),
        })),
      ),
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
    PoolPaceLive.layer((input) => ctx.rpc(POOL_STATUS).pace(input)),
    CodexAdmissionLive.layer(options.codex === false ? CODEX_BUDGET : options.codex.script),
    CompactionWindowsLive.layer(options.windows),
  )

/**
 * OpenCode's answer to a refused call. `@opencode/plugin/effect` does not
 * export `Tool`, so this is its shape and tag: the host catches the failure
 * by its `Tool.Error` tag and reports its message, as it does a Promise
 * plugin's thrown error.
 */
class ToolError extends Schema.TaggedError<ToolError>()("Tool.Error", {
  message: Schema.String,
  error: Schema.optional(Schema.Defect()),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

/** The help script a held agent waits with. */
const PACE_SCRIPT = resolve(import.meta.dir, "../../../scripts/pace.ts")
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

/** What the model reads when a call is refused, word for word as before. */
const refusal = (tool: string, rejection: SabbathRest | PaceHeld): ToolError => {
  if (rejection._tag === "SabbathRest") {
    const then =
      tool === SUBAGENT
        ? "No agent starts now. Do not retry; start it again once work resumes."
        : "Stop now: end your turn with one line on where you stopped. Make no more tool calls."
    return new ToolError({ message: `${rejection.why} ${then}`, error: rejection })
  }
  const whose = rejection.whose === "codex" ? "the Codex account's" : "the pool's"
  return new ToolError({
    message: `orchestrate: ${whose} pace holds this agent. ${rejection.reason}. Run \`bun ${quote(PACE_SCRIPT)} --wait ${Math.ceil(rejection.retryAt)}\` with shell's background:true and go on with other work. When it exits, call subagent again with the same agent and description; admission is checked again. Do not poll.`,
    error: rejection,
  })
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** The tuner rewrites compact.json about once a day; agents pick it up within this. */
const REREAD = "1 hour"

/** The plugin on `externals`: the live systems in OpenCode, test layers in the seam tests. */
export const make = (externals: (ctx: Plugin.Context, options: Options) => Layer.Layer<Externals>) =>
  Plugin.define({
    id: "dotfiles-opencode.orchestrate",
    effect: Effect.fn("Orchestrate.plugin")(function* (ctx) {
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(Effect.orDie)
      const services = yield* Layer.build(
        Model.layer({
          place: options.place,
          fullAgent: options.fullAgent,
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.codex === false ? {} : { codex: { providers: options.codex.providers } }),
        }).pipe(Layer.provideMerge(externals(ctx, options))),
      )
      const orchestrate = Context.get(services, Model.Orchestrate)
      const windows = Context.get(services, CompactionWindows)

      // The roles, defined as OpenCode's own plugins define build and general: before the
      // config's agent files, so a file in the owner's config still overrides a role's fields.
      // Each role compacts at its window, and each primary agent at root's. Config agent files
      // cannot set a window, and the config's agents arrive after this, so a primary agent
      // defined only in a config file keeps the model's ceiling. The transform is synchronous,
      // and compact.json is read on each run, so a reload picks up the tuner's rewrite.
      yield* ctx.agent.transform((editor) => {
        const sizes = Effect.runSync(windows.read)
        for (const agent of editor.list()) {
          if (agent.mode === "subagent" || agent.hidden) continue
          editor.update(agent.id, (item) => {
            item.request.settings.compactionWindow = sizes[ROOT]
          })
        }
        for (const role of ROLES) {
          const definition = definitions[role]
          editor.update(role, (item) => {
            item.description = definition.description
            item.system = definition.system
            item.mode = definition.mode
            item.permissions.push(...definition.permissions.map((rule) => ({ ...rule })))
            item.request.settings.compactionWindow = sizes[role]
          })
        }
      })
      yield* Effect.forkScoped(Effect.forever(Effect.sleep(REREAD).pipe(Effect.andThen(Effect.ignoreCause(ctx.agent.reload())))))

      yield* ctx.session.hook("compaction", (event) =>
        Effect.sync(() => {
          event.system.push({ type: "text", text: KEEP })
        }),
      )

      yield* ctx.tool.hook("execute.before", (event) => {
        const call = { sessionID: event.sessionID, callID: event.id }
        if (event.tool !== SUBAGENT)
          return orchestrate.useTool({ call, tool: event.tool }).pipe(Effect.mapError((rejection) => refusal(event.tool, rejection)))
        return orchestrate.startSubagent({ call, from: event.agent, input: event.input }).pipe(
          Effect.mapError((rejection) => refusal(event.tool, rejection)),
          Effect.map((started) => {
            // Run the call as the guard routed it, on the role's model when one was chosen.
            if (Option.isNone(started) || !isObject(event.input)) return
            const input: Record<string, unknown> = { ...event.input, agent: started.value.agent }
            if (started.value.model !== undefined) input.model = started.value.model
            event.input = input
          }),
        )
      })

      yield* ctx.tool.hook("execute.after", (event) => {
        if (event.tool !== SUBAGENT) return Effect.void
        const metadata = event.status === "completed" ? event.result.metadata : undefined
        const child = isObject(metadata) && typeof metadata.sessionID === "string" ? metadata.sessionID : undefined
        const status: Status =
          event.status === "error" ? "error" : isObject(metadata) && metadata.status === "running" ? "running" : "completed"
        return orchestrate.finishSubagent({
          call: { sessionID: event.sessionID, callID: event.id },
          ...(child === undefined ? {} : { child }),
          status,
        })
      })
    }),
  })

export default make(live)
