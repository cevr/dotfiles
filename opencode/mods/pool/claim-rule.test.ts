// The standing allowance's rule (claim-rule.ts `decideClaim`) against a model
// of the pool over generated weeks: accounts burning their 5-hour and weekly
// windows at their own rates, work held and running that comes and goes, and
// resets in hand that expire at random. Every 10 minutes the rule is asked, a
// claim it makes empties the window it is judged on and starts a new period
// there, and each property below is held over every decision:
// - no question: a verdict is a claim or a reason for none;
// - never a claim inside NATURAL_MS of the window's own reset;
// - never two claims in one window period of an account;
// - never a claim the work would not spend (projected use under WORTH_SHARE
//   of what it gives back), unless the reset expires within EXPIRING_MS;
// - never a week-long window's claim under NOT_WORTH_MS before its reset,
//   unless the reset expires within EXPIRING_MS;
// - never a reset not about to expire while a fresh account takes the work;
// - for held work, never the last reset in hand while more than a day of the
//   week remains, unless it expires before the week resets;
// - a reset expiring within EXPIRING_MS whose window is spent goes first, soonest first;
// - no reset expires unused that could have been claimed at its last call:
//   at every step of its last LAST_CALL_MS its window was about to reset by
//   itself, gave back under MIN_RESTORE, or another reset was claimed.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Option } from "effect"
import {
  type ClaimOption,
  type ClaimSituation,
  decideClaim,
  EXPIRING_MS,
  LAST_CALL_MS,
  MIN_RESTORE,
  NATURAL_MS,
  NOT_WORTH_MS,
  projected,
  WORTH_SHARE,
} from "./claim-rule.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const STEP = 10 * MINUTE
const T0 = Date.parse("2026-11-16T00:00:00Z")
const SHORT = 5 * HOUR
const LONG = 7 * DAY
type Name = "5h" | "7d"
const NAMES: ReadonlyArray<Name> = ["5h", "7d"]
/** Each window's length, and its use per hour of an account's burn: a week fills about a seventh as fast. */
const LENGTH: Readonly<Record<Name, number>> = { "5h": SHORT, "7d": LONG }
const SCALE: Readonly<Record<Name, number>> = { "5h": 1, "7d": 0.15 }

/** A deterministic stream of numbers in [0, 1). */
const random = (seed: number) => {
  // Consecutive seeds start far apart: the first draws of an LCG barely move with its seed.
  const state = { at: Math.imul(seed, 0x9e3779b1) >>> 0 }
  return () => {
    state.at = (Math.imul(state.at, 1_664_525) + 1_013_904_223) >>> 0
    return state.at / 2 ** 32
  }
}

interface Window {
  readonly name: Name
  used: number
  resetAt: number
}

interface Reset {
  readonly id: string
  /** The window it gives back. */
  readonly clears: Name
  readonly expiresAt: Option.Option<number>
  claimedAt: Option.Option<number>
}

interface Account {
  readonly id: string
  /** Its share of a 5-hour window used per hour of work. */
  readonly burn: number
  readonly windows: ReadonlyArray<Window>
  readonly resets: Array<Reset>
}

interface Decision {
  readonly now: number
  readonly situation: ClaimSituation
  readonly options: ReadonlyArray<ClaimOption>
  readonly verdict: ReturnType<typeof decideClaim>
}

const windowOf = (account: Account, name: Name) => Arr.findFirst(account.windows, (window) => window.name === name).pipe(Option.getOrThrow)

/** The account takes held work now: no window spent. */
const fresh = (account: Account) => account.windows.every((window) => window.used < 1)

/** One reset as the pool would weigh it now. */
const optionOf = (account: Account, reset: Reset, now: number, inHand: number): ClaimOption => {
  const window = windowOf(account, reset.clears)
  const length = LENGTH[reset.clears]
  const week = windowOf(account, "7d")
  return {
    credentialID: account.id,
    creditID: reset.id,
    label: account.id,
    window: window.name,
    long: length === LONG,
    from: window.used,
    restored: window.used,
    resetAt: window.resetAt,
    elapsed: Math.max(0, length - (window.resetAt - now)),
    expiresAt: reset.expiresAt,
    frees: window.used >= 1 && account.windows.every((other) => other === window || other.used < 1),
    inHand,
    weekUsed: week.used,
    weekResetAt: Option.some(week.resetAt),
  }
}

