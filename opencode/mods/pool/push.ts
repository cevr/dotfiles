// A push: an ephemeral, owner-approved spend plan that uses resets to get a
// body of work done. The owner starts one (the `pool_push` tool in their
// session). The pool spends resets on its own without one (resets.ts, the
// standing allowance); a push caps or shapes what is spent for its work.
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
//   (resets.ts `pushDue`): a claim the owner approved with the push, so
//   it passes over a peer that cannot be reached, and it still goes through the fleet's lease, the fresh read before
//   the send, and one claim at a time; the reset is chosen by value
//   (resets.ts `rankPush`).
//
// Outside its scope nothing changes. It ends by itself at its end time, when
// its run closes, or on `end`; its record goes then, and nothing of it lasts
// but the claims it made, which the resets keep as any other.
//
// The Pushes aggregate keeps the host's pushes. The plan (`planOf`) is measured from the pool: what the scope can spend
// before its windows reset by themselves, what each approved reset adds, and
// when each would likely be claimed at the current burn; and the host's load
// against its cores, which a push never raises.
import { Effect, Match, Option, Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"
import { formatNotificationTime } from "@dotfiles/decider/notification-time"
import { toolInput } from "@dotfiles/decider/tool-input"
import { accountWindow, ResetKind } from "./quota.ts"
import { KIND_LABEL, type PoolView, type PushGrant, pushOptions, rankPush, spanOf, sparesOf } from "./resets.ts"
import { byCount, percent, perHour, used as usedOf } from "./usage-text.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/** No push lasts longer than this, "until the work is done" included: nothing persists past it. */
export const MAX_PUSH_MS = WEEK
/** What one queued orchestrate unit is taken to cost, as a share of one account's week, when the config names none (a guess: a planner, an implementor and a verifier round). */
export const UNIT_COST = 0.1
/** The unit states that are queued work: planned, or being implemented. */
export const QUEUED_STATES: ReadonlyArray<string> = ["plan", "implement"]

/** Whether a unit's state (the orchestrate status script's) is done: merged, dropped or stuck. */
export const closedState = (state: string): boolean => state.startsWith("merged") || state === "dropped" || state.startsWith("stuck")

/**
 * Where a push applies: a whole host, or a session's tree (its root) on it,
 * and then an orchestrate run, when named. A run is always within a tree: the
 * pool cannot tell which sessions a run's are, so a run-only scope cannot be
 * built, and a push for a run never reaches past the tree it was started from.
 */
export const PushScope = Schema.Union([
  Schema.Struct({ host: Schema.String, sessionID: Schema.optionalKey(Schema.Never), run: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ host: Schema.String, sessionID: Schema.String, run: Schema.optionalKey(Schema.String) }),
])
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
  /** Started by the owner's call; `proactive`: by a yes to an older pool's question. */
  by: PushBy,
  /** The session the owner started it from, or answered in. */
  sessionID: Schema.optionalKey(Schema.String),
})
export type Push = typeof Push.Type

export const PushState = Schema.Struct({
  pushes: Schema.Record(Schema.String, Push),
})
export type PushState = typeof PushState.Type

export const empty: PushState = { pushes: {} }

/**
 * A scope as one key: the host and the session's root, or the host and the
 * run. A run's key names no session: its work is the same whichever session
 * started it, so a new push for it replaces the last.
 */
export const scopeKey = (scope: PushScope) => (scope.run === undefined ? `${scope.host}:${scope.sessionID ?? "*"}:*` : `${scope.host}:*:${scope.run}`)

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

/** Time passed: pushes past their end go, so do those whose run closed (`closedRuns`, by name). */
export const Tick = Schema.TaggedStruct("Tick", { closedRuns: Schema.Array(Schema.String) })
export interface Tick extends Schema.Schema.Type<typeof Tick> {}

export type Command = StartPush | EndPush | Tick

