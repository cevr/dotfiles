// The orchestrate model's handlers: each gathers what one command needs from
// the outside systems, has the ToolCall aggregate decide it, and writes the
// outcome to the call log. The aggregate is the one decision entry point, so
// the stories run exactly what these do. The plugin calls these and nothing else.
//
// Opus first, Codex second: a new agent the pace holds on its model, that
// named no model of its own, is offered the newest Codex model for its role
// (role.ts `codexFallback`), when the host offers one, with the Codex pace's
// hold on it. The aggregate starts it there when Codex has room. Only a
// planner or verifier is ever offered it (role.ts `onCodex`): Codex never
// implements. A new implementor whose model is a Codex one (named, or its
// parent's) runs on the newest Opus instead (`offCodex`), and a latch an older
// build kept for one opens on Opus; with no Opus offered it never starts.
//
// The planner goes first on its own first model (the `planner` option, the
// newest Fable: the owner's call, 2026-11-12): a new planner start that names
// no model of its own runs on it at the planner's effort while the host offers
// it and its pace has room; otherwise it takes the chain above (the role's own
// model, Opus, then Codex) and its line says why (`first`). No other role has
// a first model, so an implementor or verifier never starts on it.
//
// A held start latches: the wakes keep it (Latches), and at its time they ask
// `openLatch`, which decides it again, its first model before its fallback,
// and, admitted, starts it. With no wakes to keep it, the call is refused with
// the hold's reason and time.
//
// A role's start, and its hand-back when it goes idle, move its unit in the
// run's log (unit-log.ts, through UnitLogs): the orchestrator need not log
// them, and a run with no unit dir found writes nothing.
//
// The wakes keep the system's time. With a fixed `now`, every time the rules
// read or write (the Sabbath's, a pace's) is on that fixed clock, so the
// times a latch hands the wakes are moved onto the system's by how far the
// fixed clock is behind it at that moment. Without one, they move by nothing.
import { Clock, Context, Effect, Layer, Match, Option, Schema, Semaphore } from "effect"
import { fold } from "@dotfiles/decider/decider"
import * as CallLine from "./call-line.ts"
import type { FirstRecord } from "./call-line.ts"
import {
  type Command as IdleCommand,
  GoIdle,
  Hear,
  heldBack,
  IdleRoot,
  type IdleRootState,
  NO_HOLDS,
  Nudge,
  ReportDraft,
  unitsOf,
} from "./idle.ts"
import { formatRef, namesModel, PaceHeld, paceOfReply, parseModel, type ModelRef, type PaceHold, type PaceReply } from "./pace.ts"
import { codexFallback, effort, IMPLEMENTOR, isCodexModel, isRole, onCodex, OPUS, Reason, WORKER } from "./role.ts"
import { resumesAt, SabbathRest, type Place } from "./sabbath.ts"
import {
  CallLog,
  CodexAdmission,
  Latches,
  Fleet,
  Models,
  Remind,
  PoolPace,
  RootHolds,
  RunRecords,
  Runs,
  Sessions,
  Skill,
  Steer,
  StepLog,
  Tell,
  UnitLogs,
} from "./service.ts"
import { descriptionOf, type Drift, noteOf, stepOf } from "./skill-drift.ts"
import { FLEET_DESCRIPTION, type FleetOutcome, fleetLineOf } from "./fleet.ts"
import { handBackOf, startOf, type Transition, unitDirsIn } from "./unit-log.ts"
import { isStep } from "./described.ts"
import {
  type CodexNeverImplements,
  continues,
  type Fallback,
  FinishSubagent,
  type Hold,
  OpenLatch,
  routeOf,
  StartSubagent,
  type StillLatched,
  ToolCall,
  UseTool,
  type Command,
  type Event,
  type Rejection,
  type Status,
  type SubagentLatched,
  type SubagentStarted,
  type ToolCallId,
} from "./tool-call.ts"

/** The paces a new agent's line records. */
type Asked = CallLine.Asked

/** The rules' settings, from the plugin's options. */
export interface Config {
  readonly place: Place
  /** An untyped or general call runs as asked. */
  readonly fullAgent: boolean
  /** A fixed time (epoch ms) for the Sabbath clock; the system clock when absent. */
  readonly now?: number
  /**
   * The providers whose new subagents the Codex account's pace admits; absent
   * leaves every provider to the pool. With `pool`, the pool answers first: it
   * measures the account as the provider does when it paces the provider
   * (`paced` in the pool's options), and only when it cannot does the
   * admission script. Without it the script alone answers.
   */
  readonly codex?: { readonly providers: ReadonlyArray<string>; readonly pool?: boolean }
  /** The planner's first model (`provider/id`, no variant), tried before the role's own on a new planner start. */
  readonly planner?: { readonly model: string }
}

/** A held start the wakes keep: the latch's id and child, with the decision. */
export interface LatchedStart {
  readonly _tag: "LatchedStart"
  readonly id: string
  readonly child: string
  readonly latched: SubagentLatched
}

/**
 * The effort `level` that `model` (`provider/id[#variant]`) does not run at: none when it names `#level`, or when
 * there is no effort to run at (none, or the worker's empty one).
 */
const lackedEffort = (model: string, level: Option.Option<string>): Option.Option<string> =>
  Option.filter(level, (wanted) => wanted !== "" && !model.endsWith(`#${wanted}`))
/** Where a start runs, Codex never implementing (`offCodex`): its model, and the Codex model it is refused on with no Opus offered. */
interface OffCodex {
  readonly model: Option.Option<string>
  readonly refused: Option.Option<string>
}

/** A latch's models, kept in its context: the first it is decided on, and the Codex fallback. */
const LatchModels = Schema.Struct({ primary: Schema.String, fallback: Schema.String })

/** Why a latched planner left its first model, kept in the latch's context, so the line its open writes records it too. */
const LatchFirst = Schema.Struct({ model: Schema.String, fellBack: Schema.String })

