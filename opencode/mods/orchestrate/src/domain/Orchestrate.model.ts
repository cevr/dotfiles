// The orchestrate model's handlers: each gathers what one command needs from
// the outside systems, has the ToolCall aggregate's command decide it, and writes the
// outcome to the call log. The plugin calls these and nothing else.
import { Clock, Context, Effect, Layer, Option } from "effect"
import * as CallLine from "./CallLine.ts"
import { parseModel, type PaceHold } from "./Pace.ts"
import { effort, isRole } from "./Role.ts"
import { resumesAt, type Place } from "./Sabbath.ts"
import { CallLog } from "./ToolCall/CallLog.external.ts"
import { CodexAdmission } from "./ToolCall/CodexAdmission.external.ts"
import * as Finish from "./ToolCall/FinishSubagent.command.ts"
import { Models } from "./ToolCall/Models.external.ts"
import { PoolPace } from "./ToolCall/PoolPace.external.ts"
import type { SabbathRest } from "./ToolCall/SabbathRest.rejection.ts"
import { Sessions } from "./ToolCall/Sessions.external.ts"
import * as Start from "./ToolCall/StartSubagent.command.ts"
import type { Event, Rejection } from "./ToolCall/ToolCall.aggregate.ts"
import type { ToolCallId } from "./ToolCall/ToolCall.id.ts"
import * as Use from "./ToolCall/UseTool.command.ts"

/** The rules' settings, from the plugin's options. */
export interface Config {
  readonly place: Place
  /** An untyped or general call runs as asked. */
  readonly fullAgent: boolean
  /** A fixed time (epoch ms) for the Sabbath clock; the system clock when absent. */
  readonly now?: number
  /** The providers whose new subagents the Codex account's pace admits; absent leaves every provider to the pool. */
  readonly codex?: { readonly providers: ReadonlyArray<string> }
}

export class Orchestrate extends Context.Service<
  Orchestrate,
  {
    /**
     * A `subagent` call: the agent and model it runs as, or none when its
     * input is not an object (the tool refuses that itself). The plugin
     * rewrites the call's input with what started.
     */
    readonly startSubagent: (input: {
      readonly call: ToolCallId
      readonly from: string
      readonly input: unknown
    }) => Effect.Effect<Option.Option<Start.SubagentStarted>, Start.StartSubagent.Rejections>
    /** Any other tool call. */
    readonly useTool: (input: { readonly call: ToolCallId; readonly tool: string }) => Effect.Effect<void, SabbathRest>
    /** A `subagent` call returned. */
    readonly finishSubagent: (input: {
      readonly call: ToolCallId
      readonly child?: string
      readonly status: Finish.Status
    }) => Effect.Effect<void>
  }
>()("dotfiles-opencode/orchestrate/Orchestrate") {}

const SUBAGENT = "subagent"