export const PushStarted = Schema.TaggedStruct("PushStarted", { push: Push })
export interface PushStarted extends Schema.Schema.Type<typeof PushStarted> {}

export const PushEnded = Schema.TaggedStruct("PushEnded", { id: Schema.String, at: Schema.Number, why: Schema.String })
export interface PushEnded extends Schema.Schema.Type<typeof PushEnded> {}

export type Event = PushStarted | PushEnded

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
  return ended
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
  }
}

// ── The push method (status.ts `POOL_STATUS.push`, the `pool_push` tool) ──

/**
 * What the owner's session asks of the push method. `start` a push for
 * `goal`; `status` of the host's pushes; `end` one (`id`, else every push of
 * the host); `plan` without starting, for `units` of queued work. `host` names the
 * host the push is for (default this one; a peer's is forwarded to it, with
 * the host as its scope, and the host named by none: the peer knows itself by
 * its own name); `session: true` scopes it to the calling session's tree
 * (`sessionID`, the caller's, set by the tool); `run` names the orchestrate
 * run that tree drives, which ends the push when it closes. `until`: an ISO time, or `"done"` (the
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
  run: Schema.optionalKey(Schema.String).annotate({ description: "The orchestrate run (its directory's name) this session drives: the push covers this session's tree, as session does, and ends when the run closes." }),
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
  "Start, read, end or plan a push: an owner-approved, time-boxed spend plan that uses rate-limit resets to get a body of work done. Call it only when the owner asked for a push: the pool spends resets on its own without one, and a push caps or shapes that for its work.",
  "While a push is active in its scope (a whole host, or this session's tree, which a run's push also is), agents start without the spend-evenly hold (planners and verifiers stay on Opus), and a start held for real lack of quota claims one of the push's approved resets (the most valuable first, one at a time, through the fleet's lease) and goes on. Outside the scope nothing changes. It ends by itself at its end time, when its run closes, or on end.",
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
  /** The weeks' use as read, summed (shares of one account's week), and how many accounts were read: the owner reads their average. */
  readonly weeklyUsed: number
  readonly weeklyRead: number
  /** How many accounts' usage says they have no week: never read, never unread. */
  readonly weeklyAbsent: number
  /** The soonest natural weekly reset. */
  readonly weekResetAt?: number
  /** The weekly burn now: the accounts' use this period over the time it ran, summed (share of one account's week per hour). */
  readonly weeklyBurn: number
  /** The 5-hour windows' room, their soonest reset and their burn (share of one account's window per hour). */
  readonly shortRoom: number
  readonly shortUsed: number
  readonly shortRead: number
  /** How many accounts' usage says they have no 5-hour window. */
  readonly shortAbsent: number
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
  let used = 0
  let read = 0
  let burn = 0
  let resetAt: number | undefined
  for (const account of view.accounts) {
    const window = windowOf(account, name)
    if (window?.resetAt === undefined || window.resetAt <= now) continue
    room += Math.max(0, 1 - window.utilization)
    used += window.utilization
    read += 1
    const elapsed = Math.max(length - (window.resetAt - now), HOUR / 12)
    burn += (window.utilization / elapsed) * HOUR
    resetAt = resetAt === undefined ? window.resetAt : Math.min(resetAt, window.resetAt)
  }
  // An account whose usage says it has no such window is counted apart: it has nothing to measure, and is never "unread".
  const absent = view.accounts.filter((account) => accountWindow(account, name)._tag === "Absent").length
  return { room, used, read, absent, burn, ...(resetAt === undefined ? {} : { resetAt }) }
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
      weeklyUsed: week.used,
      weeklyRead: week.read,
      weeklyAbsent: week.absent,
      ...(week.resetAt === undefined ? {} : { weekResetAt: week.resetAt }),
      weeklyBurn: week.burn,
      shortRoom: short.room,
      shortUsed: short.used,
      shortRead: short.read,
      shortAbsent: short.absent,
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

