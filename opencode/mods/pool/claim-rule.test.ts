// The standing allowance's rule (claim-rule.ts `decideClaim`) against a model
// of the pool over generated weeks with steady burn and no holds: agents run
// on the pool (their number changes now and then, sometimes to none), their
// work spreads over the accounts not spent, some accounts read a 5-hour
// window and some do not, and resets in hand expire at random. Every 10
// minutes the rule is asked with what the readings show (an open window's
// burn now, a spent one's average over its period); a claim empties the
// window it is judged on and starts a new period there. Each property below
// is held over every decision, judged on the world's own numbers:
// - no question: a verdict is a claim or a reason for none;
// - never a claim inside NATURAL_MS of the window's own reset, nor a
//   week-long window's under NOT_WORTH_MS before it, but a reset's last day
//   may go on any window not about to reset within NATURAL_MS;
// - never two claims in one window period of an account (the pool offers
//   none on a period claimed, as resets.ts `candidatesOf` does);
// - never a claim not about to expire while the pool keeps room to its first
//   natural reset (the freshest account takes the work first), and then only
//   on an account near its limit;
// - before the pool runs out: whenever no account has room on a window with
//   agents running and a reset is in hand that frees its account, is not
//   soon, and the work would spend half of what it gives back before its
//   window resets by itself, a claim is made;
// - a reset expiring within EXPIRING_MS whose window is spent goes first, soonest first;
// - no reset expires unused when a claim was allowed at its last call: at
//   every step of its last LAST_CALL_MS its window was about to reset by
//   itself, it gave nothing back, or another reset was claimed.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Match, Option } from "effect"
import {
  type AccountLoad,
  AVERAGED_TEXT,
  type ClaimOption,
  type ClaimSituation,
  ClaimVerdict,
  decideClaim,
  EXPIRING_MS,
  LAST_CALL_MS,
  NATURAL_MS,
  NEAR_MS,
  NEAR_USED,
  NOT_WORTH_MS,
  WORTH_SHARE,
} from "./claim-rule.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const STEP = 10 * MINUTE
const T0 = Date.parse("2026-11-16T00:00:00Z")
type Name = "5h" | "7d"
/** The window a reset clears: the week, or the 5-hour one. */
const CLEARS: ReadonlyArray<Name> = ["7d", "5h"]
const LENGTH: Readonly<Record<Name, number>> = { "5h": 5 * HOUR, "7d": 7 * DAY }
/** A window's share used per hour of one agent's work, by its name: a week fills about fifteen times slower than a 5-hour window. */
const PER_AGENT: ReadonlyMap<string, number> = new Map([
  ["5h", 0.06],
  ["7d", 0.004],
])
const perAgent = (name: string) => PER_AGENT.get(name) ?? 0

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
  /** Its use per hour in the last step. */
  burn: number
}

interface Reset {
  readonly id: string
  readonly clears: Name
  readonly expiresAt: Option.Option<number>
  claimedAt: Option.Option<number>
}

interface Account {
  readonly id: string
  readonly windows: ReadonlyArray<Window>
  readonly resets: Array<Reset>
}

interface Decision {
  readonly now: number
  readonly running: number
  readonly accounts: ReadonlyArray<{ readonly id: string; readonly windows: ReadonlyArray<Window> }>
  readonly situation: ClaimSituation
  readonly options: ReadonlyArray<ClaimOption>
  readonly verdict: ReturnType<typeof decideClaim>
}

const windowOf = (account: Pick<Account, "windows">, name: string) => Arr.findFirst(account.windows, (window) => window.name === name)
const spent = (account: Pick<Account, "windows">) => account.windows.some((window) => window.used >= 1)

/** A window's burn as the readings show it: an open one's now, a spent one's average over its period so far. */
const shownBurn = (window: Window, now: number) =>
  Match.value(window.used >= 1).pipe(
    Match.when(true, () => (window.used / Math.max(LENGTH[window.name] - (window.resetAt - now), HOUR / 12)) * HOUR),
    Match.orElse(() => window.burn),
  )

const loadOf = (account: Account, now: number): AccountLoad => ({
  credentialID: account.id,
  windows: account.windows.map((window) => ({ name: window.name, used: window.used, resetAt: window.resetAt, burn: shownBurn(window, now) })),
  freeAt: Option.liftPredicate(Math.max(...account.windows.filter((window) => window.used >= 1).map((window) => window.resetAt), 0), (at) => at > 0),
})

