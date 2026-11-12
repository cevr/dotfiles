// The orchestrate model's handlers: each gathers what one command needs from
// the outside systems, has the ToolCall aggregate decide it, and writes the
// outcome to the call log. The aggregate is the one decision entry point, so
// the stories run exactly what these do. The plugin calls these and nothing else.
//
// Opus first, Codex second: a new agent the pace holds on its model, that
// named no model of its own, is offered the newest Codex model for its role
// (role.ts `codexFallback`), when the host offers one, with the Codex pace's
// hold on it. The aggregate starts it there when Codex has room.
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
import { Clock, Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
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
import {
  briefOf,
  type Cadence,
  type Command as MachineCommand,
  type Event as MachineEvent,
  Drop,
  HandBack,
  handBackOf as stepHandBackOf,
  Land,
  Landed,
  entryOf,
  type LandEntry,
  type LandTarget,
  machine,
  type MachineState,
  notesOf,
  type Refused,
  ReportRead,
  reportOf,
  Spawned,
  type Start,
  startOf as stepOfCall,
  unresolvedOf,
  verifierPromptOf,
} from "./machine.ts"
import { formatRef, namesModel, PaceHeld, paceOfReply, parseModel, type ModelRef, type PaceHold, type PaceReply } from "./pace.ts"
import { codexFallback, effort, isCodexModel, isRole, Reason, route, unspecific, WORKER } from "./role.ts"

/** The owner's rule: Codex plans and verifies, never implements; every other agent stays on its own model. */
const onCodex = (agent: string) => agent === "planner" || agent === "verifier"
import { resumesAt, SabbathRest, type Place } from "./sabbath.ts"
import {
  Branches,
  CallLog,
  CodexAdmission,
  type Decided,
  type GuardMode,
  Latches,
  Findings,
  Fleet,
  Ledger,
  Liveness,
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
import { departureLines, driftLine, logLineOf, scoreOf } from "./drift.ts"
import { FLEET_DESCRIPTION, type FleetOutcome, fleetLineOf } from "./fleet.ts"
import { handBackOf, startOf, type Transition, unitDirsIn } from "./unit-log.ts"
import { isStep } from "./described.ts"
import {
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

/** A latch's models, kept in its context: the first it is decided on, and the Codex fallback. */
const LatchModels = Schema.Struct({ primary: Schema.String, fallback: Schema.String })

/** Why a latched planner left its first model, kept in the latch's context, so the line its open writes records it too. */
const LatchFirst = Schema.Struct({ model: Schema.String, fellBack: Schema.String })

/** What `startSubagent` may refuse: the Sabbath or a still-latched child for a follow-up, and a held start no latch could be kept for. */
export type StartRefusal = SabbathRest | PaceHeld | StillLatched

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
        const codexNamed = asks !== undefined && routed.agent === "implementor" && isCodexModel(asks, config.codex?.providers ?? [])
        const dropped = asks !== undefined && ((bound !== undefined && namesModel(asks, bound)) || codexNamed) ? asks : undefined
        const level = isRole(routed.agent) ? effort(routed.agent) : undefined
        const onFirst = yield* firstOf(call.sessionID, {
          agent: routed.agent,
          followUp: child !== undefined,
          namedModel: asks !== undefined && dropped === undefined,
          level,
          resting,
        })
        // A new role subagent runs at the role's effort, as a variant of the model it would run on; a planner on its first model, at it.
        let model = onFirst?.model ?? (dropped === undefined ? asks : undefined)
        if (child === undefined && level !== undefined && level !== "" && model === undefined) {
          const variant = yield* models.variant(call.sessionID, routed.agent, level)
          if (variant) model = variant
        }
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
        const kept = Option.getOrUndefined(Schema.decodeUnknownOption(LatchModels)(latch.context.models))
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
        const primary = tried?.model ?? own ?? kept?.primary ?? latch.model
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
        yield* decide(UseTool.make({ call, tool, inSubagent, place: config.place }), now, tool).pipe(Effect.catchTag("StillLatched", Effect.die))
      })

      const finish = Effect.fn("Orchestrate.finishSubagent")(function* (input: {
        readonly call: ToolCallId
        readonly child?: string
        readonly status: Status
      }) {
        // A finish is only recorded, never refused.
        const now = yield* sabbathNow
        yield* decide(FinishSubagent.make(input), now, SUBAGENT).pipe(Effect.catchTags({ SabbathRest: Effect.die, StillLatched: Effect.die }))
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

export class IdleRoots extends Context.Service<
  IdleRoots,
  {
    /** The session ended its turn with nothing pending; `background` still runs for it. A root's idle period is decided now. */
    readonly idle: (sessionID: string, background: number) => Effect.Effect<IdleOutcome | undefined>
    /** New input reached the session (not the nudge): its idle period, if any, ends. */
    readonly heard: (sessionID: string) => Effect.Effect<void>
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
          if (held !== undefined) return { _tag: "NotNudged", why: held.why, detail: held.detail } as const
          const resting = resumesAt(yield* sabbathNow, config.place) !== undefined
          const units = resting ? { moving: [], ready: [] } : unitsOf(yield* runs.list, yield* steps.units(sessionID))
          const gathered = units.moving.length === 0 && units.ready.length === 0 ? NO_HOLDS : yield* holds.of(sessionID)
          const decided = yield* apply(sessionID, Nudge.make({ ...units, holds: gathered, resting })).pipe(Effect.result)
          if (decided._tag === "Failure") return { _tag: "NotNudged", why: decided.failure.why, detail: decided.failure.detail } as const
          const nudged = decided.success.events.find((event) => event._tag === "Nudged")
          if (nudged === undefined) return { _tag: "NotNudged", why: "nudged", detail: "nothing to record" } as const
          return yield* steer.nudge(sessionID, nudged.line).pipe(
            Effect.as<IdleOutcome>({ _tag: "Nudged", line: nudged.line }),
            Effect.catchTag("NudgeRefused", (refused) => Effect.succeed<IdleOutcome>({ _tag: "Refused", message: refused.message })),
          )
        }).pipe(one.withPermits(1))

      const idle = Effect.fn("IdleRoots.idle")(function* (sessionID: string, background: number) {
        if ((yield* sessions.parentOf(sessionID)) !== undefined) return undefined
        yield* apply(sessionID, GoIdle.make({ background })).pipe(Effect.orDie)
        return yield* consider(sessionID)
      })

      const heard = Effect.fn("IdleRoots.heard")(function* (sessionID: string) {
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

      const forget = (sessionID: string) => Effect.sync(() => void roots.delete(sessionID)).pipe(Effect.withSpan("IdleRoots.forget"))

      return { idle, heard, draft, forget }
    }),
  )

// ── The batch machine (machine.ts) ──

/** The machine's settings, from the plugin's options. */
export interface MachineConfig {
  readonly cadence: Cadence
  readonly mode: GuardMode
  /** An untyped or general call runs as asked (Config `fullAgent`). */
  readonly fullAgent: boolean
  /** The machine block a compacted root is told: SKILL.md's "The machine" section (agents.json `machine`). */
  readonly block: string
}

/** A role's start the machine let through, still in its call: alive though its session is not known yet. */
interface InFlight {
  readonly root: string
  readonly role: Start["role"]
  readonly name: string
}

/** What telling a compacted root came to, for the plugin's log. */
export type BriefOutcome =
  | { readonly _tag: "Told"; readonly brief: string }
  | { readonly _tag: "Quiet"; readonly why: string }
  | { readonly _tag: "Refused"; readonly message: string }

/** The notice row the brief draws. */
export const BRIEF_DESCRIPTION = "orchestrate: the machine and your run, after the compaction"

/** The message a compacted root reads: the machine (SKILL.md's section), its run from the ledger, and the re-read. */
export const briefText = (block: string, brief: string): string =>
  [
    block.trim(),
    `Your run now, from the plugin's ledger:\n${brief}`,
    "Re-read ~/.claude/skills/orchestrate/SKILL.md and protocol.md, and your plan, before any other action.",
  ].join("\n\n")

/** What a call the machine let through answers with first: its notes, and under `warn` the rule it broke. */
export interface Passed {
  readonly notes: ReadonlyArray<string>
  /** What the call's prompt gains at its end: a batch verifier's findings to check as folded. */
  readonly prompt?: string
}

export class Machines extends Context.Service<
  Machines,
  {
    /**
     * A subagent call of `root`, about to start (`key` names the call: a kernel cell's calls share one id).
     * A role's step is decided on the root's ledger: refused, the call fails with the rule's words; let
     * through, it answers with the notes. Any other call passes with none.
     */
    readonly start: (input: { readonly root: string; readonly key: string; readonly input: unknown }) => Effect.Effect<Passed, Refused>
    /** The call `key` answered: its child's session, or none when it did not start. */
    readonly started: (input: { readonly root: string; readonly key: string; readonly child?: string }) => Effect.Effect<void>
    /**
     * A land's Rifts as the machine knows them: each entry by path (`/…`, `~/…`) with the branch checked
     * out there, when it reads. Read once, before the land: a pushed land trashes its Rifts.
     */
    readonly resolve: (rifts: ReadonlyArray<LandTarget>) => Effect.Effect<ReadonlyArray<LandEntry>>
    /** A `rift` land of `root`, about to run. */
    readonly land: (input: { readonly root: string; readonly rifts: ReadonlyArray<LandTarget>; readonly departs?: string }) => Effect.Effect<Passed, Refused>
    /** The Rifts a land of `root` answered green. */
    readonly landed: (input: { readonly root: string; readonly rifts: ReadonlyArray<LandTarget> }) => Effect.Effect<void>
    /**
     * `root` ran log.ts moving the units in `dirs` to `dropped` (relative ones from `workdir`, else the root's
     * directory). Each whose log.md now ends in that move ends, and the findings it held go with it (machine.ts
     * `Drop`); one whose move log.ts refused, or did not write, stays.
     */
    readonly dropped: (input: { readonly root: string; readonly dirs: ReadonlyArray<string>; readonly workdir: Option.Option<string> }) => Effect.Effect<void>
    /** A session went idle: a step's hand-back moves its unit or ends its verifier. */
    readonly handBack: (sessionID: string) => Effect.Effect<void>
    /** The root's run as its ledger holds it, its dead steps handed back first; empty for a root that runs no unit. */
    readonly brief: (root: string) => Effect.Effect<string>
    /**
     * A session's compaction ended: a root whose brief is not empty is told the machine and its run, in one
     * message that rides on its next request. The plugin calls it once per compaction.
     */
    readonly compacted: (sessionID: string) => Effect.Effect<BriefOutcome>
  }
>()("dotfiles-opencode/orchestrate/Machines") {}

/** The machine's handlers: the plugin feeds each call it sees, and the ledger decides it. */
export const machineLayer = (config: MachineConfig) =>
  Layer.effect(
    Machines,
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const sessions = yield* Sessions
      const liveness = yield* Liveness
      const remind = yield* Remind
      const findings = yield* Findings
      const branches = yield* Branches
      const records = yield* RunRecords
      const fleet = yield* Fleet
      const unitLogs = yield* UnitLogs
      const inFlight = new Map<string, InFlight>()

      const flying = (root: string, role: Start["role"], name: string) =>
        [...inFlight.values()].some((step) => step.root === root && step.role === role && step.name === name)

      /** Whether a step still works: its call is in flight, or its session runs, is latched, or keeps work of its own. */
      const working = (root: string, role: Start["role"], name: string, child: string | undefined) =>
        Effect.gen(function* () {
          if (flying(root, role, name)) return true
          if (child === undefined) return false
          return (yield* liveness.alive(child)) || (yield* sessions.latchOf(child)) !== undefined
        })

      /** The verdict an implementor's session hands `name` back with in its last words; `none` when they hand back no such step. */
      const lastVerdictOf = (name: string, child: Option.Option<string>) =>
        Effect.map(Effect.forEach(Option.toArray(child), (id) => sessions.lastWordsOf(id)), (words) =>
          Option.fromNullishOr(stepHandBackOf("implementor", words.join("\n"))).pipe(
            Option.filter((back) => back.name === name),
            Option.map((back) => back.verdict),
            Option.getOrElse((): HandBack["verdict"] => "none"),
          ),
        )

      /** A `changes` hand-back's findings as its report gives them, or why they are not known. */
      const readReport = (report: string | undefined) =>
        Effect.gen(function* () {
          if (report === undefined) return { unread: { why: "its hand-back names no findings report" } }
          const read = yield* findings.read(report)
          return read._tag === "Read" ? { findings: read.findings } : { unread: { report, why: read.why } }
        })

      /** The hand-back a step's session's last words say, as the machine takes it: a verifier's `changes` with its report read. */
      const saidBy = (agent: string, sessionID: string) =>
        Effect.gen(function* () {
          const words = yield* sessions.lastWordsOf(sessionID)
          const back = Option.fromNullishOr(stepHandBackOf(agent, words))
          if (Option.isNone(back) || back.value.role !== "verifier" || back.value.verdict !== "changes") return back
          return Option.some(HandBack.make({ ...back.value, ...(yield* readReport(reportOf(words))) }))
        })

      /** A verifier whose verdict a reconcile read from its last words, before its idle was seen: its batch, session and verdict. */
      interface Heard {
        readonly batch: string
        readonly child: string
        readonly verdict: HandBack["verdict"]
      }

      /**
       * The ledger can miss an end (a restart, a cancelled latch, a child that never handed back): each
       * implementor and the verifier that no longer works is handed back before a decision reads them, with the
       * hand-back its session's last words say, else `none`. A land made the moment a step handed back would
       * otherwise end it ahead of its own hand-back (the ledger of 2026-11-12, batch af, for an implementor; the
       * same race lost a verifier's verdict). Each verifier verdict read so goes into `heard`, to be concluded.
       */
      const reconcile = (root: string, state: MachineState, heard: Array<Heard>) =>
        Effect.gen(function* () {
          const dead: Array<MachineCommand> = []
          for (const [name, unit] of Object.entries(state.units)) {
            if (unit.state !== "implement" || (yield* working(root, "implementor", name, unit.child))) continue
            dead.push(HandBack.make({ role: "implementor", name, verdict: yield* lastVerdictOf(name, Option.fromNullishOr(unit.child)) }))
          }
          const verifier = state.verifier
          if (verifier === undefined || (yield* working(root, "verifier", verifier.batch, verifier.child))) return dead
          const said = yield* Effect.forEach(Option.toArray(Option.fromNullishOr(verifier.child)), (child) =>
            Effect.map(saidBy("verifier", child), Option.map((back) => ({ back, child }))),
          )
          const own = Option.filter(Option.flatten(Option.fromIterable(said)), ({ back }) => back.name === verifier.batch)
          if (Option.isNone(own)) return [...dead, HandBack.make({ role: "verifier", name: verifier.batch, verdict: "none" })]
          heard.push({ batch: verifier.batch, child: own.value.child, verdict: own.value.back.verdict })
          return [...dead, own.value.back]
        })

      /** Each unresolved verdict whose report reads now: its findings, read again before a decision. */
      const reread = (state: MachineState) =>
        Effect.gen(function* () {
          const read: Array<MachineCommand> = []
          for (const [batch, debt] of unresolvedOf(state)) {
            if (debt.report === undefined) continue
            const again = yield* findings.read(debt.report)
            if (again._tag === "Read") read.push(ReportRead.make({ batch, findings: again.findings }))
          }
          return read
        })

      /** `state` after `commands` that never refuse (a report read again), as the ledger will decide them. */
      const decider = machine(config.cadence)
      const advance = (state: MachineState, commands: ReadonlyArray<MachineCommand>, at: number) =>
        Effect.gen(function* () {
          let current = state
          for (const command of commands) {
            const events = yield* decider.decide(current, command, at).pipe(Effect.orElseSucceed((): ReadonlyArray<MachineEvent> => []))
            current = events.reduce(decider.evolve, current)
          }
          return current
        })

      const now = Clock.currentTimeMillis
      const warnedNote = (decided: Decided) => (decided.warned === undefined ? [] : [decided.warned.message])

      /**
       * Says what recording the fleet target did where the orchestrator reads it: the run's log.md,
       * the server's log, and, when nothing was published, the root's context for its next turn.
       */
      const toldFleet = Effect.fn("Machines.toldFleet")(function* (root: string, batch: string, report: Option.Option<string>, directory: Option.Option<string>, outcome: FleetOutcome) {
        for (const line of fleetLineOf(batch, outcome, yield* now)) {
          if (outcome._tag === "Refused") yield* Effect.logWarning(line)
          else yield* Effect.logInfo(line)
          const entries = Option.toArray(report).map((near) => Option.match(directory, { onNone: () => ({ near, line }), onSome: (dir) => ({ near, line, directory: dir }) }))
          yield* Effect.forEach(entries, (entry) => records.log(entry), { discard: true })
          if (outcome._tag === "Refused") yield* remind.remind(root, { text: line, description: FLEET_DESCRIPTION }).pipe(Effect.ignore)
        }
      })

      /**
       * A verifier's verdict the ledger recorded, once: it adds the root's drift to its run's log.md (its report's
       * run), and an accepted one records the fleet target its batch file names, apart from the hand-back. The
       * ledger records a verdict once (it ends the verifier), so whichever reads it first, the idle hand-back or a
       * reconcile, concludes it.
       */
      const conclude = Effect.fn("Machines.conclude")(function* (root: string, at: number, ended: Heard) {
        const words = yield* sessions.lastWordsOf(ended.child)
        const report = reportOf(words)
        const directory = yield* sessions.directoryOf(ended.child)
        if (ended.verdict === "accepted")
          yield* fleet.record({ report: Option.fromNullishOr(report), batch: ended.batch }).pipe(
            Effect.flatMap((outcome) => toldFleet(root, ended.batch, Option.fromNullishOr(report), Option.fromNullishOr(directory), outcome)),
            Effect.forkDetach,
          )
        if (ended.verdict === "none" || report === undefined) return
        const line = logLineOf(yield* ledger.drift(root), at, ended.batch, ended.verdict)
        yield* records.log({ near: report, line, ...(directory === undefined ? {} : { directory }) })
      })

      /**
       * `decide`, on a fresh record of the verdicts its reconcile reads from verifiers' last words, each concluded
       * once `decide` ends, whatever it came to: the hand-backs come first in its commands and never refuse, so a
       * call the machine refuses after them has still recorded them.
       */
      const reconciled = <A, E, R>(root: string, at: number, decide: (heard: Array<Heard>) => Effect.Effect<A, E, R>) =>
        Effect.suspend(() => {
          const heard: Array<Heard> = []
          return decide(heard).pipe(Effect.ensuring(Effect.suspend(() => Effect.forEach(heard, (each) => conclude(root, at, each), { discard: true }))))
        })

      const start = Effect.fn("Machines.start")(function* (input: { readonly root: string; readonly key: string; readonly input: unknown }) {
        if (typeof input.input !== "object" || input.input === null) return { notes: [] }
        const fields = input.input as Record<string, unknown>
        const description = typeof fields.description === "string" ? fields.description : undefined
        // The role it runs as, as the guard routes it: a follow-up naming no agent keeps its child's.
        const child = typeof fields.sessionID === "string" && fields.sessionID !== "" ? fields.sessionID : undefined
        const routed = route(fields.agent, config.fullAgent, description).agent
        const agent = child !== undefined && unspecific(fields.agent) ? ((yield* sessions.agentOf(child)) ?? routed) : routed
        // The step is its description's alone: no prompt is read (a land knows a unit by its Rift's branch, unitOfEntry).
        const command = stepOfCall(agent, description)
        if (command === undefined) return { notes: [] }
        const at = yield* now
        let notes: ReadonlyArray<string> = []
        let prompt: string | undefined
        const decided = yield* reconciled(input.root, at, (heard) =>
          ledger.decide(
            input.root,
            at,
            (state) =>
              Effect.gen(function* () {
                const dead = command.role === "verifier" ? yield* reconcile(input.root, state, heard) : []
                // An unresolved verdict's report that reads now opens its findings first: this start may fold them.
                const read = yield* reread(state)
                const seen = yield* advance(state, read, at)
                notes = notesOf(seen, command, at, config.cadence)
                prompt = verifierPromptOf(seen, command)
                return [...dead, ...read, command]
              }),
            config.mode,
          ),
        )
        inFlight.set(input.key, { root: input.root, role: command.role, name: command.name })
        return { notes: [...warnedNote(decided), ...notes], ...(prompt === undefined ? {} : { prompt }) }
      })

      const started = Effect.fn("Machines.started")(function* (input: { readonly root: string; readonly key: string; readonly child?: string }) {
        const step = inFlight.get(input.key)
        if (step === undefined) return
        inFlight.delete(input.key)
        const child = input.child
        if (child === undefined || step.role === "planner") return
        yield* ledger.decide(input.root, yield* now, () => Effect.succeed([Spawned.make({ role: step.role, name: step.name, child })])).pipe(Effect.ignore)
      })

      const resolve = Effect.fn("Machines.resolve")(function* (rifts: ReadonlyArray<LandTarget>) {
        return yield* Effect.forEach(
          rifts,
          (target) => {
            const entry = entryOf(target)
            if (entry.unit !== undefined || entry.branch !== undefined || !/^(?:\/|~\/)/.test(entry.rift)) return Effect.succeed(entry)
            return branches.of(entry.rift).pipe(Effect.map((branch): LandEntry => (branch === undefined ? entry : { ...entry, branch })))
          },
          { concurrency: 4 },
        )
      })

      const land = Effect.fn("Machines.land")(function* (input: { readonly root: string; readonly rifts: ReadonlyArray<LandTarget>; readonly departs?: string }) {
        const command = Land.make({ rifts: input.rifts, ...(input.departs === undefined ? {} : { departs: input.departs }) })
        const at = yield* now
        const decided = yield* reconciled(input.root, at, (heard) =>
          ledger.decide(
            input.root,
            at,
            (state) => Effect.all([reconcile(input.root, state, heard), reread(state)]).pipe(Effect.map(([dead, read]) => [...dead, ...read, command])),
            config.mode,
          ),
        )
        return { notes: warnedNote(decided) }
      })

      const landed = Effect.fn("Machines.landed")(function* (input: { readonly root: string; readonly rifts: ReadonlyArray<LandTarget> }) {
        yield* ledger.decide(input.root, yield* now, () => Effect.succeed([Landed.make({ rifts: input.rifts })])).pipe(Effect.ignore)
      })

      const dropped = Effect.fn("Machines.dropped")(function* (input: { readonly root: string; readonly dirs: ReadonlyArray<string>; readonly workdir: Option.Option<string> }) {
        if (input.dirs.length === 0) return
        const rootDirectory = Option.fromNullishOr(yield* sessions.directoryOf(input.root))
        const directory = Option.orElse(input.workdir, () => rootDirectory)
        // What log.ts wrote decides, never what the command asked: a refused move leaves its unit as it was.
        const units = yield* Effect.forEach(input.dirs, (dir) => unitLogs.droppedIn(dir, directory))
        const drops = [...new Set(units.flatMap(Option.toArray))].map((unit) => Drop.make({ unit }))
        if (drops.length > 0) yield* ledger.decide(input.root, yield* now, () => Effect.succeed(drops)).pipe(Effect.ignore)
      })

      const handBack = Effect.fn("Machines.handBack")(function* (sessionID: string) {
        const agent = yield* sessions.agentOf(sessionID)
        if (agent === undefined || !isStep(agent)) return
        const root = yield* sessions.parentOf(sessionID)
        if (root === undefined) return
        // A verifier's `changes` opens the findings its report holds: each folds into the next batch. A report that
        // does not read, or none named, leaves the verdict unresolved: never an empty set of findings.
        const back = yield* saidBy(agent, sessionID)
        if (Option.isNone(back)) return
        const said = back.value
        // The session that handed back is the step's: a step started before its session was known gets it here.
        const at = yield* now
        const decided = yield* ledger.decide(root, at, () => Effect.succeed([said])).pipe(Effect.orElseSucceed(() => undefined))
        // A verdict a reconcile read first was concluded there: the ledger then decides this hand-back to nothing.
        const ended = decided?.events.find((event) => event._tag === "VerifierEnded")
        if (ended !== undefined) yield* conclude(root, at, { batch: ended.batch, child: sessionID, verdict: ended.verdict })
      })

      const brief = Effect.fn("Machines.brief")(function* (root: string) {
        const at = yield* now
        const decided = yield* reconciled(root, at, (heard) =>
          ledger.decide(root, at, (state) => Effect.all([reconcile(root, state, heard), reread(state)]).pipe(Effect.map(([dead, read]) => [...dead, ...read]))),
        ).pipe(Effect.orElseSucceed(() => undefined))
        const state = decided?.state ?? (yield* ledger.state(root))
        const run = briefOf(state, at, config.cadence)
        if (run === "") return run
        // How far the run drifted from the machine so far, with its newest departures and why.
        const drift = yield* ledger.drift(root)
        const departures = departureLines(drift)
        return [run, scoreOf(drift) === 0 ? driftLine(drift) : `${driftLine(drift)} (0 is a clean run)`, ...(departures.length === 0 ? [] : ["last departures:", ...departures.map((line) => `  ${line}`)])].join("\n")
      })

      const compacted = Effect.fn("Machines.compacted")(function* (sessionID: string) {
        if ((yield* sessions.parentOf(sessionID)) !== undefined) return { _tag: "Quiet", why: "a subagent" } as const
        const state = yield* brief(sessionID)
        if (state === "") return { _tag: "Quiet", why: "runs no unit" } as const
        return yield* remind.remind(sessionID, { text: briefText(config.block, state), description: BRIEF_DESCRIPTION }).pipe(
          Effect.as<BriefOutcome>({ _tag: "Told", brief: state }),
          Effect.catchTag("NudgeRefused", (refused) => Effect.succeed<BriefOutcome>({ _tag: "Refused", message: refused.message })),
        )
      })

      return { start, started, resolve, land, landed, dropped, handBack, brief, compacted }
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
const whyOf = (rejection: Rejection | PaceHeld) =>
  rejection._tag === "SabbathRest"
    ? rejection.why
    : rejection._tag === "PaceHeld"
      ? rejection.reason
      : `subagent ${rejection.child} is latched until ${new Date(rejection.opensAt).toISOString()}`