/** A forecast as the owner reads it: `at this rate (it uses X% of a week per hour), N resets (each gives back ≈Y% of a week) expire unused by <date>`; none when none would. */
export const forecastText = (forecast: Forecast): string | undefined => {
  const { wasted } = forecast
  if (wasted.length === 0) return undefined
  const each = wasted.reduce((total, item) => total + item.spare, 0) / wasted.length
  const first = Math.min(...wasted.map((item) => item.expiresAt))
  const last = Math.max(...wasted.map((item) => item.expiresAt))
  const kinds = [...new Set(wasted.map((item) => KIND_LABEL[item.kind]))].join(", ")
  return (
    `Pool ${forecast.pool}: at this rate (it uses ${perHour(forecast.burn, "a week")}), ${wasted.length} of its ${forecast.inHand} resets (${kinds}; each gives back ≈${percent(each)} of a week) ` +
    `expire unused by ${formatNotificationTime(last)}${first === last ? "" : `, the first ${formatNotificationTime(first)}`}.`
  )
}

/** Several accounts' use as the owner reads it, after `at`: their average out of 100%; `unread` with none read. */
const average = (total: number, read: number, at: string) =>
  Match.value(read).pipe(
    Match.when(0, () => "unread"),
    Match.when(1, () => `${at}${usedOf(total)}`),
    Match.orElse(() => `${at}${usedOf(total / read)} on average`),
  )

/** Text for a value that is there, else nothing. */
const ifSome = <A>(value: Option.Option<A>, text: (value: A) => string) => Option.match(value, { onNone: () => "", onSome: text })

/** One pool's line of the plan: its weeks' and 5-hour windows' use, when the first resets by itself, and the use per hour. */
const poolLine = (pool: PlannedPool): string => {
  const count = pool.accounts
  const resetting = (at: Option.Option<number>, how: string) => ifSome(at, (at) => `, ${byCount(count, "", "the first ")}resetting${how} ${formatNotificationTime(at)}`)
  const full = ifSome(
    Option.liftPredicate(pool.weeklyBurn, (burn) => burn > 0),
    (burn) => `, reaching ${usedOf(1)} in ~${spanOf((pool.weeklyRoom / burn) * HOUR)} at this rate`,
  )
  // A window every account's usage says it has none of is named absent, with no use to speak of; some without one are counted.
  const none = byCount(count, "absent (its usage reports none)", "absent (their usage reports none)")
  const week = Match.value(count > 0 && pool.weeklyAbsent === count).pipe(
    Match.when(true, () => `${none}; `),
    Match.orElse(() =>
      `${average(pool.weeklyUsed, pool.weeklyRead, "at ")}${without(pool.weeklyAbsent)}${resetting(Option.fromUndefinedOr(pool.weekResetAt), " by itself")}; ` +
      `${byCount(count, "it uses", "together they use")} ${perHour(pool.weeklyBurn, "a week")}${full}. `),
  )
  const short = Match.value(count > 0 && pool.shortAbsent === count).pipe(
    Match.when(true, () => `${none}.`),
    Match.orElse(() =>
      `${average(pool.shortUsed, pool.shortRead, "at ")}${without(pool.shortAbsent)}${resetting(Option.fromUndefinedOr(pool.shortResetAt), "")}; ` +
      `${byCount(count, "it uses", "they use")} ${perHour(pool.shortBurn, "a 5-hour window", 1)}.`),
  )
  return `Pool ${pool.id}: ${count} ${byCount(count, "account, its week", "accounts, their weeks")} ${week}5-hour ${byCount(count, "window", "windows")} ${short}`
}

/** How many of a pool's accounts have no such window, when some do: ` (1 account has none)`. */
const without = (absent: number) =>
  Match.value(absent).pipe(Match.when(0, () => ""), Match.orElse(() => ` (${absent} ${byCount(absent, "account has", "accounts have")} none)`))