/** One reset as the pool would weigh it now. */
const optionOf = (account: Account, reset: Reset, now: number): Option.Option<ClaimOption> =>
  Option.map(windowOf(account, reset.clears), (window) => {
    const week = Option.getOrThrow(windowOf(account, "7d"))
    return {
      credentialID: account.id,
      creditID: reset.id,
      label: account.id,
      window: window.name,
      long: window.name === "7d",
      forecast: window.name,
      from: window.used,
      restored: window.used,
      resetAt: window.resetAt,
      burn: shownBurn(window, now),
      expiresAt: reset.expiresAt,
      frees: account.windows.every((other) => other === window || other.used < 1),
      weekUsed: week.used,
      weekResetAt: Option.some(week.resetAt),
    }
  })

/** A world: 1 to 3 accounts, half of them reading a 5-hour window, 0 to 6 resets each, most expiring within a week. */
const world = (seed: number) => {
  const next = random(seed)
  const accounts: ReadonlyArray<Account> = Array.from({ length: 1 + Math.floor(next() * 3) }, (_, index) => {
    const short = next() < 0.5
    const windows: Array<Window> = [{ name: "7d", used: next() * 0.9, resetAt: T0 + next() * LENGTH["7d"], burn: 0 }]
    if (short) windows.push({ name: "5h", used: next() * 0.9, resetAt: T0 + next() * LENGTH["5h"], burn: 0 })
    return {
      id: `acct-${index}`,
      windows,
      resets: Array.from({ length: Math.floor(next() * 7) }, (_, reset) => ({
        id: `acct-${index}-r${reset}`,
        clears: CLEARS[Number(short && next() < 0.4)]!,
        expiresAt: Option.liftPredicate(T0 + next() ** 2 * 7 * DAY, () => next() < 0.85),
        claimedAt: Option.none<number>(),
      })),
    }
  })
  return { next, accounts }
}

/** A rule that never claims: the world as it runs with no reset spent. */
const never: typeof decideClaim = () => decideClaim({ now: 0, held: 0, running: 0, hosts: 1, accounts: [], settling: false, pushed: false }, [])

/** One step of the world: a window past its reset starts again, empty, and the work of `running` agents spreads over the accounts not spent. */
const burnStep = (accounts: ReadonlyArray<Account>, running: number, now: number) => {
  for (const account of accounts)
    for (const window of account.windows) if (window.resetAt <= now) Object.assign(window, { used: 0, resetAt: now + LENGTH[window.name] })
  const open = accounts.filter((account) => !spent(account))
  for (const account of accounts)
    for (const window of account.windows) {
      window.burn = Number(open.includes(account)) * ((running * perAgent(window.name)) / Math.max(open.length, 1))
      window.used = Math.min(1, window.used + window.burn * (STEP / HOUR))
    }
}

/** Run a world for eight days under `rule`: every decision, and each reset's fate. */
const simulate = (seed: number, rule: typeof decideClaim = decideClaim) => {
  const { next, accounts } = world(seed)
  const decisions: Array<Decision> = []
  const periods: Array<string> = []
  const work = { running: Math.floor(next() * 12) }
  for (let now = T0; now < T0 + 8 * DAY; now += STEP) {
    // The number of agents changes now and then: none, a few, or many.
    if (next() < 0.02) work.running = Math.floor(next() ** 2 * 16)
    burnStep(accounts, work.running, now)
    const options = accounts.flatMap((account) =>
      account.resets
        .filter((reset) => Option.isNone(reset.claimedAt) && Option.match(reset.expiresAt, { onNone: () => true, onSome: (at) => at > now }))
        .flatMap((reset) => Option.toArray(optionOf(account, reset, now)))
        .filter((option) => !periods.includes(`${account.id}:${option.window}:${option.resetAt}`)),
    )
    const situation: ClaimSituation = {
      now,
      held: 0,
      running: work.running,
      hosts: 1,
      accounts: accounts.map((account) => loadOf(account, now)),
      settling: false,
      pushed: false,
    }
    const verdict = rule(situation, options)
    decisions.push({ now, running: work.running, accounts: accounts.map((account) => ({ id: account.id, windows: account.windows.map((window) => ({ ...window })) })), situation, options, verdict })
    if (verdict._tag === "Claim") {
      const account = Arr.findFirst(accounts, (item) => item.id === verdict.option.credentialID).pipe(Option.getOrThrow)
      const reset = Arr.findFirst(account.resets, (item) => item.id === verdict.option.creditID).pipe(Option.getOrThrow)
      const window = Option.getOrThrow(windowOf(account, reset.clears))
      periods.push(`${account.id}:${window.name}:${window.resetAt}`)
      reset.claimedAt = Option.some(now)
      Object.assign(window, { used: 0, resetAt: now + LENGTH[window.name] })
    }
  }
  return { accounts, decisions, periods }
}

