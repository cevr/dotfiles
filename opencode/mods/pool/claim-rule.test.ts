// Public seam: decideClaim against an independent numeric pool simulation.
// Generated weeks exercise exhaustion, expiry ordering, natural boundaries,
// actual refill/remaining-credit state, and no double spending. Forecasts do
// not authorize or veto an ordinary claim; provider transport is outside this seam.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Match, Option } from "effect"
import {
  type AccountLoad,
  type ClaimOption,
  type ClaimSituation,
  ClaimVerdict,
  decideClaim,
  EXPIRING_MS,
  LAST_CALL_MS,
  NATURAL_MS,
  NOT_WORTH_MS,
} from "./claim-rule.ts"

// This domain's import fence keeps the simulator helper out.
type WitnessTable<Key extends string> = Readonly<Record<Key, { readonly expected: ReadonlyArray<string>; readonly run: (cause: boolean) => ReadonlyArray<string> }>>
const assertWitnessCases = <const Key extends string>(
  required: ReadonlyArray<Key>,
  table: WitnessTable<NoInfer<Key>>,
) => {
  expect(Object.keys(table).toSorted(), "witness table keys").toEqual(required.toSorted())
  const completed = required.map((key) => {
    const { expected, run } = table[key]
    const observed = run(true)
    const withoutCause = run(false)
    const label = `W: ${key}`
    expect(observed, label).toEqual(expected)
    expect(() => expect(withoutCause, label).toEqual(expected), `${label}: removing the cause must fail the same observation`).toThrow()
    return key
  })
  expect(completed, "witness cases completed").toEqual([...required])
}

// Mirrors of the coverage registry, checked by scripts/sim-coverage.test.ts.
const POOL_LAW = [[0, 20, "forecast", "expiry"], [0, 100, "room", "exhaustion"]] as const
const assertPoolWitnessCases = (law: typeof POOL_LAW, table: WitnessTable<string>) =>
  assertWitnessCases(law.flatMap(([first, last, ...kinds]) => Arr.range(first, last).flatMap((index) => kinds.map((kind) => `${kind} ${index}`))), table)

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
  readonly after: ReadonlyArray<{ readonly id: string; readonly windows: ReadonlyArray<Window> }>
  readonly remaining: ReadonlyArray<ClaimOption>
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
    const available = () => accounts.flatMap((account) =>
      account.resets
        .filter((reset) => Option.isNone(reset.claimedAt) && Option.match(reset.expiresAt, { onNone: () => true, onSome: (at) => at > now }))
        .flatMap((reset) => Option.toArray(optionOf(account, reset, now)))
        .filter((option) => !periods.includes(`${account.id}:${option.window}:${option.resetAt}`)),
    )
    const options = available()
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
    const snapshot = () => accounts.map((account) => ({ id: account.id, windows: account.windows.map((window) => ({ ...window })) }))
    const before = snapshot()
    if (verdict._tag === "Claim") {
      const account = Arr.findFirst(accounts, (item) => item.id === verdict.option.credentialID).pipe(Option.getOrThrow)
      const reset = Arr.findFirst(account.resets, (item) => item.id === verdict.option.creditID).pipe(Option.getOrThrow)
      const window = Option.getOrThrow(windowOf(account, reset.clears))
      periods.push(`${account.id}:${window.name}:${window.resetAt}`)
      reset.claimedAt = Option.some(now)
      Object.assign(window, { used: 0, resetAt: now + LENGTH[window.name] })
    }
    decisions.push({ now, running: work.running, accounts: before, situation, options, verdict, after: snapshot(), remaining: available() })
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

/** Independent policy boundaries: a shared week stops at 99%, all others at 100%. */
const measuredLimit = (option: ClaimOption) => option.from >= 1 || (option.forecast === "7d" && option.from >= 0.99)
const notSoon = (option: ClaimOption, now: number) =>
  Match.value(option.long && option.preservesWeekly !== true && option.preservesWeekly !== false).pipe(
    Match.when(true, () => option.resetAt - now > NOT_WORTH_MS),
    Match.orElse(() => option.resetAt - now > NATURAL_MS),
  )

/** What every claim made holds to. */
const eachClaimHolds = (decisions: ReadonlyArray<Decision>) => {
  for (const { decision, verdict } of claims(decisions)) {
    const { option, step } = verdict
    const why = `${at(decision.now)}: ${step} ${option.creditID}`
    expect(verdict.reason, why).not.toContain("?")
    expect(option.resetAt - decision.now, why).toBeGreaterThan(NATURAL_MS)
    if (!lastDay(option, decision.now)) expect(notSoon(option, decision.now), why).toBe(true)
    expect(option.restored, why).toBeGreaterThan(0)
    if (step === "expiring") {
      expect(lastDay(option, decision.now), `${why}: ordinary credit used by expiry forecast`).toBe(true)
      expect(measuredLimit(option) || Option.getOrThrow(option.expiresAt) - decision.now <= LAST_CALL_MS, why).toBe(true)
      continue
    }
    expect(decision.situation.running > 0 || decision.situation.held > 0, why).toBe(true)
    expect(measuredLimit(option), `${why}: below the measured limit`).toBe(true)
    expect(option.frees, why).toBe(true)
  }
}