export const layer = (config: Config) =>
  Layer.effect(
    Orchestrate,
    Effect.gen(function* () {
      const log = yield* CallLog
      const sessions = yield* Sessions
      const models = yield* Models
      const pool = yield* PoolPace
      const codex = yield* CodexAdmission

      /** The Sabbath clock, which also times a held agent's retry. */
      const sabbathNow = config.now === undefined ? Clock.currentTimeMillis : Effect.succeed(config.now)
      /** The log's clock: always the system's. */
      const at = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()))

      /**
       * Log what a command recorded, or why it was refused. Each command is
       * decided on its own inputs against the aggregate's initial state (see
       * ToolCall.aggregate.ts), so its own module's `decide` keeps its exact
       * rejections.
       */
      const record = <J extends Rejection>(decided: Effect.Effect<ReadonlyArray<Event>, J>, call: ToolCallId, tool: string) =>
        decided.pipe(
          Effect.tap((events) => Effect.forEach(events, (event) => Effect.flatMap(at, (time) => log.append(lineOf(event, time))))),
          Effect.tapError((rejection) => Effect.flatMap(at, (time) => log.append(CallLine.denied(call, tool, whyOf(rejection), time)))),
        )

      /** The pace's hold on a new agent running on `model` (else the agent's model), or none. */
      const holdOf = Effect.fnUntraced(function* (sessionID: string, agent: string, model: string | undefined) {
        const ref = parseModel(model) ?? (yield* models.base(sessionID, agent))
        if (ref === undefined) return undefined
        const whose = config.codex?.providers.includes(ref.providerID) ? "codex" : "pool"
        const pace =
          whose === "codex" ? yield* codex.admit(ref.id, isRole(agent) ? agent : "none") : yield* pool.pace(ref.providerID)
        if (pace === undefined || pace.ok) return undefined
        const hold: PaceHold = { whose, reason: pace.reason, ...(pace.retryAt === undefined ? {} : { retryAt: pace.retryAt }) }
        return hold
      })

      const startSubagent = Effect.fn("Orchestrate.startSubagent")(function* ({
        call,
        from,
        input,
      }: {
        readonly call: ToolCallId
        readonly from: string
        readonly input: unknown
      }) {
        const object = typeof input === "object" && input !== null
        const fields: Record<string, unknown> = object ? (input as Record<string, unknown>) : {}
        const now = yield* sabbathNow
        const resting = resumesAt(now, config.place) !== undefined
        if (!resting && !object) return Option.none()
        const child = typeof fields.sessionID === "string" && fields.sessionID !== "" ? fields.sessionID : undefined
        const base = {
          call,
          from,
          asked: fields.agent,
          ...(child === undefined ? {} : { child }),
          background: fields.background === true,
          ...(typeof fields.description === "string" ? { description: fields.description } : {}),
          fullAgent: config.fullAgent,
          place: config.place,
        }
        // Over the Sabbath nothing is gathered: the call is refused whatever it asks.
        if (resting) return yield* record(Start.decide(Start.StartSubagent.make(base), now), call, SUBAGENT).pipe(Effect.as(Option.none()))
        // A follow-up naming no agent keeps its child's: the guard must not switch a verifier to the worker.
        const childAgent = child !== undefined && Start.continues(base) ? yield* sessions.agentOf(child) : undefined
        const routed = Start.routeOf({ ...base, ...(childAgent ? { childAgent } : {}) })
        // A new role subagent runs at the role's effort, as a variant of the model it would run on.
        let model = typeof fields.model === "string" ? fields.model : undefined
        const level = isRole(routed.agent) ? effort(routed.agent) : undefined
        if (child === undefined && level !== undefined && level !== "" && (fields.model === undefined || fields.model === "")) {
          const variant = yield* models.variant(call.sessionID, routed.agent, level)
          if (variant) model = variant
        }
        const hold = child === undefined ? yield* holdOf(call.sessionID, routed.agent, model) : undefined
        const command = Start.StartSubagent.make({
          ...base,
          ...(childAgent ? { childAgent } : {}),
          ...(model === undefined ? {} : { model }),
          ...(hold === undefined ? {} : { hold }),
        })
        const events = yield* record(Start.decide(command, now), call, SUBAGENT)
        return Option.fromNullishOr(events.find((event) => event._tag === "SubagentStarted"))
      })

      const useTool = Effect.fn("Orchestrate.useTool")(function* ({
        call,
        tool,
      }: {
        readonly call: ToolCallId
        readonly tool: string
      }) {
        // Only over the Sabbath does it matter whose session this is.
        const now = yield* sabbathNow
        const resting = resumesAt(now, config.place) !== undefined
        const inSubagent = resting ? Boolean(yield* sessions.parentOf(call.sessionID)) : false
        yield* record(Use.decide(Use.UseTool.make({ call, tool, inSubagent, place: config.place }), now), call, tool)
      })

      const finishSubagent = Effect.fn("Orchestrate.finishSubagent")(function* (input: {
        readonly call: ToolCallId
        readonly child?: string
        readonly status: Finish.Status
      }) {
        yield* record(Finish.decide(Finish.FinishSubagent.make(input)), input.call, SUBAGENT)
      })

      return { startSubagent, useTool, finishSubagent }
    }),
  )

const lineOf = (event: Event, at: string) =>
  event._tag === "SubagentStarted" ? CallLine.started(event, at) : CallLine.finished(event, at)

/** What the log says about a refusal: the Sabbath's sentence, or the pace's reason. */
const whyOf = (rejection: Rejection) => (rejection._tag === "SabbathRest" ? rejection.why : rejection.reason)