/** What `startSubagent` may refuse: the Sabbath or a still-latched child for a follow-up, a held start no latch could be kept for, and an implementor with no Opus to run on. */
export type StartRefusal = SabbathRest | PaceHeld | StillLatched | CodexNeverImplements

/** A latch at its time, as the wakes hand it back: the parent's call as it was routed, and its child. */
export interface LatchOpen {
  readonly parent: string
  readonly from: string
  readonly messageID: string
  readonly callID: string
  readonly child: string
  readonly agent: string
  readonly description: string
  readonly prompt: string
  readonly model?: string
  /** The context `startSubagent` kept with the latch. */
  readonly context: { readonly [key: string]: unknown }
}

/** What an open decided, in the wakes' terms (mods/wake latch.ts `Opened`). */
export type OpenAnswer =
  | { readonly outcome: "opened" }
  | { readonly outcome: "held"; readonly hold: Hold; readonly reason: string; readonly opensAt: number; readonly recheckAt: number }
  | { readonly outcome: "failed"; readonly message: string }

export class Orchestrate extends Context.Service<
  Orchestrate,
  {
    /**
     * A `subagent` call: the agent and model it runs as, the latch it is kept
     * as when held, or none when its input is not an object (the tool refuses
     * that itself). The plugin rewrites the call's input with what started,
     * and answers a latched call at once.
     */
    readonly startSubagent: (input: {
      readonly call: ToolCallId
      readonly from: string
      readonly messageID: string
      readonly input: unknown
    }) => Effect.Effect<Option.Option<SubagentStarted | LatchedStart>, StartRefusal>
    /** A latch's time came: decide it again; admitted, start its child in the background. Never fails: a start that fails answers `failed`. */
    readonly openLatch: (latch: LatchOpen) => Effect.Effect<OpenAnswer>
    /** Any other tool call. */
    readonly useTool: (input: { readonly call: ToolCallId; readonly tool: string }) => Effect.Effect<void, SabbathRest>
    /** A `subagent` call returned. */
    readonly finishSubagent: (input: {
      readonly call: ToolCallId
      readonly child?: string
      readonly status: Status
    }) => Effect.Effect<void>
    /**
     * A session went idle: when it is a role's subagent whose last answer opens
     * with its hand-back line, its unit moves as the machine says (unit-log.ts).
     */
    readonly handBack: (input: { readonly sessionID: string }) => Effect.Effect<void>
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
      const latches = yield* Latches
      const units = yield* UnitLogs
      /** The planner's first model, when set. */
      const firstModel = Option.fromNullishOr(config.planner).pipe(Option.flatMap((planner) => Option.fromNullishOr(parseModel(planner.model))))
      /** The providers a model counts as Codex's on, beside role.ts `CODEX_PROVIDERS`: the `codex` option's. */
      const codexProviders = config.codex?.providers ?? []

      /** Move `unit` in the first of `directories` (or a path `named`) that has it; none found writes nothing. */
      const move = Effect.fnUntraced(function* (transition: Transition, named: ReadonlyArray<string>, directories: ReadonlyArray<string | undefined>) {
        for (const directory of [...new Set(directories)]) {
          const dir = yield* units.find({ unit: transition.unit, named, ...(directory === undefined ? {} : { directory }) })
          if (dir !== undefined) return yield* units.append(dir, transition)
        }
      })

      /** A role's start moves its unit, found from the paths its prompt names or under its parent's checkout. */
      const moveOnStart = Effect.fnUntraced(function* (started: SubagentStarted, prompt: unknown) {
        const transition = startOf(started.agent, started.description)
        if (transition === undefined) return
        const text = typeof prompt === "string" ? prompt : undefined
        yield* move(transition, unitDirsIn(text, transition.unit), [yield* sessions.directoryOf(started.call.sessionID)])
      })

      const handBack = Effect.fn("Orchestrate.handBack")(function* ({ sessionID }: { readonly sessionID: string }) {
        const agent = yield* sessions.agentOf(sessionID)
        if (agent === undefined || !isStep(agent)) return
        const parent = yield* sessions.parentOf(sessionID)
        if (parent === undefined) return
        const said = handBackOf(agent, yield* sessions.lastWordsOf(sessionID))
        if (said?.transition === undefined) return
        const directories = [yield* sessions.directoryOf(sessionID), yield* sessions.directoryOf(parent)]
        yield* move(said.transition, unitDirsIn(said.file, said.transition.unit), directories)
      })

      /** The Sabbath clock, which also times a held agent's retry. */
      const sabbathNow = config.now === undefined ? Clock.currentTimeMillis : Effect.succeed(config.now)
      /** The log's clock: always the system's. */
      const at = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()))
      /** How far the system's clock is ahead of the rules' clock now: what moves a latch's times onto the wakes'. */
      const fixed = config.now
      const skew = fixed === undefined ? Effect.succeed(0) : Clock.currentTimeMillis.pipe(Effect.map((ms) => ms - fixed))

      /**
       * Have the aggregate decide a command, and log what it recorded or why it
       * was refused. Every command is decided on its own inputs against the
       * aggregate's initial state (see tool-call.ts).
       */
      const decide = (command: Command, now: number, tool: string, asked?: Asked, first?: FirstRecord) =>
        ToolCall.decide(ToolCall.initial, command, now).pipe(
          // A latch is logged once the wakes keep it, with its child; or as the call's refusal when they cannot.
          Effect.tap((events) =>
            Effect.forEach(events, (event) =>
              event._tag === "SubagentLatched" && event.child === undefined ? Effect.void : Effect.flatMap(at, (time) => log.append(lineOf(event, time, asked, first))),
            ),
          ),
          Effect.tapError((rejection) => deny(command.call, tool, whyOf(rejection))),
        )

      const deny = (call: ToolCallId, tool: string, why: string) => Effect.flatMap(at, (time) => log.append(CallLine.denied(call, tool, why, time)))

      /**
       * The model a new agent runs on (`model`, else the agent's), and the
       * pace's hold on it, if any. A Codex provider's pace is the admission
       * script's, or with `codex.pool` the pool's when the pool measures it.
       */
      const paceOf = Effect.fnUntraced(function* (sessionID: string, agent: string, model: string | undefined) {
        const ref = parseModel(model) ?? (yield* models.base(sessionID, agent))
        const none: Asked = {}
        if (ref === undefined) return { ref, hold: undefined, asked: none }
        const { hold, replies } = yield* holdOf(ref, agent, sessionID)
        const asked: Asked = {
          ...(replies.pool === undefined ? {} : { pace: replies.pool }),
          ...(replies.codex === undefined ? {} : { codex: replies.codex }),
        }
        return { ref, hold, asked }
      })

      /** The hold on a model, if any, with each pace's reply as asked: the pool's, the Codex admission's. */
      const holdOf = Effect.fnUntraced(function* (ref: ModelRef, agent: string, sessionID: string) {
        const whose = config.codex?.providers.includes(ref.providerID) ? "codex" : "pool"
        const poolReply = whose === "pool" || config.codex?.pool === true ? yield* pool.pace(ref.providerID, ref.id, sessionID) : undefined
        const pooled = poolReply === undefined ? undefined : paceOfReply(poolReply)
        const codexReply =
          whose === "codex" && (pooled === undefined || !pooled.measured) ? yield* codex.admit(ref.id, isRole(agent) ? agent : "none") : undefined
        const pace = codexReply === undefined ? pooled : paceOfReply(codexReply)
        const replies = { ...(poolReply === undefined ? {} : { pool: poolReply }), ...(codexReply === undefined ? {} : { codex: codexReply }) }
        if (pace === undefined || pace.ok) return { hold: undefined, replies }
        // An agent that never runs on Codex is not held by the spend-evenly target alone: only by a pool with no quota left.
        if (!onCodex(agent) && pace.soft === true) return { hold: undefined, replies }
        const hold: PaceHold = { whose, reason: pace.reason, ...(pace.retryAt === undefined ? {} : { retryAt: pace.retryAt }) }
        return { hold, replies }
      })

      /** A fallback's replies, as its line keeps them. */
      const fallbackAsked = (replies: { readonly pool?: PaceReply; readonly codex?: PaceReply }): Asked => ({
        ...(replies.pool === undefined ? {} : { fallbackPace: replies.pool }),
        ...(replies.codex === undefined ? {} : { fallbackCodex: replies.codex }),
      })

      /**
       * The Codex model a held agent falls back to: the newest of its role's
       * family on a Codex provider, with the Codex pace's hold on it. None
       * when no Codex provider is set, the first model is Codex's own, or the
       * host offers no such model.
       */
      const fallbackOf = Effect.fnUntraced(function* (sessionID: string, ref: ModelRef, agent: string, description: string | undefined) {
        const providers = config.codex?.providers
        // Only a planner or verifier falls back to Codex; any other held start latches for its own model.
        if (!onCodex(agent)) return undefined
        if (providers === undefined || providers.includes(ref.providerID)) return undefined
        const { family, variant } = codexFallback(agent)
        const model = yield* models.newest(sessionID, providers, family, variant)
        const at = parseModel(model)
        if (model === undefined || at === undefined) return undefined
        const { hold, replies } = yield* holdOf(at, agent, sessionID)
        const fallback: Fallback = { model, ...(hold === undefined ? {} : { hold }) }
        return { fallback, asked: fallbackAsked(replies) }
      })

      /**
       * What a new implementor runs on, given the model it `named` (or was given): that model, else its role's
       * or its parent's, unless that is a Codex one. Then the newest Opus offered, at the role's effort; with
       * none offered, it is `refused` on the Codex model, which the aggregate refuses. Any other start, and a
       * follow-up, keeps `named`.
       */
      const offCodex = Effect.fnUntraced(function* (
        sessionID: string,
        start: { readonly agent: string; readonly followUp: boolean },
        named: Option.Option<string>,
      ): Effect.fn.Return<OffCodex> {
        const kept: OffCodex = { model: named, refused: Option.none() }
        if (start.followUp || start.agent !== IMPLEMENTOR) return kept
        const base = Option.map(Option.fromNullishOr(yield* models.base(sessionID, IMPLEMENTOR)), formatRef)
        const codex = Option.filter(Option.orElse(named, () => base), (model) => isCodexModel(model, codexProviders))
        if (Option.isNone(codex)) return kept
        const level = Option.getOrElse(Option.fromNullishOr(effort(IMPLEMENTOR)), () => "")
        return Option.match(Option.fromNullishOr(yield* models.newest(sessionID, OPUS.providers, OPUS.family, level)), {
          onSome: (opus): OffCodex => ({ model: Option.some(opus), refused: Option.none() }),
          onNone: (): OffCodex => ({ model: codex, refused: codex }),
        })
      })

      /**
       * A new planner start on the planner's first model (`config.planner`),
       * when it names no model of its own: at the role's effort, with its pace
       * as asked, when the host offers that model and its pace has room;
       * otherwise it takes the role's chain (its own model, then Codex) and
       * `first` says why. Over the Sabbath it does what every role does there:
       * it latches on its own model, the first one, asking no pace, and its
       * open takes the chain (`openLatch`). None for any other start.
       */
      const firstOf = Effect.fnUntraced(function* (
        sessionID: string,
        start: {
          readonly agent: string
          readonly followUp: boolean
          readonly namedModel: boolean
          readonly level: string | undefined
          readonly resting: boolean
        },
      ) {
        const first = config.planner?.model
        if (first === undefined || start.agent !== "planner" || start.followUp || start.namedModel) return undefined
        const fell = (fellBack: string) => ({ first: { model: first, fellBack } satisfies FirstRecord, model: undefined, paced: undefined })
        const model = yield* models.at(sessionID, first, start.level === "" ? undefined : start.level)
        const ref = parseModel(model)
        if (model === undefined || ref === undefined) return fell(`${first} is not offered`)
        // Offered without the planner's effort, it would run at the model's own default: the chain runs at it instead.
        const lacks = lackedEffort(model, Option.fromNullishOr(start.level))
        if (Option.isSome(lacks)) return fell(`${first} offers no ${lacks.value}`)
        if (start.resting) return { first: undefined, model, paced: undefined }
        const { hold, replies } = yield* holdOf(ref, start.agent, sessionID)
        if (hold !== undefined) return fell(`${model} held: ${hold.reason}`)
        const asked: Asked = {
          ...(replies.pool === undefined ? {} : { pace: replies.pool }),
          ...(replies.codex === undefined ? {} : { codex: replies.codex }),
        }
        return { first: undefined, model, paced: { ref, hold: undefined, asked } }
      })

      const startSubagent = Effect.fn("Orchestrate.startSubagent")(function* ({
        call,
        from,
        messageID,
        input,
      }: {
        readonly call: ToolCallId
        readonly from: string
        readonly messageID: string
        readonly input: unknown
      }): Effect.fn.Return<Option.Option<SubagentStarted | LatchedStart>, StartRefusal> {
        // The tool refuses an input that is not an object itself.
        if (typeof input !== "object" || input === null) return Option.none()
        const fields = input as Record<string, unknown>
        const now = yield* sabbathNow
        const resting = resumesAt(now, config.place) !== undefined
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
        // Over the Sabbath a follow-up is refused whatever it asks: nothing is gathered for it.
        if (resting && child !== undefined) return yield* decide(StartSubagent.make(base), now, SUBAGENT).pipe(Effect.as(Option.none()))
        // A follow-up naming no agent keeps its child's: the guard must not switch a verifier to the worker.
        const childAgent = child !== undefined && continues(base) ? yield* sessions.agentOf(child) : undefined
        const childLatched = child === undefined ? undefined : yield* sessions.latchOf(child)
        const routed = routeOf({ ...base, ...(childAgent ? { childAgent } : {}) })
        const asks = typeof fields.model === "string" && fields.model !== "" ? fields.model : undefined
        // A new role start naming the role's own model (any variant or none) runs as if it named none: the
        // orchestrator meant the role, and only an unnamed start gets the role's effort, the fallback and the latch.
        const bound = asks !== undefined && child === undefined && isRole(routed.agent) ? yield* models.base(call.sessionID, routed.agent) : undefined
        // An implementor naming a Codex model runs on its role's model instead, a follow-up on the one it has: Codex never
        // implements, whether the Codex fallback is on or off (no-codex-impl r1 M1).
        const codexNamed = asks !== undefined && routed.agent === IMPLEMENTOR && isCodexModel(asks, codexProviders)
        // A new planner naming its first model (any variant or none) is the planner's start too: named, it ran at the
        // model's default effort (the workbox's Ergo root, 2026-11-12: 11 Fable plans at 4x the cost of medium).
        const fresh = Option.isNone(Option.fromNullishOr(child))
        const firstNamed = Option.exists(Option.fromNullishOr(asks), (asked) => fresh && routed.agent === "planner" && Option.exists(firstModel, (first) => namesModel(asked, first)))
        const dropped = asks !== undefined && ((bound !== undefined && namesModel(asks, bound)) || codexNamed || firstNamed) ? asks : undefined
        const level = isRole(routed.agent) ? effort(routed.agent) : undefined
        const followUp = child !== undefined
        const onFirst = yield* firstOf(call.sessionID, {
          agent: routed.agent,
          followUp,
          namedModel: asks !== undefined && dropped === undefined,
          level,
          resting,
        })
        // A new role subagent runs at the role's effort, as a variant of the model it would run on; a planner on its first model, at it.
        let model = onFirst?.model ?? (dropped === undefined ? asks : undefined)
        // A new planner naming another model with no variant runs it at the planner's effort, when that model offers it.
        const bareNamed = Option.all({
          named: Option.filter(Option.fromNullishOr(model), (named) => !named.includes("#")),
          wanted: Option.filter(Option.fromNullishOr(level), (wanted) => wanted !== ""),
        }).pipe(Option.filter(() => fresh && routed.agent === "planner"))
        if (Option.isSome(bareNamed)) {
          const { named, wanted } = bareNamed.value
          const at = Option.fromNullishOr(yield* models.at(call.sessionID, named, wanted))
          model = Option.getOrElse(
            Option.filter(at, (offered) => Option.isNone(lackedEffort(offered, Option.some(wanted)))),
            () => named,
          )
        }
        if (child === undefined && level !== undefined && level !== "" && model === undefined) {
          const variant = yield* models.variant(call.sessionID, routed.agent, level)
          if (variant) model = variant
        }
        // Codex never implements: a new implementor whose model is a Codex one (its parent's, say) runs on the newest Opus.
        const off = yield* offCodex(call.sessionID, { agent: routed.agent, followUp }, Option.fromNullishOr(model))
        model = Option.getOrUndefined(off.model)
        // A new worker that names no model runs on the one it inherits, at that model's variant: the aggregate caps it.
        const runsOn = child === undefined && model === undefined && routed.agent === WORKER ? yield* models.base(call.sessionID, routed.agent) : undefined
        const inherited = runsOn === undefined ? undefined : formatRef(runsOn)
        // A new agent's pace; over the Sabbath only its model, for the latch.
        // A first-model start's pace was asked when it was tried.
        const paced =
          child === undefined
            ? resting
              ? { ref: parseModel(model) ?? (yield* models.base(call.sessionID, routed.agent)), hold: undefined, asked: {} }
              : (onFirst?.paced ?? (yield* paceOf(call.sessionID, routed.agent, model)))
            : undefined
        const hold = paced?.hold
        // The model it would run on, named; with a fallback the command names it so the log says what was held.
        const primary = model ?? (paced?.ref === undefined ? undefined : `${paced.ref.providerID}/${paced.ref.id}`)
        // A model the call named is kept as asked: only a role's own model falls back.
        const named = asks !== undefined && dropped === undefined
        const offered =
          hold !== undefined && !named && paced?.ref !== undefined ? yield* fallbackOf(call.sessionID, paced.ref, routed.agent, base.description) : undefined
        const fallback = offered?.fallback
        // What each pace asked said, for the line: a follow-up asked none.
        const asked: Asked = { ...paced?.asked, ...offered?.asked }
        const command = StartSubagent.make({
          ...base,
          ...(childAgent ? { childAgent } : {}),
          ...(fallback !== undefined && primary !== undefined ? { model: primary, fallback } : model === undefined ? {} : { model }),
          ...(dropped === undefined ? {} : { dropped }),
          ...(inherited === undefined ? {} : { inherited }),
          ...(hold === undefined ? {} : { hold }),
          ...(childLatched === undefined ? {} : { childLatched }),
          ...Option.match(off.refused, { onNone: () => ({}), onSome: (codex) => ({ codex }) }),
        })
        const first = onFirst?.first
        const events = yield* decide(command, now, SUBAGENT, asked, first)
        const latched = events.find((event) => event._tag === "SubagentLatched")
        if (latched !== undefined) {
          // The child is made on the model it latched on, and opened on whichever model admits it first.
          const on = latched.model ?? primary
          const ahead = yield* skew
          const kept = yield* latches
            .latch({
              parent: call.sessionID,
              from,
              messageID,
              callID: call.callID,
              agent: latched.agent,
              description: latched.description ?? latched.agent,
              prompt: typeof fields.prompt === "string" ? fields.prompt : "",
              ...(on === undefined ? {} : { model: on }),
              hold: latched.hold,
              why: latched.why,
              opensAt: latched.opensAt + ahead,
              recheckAt: latched.recheckAt + ahead,
              context: {
                reason: latched.reason,
                ...(fallback === undefined || primary === undefined ? {} : { models: { primary, fallback: fallback.model } }),
                ...(first === undefined ? {} : { first }),
              },
            })
            .pipe(
              Effect.catchTag("LatchRefused", (refused) =>
                Effect.gen(function* () {
                  yield* Effect.logWarning("orchestrate: a held start could not latch; the call is refused", { reason: refused.reason })
                  const rejection = refusalOf(latched, config.place)
                  yield* deny(call, SUBAGENT, whyOf(rejection))
                  return yield* rejection
                }),
              ),
            )
          const event: SubagentLatched = { ...latched, child: kept.child, ...(on === undefined ? {} : { model: on }) }
          yield* log.append(CallLine.latched(event, yield* at, asked, first))
          return Option.some({ _tag: "LatchedStart" as const, id: kept.id, child: kept.child, latched: event })
        }
        const started = events.find((event) => event._tag === "SubagentStarted")
        // A new agent counts on the pace of the provider it started on, here and on the owner's other hosts, until its spend shows.
        const ran = started === undefined || paced === undefined ? undefined : (parseModel(started.model) ?? paced.ref)
        if (ran !== undefined) yield* pool.started(ran.providerID)
        if (started !== undefined) yield* moveOnStart(started, fields.prompt)
        return Option.fromNullishOr(started)
      })

      const openLatch = Effect.fn("Orchestrate.openLatch")(function* (latch: LatchOpen): Effect.fn.Return<OpenAnswer> {
        const call = { sessionID: latch.parent, callID: latch.callID }
        // An open asked twice (the wakes lost the first answer) starts nothing twice.
        const ran = yield* sessions.startedOf(latch.child)
        const now = yield* sabbathNow
        const resting = resumesAt(now, config.place) !== undefined
        // Its first model before its fallback; a latch with no fallback is decided on the model it was made on.
        // Only a planner or verifier keeps a Codex fallback: one an older build kept for another agent is dropped,
        // and that latch is decided on the model it was made on (codex-no-implement).
        const kept = Option.getOrUndefined(Option.filter(Schema.decodeUnknownOption(LatchModels)(latch.context.models), () => onCodex(latch.agent)))
        // A planner latched on its first model (over the Sabbath) takes the planner's chain at its open, as a new
        // start would: the first model, else its own at its effort, then Codex.
        const firstRef = parseModel(config.planner?.model)
        const onFirstModel = latch.agent === "planner" && firstRef !== undefined && latch.model !== undefined && namesModel(latch.model, firstRef)
        const level = isRole(latch.agent) ? effort(latch.agent) : undefined
        const tried =
          !resting && !ran && kept === undefined && onFirstModel
            ? yield* firstOf(latch.parent, { agent: latch.agent, followUp: false, namedModel: false, level, resting: false })
            : undefined
        const own = tried !== undefined && tried.model === undefined && level !== undefined && level !== "" ? yield* models.variant(latch.parent, latch.agent, level) : undefined
        // Codex never implements: an implementor latched on a Codex model (an older build's) opens on Opus, or not at all.
        const off = yield* offCodex(latch.parent, { agent: latch.agent, followUp: ran }, Option.fromNullishOr(tried?.model ?? own ?? kept?.primary ?? latch.model))
        if (Option.isSome(off.refused))
          return { outcome: "failed", message: `orchestrate: Codex never implements, and no Opus is offered for this implementor (it latched on ${off.refused.value}). Start it again once an Opus model is offered.` }
        const primary = Option.getOrUndefined(off.model)
        const paced = resting || ran ? undefined : (tried?.paced ?? (yield* paceOf(latch.parent, latch.agent, primary)))
        // The chain's Codex fallback, offered as a new start's is; a latch made with one keeps its own.
        const offered =
          tried !== undefined && paced?.hold !== undefined && paced.ref !== undefined ? yield* fallbackOf(latch.parent, paced.ref, latch.agent, latch.description) : undefined
        const fallbackAt = parseModel(kept?.fallback)
        const fallbackPaced = paced?.hold !== undefined && fallbackAt !== undefined ? yield* holdOf(fallbackAt, latch.agent, latch.parent) : undefined
        const fallbackHold = fallbackPaced?.hold
        const asked: Asked = { ...paced?.asked, ...(fallbackPaced === undefined ? {} : fallbackAsked(fallbackPaced.replies)), ...offered?.asked }
        const fallback: Fallback | undefined =
          offered?.fallback ??
          (kept === undefined || paced?.hold === undefined ? undefined : { model: kept.fallback, ...(fallbackHold === undefined ? {} : { hold: fallbackHold }) })
        const reason = Schema.decodeUnknownOption(Reason)(latch.context.reason)
        const first = tried?.first ?? Option.getOrUndefined(Schema.decodeUnknownOption(LatchFirst)(latch.context.first))
        const events = yield* ToolCall.decide(
          ToolCall.initial,
          OpenLatch.make({
            call,
            from: latch.from,
            agent: latch.agent,
            reason: reason._tag === "Some" ? reason.value : "kept",
            ...(primary === undefined ? {} : { model: primary }),
            description: latch.description,
            child: latch.child,
            place: config.place,
            ...(paced?.hold === undefined ? {} : { hold: paced.hold }),
            ...(fallback === undefined ? {} : { fallback }),
            started: ran,
          }),
          now,
        ).pipe(Effect.orDie) // An open is never refused: it latches again or starts.
        const latched = events.find((event) => event._tag === "SubagentLatched")
        if (latched !== undefined) {
          yield* log.append(CallLine.latched(latched, yield* at, asked, first))
          const ahead = yield* skew
          return { outcome: "held", hold: latched.hold, reason: latched.why, opensAt: latched.opensAt + ahead, recheckAt: latched.recheckAt + ahead }
        }
        const started = events.find((event) => event._tag === "SubagentStarted")
        if (started === undefined) return { outcome: "opened" }
        yield* log.append(CallLine.started(started, yield* at, asked, first))
        const on = started.model ?? latch.model
        const opened = parseModel(on) ?? paced?.ref
        if (opened !== undefined) yield* pool.started(opened.providerID)
        const failed = yield* latches
          .start({
            parent: latch.parent,
            from: latch.from,
            messageID: latch.messageID,
            callID: latch.callID,
            child: latch.child,
            agent: latch.agent,
            description: latch.description,
            prompt: latch.prompt,
            ...(on === undefined ? {} : { model: on }),
          })
          .pipe(
            Effect.as(undefined),
            Effect.catchTag("StartFailed", (failed) => Effect.succeed(failed)),
          )
        yield* finish({ call, child: latch.child, status: failed === undefined ? "running" : "error" })
        if (failed === undefined) yield* moveOnStart(started, latch.prompt)
        return failed === undefined ? { outcome: "opened" } : { outcome: "failed", message: failed.message }
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
        yield* decide(UseTool.make({ call, tool, inSubagent, place: config.place }), now, tool).pipe(Effect.catchTags({ StillLatched: Effect.die, CodexNeverImplements: Effect.die }))
      })

      const finish = Effect.fn("Orchestrate.finishSubagent")(function* (input: {
        readonly call: ToolCallId
        readonly child?: string
        readonly status: Status
      }) {
        // A finish is only recorded, never refused.
        const now = yield* sabbathNow
        yield* decide(FinishSubagent.make(input), now, SUBAGENT).pipe(Effect.catchTags({ SabbathRest: Effect.die, StillLatched: Effect.die, CodexNeverImplements: Effect.die }))
      })

      return { startSubagent, openLatch, useTool, finishSubagent: finish, handBack }
    }),
  )

