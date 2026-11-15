// When the pool spends a reset on its own: the standing allowance's one rule.
// The owner approved every reset in hand ahead of time, so nothing here asks;
// it only decides whether a claim pays now, and says why not when it does not.
//
// Demand is a forecast of what runs now (2026-11-15: a start is almost never
// held any more): the pool's burn per hour, measured over its recent
// readings (it carries the agents running across the fleet), a start held
// adding its share, run forward to each window's natural reset.
//
// Capacity is taken in this order:
// 1. A reset about to expire unused, soonest expiry first. One that expires
//    within EXPIRING_MS is just used, whatever the demand, on anything it
//    gives back: on a spent window at once, else at its last call
//    (LAST_CALL_MS before it expires, longer than a 5-hour period) on the
//    window it gives back most of; never while that window resets by itself
//    within NATURAL_MS (it goes once that reset has passed). One that expires
//    later but before the window it gives back resets by itself is used once
//    that window is spent and the work would use it.
// 2. A fresh account: while the forecast keeps room on the pool's accounts
//    to the first natural reset, the work goes there and no reset is spent.
// 3. Only when the pool is forecast to run out before that reset: a reset on
//    the most-used account near its limit (NEAR_USED, or its own run-out
//    within NEAR_MS), so the claim gives back the most, that frees the
//    account (no other spent window still holds it), when the work would use
//    at least WORTH_SHARE of what it gives back before the window resets by
//    itself. With no agent running and no start held there is no forecast:
//    the burn the readings show is past use.
//
// Steps 1 (past its last day) and 3 are never soon anyway: no claim for a
// 5-hour window that resets by itself within NATURAL_MS, nor for a week-long
// one within NOT_WORTH_MS. The 5-hour window is optional: readings may not
// carry one, and the forecast stands on the week-long windows alone.
import { Array as Arr, Data, Match, Option, Order } from "effect"
import { iso } from "./usage-text.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A 5-hour window that resets by itself this soon is waited for. */
export const NATURAL_MS = 30 * MINUTE
/** A week-long window that resets by itself this soon is waited for. */
export const NOT_WORTH_MS = DAY
/** A reset that expires this soon is just used, whatever the demand. */
export const EXPIRING_MS = DAY
/** This close to its expiry, an expiring reset goes on whatever window it gives back most of: more than a 5-hour period, so one comes round in it. */
export const LAST_CALL_MS = 6 * HOUR
/** A claim pays when the work would spend at least this share of what it gives back before the window resets by itself. */
export const WORTH_SHARE = 0.5
/** A claim gives back at least this much of the window it is judged on, or it is not worth sending: but a reset in its last EXPIRING_MS, lost otherwise. */
export const MIN_RESTORE = 0.1
/** With nothing running, a held start counts this share of an agent's burn: one held start alone is a third of three agents. */
export const BURN_AGENTS = 3
/** An account this used, or forecast to reach 100% this soon, is near its limit: a claim there gives back the most. */
export const NEAR_USED = 0.85
export const NEAR_MS = HOUR

/** One reset the pool could claim now, judged on the window it gives back most of. */
export interface ClaimOption {
  readonly credentialID: string
  readonly creditID: string
  readonly label: string
  /** The window it is judged on, as the owner reads it, and whether it is week-long (else the 5-hour one). */
  readonly window: string
  readonly long: boolean
  /** The name of that window as read (`7d`, `7d:Fable`, `5h`): the pool's forecast on it decides. */
  readonly forecast: string
  /** That window's use now, and the share of it the claim gives back (0 to 1). */
  readonly from: number
  readonly restored: number
  /** When that window resets by itself (epoch ms), and its use per hour now. */
  readonly resetAt: number
  readonly burn: number
  /** When the reset expires: none, never. */
  readonly expiresAt: Option.Option<number>
  /** Whether, once claimed, no window still holds the account (a spent window the reset does not clear would). */
  readonly frees: boolean
  /** The account's week: its use, and when it resets by itself. */
  readonly weekUsed: number
  readonly weekResetAt: Option.Option<number>
}

/** One window of an account, as the forecast reads it. */
export interface LoadWindow {
  readonly name: string
  readonly used: number
  readonly resetAt: number
  /** Its use per hour now (share of the window). */
  readonly burn: number
}

/** One account of the pool, as the forecast reads it: its windows still running, and until when a spent window holds it, if one does. */
export interface AccountLoad {
  readonly credentialID: string
  readonly windows: ReadonlyArray<LoadWindow>
  readonly freeAt: Option.Option<number>
}