/** A world: 1 to 3 accounts burning at their own rates, 0 to 5 resets each, most expiring within four days. */
const world = (seed: number) => {
  const next = random(seed)
  const accounts: ReadonlyArray<Account> = Array.from({ length: 1 + Math.floor(next() * 3) }, (_, index) => ({
    id: `acct-${index}`,
    burn: 0.02 + next() ** 2 * 0.8,
    windows: [
      { name: "5h", used: next(), resetAt: T0 + next() * SHORT },
      { name: "7d", used: next() * 0.8, resetAt: T0 + next() * LONG },
    ],
    resets: Array.from({ length: Math.floor(next() * 6) }, (_, reset) => ({
      id: `acct-${index}-r${reset}`,
      clears: NAMES[Number(next() >= 0.6)]!,
      expiresAt: Option.liftPredicate(T0 + next() ** 2 * 7 * DAY, () => next() < 0.85),
      claimedAt: Option.none<number>(),
    })),
  }))
  return { next, accounts }
}

/** Run a world for eight days: every decision, and each reset's fate. */
const simulate = (seed: number) => {
  const { next, accounts } = world(seed)
  const decisions: Array<Decision> = []
  const periods: Array<string> = []
  const work = { held: 0, running: 0 }
  for (let now = T0; now < T0 + 8 * DAY; now += STEP) {
    // The work changes now and then: none, a little, a lot, or a queue far past what runs.
    if (next() < 0.05) Object.assign(work, { held: Math.floor(next() ** 3 * 13), running: Math.floor(next() * 9) })
    for (const account of accounts) {
      for (const window of account.windows) {
        // A window past its reset starts again, empty.
        if (window.resetAt <= now) Object.assign(window, { used: 0, resetAt: now + LENGTH[window.name] })
        window.used = Math.min(1, window.used + (account.burn * SCALE[window.name] * (STEP / HOUR) * work.running) / 3)
      }
    }
    const options = accounts.flatMap((account) => {
      const live = account.resets.filter((reset) => Option.isNone(reset.claimedAt) && Option.match(reset.expiresAt, { onNone: () => true, onSome: (at) => at > now }))
      return live.map((reset) => optionOf(account, reset, now, live.length))
    })
    const situation: ClaimSituation = { now, held: work.held, running: work.running, freeAccount: work.held > 0 && accounts.some(fresh), pushed: false }
    const verdict = decideClaim(situation, options)
    decisions.push({ now, situation, options, verdict })
    if (verdict._tag === "Claim") {
      const account = Arr.findFirst(accounts, (item) => item.id === verdict.option.credentialID).pipe(Option.getOrThrow)
      const reset = Arr.findFirst(account.resets, (item) => item.id === verdict.option.creditID).pipe(Option.getOrThrow)
      const window = windowOf(account, reset.clears)
      periods.push(`${account.id}:${window.name}:${window.resetAt}`)
      reset.claimedAt = Option.some(now)
      // The claim empties the window and starts its period again.
      Object.assign(window, { used: 0, resetAt: now + LENGTH[window.name] })
    }
  }
  return { accounts, decisions, periods }
}

const SEEDS = Array.from({ length: 60 }, (_, index) => index + 1)
/** Each claim made, with the decision it came from. */
const claims = (decisions: ReadonlyArray<Decision>) =>
  decisions.flatMap((decision) => {
    const { verdict } = decision
    if (verdict._tag !== "Claim") return []
    return [{ decision, verdict }]
  })
const expiringSoon = (option: ClaimOption, now: number) => Option.match(option.expiresAt, { onNone: () => false, onSome: (at) => at - now <= EXPIRING_MS })
const at = (now: number) => `at T0+${(now - T0) / MINUTE} min`