const lineOf = (event: Event, at: string, asked: Asked | undefined, first: FirstRecord | undefined) =>
  event._tag === "SubagentStarted"
    ? CallLine.started(event, at, asked, first)
    : event._tag === "SubagentLatched"
      ? CallLine.latched(event, at, asked, first)
      : CallLine.finished(event, at)

/** A held start that could not latch, as the call's refusal: the Sabbath's rest, or the pace's hold until it opens. */
const refusalOf = (latched: SubagentLatched, place: Place): SabbathRest | PaceHeld =>
  latched.hold === "sabbath"
    ? new SabbathRest({ resumesAt: latched.opensAt, place })
    : new PaceHeld({ whose: latched.whose ?? "pool", reason: latched.why, retryAt: latched.opensAt })

// ── Idle roots (idle.ts) ──

/** How long after a draft ends, with no new input, the idle period is decided again: a sent prompt lands first. */
export const RECHECK_MS = 2_000

/** What one decision of an idle root came to, for the plugin's log. */
export type IdleOutcome =
  | { readonly _tag: "Nudged"; readonly line: string }
  | { readonly _tag: "NotNudged"; readonly why: string; readonly detail: string }
  | { readonly _tag: "Refused"; readonly message: string }

/** A decision's reason not to nudge, as its outcome. */
const notNudged = (reason: { readonly why: string; readonly detail: string }): IdleOutcome => ({ _tag: "NotNudged", why: reason.why, detail: reason.detail })