const SEEDS = Array.from({ length: 60 }, (_, index) => index + 1)
const claims = (decisions: ReadonlyArray<Decision>) =>
  decisions.flatMap((decision) => ClaimVerdict.$match(decision.verdict, { Claim: (verdict) => [{ decision, verdict }], NoClaim: () => [] }))
const lastDay = (option: ClaimOption, now: number) => Option.match(option.expiresAt, { onNone: () => false, onSome: (at) => at - now <= EXPIRING_MS })
const at = (now: number) => `at T0+${(now - T0) / MINUTE} min`

/** The world's own numbers on window `name` at a decision: the room on accounts not spent, the work's true burn, and the first natural reset. */
const truth = (decision: Decision, name: string) => {
  const read = decision.accounts.flatMap((account) => Option.toArray(Option.map(windowOf(account, name), (window) => ({ account, window }))))
  const room = read.filter(({ account }) => !spent(account)).reduce((total, { window }) => total + (1 - window.used), 0)
  const burn = decision.running * perAgent(name)
  const natural = Math.min(...read.flatMap(({ account, window }) => [window.resetAt, ...account.windows.filter((other) => other.used >= 1).map((other) => other.resetAt)]))
  return { room, burn, natural, runsOut: decision.running > 0 && room < (burn * (natural - decision.now)) / HOUR }
}

/** Whether the work would spend half of what the option gives back before its window resets by itself, at the world's burn. */
const paysTruly = (decision: Decision, option: ClaimOption) =>
  (decision.running * perAgent(option.window) * (option.resetAt - decision.now)) / HOUR >= WORTH_SHARE * option.restored

const notSoon = (option: ClaimOption, now: number) =>
  option.resetAt - now >
  Match.value(option.long).pipe(
    Match.when(true, () => NOT_WORTH_MS),
    Match.orElse(() => NATURAL_MS),
  )

/** What every claim made holds to. */
const eachClaimHolds = (decisions: ReadonlyArray<Decision>) => {
  for (const { decision, verdict } of claims(decisions)) {
    const { option, step } = verdict
    const why = `${at(decision.now)}: ${step} ${option.creditID}`
    expect(verdict.reason, why).not.toContain("?")
    expect(option.resetAt - decision.now, why).toBeGreaterThan(NATURAL_MS)
    if (!lastDay(option, decision.now)) expect(notSoon(option, decision.now), why).toBe(true)
    if (step === "expiring") continue
    // Never while the pool keeps room to its first natural reset; then on an account near its limit, that it frees.
    expect(truth(decision, option.window).runsOut, `${why}: the pool keeps room`).toBe(true)
    expect(option.from >= NEAR_USED || ((1 - option.from) / option.burn) * HOUR <= NEAR_MS, `${why}: not near its limit`).toBe(true)
    expect(option.frees, why).toBe(true)
    // And the work would spend half of what it gives back before its window resets by itself.
    expect(paysTruly(decision, option), `${why}: the work would not spend it`).toBe(true)
  }
}

/** The useful resets in hand while a window has no room left on any account and agents run on the pool. */
const outWith = (decision: Decision) =>
  decision.options.filter(
    (option) => truth(decision, option.window).room === 0 && decision.running > 0 && option.frees && notSoon(option, decision.now) && paysTruly(decision, option),
  )

/** Whenever the pool has no room on a window with agents running and a useful reset in hand, a claim is made. */
const claimedBeforeOut = (decisions: ReadonlyArray<Decision>) => {
  for (const decision of decisions) {
    const usable = outWith(decision)
    if (usable.length > 0) expect(decision.verdict._tag, `${at(decision.now)}: out of room with ${usable.map((option) => option.creditID).join(", ")} in hand`).toBe("Claim")
  }
}

