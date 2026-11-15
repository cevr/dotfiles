// When the pool spends a reset on its own: the standing allowance's one rule.
// The owner approved every reset in hand ahead of time, so nothing here asks;
// it only decides whether a claim pays now, and says why not when it does not.
//
// Capacity is taken in this order:
// 1. A reset about to expire unused, soonest expiry first. One that expires
//    within EXPIRING_MS is just used, whatever the demand: on a spent window
//    at once, else at its last call (LAST_CALL_MS before it expires, longer
//    than a 5-hour period) on the window it gives back most of; never while
//    that window resets by itself within NATURAL_MS. One that expires later
//    but before the window it gives back resets by itself is used once that
//    window is spent and the work would spend it (step 3's demand test).
// 2. A fresh account: while one can take the held work, the work goes there
//    and no other reset is spent.
// 3. Only then a reset not about to expire, for held work it frees, when the
//    work would spend at least WORTH_SHARE of what it gives back before the
//    window resets by itself, and not the last one in hand while more than a
//    day of the week remains (unless it expires before the week resets): the
//    account whose week is freshest first.
//
// Steps 1 (past its last day) and 3 are never soon anyway: no claim for a
// 5-hour window that resets by itself within NATURAL_MS, nor for a week-long
// one within NOT_WORTH_MS.
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
/** A claim gives back at least this much of the window it is judged on, or it is not worth sending. */
export const MIN_RESTORE = 0.1
/** A pool's burn is taken as at least this many agents': one held start alone counts a third of it. */
export const BURN_AGENTS = 3

/** One reset the pool could claim now, judged on the window it gives back most of. */
export interface ClaimOption {
  readonly credentialID: string
  readonly creditID: string
  readonly label: string
  /** The window it is judged on, and whether that window is week-long (else the 5-hour one). */
  readonly window: string
  readonly long: boolean
  /** That window's use now, and the share of it the claim gives back (0 to 1). */
  readonly from: number
  readonly restored: number
  /** When that window resets by itself, and how long its period has run (epoch ms, ms). */
  readonly resetAt: number
  readonly elapsed: number
  /** When the reset expires: none, never. */
  readonly expiresAt: Option.Option<number>
  /** Claiming it lets the held work start on its account. */
  readonly frees: boolean
  /** Resets in hand on the account, every count. */
  readonly inHand: number
  /** The account's week: its use, and when it resets by itself. */
  readonly weekUsed: number
  readonly weekResetAt: Option.Option<number>
}

/** The pool around the options. */
export interface ClaimSituation {
  readonly now: number
  /** Starts the pace holds, and starts in flight across the fleet. */
  readonly held: number
  readonly running: number
  /** An account can take the held work now: step 2 routes it there. */
  readonly freeAccount: boolean
  /** A push covers the held work: its approved resets decide for it (resets.ts `pushDue`). */
  readonly pushed: boolean
}

/** Which step of the order chose, or stopped a claim. */
export type ClaimStep = "expiring" | "fresh" | "reset"