export class IdleRoots extends Context.Service<
  IdleRoots,
  {
    /**
     * The session ended its turn; `background` still runs for it. Run in the host's idle hook, it reads at once whether
     * input it heard waits in its inbox, and answers the decision of a root's idle period, to run in the background:
     * none while input waits (the session goes on with it, and that turn's idle decides).
     */
    readonly idle: (sessionID: string, background: number) => Effect.Effect<Effect.Effect<IdleOutcome | undefined>>
    /** New input (inbox item `inboxID`, not the nudge) reached the session: its idle period, if any, ends. */
    readonly heard: (sessionID: string, inboxID: string) => Effect.Effect<void>
    /** A turn of the session took inbox item `inboxID`. */
    readonly delivered: (sessionID: string, inboxID: string) => Effect.Effect<void>
    /**
     * An owner's TUI says whether its composer holds a draft to the session.
     * A draft that ends while the root is idle decides it again `RECHECK_MS` later.
     */
    readonly draft: (input: { readonly sessionID: string; readonly client: string; readonly drafting: boolean }) => Effect.Effect<IdleOutcome | undefined>
    /** The session is gone. */
    readonly forget: (sessionID: string) => Effect.Effect<void>
  }
>()("dotfiles-opencode/orchestrate/IdleRoots") {}

