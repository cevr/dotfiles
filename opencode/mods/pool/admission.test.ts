// Reset-backed admission as a generated sequence against a small independent
// model, compared after every step on an explicit virtual clock. The model's
// state is the account's week as read, the reset claims attempted, the one
// recovery a claim confirmed (its time and the week observed after it), and
// what each request dispatch was admitted on. Its rule is written from the
// words, not the code: a request goes out while the week is under 99% and at
// or under its line, the even line (99% spread over the week, 5 points of
// leeway) or, after a claim whose own readings observed the week lower in the
// same period, the line started again from the claim at the week observed
// after it. A claim that failed, or whose reading after is absent, carried
// over (stale), unchanged or of another period, confirms nothing; a natural
// rollover starts a new period with no recovery carried into it.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { eligibleFor, NO_INFLIGHT, poolPace } from "./pace.ts"
import type { QuotaWindow } from "./quota.ts"
import { type Claim, observedGiveback, pacePlans } from "./resets.ts"
import type { AccountStatus } from "./status.ts"

const HOUR = 3_600_000
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const START = Date.parse("2026-11-16T12:00:00Z")
const MODEL = "claude-opus-5-5"
const SEEDS = 200
const STEPS = 40

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
type Random = ReturnType<typeof generator>
const pick = <A>(random: Random, from: readonly [A, ...ReadonlyArray<A>]): A => from[Math.floor(random() * from.length)] ?? from[0]

type After = "fresh" | "stale" | "unchanged" | "rolled" | "absent"
type Outcome = "reset" | "already-redeemed" | "failed"

interface Recovery {
  readonly at: number
  readonly from: number
}

interface ModelState {
  now: number
  week: number
  resetAt: number
  /** The confirmed recovery of this period. */
  recovery: Option.Option<Recovery>
  attempted: number
  dispatched: number
  confirmed: number
}

const evenOf = (state: ModelState) => 0.99 * ((state.now - (state.resetAt - WEEK)) / WEEK) + 0.05
/** The model's line now, from the words. */
const lineOf = (state: ModelState) =>
  Option.match(
    Option.filter(state.recovery, (r) => r.at > state.resetAt - WEEK),
    { onNone: () => evenOf(state), onSome: (r) => r.from + (0.99 - r.from) * ((state.now - r.at) / (state.resetAt - r.at)) + 0.05 },
  )
const admits = (state: ModelState) => state.week < 0.99 && state.week <= lineOf(state) + 1e-9

const week = (utilization: number, resetAt: number): QuotaWindow => ({ name: "7d", utilization, resetAt })
const carried = (utilization: number, resetAt: number, at: number): QuotaWindow => ({ name: "7d", utilization, resetAt, at })

const accountOf = (state: ModelState): AccountStatus => ({
  credentialID: "a",
  live: 0,
  load: 0,
  noRoom: false,
  reading: { at: state.now, windows: [{ name: "5h", utilization: 0.2, resetAt: state.now + HOUR }, week(state.week, state.resetAt)] },
})

const claimOf = (index: number, at: number, outcome: Outcome, before: ReadonlyArray<QuotaWindow>, after: ReadonlyArray<QuotaWindow>): Claim => ({
  key: `k${index}`,
  pool: "anthropic",
  provider: "claude",
  credentialID: "a",
  label: "a",
  creditID: "g",
  requestID: `r${index}`,
  at,
  outcome,
  before,
  after,
  weekly: "kept",
})

// ── The steps ──

/** The clock moves on; past the reset a new period starts, its week read low, no recovery carried into it. */
const advance = (state: ModelState, random: Random) => {
  state.now += Math.ceil(random() * 12 * HOUR)
  while (state.now >= state.resetAt) {
    state.resetAt += WEEK
    state.week = random() * 0.05
    state.recovery = Option.none()
  }
}

/** A request at its dispatch: admitted, it spends; held, it sends nothing. */
const dispatch = (state: ModelState, random: Random) => {
  if (!admits(state)) return
  state.dispatched++
  state.week = Math.min(1, state.week + random() * 0.08)
}

/** Another actor's spend (a peer, the provider's own accounting): the reading moves, no room is given. */
const spendElsewhere = (state: ModelState, random: Random) => {
  state.week = Math.min(1, state.week + random() * 0.05)
}

/** What the reading after a claim shows, by its kind. */
const afterOf = (kind: After, state: ModelState, before: number, lowered: number): ReadonlyArray<QuotaWindow> => {
  switch (kind) {
    case "absent":
      return []
    case "stale":
      return [carried(before * 0.5, state.resetAt, state.now - HOUR)]
    case "rolled":
      return [week(before * 0.5, state.resetAt + WEEK)]
    case "fresh":
    case "unchanged":
      return [week(lowered, state.resetAt)]
  }
}