/** The pool around the options. */
export interface ClaimSituation {
  readonly now: number
  /** Starts the pace holds, agents running across the fleet, and the hosts they run on. */
  readonly held: number
  readonly running: number
  readonly hosts: number
  readonly accounts: ReadonlyArray<AccountLoad>
  /** A claim on the pool has not shown in a reading yet: what it frees is not known. */
  readonly settling: boolean
  /** A push covers the held work: its approved resets decide for it (resets.ts `pushDue`). */
  readonly pushed: boolean
}

/** Which step of the order chose, or stopped a claim. */
export type ClaimStep = "expiring" | "fresh" | "reset"

/** The words of a step in a notice or a log line. */
export const STEP_TEXT: Readonly<Record<ClaimStep, string>> = {
  expiring: "about to expire unused",
  fresh: "an account keeps room to its reset",
  reset: "the pool runs out before its reset",
}

export type ClaimVerdict = Data.TaggedEnum<{
  /** Claim `option`: the step that chose it, and why in one clause. */
  Claim: { readonly step: ClaimStep; readonly option: ClaimOption; readonly reason: string }
  /** No claim now: the step that stopped it, if one did, and the reason for each no. */
  NoClaim: { readonly step: Option.Option<ClaimStep>; readonly reasons: ReadonlyArray<string> }
}>
export const ClaimVerdict = Data.taggedEnum<ClaimVerdict>()

const claim = (step: ClaimStep, option: ClaimOption, reason: string): ClaimVerdict => ClaimVerdict.Claim({ step, option, reason })
const noClaim = (step: Option.Option<ClaimStep>, reasons: ReadonlyArray<string>): ClaimVerdict => ClaimVerdict.NoClaim({ step, reasons })

const pct = (share: number) => `${Math.round(share * 100)}%`
export const span = (ms: number) =>
  Match.value(ms).pipe(
    Match.when(
      (left) => left >= DAY,
      (left) => `${(left / DAY).toFixed(1)} days`,
    ),
    Match.when(
      (left) => left >= HOUR,
      (left) => `${Math.round(left / HOUR)} h`,
    ),
    Match.orElse((left) => `${Math.max(1, Math.round(left / MINUTE))} min`),
  )

export const plural = (count: number, word: string) =>
  Match.value(count).pipe(
    Match.when(1, () => word),
    Match.orElse(() => `${word}s`),
  )

const expiresWithin = (option: ClaimOption, now: number, ms: number) =>
  Option.match(option.expiresAt, { onNone: () => false, onSome: (at) => at - now <= ms })

/** Whether the window resets by itself soon anyway: within NATURAL_MS for a reset in its last day, else by the window's length. */
export const soon = (option: ClaimOption, now: number): boolean =>
  option.resetAt - now <=
  Match.value({ long: option.long, last: expiresWithin(option, now, EXPIRING_MS) }).pipe(
    Match.when({ last: true }, () => NATURAL_MS),
    Match.when({ long: true }, () => NOT_WORTH_MS),
    Match.orElse(() => NATURAL_MS),
  )

/**
 * How much the work on the fleet runs at against the burn the readings
 * measured: the measured burn already carries the agents running; a start
 * held adds its share of them (at least a BURN_AGENTS'th).
 */
export const workFactor = (situation: Pick<ClaimSituation, "held" | "running">): number => 1 + situation.held / Math.max(situation.running, BURN_AGENTS)

/** The pool's forecast on one window: the room its open accounts have, the burn on it, when that room runs out and when the first account regains room by itself. */
export interface Forecast {
  readonly window: string
  readonly room: number
  readonly burn: number
  readonly runOutAt: number
  readonly naturalAt: number
}

const loadOf = (account: AccountLoad, name: string) => Arr.findFirst(account.windows, (window) => window.name === name)

/**
 * The pool's forecast on window `name` (`7d`, a model's own week, or `5h`
 * where read): the room left on accounts not spent, the pool's burn on it
 * (its open accounts', else the rate it spent the others at) scaled by the
 * held work, and the first natural reset among the accounts that read it. An
 * account that does not read the window is left out.
 */