/** The idle roots' handlers. Each root's state lives here, in memory: a restart starts every root afresh. */
export const idleLayer = (config: Pick<Config, "place" | "now">) =>
  Layer.effect(
    IdleRoots,
    Effect.gen(function* () {
      const sessions = yield* Sessions
      const steps = yield* StepLog
      const runs = yield* Runs
      const holds = yield* RootHolds
      const steer = yield* Steer
      const roots = new Map<string, IdleRootState>()
      // One decision at a time: an idle hook and a draft's end may race for one root.
      const one = yield* Semaphore.make(1)
      const sabbathNow = config.now === undefined ? Clock.currentTimeMillis : Effect.succeed(config.now)

      const apply = (sessionID: string, command: IdleCommand) =>
        Effect.gen(function* () {
          const state = roots.get(sessionID) ?? IdleRoot.initial
          const events = yield* IdleRoot.decide(state, command, yield* Clock.currentTimeMillis)
          const next = fold(IdleRoot, events, state)
          roots.set(sessionID, next)
          return { events, state: next }
        })

      /** Decide the root's idle period: gather what holds it, then nudge or say why not. */
      const consider = (sessionID: string): Effect.Effect<IdleOutcome> =>
        Effect.gen(function* () {
          const state = roots.get(sessionID) ?? IdleRoot.initial
          // Nothing is gathered while its own state already holds it back.
          const held = heldBack(state, yield* Clock.currentTimeMillis)
          if (held !== undefined) return notNudged(held)
          const resting = resumesAt(yield* sabbathNow, config.place) !== undefined
          const units = resting ? { moving: [], ready: [] } : unitsOf(yield* runs.list, yield* steps.units(sessionID))
          const gathered = units.moving.length === 0 && units.ready.length === 0 ? NO_HOLDS : yield* holds.of(sessionID)
          const decided = yield* apply(sessionID, Nudge.make({ ...units, holds: gathered, resting })).pipe(Effect.result)
          if (decided._tag === "Failure") return notNudged(decided.failure)
          const nudged = decided.success.events.find((event) => event._tag === "Nudged")
          if (nudged === undefined) return notNudged({ why: "nudged", detail: "nothing to record" })
          return yield* steer.nudge(sessionID, nudged.line).pipe(
            Effect.as<IdleOutcome>({ _tag: "Nudged", line: nudged.line }),
            Effect.catchTag("NudgeRefused", (refused) => Effect.succeed<IdleOutcome>({ _tag: "Refused", message: refused.message })),
          )
        }).pipe(one.withPermits(1))

      // Each session's heard input its turns have not taken yet: the inbox items enqueued and not delivered.
      const waiting = new Map<string, ReadonlySet<string>>()
      const waitingOf = (sessionID: string) => waiting.get(sessionID) ?? new Set<string>()

      const decide = Effect.fn("IdleRoots.idle")(function* (sessionID: string, background: number, waits: boolean) {
        if ((yield* sessions.parentOf(sessionID)) !== undefined) return undefined
        // Input that came during the turn waits in its inbox: the session goes on with it, and that turn's idle,
        // with its own background, is the one that counts. This one opens no idle period.
        if (waits) return notNudged({ why: "working", detail: "new input waits in its inbox" })
        yield* apply(sessionID, GoIdle.make({ background })).pipe(Effect.orDie)
        return yield* consider(sessionID)
      })

      // Read in the hook, before the host goes on: the execution takes its inbox right after, and the decision runs later.
      const idle = (sessionID: string, background: number) => Effect.sync(() => decide(sessionID, background, waitingOf(sessionID).size > 0))

      const heard = Effect.fn("IdleRoots.heard")(function* (sessionID: string, inboxID: string) {
        waiting.set(sessionID, new Set([...waitingOf(sessionID), inboxID]))
        if (!roots.has(sessionID)) return
        yield* apply(sessionID, Hear.make({})).pipe(Effect.orDie)
      })

      const draft = Effect.fn("IdleRoots.draft")(function* (input: { readonly sessionID: string; readonly client: string; readonly drafting: boolean }) {
        if (!roots.has(input.sessionID) && !input.drafting) return undefined
        const { events, state } = yield* apply(input.sessionID, ReportDraft.make({ client: input.client, drafting: input.drafting })).pipe(Effect.orDie)
        if (!events.some((event) => event._tag === "DraftCleared") || state.phase !== "idle") return undefined
        yield* Effect.sleep(RECHECK_MS)
        return yield* consider(input.sessionID)
      })

      const delivered = (sessionID: string, inboxID: string) =>
        Effect.sync(() => {
          const left = [...waitingOf(sessionID)].filter((id) => id !== inboxID)
          if (left.length === 0) waiting.delete(sessionID)
          else waiting.set(sessionID, new Set(left))
        }).pipe(Effect.withSpan("IdleRoots.delivered"))

      const forget = (sessionID: string) =>
        Effect.sync(() => {
          roots.delete(sessionID)
          waiting.delete(sessionID)
        }).pipe(Effect.withSpan("IdleRoots.forget"))

      return { idle, heard, delivered, draft, forget }
    }),
  )