/** The words of a step in a notice or a log line. */
export const STEP_TEXT: Readonly<Record<ClaimStep, string>> = {
  expiring: "about to expire unused",
  fresh: "a fresh account takes the work",
  reset: "held work no fresh account can take",
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
const span = (ms: number) =>
  Match.value(ms >= DAY).pipe(
    Match.when(true, () => `${(ms / DAY).toFixed(1)} days`),
    Match.orElse(() => `${Math.max(1, Math.round(ms / HOUR))} h`),
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
 * The use the work would make of the window before it resets by itself: the
 * account's burn this period, scaled to the work there now (the starts in
 * flight and held, over at least BURN_AGENTS), times the time left; at most
 * what the claim gives back. None without work.
 */
export const projected = (situation: ClaimSituation, option: ClaimOption): number => {
  const work = situation.running + situation.held
  const rate = (option.from / Math.max(option.elapsed, MINUTE)) * (work / Math.max(situation.running, BURN_AGENTS))
  return Math.min(option.restored, rate * Math.max(0, option.resetAt - situation.now))
}

/** Whether the work would spend enough of what the claim gives back. */
export const pays = (situation: ClaimSituation, option: ClaimOption): boolean =>
  option.restored >= MIN_RESTORE && projected(situation, option) >= WORTH_SHARE * option.restored

/** Whether it expires before the window it gives back resets by itself. */
const expiresFirst = (option: ClaimOption) => Option.match(option.expiresAt, { onNone: () => false, onSome: (at) => at < option.resetAt })

/** The work in one clause: `1 start held, 2 running, ~70% of the 5h window would be used before its reset in 3 h`. */
export const workText = (situation: ClaimSituation, option: ClaimOption): string =>
  `${situation.held} ${plural(situation.held, "start")} held, ${situation.running} running, ~${pct(projected(situation, option))} of the ${option.window} window would be used before its reset in ${span(option.resetAt - situation.now)}`

export const plural = (count: number, word: string) =>
  Match.value(count).pipe(
    Match.when(1, () => word),
    Match.orElse(() => `${word}s`),
  )

const expiryText = (option: ClaimOption) => Option.match(option.expiresAt, { onNone: () => "never", onSome: iso })

/** Why an option goes in step 1 now; none when it waits or is not about to expire. */
const expiringWhy = (situation: ClaimSituation, option: ClaimOption): Option.Option<string> => {
  const { now } = situation
  return Match.value({
    last: expiresWithin(option, now, EXPIRING_MS) && option.restored >= MIN_RESTORE,
    ready: option.from >= 1 || expiresWithin(option, now, LAST_CALL_MS),
    spends: expiresFirst(option) && option.from >= 1 && pays(situation, option),
  }).pipe(
    Match.when({ last: true, ready: true }, () => Option.some(`it expires ${expiryText(option)}, lost unused otherwise`)),
    Match.when({ spends: true }, () => Option.some(`it expires ${expiryText(option)} before the ${option.window} window resets, and ${workText(situation, option)}`)),
    Match.orElse(() => Option.none()),
  )
}

/** The reset to keep: the last in hand, more than a day of its week left, and it does not expire before the week resets. */
const kept = (situation: ClaimSituation, option: ClaimOption): boolean => {
  const weekLeft = Option.getOrElse(option.weekResetAt, () => situation.now) - situation.now
  const lost = Option.match(option.expiresAt, {
    onNone: () => false,
    onSome: (at) => Option.match(option.weekResetAt, { onNone: () => false, onSome: (week) => at < week }),
  })
  return option.inHand <= 1 && weekLeft > DAY && !lost
}

/** Why step 3 passes over an option. */
const passedOver = (situation: ClaimSituation, option: ClaimOption): string =>
  Match.value({ soon: soon(option, situation.now), frees: option.frees, pays: pays(situation, option), kept: kept(situation, option) }).pipe(
    Match.when({ soon: true }, () => `${option.label}: its ${option.window} window resets by itself in ${span(option.resetAt - situation.now)}`),
    Match.when({ frees: false }, () => `${option.label}: it would not free the held work`),
    Match.when({ pays: false }, () => `${option.label}: ${workText(situation, option)}, under ${pct(WORTH_SHARE)} of the ${pct(option.restored)} it gives back`),
    Match.when({ kept: true }, () => `${option.label}: the last reset in hand, kept while more than a day of the week remains`),
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

/** Step 3: a reset not about to expire, for held work no account can take. */
const forHeld = (situation: ClaimSituation, options: ReadonlyArray<ClaimOption>): ClaimVerdict => {
  const good = Arr.sort(
    options.filter((option) => !soon(option, situation.now) && option.frees && pays(situation, option) && !kept(situation, option)),
    freshestWeek,
  )
  return Option.match(Arr.head(good), {
    onSome: (option) => claim("reset", option, workText(situation, option)),
    onNone: () =>
      noClaim(
        Option.some("reset"),
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
      Match.value({ held: situation.held > 0, free: situation.freeAccount, pushed: situation.pushed }).pipe(
        Match.when({ held: false }, () => noClaim(Option.none(), ["no work is held"])),
        Match.when({ free: true }, () => noClaim(Option.some("fresh"), ["an account can take the work: it goes there first"])),
        Match.when({ pushed: true }, () => noClaim(Option.none(), ["a push covers the held work: its approved resets decide"])),
        Match.orElse(() => forHeld(situation, options)),
      ),
  })
}
