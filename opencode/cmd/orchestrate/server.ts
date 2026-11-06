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
 *   With `pool: true` the pool answers first: when it paces the provider (its
 *   `paced` option), its answer is the ChatGPT account's own measure, counting
 *   every host and harness on the account, and the script answers only when
 *   the pool cannot. Without it the script alone answers.
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
 *   first in the subagent's answer. Held on both, it latches on whichever
 *   opens first, and each open tries the first model before the fallback.
 *
 * Each new subagent is told to the pool (`started`), which counts it on its
 * provider's pace, here and on the owner's other hosts, until its spend shows
 * in a reading.
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { Agent, Plugin, Tool } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Option, Schema, SchemaGetter } from "effect"
import { POOL_STATUS } from "@dotfiles/opencode-pool/status"
import { Latch, MARK_KEY, type Opened, OPENER } from "@dotfiles/opencode-wake/latch"
import { WAKES } from "@dotfiles/opencode-wake/wake"
import * as CodexAdmissionLive from "@dotfiles/opencode-orchestrate/codex/admission"
import { KEEP, ROOT } from "@dotfiles/opencode-orchestrate/compaction"
import * as CallLogLive from "@dotfiles/opencode-orchestrate/filestore/call-log"
import * as CompactionWindowsLive from "@dotfiles/opencode-orchestrate/filestore/compaction-windows"
import * as Model from "@dotfiles/opencode-orchestrate/model"
import * as LatchesLive from "@dotfiles/opencode-orchestrate/opencode/latches"
import * as ModelsLive from "@dotfiles/opencode-orchestrate/opencode/models"
import * as PoolPaceLive from "@dotfiles/opencode-orchestrate/opencode/pool-pace"
import * as SessionsLive from "@dotfiles/opencode-orchestrate/opencode/sessions"
import type { PaceHeld } from "@dotfiles/opencode-orchestrate/pace"
import { definitions, ROLE_CACHE_TTL, ROLES } from "@dotfiles/opencode-orchestrate/role"
import { KNOWLTON, local, Place, type SabbathRest } from "@dotfiles/opencode-orchestrate/sabbath"
import {
  CompactionWindows,
  type CallLog,
  type CodexAdmission,
  type Latches,
  type Models,
  type PoolPace,
  type Sessions,
} from "@dotfiles/opencode-orchestrate/service"
import type { Status, StillLatched } from "@dotfiles/opencode-orchestrate/tool-call"

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
  pool: Schema.optional(Schema.Boolean),
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
export type Externals = CallLog | Sessions | Models | PoolPace | CodexAdmission | CompactionWindows | Latches

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]

/** The outside systems as OpenCode, the filesystem and processes provide them; `start` runs a latched child through the subagent tool. */
export const live = (ctx: Plugin.Context, options: Options, start: LatchesLive.Start): Layer.Layer<Externals> =>
  Layer.mergeAll(
    CallLogLive.layer(options.log),
    SessionsLive.layer((sessionID) =>
      ctx.session.get({ sessionID: sessionID as SessionID }).pipe(
        Effect.map((session) => ({
          ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
          ...(session.agent === undefined ? {} : { agent: session.agent }),
          started: session.time.busy !== undefined || session.outcome !== undefined,
          ...(session.metadata?.[MARK_KEY] === undefined ? {} : { latch: session.metadata[MARK_KEY] }),
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
    PoolPaceLive.layer(
      (input) => ctx.rpc(POOL_STATUS).pace(input),
      (input) => ctx.rpc(POOL_STATUS).started(input),
    ),
    CodexAdmissionLive.layer(options.codex === false ? CODEX_BUDGET : options.codex.script),
    CompactionWindowsLive.layer(options.windows),
    LatchesLive.layer((ask) => ctx.rpc(WAKES).latch(ask), start),
  )

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

/** A started fallback's note, by the call it answers: a kernel cell's calls share one id, so the description is part of the key. */
const noteKey = (sessionID: string, callID: string, input: unknown) =>
  `${sessionID}/${callID}/${isObject(input) && typeof input.description === "string" ? input.description : ""}`

/** The subagent tool tells a new child this first; a latched child opens as a follow-up, so it is told here. */
const SPAWNED = "You are a subagent spawned by another session."

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** The tuner rewrites compact.json about once a day; agents pick it up within this. */
const REREAD = "1 hour"

type Execute = Tool.Info["execute"]
type ToolContext = Parameters<Execute>[1]

/** The plugin on `externals`: the live systems in OpenCode, test layers in the seam tests. */
export const make = (externals: (ctx: Plugin.Context, options: Options, start: LatchesLive.Start) => Layer.Layer<Externals>) =>
  Plugin.define({
    id: "dotfiles-opencode.orchestrate",
    effect: Effect.fn("Orchestrate.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.orchestrate: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      // The subagent tool's own execute, as the last tool transform saw it: a latched child starts through it.
      let subagent: Execute | undefined
      const start: LatchesLive.Start = (request) =>
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
              prompt: `${SPAWNED}\n${request.prompt}`,
              ...(request.model === undefined ? {} : { model: request.model }),
              sessionID: request.child,
              background: true,
            },
            context,
          ).pipe(Effect.asVoid)
        })
      const services = yield* Layer.build(
        Model.layer({
          place: options.place,
          fullAgent: options.fullAgent,
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.codex === false ? {} : { codex: { providers: options.codex.providers, ...(options.codex.pool === undefined ? {} : { pool: options.codex.pool }) } }),
        }).pipe(Layer.provideMerge(externals(ctx, options, start))),
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

      yield* ctx.tool.hook("execute.before", (event) => {
        const call = { sessionID: event.sessionID, callID: event.id }
        if (event.tool !== SUBAGENT)
          return orchestrate.useTool({ call, tool: event.tool }).pipe(Effect.mapError((rejection) => refusal(event.tool, rejection, options.place)))
        return orchestrate.startSubagent({ call, from: event.agent, messageID: event.messageID, input: event.input }).pipe(
          Effect.mapError((rejection) => refusal(event.tool, rejection, options.place)),
          Effect.map((outcome) => {
            if (Option.isNone(outcome) || !isObject(event.input)) return
            const routed = outcome.value._tag === "LatchedStart" ? outcome.value.latched : outcome.value
            // Run the call as the guard routed it, on the role's model when one was chosen.
            const input: Record<string, unknown> = { ...event.input, agent: routed.agent }
            if (routed.model !== undefined) input.model = routed.model
            // A role's own model, named, was dropped: with no variant chosen, the role runs on its own model.
            else if (routed.reason === "model-dropped") delete input.model
            // A fallback's answer tells the parent where it ran and why.
            if (outcome.value._tag === "SubagentStarted" && outcome.value.fallback !== undefined)
              notes.set(noteKey(event.sessionID, event.id, event.input), fallbackNote(outcome.value))
            // A latched call names its child, whose answer the subagent tool gives back at once.
            if (outcome.value._tag === "LatchedStart") {
              latched.set(outcome.value.child, latchedResult(outcome.value, options.place))
              input.sessionID = outcome.value.child
            }
            event.input = input
          }),
        )
      })

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

export default make(live)