// ── A verifier's verdict (fleet.ts) ──

export class Verdicts extends Context.Service<
  Verdicts,
  {
    /**
     * A session went idle. When it is a verifier whose last words hand back `accepted`, the fleet records the
     * target its batch file names (Fleet), once per verdict however often the session goes idle after; what that
     * did goes to the run's log.md and, when nothing was published, the root's context. Anything else does nothing.
     */
    readonly handBack: (sessionID: string) => Effect.Effect<void>
  }
>()("dotfiles-opencode/orchestrate/Verdicts") {}

/** The verdicts' handler. It remembers only which verdicts it published, so a verdict read again publishes nothing. */
export const verdictLayer = Layer.effect(
  Verdicts,
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const fleet = yield* Fleet
    const records = yield* RunRecords
    const remind = yield* Remind
    const published = new Set<string>()
    const one = yield* Semaphore.make(1)

    /** Says what recording the fleet target did where the orchestrator reads it: the run's log.md, the server's log, and, when nothing was published, the root's context. */
    const told = Effect.fn("Verdicts.told")(function* (root: Option.Option<string>, batch: string, report: Option.Option<string>, directory: Option.Option<string>, outcome: FleetOutcome) {
      for (const line of fleetLineOf(batch, outcome, yield* Clock.currentTimeMillis)) {
        if (outcome._tag === "Refused") yield* Effect.logWarning(line)
        else yield* Effect.logInfo(line)
        const entries = Option.toArray(report).map((near) => Option.match(directory, { onNone: () => ({ near, line }), onSome: (dir) => ({ near, line, directory: dir }) }))
        yield* Effect.forEach(entries, (entry) => records.log(entry), { discard: true })
        if (outcome._tag === "Refused") yield* Effect.forEach(Option.toArray(root), (id) => remind.remind(id, { text: line, description: FLEET_DESCRIPTION }).pipe(Effect.ignore), { discard: true })
      }
    })

    const handBack = Effect.fn("Verdicts.handBack")(function* (sessionID: string) {
      if ((yield* sessions.agentOf(sessionID)) !== "verifier") return
      const words = yield* sessions.lastWordsOf(sessionID)
      const said = handBackOf("verifier", words)
      if (said === undefined || said.verdict !== "accepted") return
      const key = `${sessionID}\n${words ?? ""}`
      if (published.has(key)) return
      published.add(key)
      const report = Option.fromUndefinedOr(said.file)
      const outcome = yield* fleet.record({ report, batch: said.unit })
      yield* told(Option.fromUndefinedOr(yield* sessions.parentOf(sessionID)), said.unit, report, Option.fromUndefinedOr(yield* sessions.directoryOf(sessionID)), outcome)
    }, one.withPermits(1))

    return { handBack }
  }),
)

