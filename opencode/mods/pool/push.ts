// A push: an ephemeral, owner-approved spend plan that uses resets to get a
// body of work done. The owner starts one (the `pool_push` tool in their
// session), or says yes to the pool's question when the queued work needs
// more than the pool can spend before its windows reset by themselves.
//
// A push names a goal, a scope (a host, and a session's tree and an
// orchestrate run within it), an end (a time, or "until the work is done":
// the run closes; never past MAX_PUSH_MS) and the resets the owner approved
// (at most `max`, of the kinds and accounts named). While it is active in its
// scope:
//
// - the pace's soft hold (the spend-evenly target) does not hold a start
//   there: planners and verifiers stay on Opus (model.ts `pace`);
// - a start held for real lack of quota has one of the push's resets claimed
//   (resets.ts `pushDue`): an asked claim, the owner's yes given with the
//   push, so it still goes through the fleet's lease, the fresh read before
//   the send, and one claim at a time; the reset is chosen by value
//   (resets.ts `rankPush`).
//
// Outside its scope nothing changes. It ends by itself at its end time, when
// its run closes, or on `end`; its record goes then, and nothing of it lasts
// but the claims it made, which the resets keep as any other.
//
// The Pushes aggregate keeps the host's pushes and the pool's questions about
// starting one (`PushAsk`), once per scope per week: a no holds for the week.
// The plan (`planOf`) is measured from the pool: what the scope can spend
// before its windows reset by themselves, what each approved reset adds, and
// when each would likely be claimed at the current burn; and the host's load
// against its cores, which a push never raises.
import { Effect, Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"
import { toolInput } from "@dotfiles/decider/tool-input"
import { ResetKind } from "./quota.ts"
import { KIND_LABEL, type PoolView, type PushGrant, pushOptions, rankPush, spanOf, sparesOf } from "./resets.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/** No push lasts longer than this, "until the work is done" included: nothing persists past it. */
export const MAX_PUSH_MS = WEEK
/** The pool asks about a push at most once per scope in this long; a no holds for it. */
export const ASK_EVERY_MS = WEEK
/** What one queued orchestrate unit is taken to cost, as a share of one account's week, when the config names none (a guess: a planner, an implementor and a verifier round). */
export const UNIT_COST = 0.1
/** The unit states that are queued work: planned, or being implemented. */
export const QUEUED_STATES: ReadonlyArray<string> = ["plan", "implement"]

/** Whether a unit's state (the orchestrate status script's) is done: merged, dropped or stuck. */
export const closedState = (state: string): boolean => state.startsWith("merged") || state === "dropped" || state.startsWith("stuck")

/** Where a push applies: the host its starts run on, and within it a session's tree (its root) and an orchestrate run, when named. */
export const PushScope = Schema.Struct({
  host: Schema.String,
  sessionID: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
})
export type PushScope = typeof PushScope.Type

/** The resets the owner approved: at most `max`, of `kinds` and on `accounts` (an id or label) when named; `asNeeded` as the owner put it. */
export const Allowance = Schema.Struct({
  max: Schema.Number,
  asNeeded: Schema.Boolean,
  kinds: Schema.optionalKey(Schema.Array(ResetKind)),
  accounts: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type Allowance = typeof Allowance.Type

export const PushBy = Schema.Literals(["asked", "proactive"])
export type PushBy = typeof PushBy.Type

export const Push = Schema.Struct({
  id: Schema.String,
  goal: Schema.String,
  scope: PushScope,
  startedAt: Schema.Number,
  /** When it ends by itself (epoch ms): the end the owner named, else MAX_PUSH_MS on. */
  endsAt: Schema.Number,
  /** Named "until the work is done": it ends when its run closes, else at `endsAt`. */
  untilDone: Schema.Boolean,
  allowance: Allowance,
  /** Started by the owner's call, or by a yes to the pool's question. */
  by: PushBy,
  /** The session the owner started it from, or answered in. */
  sessionID: Schema.optionalKey(Schema.String),
})
export type Push = typeof Push.Type

export const AskStage = Schema.Literals(["asked", "accepted", "declined"])
export type AskStage = typeof AskStage.Type

/** The pool's question whether to start a push, and the push a yes starts. */
export const PushAsk = Schema.Struct({
  /** The scope's key (`scopeKey`): one question per scope per ASK_EVERY_MS. */
  key: Schema.String,
  goal: Schema.String,
  scope: PushScope,
  allowance: Allowance,
  sessionID: Schema.String,
  question: Schema.String,
  at: Schema.Number,
  stage: AskStage,
})
export type PushAsk = typeof PushAsk.Type

export const PushState = Schema.Struct({
  pushes: Schema.Record(Schema.String, Push),
  asks: Schema.Record(Schema.String, PushAsk),
})
export type PushState = typeof PushState.Type

export const empty: PushState = { pushes: {}, asks: {} }

/** A scope as one key: the host, the session's root, the run. */
export const scopeKey = (scope: PushScope) => `${scope.host}:${scope.sessionID ?? "*"}:${scope.run ?? "*"}`

/** The question's key in the owner's tray. */
export const askKey = (key: string) => `push:${key}`

/** The pushes active on `host` at `now`. */
export const activeOn = (state: PushState, host: string, now: number): ReadonlyArray<Push> =>
  Object.values(state.pushes)
    .filter((push) => push.scope.host === host && push.startedAt <= now && now < push.endsAt)
    .toSorted((left, right) => left.startedAt - right.startedAt)

/** Whether a push covers a start from a session whose tree's root is `root`. */
export const covers = (push: Push, root: string | undefined) => push.scope.sessionID === undefined || push.scope.sessionID === root

/** A push as the resets review reads it. */
export const grantOf = (push: Push): PushGrant => ({
  id: push.id,
  goal: push.goal,
  ...(push.scope.sessionID === undefined ? {} : { root: push.scope.sessionID }),
  max: push.allowance.max,
  ...(push.allowance.kinds === undefined ? {} : { kinds: push.allowance.kinds }),
  ...(push.allowance.accounts === undefined ? {} : { accounts: push.allowance.accounts }),
})

// ── Commands and events ──

/** Start a push; one of the same scope ends first. */
export const StartPush = Schema.TaggedStruct("StartPush", {
  goal: Schema.String,
  scope: PushScope,
  /** Its end (epoch ms); none: until the work is done. */
  endsAt: Schema.optionalKey(Schema.Number),
  allowance: Allowance,
  by: PushBy,
  sessionID: Schema.optionalKey(Schema.String),
})
export interface StartPush extends Schema.Schema.Type<typeof StartPush> {}

export const EndPush = Schema.TaggedStruct("EndPush", { id: Schema.String, why: Schema.String })
export interface EndPush extends Schema.Schema.Type<typeof EndPush> {}

/** Time passed: pushes past their end go, so do those whose run closed (`closedRuns`, by name), and questions older than ASK_EVERY_MS. */
export const Tick = Schema.TaggedStruct("Tick", { closedRuns: Schema.Array(Schema.String) })
export interface Tick extends Schema.Schema.Type<typeof Tick> {}

/** Ask the owner whether to start a push: once per scope per ASK_EVERY_MS, never while a push covers the scope. */
export const AskPush = Schema.TaggedStruct("AskPush", {
  goal: Schema.String,
  scope: PushScope,
  /** What else the question is about, once per week each: a pool whose resets would expire unused. */
  about: Schema.optionalKey(Schema.String),
  allowance: Allowance,
  sessionID: Schema.String,
  question: Schema.String,
})
export interface AskPush extends Schema.Schema.Type<typeof AskPush> {}

/** The owner answered the question under the scope's key (`undefined`: it went without an answer, a no). */
export const TakePushAnswer = Schema.TaggedStruct("TakePushAnswer", { key: Schema.String, answer: Schema.optionalKey(Schema.String) })
export interface TakePushAnswer extends Schema.Schema.Type<typeof TakePushAnswer> {}

export type Command = StartPush | EndPush | Tick | AskPush | TakePushAnswer

export const PushStarted = Schema.TaggedStruct("PushStarted", { push: Push })
export interface PushStarted extends Schema.Schema.Type<typeof PushStarted> {}

export const PushEnded = Schema.TaggedStruct("PushEnded", { id: Schema.String, at: Schema.Number, why: Schema.String })
export interface PushEnded extends Schema.Schema.Type<typeof PushEnded> {}

export const PushAsked = Schema.TaggedStruct("PushAsked", { ask: PushAsk })
export interface PushAsked extends Schema.Schema.Type<typeof PushAsked> {}

export const PushAnswered = Schema.TaggedStruct("PushAnswered", { key: Schema.String, stage: AskStage, at: Schema.Number })
export interface PushAnswered extends Schema.Schema.Type<typeof PushAnswered> {}

export const AsksForgotten = Schema.TaggedStruct("AsksForgotten", { keys: Schema.Array(Schema.String) })
export interface AsksForgotten extends Schema.Schema.Type<typeof AsksForgotten> {}

export type Event = PushStarted | PushEnded | PushAsked | PushAnswered | AsksForgotten

/** The question's choices; the first is the yes. */
export const START = "Start the push"
export const NOT_NOW = "No push this week"
export const ASK_ASSUME = "No push: the pace holds starts as usual"

/** Whether an answer to the pool's push question is a yes. */
export const isStart = (answer: string): boolean => {
  const said = answer.replace(/\s+/g, " ").trim().toLowerCase()
  return said === "start the push" || said === "start" || said === "yes" || said === "y" || said.startsWith("start the push ") || said.startsWith("yes ")
}

/** A push's id: its scope and start, so two starts at once in one scope are one. */
export const pushID = (scope: PushScope, at: number) => `push-${scopeKey(scope).replace(/[^A-Za-z0-9_-]/g, "_")}-${at.toString(36)}`

const startPush = (state: PushState, command: Omit<StartPush, "_tag">, now: number): ReadonlyArray<Event> => {
  const key = scopeKey(command.scope)
  const ended = Object.values(state.pushes)
    .filter((push) => scopeKey(push.scope) === key)
    .map((push) => PushEnded.make({ id: push.id, at: now, why: "replaced by a new push in its scope" }))
  const cap = now + MAX_PUSH_MS
  const push: Push = {
    id: pushID(command.scope, now),
    goal: command.goal,
    scope: command.scope,
    startedAt: now,
    endsAt: Math.min(command.endsAt ?? cap, cap),
    untilDone: command.endsAt === undefined,
    allowance: { ...command.allowance, max: Math.max(0, Math.floor(command.allowance.max)) },
    by: command.by,
    ...(command.sessionID === undefined ? {} : { sessionID: command.sessionID }),
  }
  return [...ended, PushStarted.make({ push })]
}

const tick = (state: PushState, command: Tick, now: number): ReadonlyArray<Event> => {
  const closed = new Set(command.closedRuns)
  const ended = Object.values(state.pushes).flatMap((push) =>
    now >= push.endsAt
      ? [PushEnded.make({ id: push.id, at: now, why: "its end time came" })]
      : push.scope.run !== undefined && closed.has(push.scope.run)
        ? [PushEnded.make({ id: push.id, at: now, why: `its run ${push.scope.run} closed` })]
        : [],
  )
  const old = Object.values(state.asks).flatMap((ask) => (now - ask.at >= ASK_EVERY_MS ? [ask.key] : []))
  return [...ended, ...(old.length === 0 ? [] : [AsksForgotten.make({ keys: old })])]
}

const askPush = (state: PushState, command: AskPush, now: number): ReadonlyArray<Event> => {
  const key = `${scopeKey(command.scope)}${command.about === undefined ? "" : `#${command.about}`}`
  const asked = state.asks[key]
  if (asked !== undefined && now - asked.at < ASK_EVERY_MS) return []
  const covered = activeOn(state, command.scope.host, now).some(
    (push) => covers(push, command.scope.sessionID) && (push.scope.run === undefined || push.scope.run === command.scope.run),
  )
  if (covered) return []
  return [
    PushAsked.make({
      ask: {
        key,
        goal: command.goal,
        scope: command.scope,
        allowance: command.allowance,
        sessionID: command.sessionID,
        question: command.question,
        at: now,
        stage: "asked",
      },
    }),
  ]
}

const takeAnswer = (state: PushState, command: TakePushAnswer, now: number): ReadonlyArray<Event> => {
  const ask = state.asks[command.key]
  if (ask === undefined || ask.stage !== "asked") return []
  if (command.answer === undefined || !isStart(command.answer)) return [PushAnswered.make({ key: ask.key, stage: "declined", at: now })]
  return [
    PushAnswered.make({ key: ask.key, stage: "accepted", at: now }),
    ...startPush(state, { goal: ask.goal, scope: ask.scope, allowance: ask.allowance, by: "proactive", sessionID: ask.sessionID }, now),
  ]
}

export const Pushes: Decider<PushState, Command, Event> = {
  initial: empty,
  decide: (state, command, now) => {
    switch (command._tag) {
      case "StartPush":
        return Effect.succeed(startPush(state, command, now))
      case "EndPush":
        return Effect.succeed(state.pushes[command.id] === undefined ? [] : [PushEnded.make({ id: command.id, at: now, why: command.why })])
      case "Tick":
        return Effect.succeed(tick(state, command, now))
      case "AskPush":
        return Effect.succeed(askPush(state, command, now))
      case "TakePushAnswer":
        return Effect.succeed(takeAnswer(state, command, now))
    }
  },
  evolve: (state, event) => evolve(state, event),
}

export const evolve = (state: PushState, event: Event): PushState => {
  switch (event._tag) {
    case "PushStarted":
      return { ...state, pushes: { ...state.pushes, [event.push.id]: event.push } }
    case "PushEnded":
      return { ...state, pushes: Object.fromEntries(Object.entries(state.pushes).filter(([id]) => id !== event.id)) }
    case "PushAsked":
      return { ...state, asks: { ...state.asks, [event.ask.key]: event.ask } }
    case "PushAnswered": {
      const ask = state.asks[event.key]
      // The week is counted from the answer: a no holds a week from when it was said.
      return ask === undefined ? state : { ...state, asks: { ...state.asks, [event.key]: { ...ask, stage: event.stage, at: event.at } } }
    }
    case "AsksForgotten": {
      const drop = new Set(event.keys)
      return { ...state, asks: Object.fromEntries(Object.entries(state.asks).filter(([key]) => !drop.has(key))) }
    }
  }
}

// ── The push method (status.ts `POOL_STATUS.push`, the `pool_push` tool) ──

/**
 * What the owner's session asks of the push method. `start` a push for
 * `goal`; `status` of the host's pushes; `end` one (`id`, else every push of
 * the host); `plan` without starting, for `units` of queued work: a plan that
 * needs resets asks the owner once (the proactive question). `host` names the
 * host the push is for (default this one; a peer's is forwarded to it, with
 * the host as its scope); `session: true` scopes it to the calling session's
 * tree (`sessionID`, the caller's, set by the tool); `run` to an orchestrate
 * run, which ends it when it closes. `until`: an ISO time, or `"done"` (the
 * default) for until the work is done; `hours` instead of `until`. `resets`:
 * how many resets the owner approves, `asNeeded` when said "as needed up to
 * N"; `kinds` and `accounts` narrow which.
 */
const requestFields = {
  action: Schema.Literals(["start", "status", "end", "plan"]).annotate({
    description: "start a push, status of the host's pushes, end one (id) or all, or plan (with units: the queued work) without starting",
  }),
  goal: Schema.optionalKey(Schema.String).annotate({ description: "The work the push is for, in the owner's words. Required to start." }),
  host: Schema.optionalKey(Schema.String).annotate({ description: "The fleet host the push is for (its fleet name, e.g. workbox); default this host." }),
  session: Schema.optionalKey(Schema.Boolean).annotate({ description: "true: only this session's tree (its subagents); default the whole host." }),
  run: Schema.optionalKey(Schema.String).annotate({ description: "The orchestrate run (its directory's name) the push is for: it ends when the run closes." }),
  until: Schema.optionalKey(Schema.String).annotate({ description: 'When it ends: an ISO 8601 time, or "done" (the default) for until the work is done, at most 7 days.' }),
  hours: Schema.optionalKey(Schema.Finite).annotate({ description: "Instead of until: it ends this many hours from now." }),
  resets: Schema.optionalKey(Schema.Finite).annotate({ description: "How many resets the owner approved; default 0 (the push only lifts the spend-evenly hold)." }),
  asNeeded: Schema.optionalKey(Schema.Boolean).annotate({ description: 'true when the owner said "as needed, up to N".' }),
  kinds: Schema.optionalKey(Schema.Array(ResetKind)).annotate({ description: "Only these reset kinds (session, weekly, fable, full, codex); default any the owner approved." }),
  accounts: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "Only resets on these accounts (labels or ids); default any." }),
  units: Schema.optionalKey(Schema.Finite).annotate({ description: "For plan: how many units of work are queued." }),
  id: Schema.optionalKey(Schema.String).annotate({ description: "For end: the push to end; default every push of the host." }),
}

/** The `pool_push` tool's input: a request, the calling session set by the tool. */
export const PushToolInput = toolInput(Schema.Struct(requestFields))
export type PushToolInput = typeof PushToolInput.Type

/** What the `pool_push` tool tells the model. */
export const PUSH_DESCRIPTION = [
  "Start, read, end or plan a push: an owner-approved, time-boxed spend plan that uses rate-limit resets to get a body of work done. Call it only when the owner asked for a push, or said yes to one.",
  "While a push is active in its scope (a host, and optionally this session's tree or an orchestrate run), agents start without the spend-evenly hold (planners and verifiers stay on Opus), and a start held for real lack of quota claims one of the push's approved resets (the most valuable first, one at a time, through the fleet's lease) and goes on. Outside the scope nothing changes. It ends by itself at its end time, when its run closes, or on end.",
  "Answers with the plan, measured from the pool: what the scope can spend before its windows reset by themselves, what each approved reset adds, when each would likely be claimed at the current burn, and the host's load against its cores (a push raises no CPU gate).",
].join("\n\n")

export const PushRequest = Schema.Struct({ ...requestFields, sessionID: Schema.optionalKey(Schema.String) })
export type PushRequest = typeof PushRequest.Type

/** The push method's answer: what it did and the plan, as text, and the host's pushes now. */
export const PushAnswer = Schema.Struct({
  ok: Schema.Boolean,
  text: Schema.String,
  pushes: Schema.Array(Push),
})
export type PushAnswer = typeof PushAnswer.Type

// ── The plan ──

/** The host's CPU load (its 1-minute load average) and its cores. */
export interface HostLoad {
  readonly load: number
  readonly cores: number
}

/** One reset in a plan: where, what it adds, and when it would likely be claimed. */
export interface PlannedReset {
  readonly pool: string
  readonly label: string
  readonly kind: ResetKind
  /** The use it adds back, of week-long windows and of the 5-hour window (shares of one account's window). */
  readonly weekly: number
  readonly short: number
  readonly expiresAt?: number
  readonly expiresFirst: boolean
  /** When it would likely be claimed at the current burn; none when no burn is measured or the window resets by itself first. */
  readonly at?: number
  /** Its window resets by itself before the burn would spend down to it. */
  readonly notNeeded: boolean
}

/** One pool's quota in a plan. */
export interface PlannedPool {
  readonly id: string
  readonly accounts: number
  /** What the accounts can spend of their weeks before each resets by itself (shares of one account's week, summed). */
  readonly weeklyRoom: number
  /** The soonest natural weekly reset. */
  readonly weekResetAt?: number
  /** The weekly burn now: the accounts' use this period over the time it ran, summed (share of one account's week per hour). */
  readonly weeklyBurn: number
  /** The 5-hour windows' room, their soonest reset and their burn (share of one account's window per hour). */
  readonly shortRoom: number
  readonly shortResetAt?: number
  readonly shortBurn: number
}

export interface Plan {
  readonly at: number
  readonly pools: ReadonlyArray<PlannedPool>
  /** The approved resets in the order a push spends them, the best `max` of them. */
  readonly resets: ReadonlyArray<PlannedReset>
  /** The queued work, when known: units, and their cost in shares of one account's week. */
  readonly need?: { readonly units: number; readonly cost: number }
  readonly load?: HostLoad
  /** Each pool's use-or-lose forecast at the current burn. */
  readonly forecasts: ReadonlyArray<Forecast>
}

const windowOf = (account: PoolView["accounts"][number], name: string) => account.reading?.windows.find((window) => window.name === name)

/** A window's room, burn and soonest reset across a pool's accounts. */
const measure = (view: PoolView, name: string, length: number, now: number) => {
  let room = 0
  let burn = 0
  let resetAt: number | undefined
  for (const account of view.accounts) {
    const window = windowOf(account, name)
    if (window?.resetAt === undefined || window.resetAt <= now) continue
    room += Math.max(0, 1 - window.utilization)
    const elapsed = Math.max(length - (window.resetAt - now), HOUR / 12)
    burn += (window.utilization / elapsed) * HOUR
    resetAt = resetAt === undefined ? window.resetAt : Math.min(resetAt, window.resetAt)
  }
  return { room, burn, ...(resetAt === undefined ? {} : { resetAt }) }
}

/**
 * The plan for a push of `grant`'s resets over `views` at `now`: each pool's
 * room and burn, measured from its readings, and the approved resets in the
 * order a push spends them (`rankPush`), each with what it adds and when it
 * would likely be claimed: once the burn spends the room before it and the
 * resets ranked ahead, unless its window resets by itself first.
 */
export const planOf = (input: {
  readonly views: ReadonlyArray<PoolView>
  readonly grant: Pick<PushGrant, "kinds" | "accounts" | "max">
  readonly now: number
  readonly need?: Plan["need"]
  readonly load?: HostLoad
}): Plan => {
  const { now } = input
  const pools: Array<PlannedPool> = []
  const resets: Array<PlannedReset> = []
  for (const view of input.views) {
    const week = measure(view, "7d", WEEK, now)
    const short = measure(view, "5h", 5 * HOUR, now)
    pools.push({
      id: view.id,
      accounts: view.accounts.length,
      weeklyRoom: week.room,
      ...(week.resetAt === undefined ? {} : { weekResetAt: week.resetAt }),
      weeklyBurn: week.burn,
      shortRoom: short.room,
      ...(short.resetAt === undefined ? {} : { shortResetAt: short.resetAt }),
      shortBurn: short.burn,
    })
    const options = view.accounts
      .flatMap((account) => pushOptions(view, account, input.grant, now, undefined, false))
      .toSorted(rankPush)
    let weekSpent = week.room
    let shortSpent = short.room
    for (const option of options) {
      if (resets.length >= input.grant.max) break
      const onWeek = option.weekly > 0
      const burn = onWeek ? week.burn : short.burn
      const ahead = onWeek ? weekSpent : shortSpent
      const at = burn > 0 ? now + (ahead / burn) * HOUR : undefined
      const natural = onWeek ? option.weekResetAt : windowOf(option.account, "5h")?.resetAt
      const notNeeded = at !== undefined && natural !== undefined && at >= natural
      if (onWeek) weekSpent += option.weekly
      else shortSpent += option.short
      resets.push({
        pool: view.id,
        label: view.labels[option.account.credentialID] ?? option.account.credentialID,
        kind: option.kind,
        weekly: option.weekly,
        short: option.short,
        ...(option.credit.expiresAt === undefined ? {} : { expiresAt: option.credit.expiresAt }),
        expiresFirst: option.expiresFirst,
        ...(at === undefined || notNeeded ? {} : { at }),
        notNeeded,
      })
    }
  }
  return { at: now, pools, resets, forecasts: input.views.map((view) => forecastOf(view, now)), ...(input.need === undefined ? {} : { need: input.need }), ...(input.load === undefined ? {} : { load: input.load }) }
}

/**
 * The resets a push would need for the queued work: when the work (`need`,
 * in shares of one account's week) is more than the pools can spend before
 * their weeks reset by themselves, the fewest of the plan's resets, in its
 * order, whose week-long use given back covers the rest. None when the room
 * covers the work, or when every approved reset together does not.
 */
export const proposalOf = (plan: Plan, need: number): ReadonlyArray<PlannedReset> | undefined => {
  const room = plan.pools.reduce((total, pool) => total + pool.weeklyRoom, 0)
  if (need <= room) return undefined
  const chosen: Array<PlannedReset> = []
  let covered = room
  for (const reset of plan.resets) {
    if (reset.weekly <= 0) continue
    chosen.push(reset)
    covered += reset.weekly
    if (covered >= need) return chosen
  }
  return undefined
}

// ── Use it or lose it: the forecast ──

/** A reset in hand that, at the current burn, expires before the pool would need it. */
export interface Wasted {
  readonly pool: string
  readonly label: string
  readonly kind: ResetKind
  /** The share of a spent week it gives back. */
  readonly spare: number
  readonly expiresAt: number
}

/** One pool's forecast: its weekly burn, its resets in hand that give back some of a week, and those that would expire unused. */
export interface Forecast {
  readonly pool: string
  /** Shares of one account's week per hour, summed over the accounts. */
  readonly burn: number
  readonly inHand: number
  readonly wasted: ReadonlyArray<Wasted>
}

/**
 * What a pool's resets in hand come to at the current burn. A reset is
 * budget: by each reset's expiry the pool can spend what its accounts' weeks
 * hold now, a whole week more at each natural weekly reset before then, and
 * what the resets before it give back. The burn (the weeks' use this period
 * over the time each ran) spends `burn × time` by then. Taken soonest to
 * expire first, a reset is used when the burn would outrun that budget before
 * it expires; else it expires unused, however well it would be spent.
 */
export const forecastOf = (view: PoolView, now: number): Forecast => {
  const week = measure(view, "7d", WEEK, now)
  // No current weekly reading, no forecast: nothing is spent on unread data, nor called wasted on it.
  if (week.resetAt === undefined) return { pool: view.id, burn: 0, inHand: 0, wasted: [] }
  const capacity = (at: number) =>
    view.accounts.reduce((total, account) => {
      const window = windowOf(account, "7d")
      if (window?.resetAt === undefined || window.resetAt <= now) return total
      const periods = at > window.resetAt ? Math.floor((at - window.resetAt) / WEEK) + 1 : 0
      return total + Math.max(0, 1 - window.utilization) + periods
    }, 0)
  const resets = view.accounts
    .flatMap((account) =>
      sparesOf(view.provider, account, now, view.ratios ?? {}).flatMap((item) =>
        item.expiresAt === undefined
          ? []
          : [{ pool: view.id, label: view.labels[account.credentialID] ?? account.credentialID, kind: item.kind, spare: item.spare, expiresAt: item.expiresAt }],
      ),
    )
    .toSorted((left, right) => left.expiresAt - right.expiresAt)
  const wasted: Array<Wasted> = []
  let used = 0
  for (const reset of resets) {
    const short = (week.burn * (reset.expiresAt - now)) / HOUR - capacity(reset.expiresAt)
    if (short > used + 1e-9) used += reset.spare
    else wasted.push(reset)
  }
  return { pool: view.id, burn: week.burn, inHand: resets.length, wasted }
}

/** A forecast as the owner reads it: `at this rate, N resets (≈X% of a week each) expire unused by <date>`; none when none would. */
export const forecastText = (forecast: Forecast): string | undefined => {
  const { wasted } = forecast
  if (wasted.length === 0) return undefined
  const each = wasted.reduce((total, item) => total + item.spare, 0) / wasted.length
  const first = Math.min(...wasted.map((item) => item.expiresAt))
  const last = Math.max(...wasted.map((item) => item.expiresAt))
  const kinds = [...new Set(wasted.map((item) => KIND_LABEL[item.kind]))].join(", ")
  return (
    `Pool ${forecast.pool}: at this rate (${(forecast.burn * 100).toFixed(2)}%/h of a week), ${wasted.length} of its ${forecast.inHand} resets (${kinds}; ≈${percent(each)} of a week each) ` +
    `expire unused by ${iso(last)}${first === last ? "" : `, the first ${iso(first)}`}.`
  )
}

/** The pool's question when resets would expire unused: the waste, the queued work found, and the plan. */
export const wasteAskText = (forecast: Forecast, queued: ReadonlyArray<{ readonly run: string; readonly units: number }>, plan: Plan): string => {
  const work =
    queued.length === 0
      ? "No queued work was found (no orchestrate run with planned or implementing units): a push would still spend them before they expire."
      : `Queued work: ${queued.map((item) => `run ${item.run} (${item.units} unit${item.units === 1 ? "" : "s"} planned or implementing)`).join(", ")}.`
  return `Start a push to spend the ${forecast.pool} resets that would go unused?\n${work}\n${planText(plan)}`
}

const percent = (value: number) => `${Math.round(value * 100)}%`
const iso = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ") + "Z"

/** The host's load as the plan says it: against its cores, never raised by a push. */
export const loadText = (load: HostLoad) =>
  `Host load ${load.load.toFixed(1)} on ${load.cores} cores${load.load > load.cores ? " (over its cores)" : ""}: a push raises no CPU gate; agents start heavy checks only within the host's ${load.cores} cores.`

/** A plan as the owner reads it. */
export const planText = (plan: Plan): string => {
  const lines: Array<string> = []
  for (const pool of plan.pools) {
    const spentIn = pool.weeklyBurn > 0 ? ` (spent in ~${spanOf((pool.weeklyRoom / pool.weeklyBurn) * HOUR)} at the current burn)` : ""
    lines.push(
      `Pool ${pool.id}: ${pool.accounts} account${pool.accounts === 1 ? "" : "s"} can spend ${percent(pool.weeklyRoom)} of one account's week before their weeks reset by themselves` +
        `${pool.weekResetAt === undefined ? "" : ` (the first ${iso(pool.weekResetAt)})`}; burn ${(pool.weeklyBurn * 100).toFixed(2)}%/h${spentIn}. ` +
        `5-hour windows: ${percent(pool.shortRoom)} before ${pool.shortResetAt === undefined ? "their reset" : iso(pool.shortResetAt)}, burn ${(pool.shortBurn * 100).toFixed(1)}%/h.`,
    )
  }
  if (plan.resets.length === 0) lines.push("No approved reset is in hand.")
  plan.resets.forEach((reset, index) => {
    const adds = reset.weekly > 0 ? `+${percent(reset.weekly)} of a week` : `+${percent(reset.short)} of a 5-hour window`
    const when = reset.notNeeded
      ? "not reached at the current burn before its window resets by itself (a push spends faster)"
      : reset.at === undefined
        ? "claimed when a start is held for lack of quota (no burn measured)"
        : `likely claimed ~${iso(reset.at)} at the current burn`
    const expires = reset.expiresAt === undefined ? "" : `, expires ${iso(reset.expiresAt)}${reset.expiresFirst ? " (before its week resets: spent first)" : ""}`
    lines.push(`${index + 1}. ${KIND_LABEL[reset.kind]} on ${reset.label} (${reset.pool}): ${adds}${expires}; ${when}.`)
  })
  if (plan.need !== undefined) {
    const room = plan.pools.reduce((total, pool) => total + pool.weeklyRoom, 0)
    const added = plan.resets.reduce((total, reset) => total + reset.weekly, 0)
    lines.push(
      `Queued work: ${plan.need.units} unit${plan.need.units === 1 ? "" : "s"} ≈ ${percent(plan.need.cost)} of one account's week; ` +
        `room ${percent(room)}, with the resets ${percent(room + added)}.`,
    )
  }
  for (const forecast of plan.forecasts) {
    const text = forecastText(forecast)
    if (text !== undefined) lines.push(text)
  }
  if (plan.load !== undefined) lines.push(loadText(plan.load))
  return lines.join("\n")
}

/** A push as the owner reads it: goal, scope, end and the resets approved and spent. */
export const pushText = (push: Push, used: number, now: number): string => {
  const scope = [`host ${push.scope.host}`, ...(push.scope.sessionID === undefined ? [] : [`session ${push.scope.sessionID}`]), ...(push.scope.run === undefined ? [] : [`run ${push.scope.run}`])].join(", ")
  const end = push.untilDone ? `until the work is done (at most ${iso(push.endsAt)})` : `until ${iso(push.endsAt)}`
  const kinds = push.allowance.kinds === undefined ? "" : ` (${push.allowance.kinds.map((kind) => KIND_LABEL[kind]).join(", ")})`
  const accounts = push.allowance.accounts === undefined ? "" : ` on ${push.allowance.accounts.join(", ")}`
  const resets = `${push.allowance.asNeeded ? "as needed, up to" : "up to"} ${push.allowance.max} reset${push.allowance.max === 1 ? "" : "s"}${kinds}${accounts}, ${used} spent`
  return `Push ${push.id} "${push.goal}" (${push.by}): ${scope}; ${end}, ${spanOf(Math.max(0, push.endsAt - now))} left; ${resets}.`
}

/** The pool's question whether to start a push, with the plan's numbers. */
export const askText = (goal: string, proposal: ReadonlyArray<PlannedReset>, plan: Plan): string => {
  const using = proposal.map((reset) => `the ${KIND_LABEL[reset.kind]} on ${reset.label}`).join(", ")
  return `Start a push for ${goal} using ${using}? The queued work needs more than the pool can spend before its windows reset by themselves.\n${planText(plan)}`
}

/** The header of the pool's push question, at most 30 characters. */
export const askHeader = (goal: string) => {
  const header = `Push? · ${goal}`
  return header.length <= 30 ? header : `${header.slice(0, 29)}…`
}