export const forecastOf = (situation: ClaimSituation, name: string): Forecast => {
  const { now } = situation
  const read = situation.accounts.flatMap((account) => Option.toArray(Option.map(loadOf(account, name), (window) => ({ account, window }))))
  const open = read.filter(({ account, window }) => Option.isNone(account.freeAt) && window.used < 1)
  const room = open.reduce((total, { window }) => total + (1 - window.used), 0)
  // The work runs on the open accounts; with none open (or none burning), at the rate it spent the others.
  const openBurn = open.reduce((total, { window }) => total + window.burn, 0)
  const spentBurn = read.reduce((total, { window }) => total + window.burn, 0) - openBurn
  const burn = Match.value(openBurn).pipe(Match.when(0, () => spentBurn), Match.orElse((open) => open)) * workFactor(situation)
  const frees = read.flatMap(({ account, window }) => [window.resetAt, ...Option.toArray(account.freeAt)])
  const runOutAt = Match.value({ room, burn }).pipe(
    Match.when({ room: 0 }, () => now),
    Match.when({ burn: 0 }, () => Number.POSITIVE_INFINITY),
    Match.orElse(() => now + (room / burn) * HOUR),
  )
  return { window: name, room, burn, runOutAt, naturalAt: Math.min(...frees, Number.POSITIVE_INFINITY) }
}

/** Whether work is on the pool now: an agent running across the fleet, or a start held. The burn of a pool no agent runs on is past use, not a forecast. */
export const working = (situation: Pick<ClaimSituation, "held" | "running">): boolean => situation.running > 0 || situation.held > 0

/** Whether the pool runs out of the window before any of its accounts regains room by itself, with work on it. */
export const runsOut = (situation: ClaimSituation, forecast: Forecast) => working(situation) && forecast.runOutAt < forecast.naturalAt

/** The use the pool's work would make of the window once the claim gives it back, before it resets by itself, at the pool's burn on it now; at most what the claim gives back. */
export const projected = (situation: ClaimSituation, option: ClaimOption): number =>
  Math.min(option.restored, forecastOf(situation, option.forecast).burn * (Math.max(0, option.resetAt - situation.now) / HOUR))

/** Whether the work would spend enough of what the claim gives back. */
export const pays = (situation: ClaimSituation, option: ClaimOption): boolean =>
  option.restored >= MIN_RESTORE && projected(situation, option) >= WORTH_SHARE * option.restored

/** Whether the option's account is near its limit: NEAR_USED, or its own run-out within NEAR_MS at its burn now. */
export const near = (situation: ClaimSituation, option: ClaimOption): boolean => {
  const burn = option.burn * workFactor(situation)
  return option.from >= NEAR_USED || (burn > 0 && ((1 - option.from) / burn) * HOUR <= NEAR_MS)
}

/** The forecast in one clause: `7 agents running on 2 hosts, week 88% used, forecast 100% in 50 min, reset in 3.0 days`. */
export const forecastText = (situation: ClaimSituation, option: ClaimOption, forecast: Forecast): string => {
  const { now } = situation
  const held = Arr.match(Arr.filter([situation.held], (count) => count > 0), {
    onEmpty: () => "",
    onNonEmpty: ([count]) => `${count} ${plural(count, "start")} held, `,
  })
  const out = Match.value(forecast.runOutAt - now).pipe(
    Match.when(
      (left) => left <= 0,
      () => "now",
    ),
    Match.when(
      (left) => !Number.isFinite(left),
      () => "never at this burn",
    ),
    Match.orElse((left) => `in ${span(left)}`),
  )
  return (
    `${held}${situation.running} ${plural(situation.running, "agent")} running on ${situation.hosts} ${plural(situation.hosts, "host")}, ` +
    `${option.window} ${pct(option.from)} used, forecast 100% ${out}, reset in ${span(option.resetAt - now)}`
  )
}

/** The work in one clause, for a reset that expires before its window resets: `3 agents running, ~70% of the 5h window would be used before its reset in 3 h`. */
export const workText = (situation: ClaimSituation, option: ClaimOption): string =>
  `${situation.running} ${plural(situation.running, "agent")} running, ${situation.held} ${plural(situation.held, "start")} held, ~${pct(projected(situation, option))} of the ${option.window} window would be used before its reset in ${span(option.resetAt - situation.now)}`

const expiryText = (option: ClaimOption) => Option.match(option.expiresAt, { onNone: () => "never", onSome: iso })

/** Whether it expires before the window it gives back resets by itself. */
const expiresFirst = (option: ClaimOption) => Option.match(option.expiresAt, { onNone: () => false, onSome: (at) => at < option.resetAt })

/** Why an option goes in step 1 now; none when it waits or is not about to expire. */
const expiringWhy = (situation: ClaimSituation, option: ClaimOption): Option.Option<string> => {
  const { now } = situation
  return Match.value({
    last: expiresWithin(option, now, EXPIRING_MS),
    ready: option.from >= 1 || expiresWithin(option, now, LAST_CALL_MS),
    gives: option.restored > 0,
    spends: expiresFirst(option) && option.from >= 1 && working(situation) && pays(situation, option),
  }).pipe(
    Match.when({ last: true, ready: true, gives: true }, () => Option.some(`it expires ${expiryText(option)}, lost unused otherwise`)),
    Match.when({ spends: true }, () => Option.some(`it expires ${expiryText(option)} before the ${option.window} window resets, and ${workText(situation, option)}`)),
    Match.orElse(() => Option.none()),
  )
}