/** What every claim made holds to. */
const eachClaimHolds = (decisions: ReadonlyArray<Decision>) => {
  for (const { decision, verdict } of claims(decisions)) {
    const { option, step } = verdict
    const why = `${at(decision.now)}: ${step} ${option.creditID}`
    const last = expiringSoon(option, decision.now)
    // No question: the reason is a clause, never a question.
    expect(verdict.reason, why).not.toContain("?")
    // Never inside NATURAL_MS of the window's own reset.
    expect(option.resetAt - decision.now, why).toBeGreaterThan(NATURAL_MS)
    // Never one the work would not spend, but in a reset's last day.
    if (!last) expect(projected(decision.situation, option), why).toBeGreaterThanOrEqual(WORTH_SHARE * option.restored)
    // Never a week-long window's under a day before it resets, but in a reset's last day.
    if (option.long && !last) expect(option.resetAt - decision.now, why).toBeGreaterThan(NOT_WORTH_MS)
    // Never a reset not about to expire while a fresh account takes the work.
    if (decision.situation.freeAccount) expect(step, why).toBe("expiring")
    expect(option.restored, why).toBeGreaterThanOrEqual(MIN_RESTORE)
    // For held work, never the last reset in hand while more than a day of its week remains, unless it expires before the week resets.
    const week = Option.getOrThrow(option.weekResetAt)
    const lost = Option.match(option.expiresAt, { onNone: () => false, onSome: (expiry) => expiry < week })
    if (step === "reset" && option.inHand <= 1 && !lost) expect(week - decision.now, why).toBeLessThanOrEqual(DAY)
  }
}

/** A reset in its last day, its window spent and not about to reset by itself, goes first: soonest first. */
const expiringGoFirst = (decisions: ReadonlyArray<Decision>) => {
  for (const decision of decisions) {
    const ready = decision.options.filter((option) => expiringSoon(option, decision.now) && option.from >= 1 && option.resetAt - decision.now > NATURAL_MS)
    if (ready.length === 0) continue
    const { verdict } = decision
    expect(verdict._tag, at(decision.now)).toBe("Claim")
    if (verdict._tag !== "Claim") continue
    expect(verdict.step, at(decision.now)).toBe("expiring")
    const soonest = Math.min(...ready.map((option) => Option.getOrThrow(option.expiresAt)))
    expect(Option.getOrThrow(verdict.option.expiresAt), at(decision.now)).toBeLessThanOrEqual(soonest)
  }
}

/** The steps of a reset's last call at which it could have been claimed and nothing was: none for any reset that expired unused. */
const noneLost = (accounts: ReadonlyArray<Account>, decisions: ReadonlyArray<Decision>) => {
  const unused = accounts.flatMap((account) => account.resets).filter((reset) => Option.isNone(reset.claimedAt))
  for (const reset of unused) {
    const expiresAt = Option.getOrElse(reset.expiresAt, () => Number.POSITIVE_INFINITY)
    const missed = decisions.filter(
      (decision) =>
        decision.now >= expiresAt - LAST_CALL_MS &&
        decision.now < expiresAt &&
        decision.verdict._tag === "NoClaim" &&
        decision.options.some((option) => option.creditID === reset.id && option.restored >= MIN_RESTORE && option.resetAt - decision.now > NATURAL_MS),
    )
    expect(missed.map((decision) => at(decision.now)), `${reset.id} expired unused`).toEqual([])
  }
}

describe("the standing allowance's rule over generated weeks", () => {
  test("the worlds claim: some resets are spent, some are not (the properties below are not vacuous)", () => {
    const all = SEEDS.flatMap((seed) => claims(simulate(seed).decisions))
    expect(all.length).toBeGreaterThan(20)
    expect(new Set(all.map(({ verdict }) => verdict.step))).toEqual(new Set(["expiring", "reset"]))
    // Held work a reset would free and pay for, while a fresh account could take it instead.
    const routed = SEEDS.flatMap((seed) => simulate(seed).decisions).filter(
      ({ situation, options }) => situation.freeAccount && options.some((option) => option.frees && projected(situation, option) >= WORTH_SHARE * option.restored),
    )
    expect(routed.length).toBeGreaterThan(20)
  })

  for (const seed of SEEDS)
    test(`seed ${seed}: every property holds`, () => {
      const { accounts, decisions, periods } = simulate(seed)
      // Never two claims in one window period of an account.
      expect(new Set(periods).size, "a window period claimed twice").toBe(periods.length)
      eachClaimHolds(decisions)
      expiringGoFirst(decisions)
      noneLost(accounts, decisions)
    })
})