// ── A run's skill drift (skill-drift.ts) ──

/** What one drift check of an idle root came to, for the plugin's log. */
export type DriftOutcome =
  | { readonly _tag: "Told"; readonly runs: ReadonlyArray<string> }
  | { readonly _tag: "Quiet"; readonly why: string }
  | { readonly _tag: "Refused"; readonly message: string }

export class SkillDrifts extends Context.Service<
  SkillDrifts,
  {
    /**
     * The session ended its turn. When it is a root that owns runs (it started
     * a step of one), each run with a dir is checked against the installed
     * skill: a run never seen records the version; a run that saw an older one
     * goes into one note to the root, and records the new one once told.
     */
    readonly idle: (sessionID: string) => Effect.Effect<DriftOutcome>
  }
>()("dotfiles-opencode/orchestrate/SkillDrifts") {}

/** The drift checks: one at a time, so two idle events tell a run once. */
export const driftLayer = (config: Pick<Config, "place" | "now">) =>
  Layer.effect(
    SkillDrifts,
    Effect.gen(function* () {
      const sessions = yield* Sessions
      const steps = yield* StepLog
      const runs = yield* Runs
      const skill = yield* Skill
      const records = yield* RunRecords
      const tell = yield* Tell
      const one = yield* Semaphore.make(1)
      const sabbathNow = config.now === undefined ? Clock.currentTimeMillis : Effect.succeed(config.now)

      const idle: (sessionID: string) => Effect.Effect<DriftOutcome> = Effect.fn("SkillDrifts.idle")(
        function* (sessionID: string) {
          if ((yield* sessions.parentOf(sessionID)) !== undefined) return { _tag: "Quiet", why: "a subagent" } as const
          // No agent works over the Sabbath, so no reconcile is asked for then.
          if (resumesAt(yield* sabbathNow, config.place) !== undefined) return { _tag: "Quiet", why: "the Sabbath" } as const
          const started = yield* steps.units(sessionID)
          if (started.length === 0) return { _tag: "Quiet", why: "owns no run" } as const
          const owned = (yield* runs.list).flatMap((run) =>
            run.dir !== undefined && run.units.some((unit) => started.includes(unit.unit)) ? [{ name: run.name, dir: run.dir }] : [],
          )
          if (owned.length === 0) return { _tag: "Quiet", why: "owns no run with a dir" } as const
          const installed = yield* skill.version
          if (installed === undefined) return { _tag: "Quiet", why: "the skill's version cannot be read" } as const
          const drifts: Array<Drift & { readonly dir: string }> = []
          for (const { name, dir } of owned) {
            const seen = yield* records.seen(dir)
            const relation = seen === undefined || seen === installed ? undefined : yield* skill.relation(seen, installed)
            const step = stepOf(seen, installed, relation)
            if (step._tag === "Record") yield* records.see(dir, installed)
            if (step._tag === "Tell" && seen !== undefined)
              drifts.push({ run: name, dir, seen, installed, subjects: step.subjects, unrelated: step.unrelated, departures: yield* records.departures(dir) })
          }
          if (drifts.length === 0) return { _tag: "Quiet", why: "every run saw this skill" } as const
          return yield* tell.tell(sessionID, { text: noteOf(drifts), description: descriptionOf(drifts) }).pipe(
            Effect.andThen(Effect.forEach(drifts, (drift) => records.see(drift.dir, installed), { discard: true })),
            Effect.as<DriftOutcome>({ _tag: "Told", runs: drifts.map((drift) => drift.run) }),
            Effect.catchTag("NudgeRefused", (refused) => Effect.succeed<DriftOutcome>({ _tag: "Refused", message: refused.message })),
          )
        },
        one.withPermits(1),
      )

      return { idle }
    }),
  )

/** What the log says about a refusal: the Sabbath's sentence, the pace's reason, or the latch the child waits on. */
const whyOf = (rejection: Rejection | PaceHeld): string =>
  Match.value(rejection).pipe(
    Match.tagsExhaustive({
      SabbathRest: (rest) => rest.why,
      PaceHeld: (held) => held.reason,
      CodexNeverImplements: (codex) => `Codex never implements: the ${codex.agent} would run on ${codex.model} and no Opus is offered`,
      StillLatched: (still) => `subagent ${still.child} is latched until ${new Date(still.opensAt).toISOString()}`,
    }),
  )