/** A reset in its last day, its window spent and not about to reset by itself, goes first: soonest first. */
const expiringGoFirst = (decisions: ReadonlyArray<Decision>) => {
  for (const decision of decisions) {
    const ready = decision.options.filter((option) => lastDay(option, decision.now) && option.from >= 1 && option.resetAt - decision.now > NATURAL_MS)
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
        decision.options.some((option) => option.creditID === reset.id && option.restored > 0 && option.resetAt - decision.now > NATURAL_MS),
    )
    expect(missed.map((decision) => at(decision.now)), `${reset.id} expired unused`).toEqual([])
  }
}

describe("the rule on one pool, by example", () => {
  const NOW = T0
  /** One account, its week `used` and resetting in `resetsIn`, burning `burn` of it an hour now, a 5-hour window spent or not. */
  const load = (id: string, used: number, resetsIn: number, burn: number, fiveSpent = false): AccountLoad => ({
    credentialID: id,
    windows: [{ name: "7d", used, resetAt: NOW + resetsIn, burn }, ...Arr.filter([{ name: "5h", used: 1, resetAt: NOW + 3 * HOUR, burn: 0.3 }], () => fiveSpent)],
    // Held until its spent 5-hour window resets, else its spent week.
    freeAt: Option.orElse(
      Option.liftPredicate(NOW + 3 * HOUR, () => fiveSpent),
      () => Option.liftPredicate(NOW + resetsIn, () => used >= 1),
    ),
  })
  const option = (account: AccountLoad, id: string, fields: Partial<ClaimOption> = {}): ClaimOption => {
    const week = account.windows[0]!
    return {
      credentialID: account.credentialID,
      creditID: id,
      label: account.credentialID,
      window: "7d",
      long: true,
      forecast: "7d",
      from: week.used,
      restored: week.used,
      resetAt: week.resetAt,
      burn: week.burn,
      expiresAt: Option.some(NOW + 30 * DAY),
      frees: !account.windows.some((window) => window.name === "5h" && window.used >= 1),
      weekUsed: week.used,
      weekResetAt: Option.some(week.resetAt),
      ...fields,
    }
  }
  const situation = (accounts: ReadonlyArray<AccountLoad>, running = 6): ClaimSituation => ({ now: NOW, held: 0, running, hosts: 2, accounts, settling: false, pushed: false })
  const verdictOf = (accounts: ReadonlyArray<AccountLoad>, options: ReadonlyArray<ClaimOption>, running?: number) => decideClaim(situation(accounts, running), options)

  test("the pool runs out before its first reset: the most-used account near its limit is claimed, the reason the forecast in one clause", () => {
    const full = load("a", 0.92, 3 * DAY, 0.02)
    const half = load("b", 0.5, 4 * DAY, 0.02)
    const verdict = verdictOf([full, half], [option(full, "ra"), option(half, "rb")])
    expect(verdict._tag).toBe("Claim")
    expect(verdict).toMatchObject({ step: "reset", option: { creditID: "ra" } })
    if (verdict._tag === "Claim") expect(verdict.reason).toBe("6 agents running on 2 hosts, 7d 92% used, forecast 100% in 15 h, reset in 3.0 days")
  })

  test("a burn that is the window's average, as after a restart, is said in the reason", () => {
    const full = load("a", 0.92, 3 * DAY, 0.02)
    const half = load("b", 0.5, 4 * DAY, 0.02)
    const averaged = { ...half, windows: half.windows.map((window) => ({ ...window, averaged: true })) }
    const verdict = verdictOf([full, averaged], [option(full, "ra")])
    expect(verdict._tag).toBe("Claim")
    if (verdict._tag === "Claim") expect(verdict.reason).toBe(`6 agents running on 2 hosts, 7d 92% used, forecast 100% in 15 h, reset in 3.0 days${AVERAGED_TEXT}`)
  })

  test("the same pool burning slowly keeps room to its first reset: nothing claimed, the freshest account takes the work", () => {
    const full = load("a", 0.92, 3 * DAY, 0.0005)
    const half = load("b", 0.5, 4 * DAY, 0.0005)
    const verdict = verdictOf([full, half], [option(full, "ra")])
    expect(verdict._tag).toBe("NoClaim")
    expect(verdict).toMatchObject({ step: Option.some("fresh") })
  })

  test("no agent running: no forecast, nothing claimed", () => {
    const spent = load("a", 1, 3 * DAY, 0.02)
    const verdict = verdictOf([spent], [option(spent, "ra")], 0)
    expect(verdict._tag).toBe("NoClaim")
    expect(verdict).toMatchObject({ reasons: ["no agent is running and no start is held"] })
  })

  test("a week that resets by itself within a day is waited for, however short the pool runs", () => {
    const spent = load("a", 1, 20 * HOUR, 0.05)
    const verdict = verdictOf([spent], [option(spent, "ra")])
    expect(verdict._tag).toBe("NoClaim")
    if (verdict._tag === "NoClaim") expect(verdict.reasons).toEqual(["a: its 7d window resets by itself in 20 h"])
  })

  test("a reset that leaves its account held by another spent window is not claimed", () => {
    const held = load("a", 1, 3 * DAY, 0.02, true)
    const verdict = verdictOf([held], [option(held, "ra")])
    expect(verdict._tag).toBe("NoClaim")
    expect(verdict).toMatchObject({ reasons: ["a: it would not free the account, another spent window still holds it"] })
  })

  test("a claim the work would not spend half of before the window resets is not made", () => {
    const spent = load("a", 1, 3 * DAY, 0.0001)
    const verdict = verdictOf([spent], [option(spent, "ra")])
    expect(verdict._tag).toBe("NoClaim")
    if (verdict._tag === "NoClaim") expect(verdict.reasons[0]).toContain("under 50% of the 100% it gives back")
  })

  test("two resets in their last day on spent windows: the soonest to expire goes first", () => {
    const one = load("a", 1, 3 * DAY, 0.02)
    const two = load("b", 1, 3 * DAY, 0.02)
    const verdict = verdictOf([one, two], [option(one, "late", { expiresAt: Option.some(NOW + 20 * HOUR) }), option(two, "soon", { expiresAt: Option.some(NOW + 10 * HOUR) })], 0)
    expect(verdict._tag).toBe("Claim")
    expect(verdict).toMatchObject({ step: "expiring", option: { creditID: "soon" } })
  })

  test("forecast, expiry, room to wait, and no-reset exhaustion are exercised by deliberate pool states", () => {
    const pool = (used: number, wait: number, expiry: number, index: number, running = 6): Decision => {
      const only = load("a", used, wait + index * MINUTE, 0.02)
      const options = [option(only, "ra", { expiresAt: Option.some(NOW + expiry) })]
      const live = situation([only], running)
      const accounts = [{ id: only.credentialID, windows: [{ name: "7d" as const, used, resetAt: NOW + wait + index * MINUTE, burn: 0.02 }] }]
      return { now: NOW, running: live.running, accounts, situation: live, options, verdict: decideClaim(live, options) }
    }
    for (const index of Arr.range(0, 20)) {
      const forecast = pool(0.99, 3 * DAY, 30 * DAY, index)
      expect(forecast.verdict).toMatchObject({ step: "reset", option: { creditID: "ra" } })
      eachClaimHolds([forecast])
      const expiry = pool(1, 3 * DAY, 12 * HOUR, index)
      expect(expiry.verdict).toMatchObject({ step: "expiring", option: { creditID: "ra" } })
      expiringGoFirst([expiry])
    }
    for (const index of Arr.range(0, 100)) {
      const room = pool(0.25, 2 * DAY, 30 * DAY, index, 3)
      expect([room.options.some((each) => notSoon(each, NOW)), truth(room, "7d").runsOut, room.verdict._tag]).toEqual([true, false, "NoClaim"])
      const spent = pool(1, 3 * DAY, 30 * DAY, index)
      expect(outWith({ ...spent, verdict: never(spent.situation, spent.options) }).map((each) => each.creditID)).toEqual(["ra"])
      claimedBeforeOut([spent])
    }
  })
})

describe("the standing allowance's rule over generated weeks", () => {
  test("with the claim rule, none of the generated worlds runs all the way out of room with useful resets in hand", () => {
    const out = (decisions: ReadonlyArray<Decision>) => decisions.filter((decision) => outWith(decision).length > 0).length
    for (const seed of SEEDS) expect(out(simulate(seed).decisions), `seed ${seed}`).toBe(0)
  })

  for (const seed of SEEDS)
    test(`seed ${seed}: every property holds`, () => {
      const { accounts, decisions, periods } = simulate(seed)
      expect(new Set(periods).size, "a window period claimed twice").toBe(periods.length)
      eachClaimHolds(decisions)
      claimedBeforeOut(decisions)
      expiringGoFirst(decisions)
      noneLost(accounts, decisions)
    })
})
