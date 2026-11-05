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
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
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
import { Agent, Plugin, Tool } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Option, Schema, SchemaGetter } from "effect"
import { POOL_STATUS } from "@dotfiles/opencode-pool/status"
import * as CodexAdmissionLive from "@dotfiles/opencode-orchestrate/codex/admission"
import { KEEP, ROOT } from "@dotfiles/opencode-orchestrate/compaction"
import * as CallLogLive from "@dotfiles/opencode-orchestrate/filestore/call-log"
import * as CompactionWindowsLive from "@dotfiles/opencode-orchestrate/filestore/compaction-windows"
import * as Model from "@dotfiles/opencode-orchestrate/model"
import * as ModelsLive from "@dotfiles/opencode-orchestrate/opencode/models"
import * as PoolPaceLive from "@dotfiles/opencode-orchestrate/opencode/pool-pace"
import * as SessionsLive from "@dotfiles/opencode-orchestrate/opencode/sessions"
import type { PaceHeld } from "@dotfiles/opencode-orchestrate/pace"
import { definitions, ROLE_CACHE_TTL, ROLES } from "@dotfiles/opencode-orchestrate/role"
import { KNOWLTON, Place, type SabbathRest } from "@dotfiles/opencode-orchestrate/sabbath"
import {
  CompactionWindows,
  type CallLog,
  type CodexAdmission,
  type Models,
  type PoolPace,
  type Sessions,
} from "@dotfiles/opencode-orchestrate/service"
import type { Status } from "@dotfiles/opencode-orchestrate/tool-call"

export const DEFAULT_WINDOWS = join(homedir(), ".cache/orchestrate/compact.json")
export const DEFAULT_LOG = join(homedir(), ".cache/orchestrate/opencode-agents.jsonl")
/** The orchestrate skill's Codex admission: `admit: …` exit 0, `hold: …[; opens about <time>Z]` exit 1. */
export const CODEX_BUDGET = join(homedir(), ".claude/skills/orchestrate/scripts/budget.ts")

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
})

export const Options = Schema.Struct({
  windows: Schema.String.pipe(withDefault(DEFAULT_WINDOWS)),
  log: Schema.String.pipe(withDefault(DEFAULT_LOG)),
  now: Schema.optional(Instant),
  place: Place.pipe(withDefault<Place>(KNOWLTON)),
  fullAgent: Schema.Boolean.pipe(withDefault(false)),
  codex: Schema.Union([Schema.Literal(false), Codex]).pipe(withDefault<false | typeof Codex.Type>(CODEX_DEFAULT)),
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

/** The help script a held agent waits with. */
const PACE_SCRIPT = resolve(import.meta.dir, "../../scripts/pace.ts")
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

/** What the model reads when a call is refused, word for word as before. */
const refusal = (tool: string, rejection: SabbathRest | PaceHeld): Tool.Error => {
  if (rejection._tag === "SabbathRest") {
    const then =
      tool === SUBAGENT
        ? "No agent starts now. Do not retry; start it again once work resumes."
        : "Stop now: end your turn with one line on where you stopped. Make no more tool calls."
    return new Tool.Error({ message: `${rejection.why} ${then}`, error: rejection })
  }
  const whose = rejection.whose === "codex" ? "the Codex account's" : "the pool's"
  return new Tool.Error({
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
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.orchestrate: invalid options: ${error.message}`)),
        Effect.orDie,
      )
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
            item.request.settings.cacheTTL = ROLE_CACHE_TTL
          })
        }
      })
      yield* Effect.forkScoped(Effect.forever(Effect.sleep(REREAD).pipe(Effect.andThen(Effect.ignoreCause(ctx.agent.reload())))))

      // The keep-list goes into the summary prompt, the last user message, so the compaction request keeps the
      // conversation's cached prefix (system, tools and messages as the normal request sends them). A host without
      // the summary prompt (before fork 5970ea5dc4) takes it as a system part, which costs the cache but still works.
      yield* ctx.session.hook("compaction", (event) =>
        Effect.sync(() => {
          const prompt = (event as { experimental?: { prompt?: Array<string> } }).experimental?.prompt
          if (Array.isArray(prompt)) prompt.push(KEEP)
          else event.system.push({ type: "text", text: KEEP })
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