/** Why step 3 passes over an option. */
const passedOver = (situation: ClaimSituation, option: ClaimOption, forecast: Forecast): string =>
  Match.value({ soon: soon(option, situation.now), frees: option.frees, out: runsOut(situation, forecast), near: near(situation, option), pays: pays(situation, option) }).pipe(
    Match.when({ soon: true }, () => `${option.label}: its ${option.window} window resets by itself in ${span(option.resetAt - situation.now)}`),
    Match.when({ frees: false }, () => `${option.label}: it would not free the account, another spent window still holds it`),
    Match.when({ out: false }, () => `${option.label}: ${forecastText(situation, option, forecast)}; the pool keeps room until its first reset`),
    Match.when({ near: false }, () => `${option.label}: ${option.window} at ${pct(option.from)} used, not near its limit`),
    Match.when({ pays: false }, () => `${option.label}: ${workText(situation, option)}, under ${pct(WORTH_SHARE)} of the ${pct(option.restored)} it gives back`),
    Match.orElse(() => `${option.label}: another reset went first`),
  )

const expiryOrder = Order.mapInput(Order.Number, (option: ClaimOption) => Option.getOrElse(option.expiresAt, () => Number.POSITIVE_INFINITY))
const fullestFirst = Order.mapInput(Order.flip(Order.Number), (option: ClaimOption) => option.from)
const freshestWeek = Order.combine(
  Order.combine(
    Order.mapInput(Order.Number, (option: ClaimOption) => option.weekUsed),
    Order.mapInput(Order.flip(Order.Number), (option: ClaimOption) => Option.getOrElse(option.weekResetAt, () => 0)),
  ),
  expiryOrder,
)

/** Step 3: when the pool runs out before its reset, a reset on the most-used account near its limit. */
const forRunOut = (situation: ClaimSituation, options: ReadonlyArray<ClaimOption>): ClaimVerdict => {
  const forecasts = new Map(Arr.dedupe(options.map((option) => option.forecast)).map((name) => [name, forecastOf(situation, name)] as const))
  const forecast = (option: ClaimOption) => forecasts.get(option.forecast) ?? forecastOf(situation, option.forecast)
  const good = Arr.sort(
    options.filter((option) => !soon(option, situation.now) && option.frees && runsOut(situation, forecast(option)) && near(situation, option) && pays(situation, option)),
    Order.combine(fullestFirst, freshestWeek),
  )
  return Option.match(Arr.head(good), {
    onSome: (option) => claim("reset", option, forecastText(situation, option, forecast(option))),
    onNone: () =>
      noClaim(
        Option.some(
          Option.match(Arr.head(options), {
            onNone: (): ClaimStep => "reset",
            onSome: (option): ClaimStep =>
              Match.value(runsOut(situation, forecast(option))).pipe(
                Match.when(true, (): ClaimStep => "reset"),
                Match.orElse((): ClaimStep => "fresh"),
              ),
          }),
        ),
        Arr.match(options, { onEmpty: () => ["no reset in hand to claim"], onNonEmpty: (all) => all.map((option) => passedOver(situation, option, forecast(option))) }),
      ),
  })
}

/** The decision: which reset to claim now, by the order above, or why none. */
export const decideClaim = (situation: ClaimSituation, options: ReadonlyArray<ClaimOption>): ClaimVerdict => {
  const open = options.filter((option) => !soon(option, situation.now))
  const expiring = Arr.sort(open, Order.combine(expiryOrder, fullestFirst)).flatMap((option) =>
    Option.toArray(Option.map(expiringWhy(situation, option), (reason) => ({ option, reason }))),
  )
  return Option.match(Arr.head(expiring), {
    onSome: ({ option, reason }) => claim("expiring", option, reason),
    onNone: () =>
      Match.value({ work: working(situation), settling: situation.settling, pushed: situation.pushed }).pipe(
        Match.when({ work: false }, () => noClaim(Option.none(), ["no agent is running and no start is held"])),
        Match.when({ settling: true }, () => noClaim(Option.none(), ["a claim has not shown in a reading yet"])),
        Match.when({ pushed: true }, () => noClaim(Option.none(), ["a push covers the held work: its approved resets decide"])),
        Match.orElse(() => forRunOut(situation, options)),
      ),
  })
}