/** The queued work's line: the weeks' use it would leave, per account on average, so it reads out of 100% too; with the approved resets' use given back. */
const needLine = (plan: Plan, need: { readonly units: number; readonly cost: number }): string => {
  const weeks = plan.pools.reduce((total, pool) => total + pool.weeklyUsed, 0)
  const read = plan.pools.reduce((total, pool) => total + pool.weeklyRead, 0)
  const added = plan.resets.reduce((total, reset) => total + reset.weekly, 0)
  const after = (weeks + need.cost) / Math.max(read, 1)
  const units = `Queued work: ${need.units} ${byCount(need.units, "unit", "units")} ≈ ${percent(need.cost)} of one account's week`
  const past = ifSome(
    Option.liftPredicate(after, (share) => share > 1),
    () => " (past the limit)",
  )
  return Match.value(read).pipe(
    Match.when(0, () => Match.value(plan.pools.some((pool) => pool.accounts > 0) && plan.pools.every((pool) => pool.weeklyAbsent === pool.accounts)).pipe(
      Match.when(true, () => `${units}; the pool's accounts report no weekly window, so no week limits it.`),
      Match.orElse(() => `${units}; the pool's weeks are unread.`),
    )),
    Match.orElse(
      () =>
        `${units}: it would take the pool's weeks from ${average(weeks, read, "")} to ${usedOf(after)}${past}, ` +
        `or to ${usedOf(Math.max(0, weeks + need.cost - added) / read)} with the approved resets.`,
    ),
  )
}

/** The host's load as the plan says it: against its cores, never raised by a push. */
export const loadText = (load: HostLoad) =>
  `Host load ${load.load.toFixed(1)} on ${load.cores} cores${load.load > load.cores ? " (over its cores)" : ""}: a push raises no CPU gate; agents start heavy checks only within the host's ${load.cores} cores.`

/** A plan as the owner reads it. */
export const planText = (plan: Plan): string => {
  const lines: Array<string> = []
  for (const pool of plan.pools) lines.push(poolLine(pool))
  if (plan.resets.length === 0) lines.push("No approved reset is in hand.")
  plan.resets.forEach((reset, index) => {
    const adds = reset.weekly > 0 ? `gives back ${percent(reset.weekly)} of a week` : `gives back ${percent(reset.short)} of a 5-hour window`
    const when = reset.notNeeded
      ? "not reached at the current burn before its window resets by itself (a push spends faster)"
      : reset.at === undefined
        ? "claimed when a start is held for lack of quota (no burn measured)"
        : `likely claimed ~${formatNotificationTime(reset.at)} at the current burn`
    const expires = reset.expiresAt === undefined ? "" : `, expires ${formatNotificationTime(reset.expiresAt)}${reset.expiresFirst ? " (before its week resets: spent first)" : ""}`
    lines.push(`${index + 1}. ${KIND_LABEL[reset.kind]} on ${reset.label} (${reset.pool}): ${adds}${expires}; ${when}.`)
  })
  if (plan.need !== undefined) lines.push(needLine(plan, plan.need))
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
  const end = push.untilDone ? `until the work is done (at most ${formatNotificationTime(push.endsAt)})` : `until ${formatNotificationTime(push.endsAt)}`
  const kinds = push.allowance.kinds === undefined ? "" : ` (${push.allowance.kinds.map((kind) => KIND_LABEL[kind]).join(", ")})`
  const accounts = push.allowance.accounts === undefined ? "" : ` on ${push.allowance.accounts.join(", ")}`
  const resets = `${push.allowance.asNeeded ? "as needed, up to" : "up to"} ${push.allowance.max} reset${push.allowance.max === 1 ? "" : "s"}${kinds}${accounts}, ${used} spent`
  return `Push ${push.id} "${push.goal}" (${push.by}): ${scope}; ${end}, ${spanOf(Math.max(0, push.endsAt - now))} left; ${resets}.`
}
