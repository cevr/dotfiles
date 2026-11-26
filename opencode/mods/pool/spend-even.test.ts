// Spending every account's week, as generated pools on a virtual clock: 2 to
// 8 accounts with staggered weekly resets and any starting usage, a steady
// demand the pool can serve, and short holds now and then. Each request is
// admitted by the pace's weekly rule (weekly-pace.ts `weeklyPace`: only an
// account at or under its even line takes it) on accounts not held and under
// the week's hold line (pace.ts `eligibleFor`), and placed by the pool's own
// ranking (accounts.ts `rank`) over the readings and steps the pool keeps.
// No provider is asked: the model's week is the reading, read fresh.
//
// The demand is steady and never below the pool's own weekly rate; it is
// raised until a scheduler serving the soonest reset first could have filled
// every week that resets inside the run (the sum of what each still needs up
// to each reset fits in the demand up to it), so every such week could end at
// the pool's 99%. A week in which its account was held at any time is not
// counted: the hold, not the demand, decided it.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Option, Order } from "effect"
import { empty } from "./account-pool.ts"
import { DEFAULT_RULES, rank, type Step } from "./accounts.ts"
import type { Hold } from "./hold.ts"
import type { QuotaReading } from "./quota.ts"
import { lineOf, TARGET, WEEK, weeklyPace } from "./weekly-pace.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const START = Date.parse("2026-11-16T12:00:00Z")
const TICK = 30 * MINUTE
const RUN = 3 * WEEK
/** One request's share of its account's week. */
const COST = 0.005
/** A week that resets inside the run ends within this of the pool's 99%: at 97% or more. */
const MARGIN = 0.02
const SEEDS = 60
/** Steps are kept per account and 6 hours, so the ranking reads a ledger of the pool's size, not one per request. */
const BUCKET = 6 * HOUR

/** A seeded generator: the same seed, the same sequence. */
const generator = (seed: number) => {
  let state = Math.max((seed * 2654435761) >>> 0, 1)
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}

interface Account {
  readonly name: string
  used: number
  resetAt: number
  heldUntil: number
  /** Whether a hold fell in the week now running. */
  heldThisWeek: boolean
}

interface Reset {
  readonly name: string
  readonly used: number
  readonly held: boolean
}

interface Outcome {
  readonly resets: ReadonlyArray<Reset>
  /** Each placement the pool's own rules would not have allowed, described. */
  readonly breaches: ReadonlyArray<string>
}

/** The pool of `seed`: its accounts in pool order, and its demand per ms in shares of a week. */
const generate = (seed: number) => {
  const random = generator(seed)
  const n = 2 + Math.floor(random() * 7)
  const order = Arr.sort(
    Arr.map(Arr.range(0, n - 1), (slot) => ({ slot, key: random() })),
    Order.mapInput(Order.Number, (entry: { readonly key: number }) => entry.key),
  )
  const accounts: Array<Account> = order.map(({ slot }, index) => ({
    name: `acct-${index}`,
    used: random(),
    resetAt: START + Math.max(HOUR, ((slot + 0.2 + 0.6 * random()) / n) * WEEK),
    heldUntil: 0,
    heldThisWeek: false,
  }))
  const needs = Arr.sort(
    accounts.flatMap((account) =>
      Arr.filter(Arr.range(0, 3), (week) => account.resetAt + week * WEEK <= START + RUN).map((week) => ({
        at: account.resetAt + week * WEEK,
        // The first week still needs what its starting usage leaves; every later one a whole week.
        need: Math.max(0, TARGET - Math.min(1, account.used) * Number(week === 0)),
      })),
    ),
    Order.mapInput(Order.Number, (entry: { readonly at: number }) => entry.at),
  )
  const feasible = needs.reduce(
    (acc, { at, need }) => ({ sum: acc.sum + need, rate: Math.max(acc.rate, (acc.sum + need) / (at - START)) }),
    { sum: 0, rate: (n * TARGET) / WEEK },
  )
  return { accounts, demand: feasible.rate * 1.15, random }
}

