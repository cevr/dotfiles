// Automatic redemption follows measured exhaustion, never projected demand.
// Expiring credits get first choice (last day; depleted now or six-hour last
// call). Otherwise work waiting refills an exhausted account if the reset
// frees it: a start held, or running work when no account of the pool has
// room (`ClaimSituation.room`); running work alone goes to an account with room. Anthropic keeps the weekly deadline; Codex restarts it and waits
// out an unspent week or an imminent natural reset. All claims wait
// at least 30 minutes from the judged natural reset. Forecasts below remain
// advisory for reporting and explicit push planning.
import { Array as Arr, Data, Match, Option, Order } from "effect"
import { formatNotificationTime } from "@dotfiles/decider/notification-time"

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
  /** The name of that window as read (`7d`, `7d:Fable`, `5h`): its measured exhaustion decides. */
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
  /** The refill preserves the shared weekly deadline; unknown providers are conservative. */
  readonly preservesWeekly?: boolean
}

/** One window of an account, as the forecast reads it. */
export interface LoadWindow {
  readonly name: string
  readonly used: number
  readonly resetAt: number
  /** Its use per hour now (share of the window). */
  readonly burn: number
  /** That burn is the period's average, not measured (no readings far enough apart yet, as after a restart). */
  readonly averaged?: boolean
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
  /**
   * An account of the pool has room now (none of its windows spent): the running work goes there, so
   * running work alone is no work waiting for a refill; only a start held is (owner law: never with no work waiting).
   */
  readonly room: boolean
}

/** Which step of the order chose, or stopped a claim. */
export type ClaimStep = "expiring" | "fresh" | "reset"

/** The words of a step in a notice or a log line. */
export const STEP_TEXT: Readonly<Record<ClaimStep, string>> = {
  expiring: "about to expire unused",
  fresh: "an account keeps room to its reset",
  reset: "the account reached its limit",
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
export const soon = (option: ClaimOption, now: number): boolean => {
  const deadline = Option.getOrElse(Option.filter(option.weekResetAt, () => option.preservesWeekly === false), () => option.resetAt)
  return deadline - now <= Match.value({ long: option.long || option.preservesWeekly === false, last: expiresWithin(option, now, EXPIRING_MS), known: Option.isSome(Option.fromUndefinedOr(option.preservesWeekly)) }).pipe(
    Match.when({ last: true }, () => NATURAL_MS),
    Match.when({ known: true }, () => NATURAL_MS),
    Match.when({ long: true }, () => NOT_WORTH_MS),
    Match.orElse(() => NATURAL_MS),
  )
}

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
  /** Some account's burn on it is the period's average, not measured. */
  readonly averaged: boolean
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
  return {
    window: name,
    room,
    burn,
    runOutAt,
    naturalAt: Math.min(...frees, Number.POSITIVE_INFINITY),
    averaged: read.some(({ window }) => window.averaged === true),
  }
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
    `${option.window} ${pct(option.from)} used, forecast 100% ${out}, reset in ${span(option.resetAt - now)}` +
    Match.value(forecast.averaged).pipe(
      Match.when(true, () => AVERAGED_TEXT),
      Match.orElse(() => ""),
    )
  )
}

/** Said of a forecast whose burn is a window's period average: no measure since a restart. */
export const AVERAGED_TEXT = ", burn the window's average (none measured yet, as after a restart)"

/** The work in one clause, for a reset that expires before its window resets: `3 agents running, ~70% of the 5h window would be used before its reset in 3 h`. */
export const workText = (situation: ClaimSituation, option: ClaimOption): string =>
  `${situation.running} ${plural(situation.running, "agent")} running, ${situation.held} ${plural(situation.held, "start")} held, ~${pct(projected(situation, option))} of the ${option.window} window would be used before its reset in ${span(option.resetAt - situation.now)}`

const expiryText = (option: ClaimOption) => Option.match(option.expiresAt, { onNone: () => "never", onSome: formatNotificationTime })

/** Use-or-lose is the only exception to ordinary exhaustion; its horizon is explicit. */
const expiringWhy = (situation: ClaimSituation, option: ClaimOption): Option.Option<string> =>
  Option.filter(Option.some(`it expires ${expiryText(option)}, lost unused otherwise`), () =>
    expiresWithin(option, situation.now, EXPIRING_MS) &&
    (exhausted(option) || expiresWithin(option, situation.now, LAST_CALL_MS)) && option.restored > 0,
  )

/** Measured exhaustion, allowing the existing 99% shared-week safety stop. */
const exhausted = (option: ClaimOption) => {
  // Restarting the week on a spent 5h window would discard unspent weekly quota.
  if (option.preservesWeekly === false) return option.weekUsed >= 0.99
  return option.from >= Match.value(option.forecast).pipe(Match.when("7d", () => 0.99), Match.orElse(() => 1))
}

/** Why an ordinary reset waits. Forecasts remain advisory and authorize no claim. */
const passedOver = (situation: ClaimSituation, option: ClaimOption): string =>
  Match.value({ soon: soon(option, situation.now), frees: option.frees, spent: exhausted(option) }).pipe(
    Match.when({ soon: true }, () => `${option.label}: its ${option.window} window resets by itself in ${span(option.resetAt - situation.now)}`),
    Match.when({ frees: false }, () => `${option.label}: it would not free the account, another spent window still holds it`),
    Match.when({ spent: false }, () => `${option.label}: ${option.window} at ${pct(option.from)} used; wait for measured exhaustion`),
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

/** Refill an exhausted account with work to do; expiry has already had first choice. */
const forExhaustion = (situation: ClaimSituation, options: ReadonlyArray<ClaimOption>): ClaimVerdict => {
  const good = Arr.sort(
    options.filter((option) => !soon(option, situation.now) && option.frees && exhausted(option) && option.restored > 0),
    Order.combine(expiryOrder, Order.combine(fullestFirst, freshestWeek)),
  )
  return Option.match(Arr.head(good), {
    onSome: (option) => claim("reset", option,
      `${option.window} ${pct(option.from)} used, ${situation.running} ${plural(situation.running, "agent")} running, ${situation.held} ${plural(situation.held, "start")} held; refill the measured limit`),
    onNone: () => noClaim(
      Option.some(Match.value(options.some(exhausted)).pipe(Match.when(true, (): ClaimStep => "reset"), Match.orElse((): ClaimStep => "fresh"))),
      Arr.match(options, { onEmpty: () => ["no reset in hand to claim"], onNonEmpty: (all) => all.map((option) => passedOver(situation, option)) }),
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
      Match.value({ work: working(situation), settling: situation.settling, pushed: situation.pushed, taken: situation.room && situation.held === 0 }).pipe(
        Match.when({ work: false }, () => noClaim(Option.none(), ["no agent is running and no start is held"])),
        Match.when({ settling: true }, () => noClaim(Option.none(), ["a claim has not shown in a reading yet"])),
        Match.when({ pushed: true }, () => noClaim(Option.none(), ["a push covers the held work: its approved resets decide"])),
        Match.when({ taken: true }, () => noClaim(Option.some<ClaimStep>("fresh"), ["an account of the pool has room for the running work, and no start is held"])),
        Match.orElse(() => forExhaustion(situation, options)),
      ),
  })
}
