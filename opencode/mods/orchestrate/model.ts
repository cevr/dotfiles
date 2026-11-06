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
  readyUnits,
  ReportDraft,
} from "./idle.ts"
import { formatRef, PaceHeld, paceOfReply, parseModel, type ModelRef, type PaceHold, type PaceReply } from "./pace.ts"
import { codexFallback, effort, isRole, Reason, WORKER } from "./role.ts"
import { resumesAt, SabbathRest, type Place } from "./sabbath.ts"
import { CallLog, CodexAdmission, Latches, Models, PoolPace, RootHolds, Runs, Sessions, Steer, StepLog } from "./service.ts"
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
      const decide = (command: Command, now: number, tool: string, asked?: Asked) =>
        ToolCall.decide(ToolCall.initial, command, now).pipe(
          // A latch is logged once the wakes keep it, with its child; or as the call's refusal when they cannot.
          Effect.tap((events) =>
            Effect.forEach(events, (event) =>
              event._tag === "SubagentLatched" && event.child === undefined ? Effect.void : Effect.flatMap(at, (time) => log.append(lineOf(event, time, asked))),
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
        const poolReply = whose === "pool" || config.codex?.pool === true ? yield* pool.pace(ref.providerID) : undefined
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
        // A new role subagent runs at the role's effort, as a variant of the model it would run on.
        let model = typeof fields.model === "string" && fields.model !== "" ? fields.model : undefined
        const level = isRole(routed.agent) ? effort(routed.agent) : undefined
        if (child === undefined && level !== undefined && level !== "" && model === undefined) {
          const variant = yield* models.variant(call.sessionID, routed.agent, level)
          if (variant) model = variant
        }
        // A new worker that names no model runs on the one it inherits, at that model's variant: the aggregate caps it.
        const runsOn = child === undefined && model === undefined && routed.agent === WORKER ? yield* models.base(call.sessionID, routed.agent) : undefined
        const inherited = runsOn === undefined ? undefined : formatRef(runsOn)
        // A new agent's pace; over the Sabbath only its model, for the latch.
        const paced =
          child === undefined
            ? resting
              ? { ref: parseModel(model) ?? (yield* models.base(call.sessionID, routed.agent)), hold: undefined, asked: {} }
              : yield* paceOf(call.sessionID, routed.agent, model)
            : undefined
        const hold = paced?.hold
        // The model it would run on, named; with a fallback the command names it so the log says what was held.
        const primary = model ?? (paced?.ref === undefined ? undefined : `${paced.ref.providerID}/${paced.ref.id}`)
        // A model the call named is kept as asked: only a role's own model falls back.
        const named = typeof fields.model === "string" && fields.model !== ""
        const offered =
          hold !== undefined && !named && paced?.ref !== undefined ? yield* fallbackOf(call.sessionID, paced.ref, routed.agent, base.description) : undefined
        const fallback = offered?.fallback
        // What each pace asked said, for the line: a follow-up asked none.
        const asked: Asked = { ...paced?.asked, ...offered?.asked }
        const command = StartSubagent.make({
          ...base,
          ...(childAgent ? { childAgent } : {}),
          ...(fallback !== undefined && primary !== undefined ? { model: primary, fallback } : model === undefined ? {} : { model }),
          ...(inherited === undefined ? {} : { inherited }),
          ...(hold === undefined ? {} : { hold }),
          ...(childLatched === undefined ? {} : { childLatched }),
        })
        const events = yield* decide(command, now, SUBAGENT, asked)
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
          yield* log.append(CallLine.latched(event, yield* at, asked))
          return Option.some({ _tag: "LatchedStart" as const, id: kept.id, child: kept.child, latched: event })
        }
        const started = events.find((event) => event._tag === "SubagentStarted")
        // A new agent counts on the pace of the provider it started on, here and on the owner's other hosts, until its spend shows.
        const ran = started === undefined || paced === undefined ? undefined : (parseModel(started.model) ?? paced.ref)
        if (ran !== undefined) yield* pool.started(ran.providerID)
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
          yield* log.append(CallLine.latched(latched, yield* at, asked))
          const ahead = yield* skew
          return { outcome: "held", hold: latched.hold, reason: latched.why, opensAt: latched.opensAt + ahead, recheckAt: latched.recheckAt + ahead }
        }
        const started = events.find((event) => event._tag === "SubagentStarted")
        if (started === undefined) return { outcome: "opened" }
        yield* log.append(CallLine.started(started, yield* at, asked))
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

      return { startSubagent, openLatch, useTool, finishSubagent: finish }
    }),
  )

const lineOf = (event: Event, at: string, asked: Asked | undefined) =>
  event._tag === "SubagentStarted"
    ? CallLine.started(event, at, asked)
    : event._tag === "SubagentLatched"
      ? CallLine.latched(event, at, asked)
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
          const ready = resting ? [] : readyUnits(yield* runs.list, yield* steps.units(sessionID))
          const gathered = ready.length === 0 ? NO_HOLDS : yield* holds.of(sessionID)
          const decided = yield* apply(sessionID, Nudge.make({ ready, holds: gathered, resting })).pipe(Effect.result)
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

/** What the log says about a refusal: the Sabbath's sentence, the pace's reason, or the latch the child waits on. */
const whyOf = (rejection: Rejection | PaceHeld) =>
  rejection._tag === "SabbathRest"
    ? rejection.why
    : rejection._tag === "PaceHeld"
      ? rejection.reason
      : `subagent ${rejection.child} is latched until ${new Date(rejection.opensAt).toISOString()}`