/** Runs the pool of `seed` for three weeks and answers every reset inside it and every breach of the pool's rules. */
const simulate = (seed: number): Outcome => {
  const { accounts, demand, random } = generate(seed)
  const resets: Array<Reset> = []
  const breaches: Array<string> = []
  const steps = new Map<string, Step>()
  let backlog = 0
  let sessions = 0
  for (let now = START; now < START + RUN; now += TICK) {
    for (const account of accounts) {
      if (account.resetAt <= now) {
        resets.push({ name: account.name, used: account.used, held: account.heldThisWeek })
        account.used = 0
        account.resetAt += WEEK
        account.heldThisWeek = account.heldUntil > now
      }
      if (random() < 0.004) {
        account.heldUntil = now + HOUR + Math.floor(random() * 2) * HOUR
        account.heldThisWeek = true
      }
    }
    for (const [key, step] of steps) if (now - step.at >= WEEK) steps.delete(key)
    // Work the pool cannot take waits; no more than a tick's and a request's worth of it.
    backlog = Math.min(backlog + demand * TICK, demand * TICK + COST)
    const serve = (): boolean => {
      const open = accounts.filter((account) => account.heldUntil <= now && account.used < TARGET)
      const pace = weeklyPace(open.map((account) => ({ credentialID: account.name, used: account.used, resetAt: account.resetAt })), now, COST)
      if (!pace.ordinary || backlog < COST) return false
      const readings: Record<string, QuotaReading> = Object.fromEntries(
        accounts.map((account) => [account.name, { at: now, windows: [{ name: "7d", utilization: account.used, resetAt: account.resetAt }] }]),
      )
      const holds: Record<string, Hold> = Object.fromEntries(
        accounts.filter((account) => account.heldUntil > now).map((account) => [account.name, { kind: "rate-limit", until: account.heldUntil, at: now }]),
      )
      sessions += 1
      const session = `run-${sessions}`
      const choice = Arr.head(rank({ ...empty, credentials: accounts.map((account) => account.name), readings, holds, steps: [...steps.values()] }, session, now, DEFAULT_RULES, session, pace.eligible))
      const account = Option.flatMap(choice, (name) => Arr.findFirst(accounts, (each) => each.name === name))
      if (Option.isNone(account)) return false
      const chosen = account.value
      const line = lineOf(chosen.resetAt, now)
      if (chosen.heldUntil > now) breaches.push(`${chosen.name} took a request while held at ${now}`)
      if (!pace.eligible.includes(chosen.name)) breaches.push(`${chosen.name} took a request the pace did not admit on it at ${now}`)
      if (chosen.used > line + 1e-9) breaches.push(`${chosen.name} took a request past its line (${chosen.used} > ${line}) at ${now}`)
      if (chosen.used >= TARGET) breaches.push(`${chosen.name} took a request at its week's hold line at ${now}`)
      chosen.used += COST
      backlog -= COST
      const key = `${chosen.name}/${Math.floor((now - START) / BUCKET)}`
      const step = Option.getOrElse(Option.fromUndefinedOr(steps.get(key)), () => ({ at: now, sessionID: key, credentialID: chosen.name, cost: 0 }))
      steps.set(key, { ...step, cost: step.cost + COST * 100 })
      return true
    }
    while (serve()) continue
  }
  return { resets, breaches }
}

/** The share of the week left unused at each counted reset, summed over the generated pools, and how many resets it is over. */
const unusedAtReset = (outcomes: ReadonlyArray<Outcome>) => {
  const counted = outcomes.flatMap((outcome) => outcome.resets.filter((reset) => !reset.held))
  return { resets: counted.length, unused: counted.reduce((sum, reset) => sum + Math.max(0, TARGET - reset.used), 0) }
}

describe("spending every account's week at an even pace", () => {
  test(`in generated pools of 2 to 8 accounts with staggered resets and any starting usage, under a steady demand the pool can serve, every week that resets in the run ends within ${MARGIN * 100} points of the pool's 99%, and no request goes to a held account, past its even line or past its week's hold line`, () => {
    const outcomes = Arr.map(Arr.range(1, SEEDS), (seed) => ({ seed, outcome: simulate(seed) }))
    expect(outcomes.flatMap(({ seed, outcome }) => outcome.breaches.map((breach) => `seed ${seed}: ${breach}`))).toEqual([])
    const short = outcomes.flatMap(({ seed, outcome }) =>
      outcome.resets.filter((reset) => !reset.held && reset.used < TARGET - MARGIN).map((reset) => `seed ${seed}: ${reset.name} reset at ${(reset.used * 100).toFixed(1)}%`),
    )
    expect(short).toEqual([])
    expect(unusedAtReset(outcomes.map(({ outcome }) => outcome)).resets).toBeGreaterThan(SEEDS * 4)
  })
})
