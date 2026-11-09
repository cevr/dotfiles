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
import * as Restart from "./restart.ts"
import { codexFallback, effort, isRole, Reason, WORKER } from "./role.ts"
import { resumesAt, SabbathRest, type Place } from "./sabbath.ts"
import {
  CallLog,
  CodexAdmission,
  Latches,
  Models,
  PoolPace,
  Restarts,
  type ResumeStart,
  RootHolds,
  RunRecords,
  Runs,
  Sessions,
  Skill,
  Steer,
  StepLog,
  Tell,
  type Transcript,
  UnitLogs,
} from "./service.ts"
import { descriptionOf, type Drift, noteOf, stepOf } from "./skill-drift.ts"
import { armFor, type ArmRecord, type Experiment } from "./experiment.ts"
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
  /** The model experiment (experiment.ts): a share of one role's units run on another model. */
  readonly experiment?: Experiment
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

/** A latch's experiment arm, kept in its context, so the line its open writes records it too. */
const LatchArm = Schema.Struct({ arm: Schema.Literals(["trial", "control"]), model: Schema.String, fellBack: Schema.optional(Schema.String) })

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
      const decide = (command: Command, now: number, tool: string, asked?: Asked, arm?: ArmRecord) =>
        ToolCall.decide(ToolCall.initial, command, now).pipe(
          // A latch is logged once the wakes keep it, with its child; or as the call's refusal when they cannot.
          Effect.tap((events) =>
            Effect.forEach(events, (event) =>
              event._tag === "SubagentLatched" && event.child === undefined ? Effect.void : Effect.flatMap(at, (time) => log.append(lineOf(event, time, asked, arm))),
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
        const { hold, replies } = yield* holdOf(ref, agent)
        const asked: Asked = {
          ...(replies.pool === undefined ? {} : { pace: replies.pool }),
          ...(replies.codex === undefined ? {} : { codex: replies.codex }),
        }
        return { ref, hold, asked }
      })

      /** The hold on a model, if any, with each pace's reply as asked: the pool's, the Codex admission's. */
      const holdOf = Effect.fnUntraced(function* (ref: ModelRef, agent: string) {
        const whose = config.codex?.providers.includes(ref.providerID) ? "codex" : "pool"
        const poolReply = whose === "pool" || config.codex?.pool === true ? yield* pool.pace(ref.providerID, ref.id) : undefined
        const pooled = poolReply === undefined ? undefined : paceOfReply(poolReply)
        const codexReply =
          whose === "codex" && (pooled === undefined || !pooled.measured) ? yield* codex.admit(ref.id, isRole(agent) ? agent : "none") : undefined
        const pace = codexReply === undefined ? pooled : paceOfReply(codexReply)
        const replies = { ...(poolReply === undefined ? {} : { pool: poolReply }), ...(codexReply === undefined ? {} : { codex: codexReply }) }
        if (pace === undefined || pace.ok) return { hold: undefined, replies }
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
        if (providers === undefined || providers.includes(ref.providerID)) return undefined
        const { family, variant } = codexFallback(agent, description)
        const model = yield* models.newest(sessionID, providers, family, variant)
        const at = parseModel(model)
        if (model === undefined || at === undefined) return undefined
        const { hold, replies } = yield* holdOf(at, agent)
        const fallback: Fallback = { model, ...(hold === undefined ? {} : { hold }) }
        return { fallback, asked: fallbackAsked(replies) }
      })

      /**
       * A new start's arm of the model experiment (experiment.ts), if it is in
       * one. A trial start runs on the trial's model at the role's effort, with
       * its pace as asked, when the host offers that model and its pace has
       * room; otherwise, or over the Sabbath, it takes the normal chain (the
       * role's model, then Codex) and its record says why.
       */
      const trialOf = Effect.fnUntraced(function* (
        sessionID: string,
        start: {
          readonly agent: string
          readonly followUp: boolean
          readonly namedModel: boolean
          readonly description: string | undefined
          readonly level: string | undefined
          readonly resting: boolean
        },
      ) {
        const experiment = config.experiment
        const placed = armFor(experiment, start)
        if (experiment === undefined || placed === undefined) return undefined
        const record = (fellBack?: string): ArmRecord => ({ arm: placed.arm, model: experiment.model, ...(fellBack === undefined ? {} : { fellBack }) })
        if (placed.arm === "control") return { record: record() }
        if (start.resting) return { record: record("the Sabbath") }
        const model = yield* models.at(sessionID, experiment.model, start.level === "" ? undefined : start.level)
        const ref = parseModel(model)
        if (model === undefined || ref === undefined) return { record: record(`${experiment.model} is not offered`) }
        const { hold, replies } = yield* holdOf(ref, start.agent)
        if (hold !== undefined) return { record: record(`${model} held: ${hold.reason}`) }
        const asked: Asked = {
          ...(replies.pool === undefined ? {} : { pace: replies.pool }),
          ...(replies.codex === undefined ? {} : { codex: replies.codex }),
        }
        return { record: record(), model, paced: { ref, hold: undefined, asked } }
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
        const dropped = asks !== undefined && bound !== undefined && namesModel(asks, bound) ? asks : undefined
        const level = isRole(routed.agent) ? effort(routed.agent) : undefined
        const trial = yield* trialOf(call.sessionID, {
          agent: routed.agent,
          followUp: child !== undefined,
          namedModel: asks !== undefined && dropped === undefined,
          description: base.description,
          level,
          resting,
        })
        // A new role subagent runs at the role's effort, as a variant of the model it would run on; a trial start, on the trial's model at it.
        let model = trial?.model ?? (dropped === undefined ? asks : undefined)
        if (child === undefined && level !== undefined && level !== "" && model === undefined) {
          const variant = yield* models.variant(call.sessionID, routed.agent, level)
          if (variant) model = variant
        }
        // A new worker that names no model runs on the one it inherits, at that model's variant: the aggregate caps it.
        const runsOn = child === undefined && model === undefined && routed.agent === WORKER ? yield* models.base(call.sessionID, routed.agent) : undefined
        const inherited = runsOn === undefined ? undefined : formatRef(runsOn)
        // A new agent's pace; over the Sabbath only its model, for the latch.
        // A trial start's pace was asked when its arm was decided.
        const paced =
          child === undefined
            ? resting
              ? { ref: parseModel(model) ?? (yield* models.base(call.sessionID, routed.agent)), hold: undefined, asked: {} }
              : (trial?.paced ?? (yield* paceOf(call.sessionID, routed.agent, model)))
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
        const arm = trial?.record
        const events = yield* decide(command, now, SUBAGENT, asked, arm)
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
                ...(arm === undefined ? {} : { experiment: arm }),
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
          yield* log.append(CallLine.latched(event, yield* at, asked, arm))
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
        const primary = kept?.primary ?? latch.model
        const paced = resting || ran ? undefined : yield* paceOf(latch.parent, latch.agent, primary)
        const fallbackAt = parseModel(kept?.fallback)
        const fallbackPaced = paced?.hold !== undefined && fallbackAt !== undefined ? yield* holdOf(fallbackAt, latch.agent) : undefined
        const fallbackHold = fallbackPaced?.hold
        const asked: Asked = { ...paced?.asked, ...(fallbackPaced === undefined ? {} : fallbackAsked(fallbackPaced.replies)) }
        const fallback: Fallback | undefined =
          kept === undefined || paced?.hold === undefined ? undefined : { model: kept.fallback, ...(fallbackHold === undefined ? {} : { hold: fallbackHold }) }
        const reason = Schema.decodeUnknownOption(Reason)(latch.context.reason)
        const arm = Option.getOrUndefined(Schema.decodeUnknownOption(LatchArm)(latch.context.experiment))
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
          yield* log.append(CallLine.latched(latched, yield* at, asked, arm))
          const ahead = yield* skew
          return { outcome: "held", hold: latched.hold, reason: latched.why, opensAt: latched.opensAt + ahead, recheckAt: latched.recheckAt + ahead }
        }
        const started = events.find((event) => event._tag === "SubagentStarted")
        if (started === undefined) return { outcome: "opened" }
        yield* log.append(CallLine.started(started, yield* at, asked, arm))
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

/**
 * Resumes the subagents a restart cut (restart.ts). `resumeCut(boot)` runs
 * once when the plugin starts, at `boot`: a server start, or a plugin reload,
 * which cuts nothing itself but finds a cut an earlier start left. After the
 * first backoff, so OpenCode's own restart recovery lands first, it finds this
 * location's children the restart cut; per parent it waits the longest
 * backoff its children's earlier resumes call for, checks each child again,
 * resumes it in the background (or leaves it after too many resumes in a
 * row), logs each resume, and tells the parent once. Over the Sabbath it
 * resumes nothing.
 */
export class Restarter extends Context.Service<Restarter, { readonly resumeCut: (boot: number) => Effect.Effect<void> }>()(
  "dotfiles-opencode/orchestrate/Restarter",
) {}

/** A child the restart cut, as the scan found it. */
interface Found {
  readonly child: string
  readonly parent: string
  /** When its turn was cut: a later check must find the same cut. */
  readonly at: number
  readonly tries: number
}

export const restarter = (config: Pick<Config, "place" | "now">, backoff: ReadonlyArray<number> = Restart.BACKOFF_MS) =>
  Layer.effect(
    Restarter,
    Effect.gen(function* () {
      const log = yield* CallLog
      const restarts = yield* Restarts
      const sabbathNow = config.now === undefined ? Clock.currentTimeMillis : Effect.succeed(config.now)
      const at = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()))
      const first = backoff[0] ?? 0

      /** Find this location's children the restart cut before `boot`. Each transcript is read once. */
      const scan = Effect.fnUntraced(function* (boot: number) {
        const read = new Map<string, Transcript | undefined>()
        const transcript = (id: string) =>
          read.has(id) ? Effect.succeed(read.get(id)) : restarts.transcript(id).pipe(Effect.tap((found) => Effect.sync(() => read.set(id, found))))
        const judged = new Map<string, boolean>()
        // Cut by the restart: cut with no turn end, or interrupted through a parent's call that was.
        const cut = (id: string): Effect.Effect<boolean> =>
          judged.has(id)
            ? Effect.succeed(judged.get(id)!)
            : Effect.gen(function* () {
                judged.set(id, false) // a cycle in the parent links cuts nothing
                const found = yield* transcript(id)
                if (found === undefined) return false
                const end = Restart.ending(found.entries)
                if (!Restart.inWindow(end, boot)) return false
                const parentID = found.session.parentID
                let verdict = end._tag === "Cut"
                if (!verdict && parentID !== undefined) {
                  const parent = yield* transcript(parentID)
                  verdict = parent !== undefined && Restart.callCut(parent.entries, id, yield* cut(parentID))
                }
                judged.set(id, verdict)
                return verdict
              })
        const found: Array<Found> = []
        for (const card of yield* restarts.children(boot - Restart.WINDOW_MS)) {
          if (card.parentID === undefined || !(yield* cut(card.id))) continue
          const entries = read.get(card.id)?.entries ?? []
          const end = Restart.ending(entries)
          if (end._tag === "Settled") continue
          found.push({ child: card.id, parent: card.parentID, at: end.at, tries: Restart.resumes(entries) })
        }
        return found
      })

      /** Resume one parent's cut children, each checked again first, and tell the parent once. */
      const settle = Effect.fnUntraced(function* (parent: string, children: ReadonlyArray<Found>) {
        const waits = children.map((child) => Restart.verdict(child.tries, backoff)).flatMap((verdict) => (verdict._tag === "Resume" ? [verdict.waitMs] : []))
        const wait = Math.max(0, ...waits) - first
        if (wait > 0) yield* Effect.sleep(wait)
        if (resumesAt(yield* sabbathNow, config.place) !== undefined) return
        const parentNow = yield* restarts.transcript(parent)
        const resumed: Array<Restart.Named> = []
        const left: Array<Restart.Named & { readonly why: string }> = []
        for (const found of children) {
          const now = yield* restarts.transcript(found.child)
          if (now === undefined) continue
          const end = Restart.ending(now.entries)
          // Continued meanwhile (its parent called it, OpenCode resumed it): nothing to do.
          if (end._tag === "Settled" || end.at !== found.at) continue
          const description = now.session.title ?? now.session.agent ?? "subagent"
          const named = { child: found.child, description }
          const verdict = Restart.verdict(Restart.resumes(now.entries), backoff)
          if (verdict._tag === "GiveUp") {
            // Left to the parent once: a later start finds the parent told.
            if (!Restart.toldSince(parentNow?.entries ?? [], found.child, found.at)) left.push({ ...named, why: Restart.gaveUp(verdict.attempts) })
            continue
          }
          const call = parentNow === undefined ? undefined : Restart.callTo(parentNow.entries, found.child)
          const lastTurn = parentNow?.entries.findLast((entry) => entry.type === "assistant")
          const start: ResumeStart = {
            parent,
            from: call?.agent ?? parentNow?.session.agent ?? "build",
            messageID: call?.messageID ?? (lastTurn?.type === "assistant" ? lastTurn.id : ""),
            callID: call?.callID ?? `resume-${found.child}`,
            child: found.child,
            agent: now.session.agent ?? "worker",
            description,
            prompt: Restart.resumePrompt,
          }
          const failed = yield* restarts.resume(start).pipe(
            Effect.as(undefined),
            Effect.catchTag("StartFailed", (failure) => Effect.succeed(failure)),
          )
          if (failed !== undefined) {
            yield* Effect.logWarning("orchestrate: a subagent the restart cut could not be resumed", { child: found.child, message: failed.message })
            left.push({ ...named, why: `it could not be resumed: ${failed.message}` })
            continue
          }
          yield* log.append(CallLine.resumed(start, verdict.attempt, yield* at))
          resumed.push(named)
        }
        if (resumed.length === 0 && left.length === 0) return
        // A resumed child's result wakes the parent; a parent left only to act itself is woken now.
        yield* restarts.tell({
          parent,
          text: Restart.notice(resumed, left),
          description: Restart.NOTICE_TITLE,
          wake: resumed.length === 0,
          children: [...resumed, ...left].map((item) => item.child),
        })
      })

      const resumeCut = Effect.fn("Restarter.resumeCut")(function* (boot: number) {
        // Even with no wait, the plugin's setup finishes first: the subagent tool is handed in after it.
        yield* Effect.sleep(first)
        const found = yield* scan(boot)
        const parents = Map.groupBy(found, (item) => item.parent)
        yield* Effect.forEach(parents, ([parent, children]) => settle(parent, children), { concurrency: "unbounded", discard: true })
      })

      return { resumeCut }
    }),
  )

const lineOf = (event: Event, at: string, asked: Asked | undefined, arm: ArmRecord | undefined) =>
  event._tag === "SubagentStarted"
    ? CallLine.started(event, at, asked, arm)
    : event._tag === "SubagentLatched"
      ? CallLine.latched(event, at, asked, arm)
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

      const idle = (sessionID: string): Effect.Effect<DriftOutcome> =>
        Effect.gen(function* () {
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
        }).pipe(one.withPermits(1), Effect.withSpan("SkillDrifts.idle"))

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