/** A claim: its outcome and what the reading after it showed; the model confirms a recovery only on a fresh, lower week. */
const claim = (state: ModelState, random: Random, claims: Array<Claim>) => {
  const outcome = pick<Outcome>(random, ["reset", "already-redeemed", "failed"])
  const after = pick<After>(random, ["fresh", "stale", "unchanged", "rolled", "absent"])
  state.attempted++
  const before = state.week
  const gives = outcome !== "failed" && after === "fresh" && before > 0.01
  // Given back, the week drops to a random part of what it was; else it stays.
  const part = random() * 0.9
  const lowered = before * (Number(gives) * part + Number(!gives))
  claims.push(claimOf(claims.length, state.now, outcome, [week(before, state.resetAt)], afterOf(after, state, before, lowered)))
  const confirms = gives && lowered < before - 1e-9
  if (confirms) {
    state.week = lowered
    state.recovery = Option.some({ at: state.now, from: lowered })
    state.confirmed++
  }
  return confirms
}

/** One generated step, and whether it was a claim the model confirmed (none when it was no claim). */
const step = (state: ModelState, random: Random, claims: Array<Claim>): Option.Option<boolean> => {
  const roll = random()
  if (roll < 0.3) advance(state, random)
  else if (roll < 0.75) dispatch(state, random)
  else if (roll < 0.85) spendElsewhere(state, random)
  else return Option.some(claim(state, random, claims))
  return Option.none()
}

/** What the pool says of the state: its pace and the eligible accounts, on the claims made so far. */
const poolOf = (state: ModelState, claims: ReadonlyArray<Claim>) => {
  const account = accountOf(state)
  return {
    pace: poolPace([account], state.now, NO_INFLIGHT, MODEL, pacePlans("claude", [account], claims, state.now)),
    eligible: eligibleFor([account], state.now, MODEL).length,
  }
}

const expectedAdmission = (state: ModelState) => {
  if (!admits(state)) return "held"
  if (state.week > evenOf(state) + 1e-9) return "backed"
  return "ordinary"
}

describe("reset-backed admission, a generated sequence against an independent model", () => {
  test("every step: the pool admits a dispatch exactly when the model does, backed only on a confirmed recovery", () => {
    const totals = { steps: 0, backed: 0, confirmed: 0 }
    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = generator(seed)
      const state: ModelState = { now: START + random() * 3 * DAY, week: random() * 0.6, resetAt: START + 4 * DAY, recovery: Option.none(), attempted: 0, dispatched: 0, confirmed: 0 }
      const claims: Array<Claim> = []
      for (let index = 0; index < STEPS; index++) {
        const claimed = step(state, random, claims)
        const label = `seed ${seed} step ${index}: week ${state.week.toFixed(4)}, line ${lineOf(state).toFixed(4)}`
        // A claim confirms exactly what the model says it does.
        if (Option.isSome(claimed)) expect(Option.isSome(observedGiveback(claims[claims.length - 1]!)), label).toBe(claimed.value)
        // Compared after every step.
        const { pace, eligible } = poolOf(state, claims)
        expect({ ok: pace.ok, measured: pace.measured, admission: pace.admission, eligible }, label).toEqual({
          ok: admits(state),
          measured: true,
          admission: expectedAdmission(state),
          eligible: Number(state.week < 0.99),
        })
        if (pace.admission === "backed") expect(Option.isSome(state.recovery), label).toBe(true)
        totals.backed += Number(pace.admission === "backed")
        totals.steps++
      }
      totals.confirmed += state.confirmed
    }
    // The sequences reached every kind of room.
    expect(totals.steps).toBe(SEEDS * STEPS)
    expect(totals.confirmed).toBeGreaterThan(10)
    expect(totals.backed).toBeGreaterThan(0)
  })

  test("one recovery is charged once: spending the room it gave back holds again, and a later claim with no give-back adds none", () => {
    const resetAt = START + 3.5 * DAY
    const now = START
    const at = (used: number): AccountStatus => ({
      credentialID: "a",
      live: 0,
      load: 0,
      noRoom: false,
      reading: { at: now, windows: [{ name: "5h", utilization: 0.2, resetAt: now + HOUR }, week(used, resetAt)] },
    })
    const claims = [claimOf(1, now - HOUR, "reset", [week(1, resetAt)], [week(0.66, resetAt)])]
    const paced = (used: number, list: ReadonlyArray<Claim>) => poolPace([at(used)], now, NO_INFLIGHT, MODEL, pacePlans("claude", [at(used)], list, now))
    expect(paced(0.7, claims)).toMatchObject({ ok: true, admission: "backed" })
    expect(paced(0.75, claims)).toMatchObject({ ok: false, admission: "held" })
    // A second claim whose reading after shows the week as it was: nothing more, the first one's line still holds.
    const again = [...claims, claimOf(2, now - 1000, "reset", [week(0.75, resetAt)], [week(0.75, resetAt)])]
    expect(paced(0.75, again)).toMatchObject({ ok: false, admission: "held" })
  })
})