/** Ordinary credits available on an exhausted window with work and a useful refill. */
const outWith = (decision: Decision) =>
  decision.options.filter((option) => measuredLimit(option) && decision.running > 0 && option.restored > 0 && option.frees && notSoon(option, decision.now))

/** Actual room and credits after the action, rather than a pre-action spent reading. */
const strandedAfter = (decision: Decision) =>
  decision.after.every(spent) && decision.running > 0 && decision.remaining.some((option) => measuredLimit(option) && option.restored > 0 && option.frees && notSoon(option, decision.now))

/** An eligible measured limit is refilled whenever there is work, regardless of other accounts' room. */
const claimedBeforeOut = (decisions: ReadonlyArray<Decision>) => {
  for (const decision of decisions) {
    const usable = outWith(decision)
    if (usable.length > 0) expect(decision.verdict._tag, `${at(decision.now)}: out of room with ${usable.map((option) => option.creditID).join(", ")} in hand`).toBe("Claim")
  }
}

/** Last-day credits at a measured limit, or in their last call, go first: soonest first. */
const expiringGoFirst = (decisions: ReadonlyArray<Decision>) => {
  for (const decision of decisions) {
    const ready = decision.options.filter((option) => lastDay(option, decision.now) && option.restored > 0 &&
      (measuredLimit(option) || Option.getOrThrow(option.expiresAt) - decision.now <= LAST_CALL_MS) && option.resetAt - decision.now > NATURAL_MS)
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

  test("forecast exhaustion cannot redeem a credit at 92%, however fast the burn", () => {
    const full = load("a", 0.92, 3 * DAY, 1_000_000)
    const half = load("b", 0.5, 4 * DAY, 0.02)
    const verdict = verdictOf([full, half], [option(full, "ra"), option(half, "rb")])
    expect(verdict._tag).toBe("NoClaim")
    if (verdict._tag === "NoClaim") expect(verdict.reasons[0]).toContain("wait for measured exhaustion")
  })

  test("a measured limit is refilled even while another account has ample room", () => {
    const full = load("a", 1, 3 * DAY, 0.02)
    const fresh = load("b", 0, 4 * DAY, 0)
    const verdict = verdictOf([full, fresh], [option(full, "ra")])
    expect(verdict._tag).toBe("Claim")
    expect(verdict).toMatchObject({ step: "reset", option: { creditID: "ra" } })
  })

  test("zero, tiny, and averaged burn never veto a measured refill", () => {
    for (const burn of [0, 0.0001]) for (const averaged of [false, true]) {
      const full = load("a", 1, 3 * DAY, burn)
      const reading = { ...full, windows: full.windows.map((window) => ({ ...window, averaged })) }
      const verdict = verdictOf([reading], [option(reading, "ra")])
      expect(verdict._tag).toBe("Claim")
      expect(verdict).toMatchObject({ step: "reset", option: { creditID: "ra" } })
    }
  })

  test("a window below its measured limit keeps its ordinary credit", () => {
    const full = load("a", 0.92, 3 * DAY, 0.0005)
    const half = load("b", 0.5, 4 * DAY, 0.0005)
    const verdict = verdictOf([full, half], [option(full, "ra")])
    expect(verdict._tag).toBe("NoClaim")
    expect(verdict).toMatchObject({ step: Option.some("fresh") })
  })

  test("no running agent or held start leaves an ordinary credit unused", () => {
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

  test("shared weekly exhaustion starts at 99%; model and short windows wait for 100%", () => {
    for (const [forecast, window, long, from, expected] of [
      ["7d", "7d", true, 0.989, "NoClaim"],
      ["7d", "7d", true, 0.99, "Claim"],
      ["7d:Fable", "7d:Fable", true, 0.99, "NoClaim"],
      ["7d:Fable", "7d:Fable", true, 1, "Claim"],
      ["5h", "5h", false, 0.999, "NoClaim"],
      ["5h", "5h", false, 1, "Claim"],
    ] as const) {
      const full = load("a", from, 3 * DAY, 0)
      expect(verdictOf([full], [option(full, "ra", { forecast, window, long })])._tag, `${forecast} at ${from}`).toBe(expected)
    }
  })

  test("a held start needs only a positive refill at the measured limit", () => {
    const full = load("a", 1, 3 * DAY, 0)
    const held = { ...situation([full], 0), held: 1 }
    const verdict = decideClaim(held, [option(full, "ra", { restored: 0.001 })])
    expect(verdict._tag).toBe("Claim")
    expect(verdict).toMatchObject({ step: "reset" })
    expect(decideClaim(held, [option(full, "ra", { restored: 0 })])._tag).toBe("NoClaim")
  })

  test("known cadence weekly refills wait 30 minutes; unknown cadence waits 24 hours", () => {
    for (const [cadence, wait, expected] of [
      [{ preservesWeekly: true }, 30 * MINUTE, "NoClaim"],
      [{ preservesWeekly: true }, 31 * MINUTE, "Claim"],
      [{ preservesWeekly: true }, 20 * HOUR, "Claim"],
      [{ preservesWeekly: false }, 30 * MINUTE, "NoClaim"],
      [{ preservesWeekly: false }, 31 * MINUTE, "Claim"],
      [{ preservesWeekly: false }, 20 * HOUR, "Claim"],
      [{ preservesWeekly: false }, 24 * HOUR, "Claim"],
      [{}, 20 * HOUR, "NoClaim"],
      [{}, 24 * HOUR, "NoClaim"],
      [{}, 24 * HOUR + MINUTE, "Claim"],
    ] as const) {
      const full = load("a", 1, wait, 0)
      expect(verdictOf([full], [option(full, "ra", cadence)])._tag, `reset in ${wait / MINUTE} min`).toBe(expected)
    }
  })

  test("expiry more than 24 hours away follows ordinary refill rules even if its burn forecast pays", () => {
    const held = load("a", 1, 3 * DAY, 0.02, true)
    expect(verdictOf([held], [option(held, "ra", { expiresAt: Option.some(NOW + 2 * DAY) })])._tag).toBe("NoClaim")
  })

  test("last-day expiry uses the shared weekly 99% hold and the other windows' 100% limit", () => {
    for (const [forecast, used, expected] of [
      ["7d", 0.989, "NoClaim"],
      ["7d", 0.99, "Claim"],
      ["7d:Fable", 0.99, "NoClaim"],
      ["7d:Fable", 1, "Claim"],
      ["5h", 0.999, "NoClaim"],
      ["5h", 1, "Claim"],
    ] as const) {
      const full = load("a", used, 3 * DAY, 0)
      const verdict = verdictOf([full], [option(full, "ra", { forecast, expiresAt: Option.some(NOW + 24 * HOUR) })], 0)
      expect(verdict._tag, `${forecast} at ${used}`).toBe(expected)
      if (verdict._tag === "Claim") expect(verdict.step).toBe("expiring")
    }
  })

  test("expiry uses a spent window in its last 24 hours and any positive restoration only in its last 6 hours", () => {
    for (const [used, expiresIn, wait, expected] of [
      [1, 24 * HOUR + MINUTE, 3 * DAY, "NoClaim"],
      [1, 24 * HOUR, 3 * DAY, "Claim"],
      [0.001, 6 * HOUR + MINUTE, 3 * DAY, "NoClaim"],
      [0.001, 6 * HOUR, 3 * DAY, "Claim"],
      [0, 6 * HOUR, 3 * DAY, "NoClaim"],
      [1, HOUR, 30 * MINUTE, "NoClaim"],
      [1, HOUR, 31 * MINUTE, "Claim"],
    ] as const) {
      const full = load("a", used, wait, 0)
      expect(verdictOf([full], [option(full, "ra", { expiresAt: Option.some(NOW + expiresIn) })], 0)._tag, `${used} used, expiry in ${expiresIn / HOUR}h`).toBe(expected)
    }
  })

  test("two resets in their last day on spent windows: the soonest to expire goes first", () => {
    const one = load("a", 1, 3 * DAY, 0.02)
    const two = load("b", 1, 3 * DAY, 0.02)
    const verdict = verdictOf([one, two], [option(one, "late", { expiresAt: Option.some(NOW + 20 * HOUR) }), option(two, "soon", { expiresAt: Option.some(NOW + 10 * HOUR) })], 0)
    expect(verdict._tag).toBe("Claim")
    expect(verdict).toMatchObject({ step: "expiring", option: { creditID: "soon" } })
  })

  const pool = (used: number, wait: number, expiry: number, index: number, running = 6, rule = decideClaim): Decision => {
    const only = load("a", used, wait + index * MINUTE, 0.02)
    const options = [option(only, "ra", { expiresAt: Option.some(NOW + expiry) })]
    const live = situation([only], running)
    const accounts = [{ id: only.credentialID, windows: [{ name: "7d" as const, used, resetAt: NOW + wait + index * MINUTE, burn: 0.02 }] }]
    return { now: NOW, running: live.running, accounts, situation: live, options, verdict: rule(live, options), after: accounts, remaining: options }
  }
  const taken = ({ verdict }: Decision) => {
    if (verdict._tag === "Claim") return [verdict.step, verdict.option.creditID]
    return []
  }
  const unclaimed = (decision: Decision) => outWith(decision).filter(() => decision.verdict._tag === "NoClaim").map((each) => each.creditID)
  const checkedRoom = (room: Decision) => {
    expect([room.options.some((each) => notSoon(each, NOW)), truth(room, "7d").runsOut]).toEqual([true, false])
    expect(room.verdict._tag).toBe("NoClaim")
  }
  const [[claimFirst, claimLast, ...claimKinds], [waitFirst, waitLast, ...waitKinds]] = POOL_LAW
  type PoolCase = (typeof claimKinds | typeof waitKinds)[number]
  type Input = Parameters<typeof pool>
  const room = (index: number): Input => [0.25, 2 * DAY, 30 * DAY, index, 3]
  const spent = (index: number): Input => [1, 3 * DAY, 30 * DAY, index]
  const fixtures = {
    forecast: (index, cause) => {
      if (cause) return [0.99, 3 * DAY, 30 * DAY, index]
      return room(index)
    },
    expiry: (index, cause) => {
      if (cause) return [1, 3 * DAY, 12 * HOUR, index]
      return spent(index)
    },
    room: (index, cause) => {
      if (cause) return room(index)
      return spent(index)
    },
    exhaustion: (index, cause) => {
      if (cause) return [1, 3 * DAY, 30 * DAY, index, 6, never]
      return spent(index)
    },
  } satisfies Record<PoolCase, (index: number, cause: boolean) => Input>
  const cases = [
    ...Arr.range(claimFirst, claimLast).flatMap((index) => claimKinds.map((kind) => ({ index, kind }))),
    ...Arr.range(waitFirst, waitLast).flatMap((index) => waitKinds.map((kind) => ({ index, kind }))),
  ]
  const poolFixtures = Object.fromEntries(cases.map(({ index, kind }) => [`${kind} ${index}`, {
    expected: { forecast: ["reset", "ra"], expiry: ["expiring", "ra"], room: ["NoClaim"], exhaustion: ["ra"] }[kind],
    run: (cause: boolean) => {
      const input: Input = fixtures[kind](index, cause)
      const decision = pool(...input)
      if ((kind === "room" && cause) || (kind === "forecast" && !cause)) checkedRoom(decision)
      if (!cause && kind !== "forecast") expect(taken(decision)).toEqual(["reset", "ra"])
      if (kind === "forecast" && cause) eachClaimHolds([decision])
      if (kind === "expiry" && cause) expiringGoFirst([decision])
      if (kind === "exhaustion") {
        if (!cause) claimedBeforeOut([decision])
        return unclaimed(decision)
      }
      if (kind === "room") return [decision.verdict._tag]
      return taken(decision)
    },
  }]))
  test("W: all forecast, expiry, room, and exhaustion decisions", () => assertPoolWitnessCases(POOL_LAW, { ...poolFixtures }))
})

describe("the standing allowance's rule over generated weeks", () => {
  const regressions = [18926016, 18926168, 18926350, 18927240, 18927416, 18927526, 31415527]

  const weekHolds = (seed: number) => {
    const { accounts, decisions, periods } = simulate(seed)
    expect(new Set(periods).size, "a window period claimed twice").toBe(periods.length)
    const usedCredits = claims(decisions).map(({ verdict }) => verdict.option.creditID)
    expect(new Set(usedCredits).size, "a credit claimed twice").toBe(usedCredits.length)
    for (const { decision, verdict } of claims(decisions)) {
      const account = decision.after.find((each) => each.id === verdict.option.credentialID)!
      expect(Option.getOrThrow(windowOf(account, verdict.option.window)).used, "the chosen window was refilled").toBe(0)
      expect(decision.remaining.some((each) => each.creditID === verdict.option.creditID), "the credit was consumed").toBe(false)
    }
    eachClaimHolds(decisions)
    claimedBeforeOut(decisions)
    expiringGoFirst(decisions)
    noneLost(accounts, decisions)
  }

  test("after each decision the pool has room or no usable ordinary credit remaining", () => {
    for (const seed of [...SEEDS, ...regressions]) {
      const stranded = simulate(seed).decisions.filter(strandedAfter)
      expect(stranded.map((decision) => at(decision.now)), `seed ${seed}`).toEqual([])
    }
  })

  for (const seed of new Set([...SEEDS, ...regressions]))
    test(`seed ${seed}: every property holds`, () => weekHolds(seed))
})
