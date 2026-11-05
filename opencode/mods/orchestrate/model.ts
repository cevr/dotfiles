// The orchestrate model's handlers: each gathers what one command needs from
// the outside systems, has the ToolCall aggregate decide it, and writes the
// outcome to the call log. The aggregate is the one decision entry point, so
// the stories run exactly what these do. The plugin calls these and nothing else.
import { Clock, Context, Effect, Layer, Option } from "effect"
import * as CallLine from "./call-line.ts"
import { parseModel, type PaceHold } from "./pace.ts"
import { effort, isRole } from "./role.ts"
import { resumesAt, type Place, type SabbathRest } from "./sabbath.ts"
import { CallLog, CodexAdmission, Models, PoolPace, Sessions } from "./service.ts"
import {
  continues,
  FinishSubagent,
  routeOf,
  StartSubagent,
  ToolCall,
  UseTool,
  type Command,
  type Event,
  type Rejection,
  type Status,
  type SubagentStarted,
  type ToolCallId,
} from "./tool-call.ts"

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
    }) => Effect.Effect<Option.Option<SubagentStarted>, StartSubagent.Rejections>
    /** Any other tool call. */
    readonly useTool: (input: { readonly call: ToolCallId; readonly tool: string }) => Effect.Effect<void, SabbathRest>
    /** A `subagent` call returned. */
    readonly finishSubagent: (input: {
      readonly call: ToolCallId
      readonly child?: string
      readonly status: Status
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
       * Have the aggregate decide a command, and log what it recorded or why it
       * was refused. Every command is decided on its own inputs against the
       * aggregate's initial state (see tool-call.ts).
       */
      const decide = (command: Command, now: number, tool: string) =>
        ToolCall.decide(ToolCall.initial, command, now).pipe(
          Effect.tap((events) => Effect.forEach(events, (event) => Effect.flatMap(at, (time) => log.append(lineOf(event, time))))),
          Effect.tapError((rejection) => Effect.flatMap(at, (time) => log.append(CallLine.denied(command.call, tool, whyOf(rejection), time)))),
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
        if (resting) return yield* decide(StartSubagent.make(base), now, SUBAGENT).pipe(Effect.as(Option.none()))
        // A follow-up naming no agent keeps its child's: the guard must not switch a verifier to the worker.
        const childAgent = child !== undefined && continues(base) ? yield* sessions.agentOf(child) : undefined
        const routed = routeOf({ ...base, ...(childAgent ? { childAgent } : {}) })
        // A new role subagent runs at the role's effort, as a variant of the model it would run on.
        let model = typeof fields.model === "string" ? fields.model : undefined
        const level = isRole(routed.agent) ? effort(routed.agent) : undefined
        if (child === undefined && level !== undefined && level !== "" && (fields.model === undefined || fields.model === "")) {
          const variant = yield* models.variant(call.sessionID, routed.agent, level)
          if (variant) model = variant
        }
        const hold = child === undefined ? yield* holdOf(call.sessionID, routed.agent, model) : undefined
        const command = StartSubagent.make({
          ...base,
          ...(childAgent ? { childAgent } : {}),
          ...(model === undefined ? {} : { model }),
          ...(hold === undefined ? {} : { hold }),
        })
        const events = yield* decide(command, now, SUBAGENT)
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
        // Another tool is never paced.
        yield* decide(UseTool.make({ call, tool, inSubagent, place: config.place }), now, tool).pipe(
          Effect.catchTag("PaceHeld", Effect.die),
        )
      })

      const finishSubagent = Effect.fn("Orchestrate.finishSubagent")(function* (input: {
        readonly call: ToolCallId
        readonly child?: string
        readonly status: Status
      }) {
        // A finish is only recorded, never refused.
        const now = yield* sabbathNow
        yield* decide(FinishSubagent.make(input), now, SUBAGENT).pipe(
          Effect.catchTags({ SabbathRest: Effect.die, PaceHeld: Effect.die }),
        )
      })

      return { startSubagent, useTool, finishSubagent }
    }),
  )

const lineOf = (event: Event, at: string) =>
  event._tag === "SubagentStarted" ? CallLine.started(event, at) : CallLine.finished(event, at)

/** What the log says about a refusal: the Sabbath's sentence, or the pace's reason. */
const whyOf = (rejection: Rejection) => (rejection._tag === "SabbathRest" ? rejection.why : rejection.reason)
