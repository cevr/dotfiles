// Reset-backed admission at a request's dispatch, as a generated sequence
// against a small independent model, compared after every dispatch on an
// explicit virtual clock. The model keeps what the provider's account really
// used apart from what the pool last read of it: a dispatch spends the real
// week at once, and a reading shows it only when one is taken, so requests
// race readings that lag them. Its state is the account's real week, the week
// as last read and when, the reset claims made, the one recovery a claim's own
// readings confirmed (its time and the week observed after it), the claim
// still waiting for its observation, and the shares reserved on the recovery.
//
// Its rule, from the words: a request goes out only on a reading of the last
// 30 minutes in its own period; then at or under the even line (99% spread
// over the week, 5 points of leeway) it is ordinary; past it, only on the room
// a confirmed recovery gave back (the line started again from the claim at
// the week observed after it), and only while that room still holds one more
// request's share (4% of the week) beside the shares already reserved on it,
// which count until a reading shows the week risen past them. Only a claim
// that went through (`reset`) confirms a recovery, on its own reading after
// it, or, when that one could not be read or did not show it yet (the
// provider's reporting lags), a reading taken later in the same period and
// within 30 minutes of the claim that shows the week lower; a claim answered
// `already-redeemed` confirms nothing, however low the week is read around it.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Option } from "effect"
import { dispatchPace } from "./pace.ts"
import type { QuotaWindow } from "./quota.ts"
import { awaitingObservation, type Claim, decideSpend, type Event, evolve, ObserveClaim, pacePlans, ReserveSpend, type ResetsState, reservationHolds, type Spend, WithdrawSpend } from "./resets.ts"
import type { AccountStatus } from "./status.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const START = Date.parse("2026-11-16T12:00:00Z")
const MODEL = "claude-opus-5-5"
/** One request's share of the account's week, reserved at its dispatch on a claim's room. */
const COST = 0.04
const SEEDS = 300
const STEPS = 60
/** How long after a claim that went through a reading may still confirm its recovery. */
const OBSERVE = 30 * MINUTE

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
const pick = <A>(random: Random, from: readonly [A, ...ReadonlyArray<A>]): A => Option.getOrElse(Arr.get(from, Math.floor(random() * from.length)), () => from[0])

type After = "fresh" | "absent" | "stale" | "unchanged" | "rolled" | "lagging"
type Outcome = "reset" | "already-redeemed" | "failed"

interface Recovery {
  readonly at: number
  readonly from: number
}

/** A claim that went through while its reading after it could not be taken: the week before it and its period. */
interface Pending {
  readonly at: number
  readonly before: number
  readonly resetAt: number
}

interface ModelState {
  now: number
  /** The provider's real week, and when it resets. */
  actual: number
  resetAt: number
  /** The week as the pool last read it, when, and the reset that reading named. */
  read: number
  readAt: number
  readResetAt: number
  recovery: Option.Option<Recovery>
  pending: Option.Option<Pending>
  /** The shares reserved on the recovery. */
  reserved: number
}

// ── The model's rule ──

const evenOf = (state: ModelState) => 0.99 * ((state.now - (state.readResetAt - WEEK)) / WEEK) + 0.05
/** The recovery of the period the reading names, if any. */
const recoveryOf = (state: ModelState) => Option.filter(state.recovery, (r) => r.at > state.readResetAt - WEEK)
const lineOf = (state: ModelState) =>
  Option.match(recoveryOf(state), {
    onNone: () => evenOf(state),
    onSome: (r) => r.from + (0.99 - r.from) * ((state.now - r.at) / (state.readResetAt - r.at)) + 0.05,
  })
/** The week as far as the pool may know it: the reading, plus the reserved shares the reading's rise since the recovery does not cover. */
const knownOf = (state: ModelState) =>
  Option.match(recoveryOf(state), {
    onNone: () => state.read,
    onSome: (r) => state.read + Math.max(0, state.reserved - Math.max(0, state.read - r.from)),
  })
const freshOf = (state: ModelState) => state.now - state.readAt <= 30 * MINUTE && state.readResetAt > state.now

const expected = (state: ModelState): "ordinary" | "backed" | "held" => {
  const known = knownOf(state)
  if (!freshOf(state) || state.read >= 0.99 || known > lineOf(state) + 1e-9) return "held"
  if (known <= evenOf(state) + 1e-9) return "ordinary"
  if (Option.isSome(recoveryOf(state)) && lineOf(state) - known >= COST - 1e-9) return "backed"
  return "held"
}

// ── The pool's side: the account as read, and the Resets state ──

const week = (utilization: number, resetAt: number): QuotaWindow => ({ name: "7d", utilization, resetAt })
const carried = (utilization: number, resetAt: number, at: number): QuotaWindow => ({ name: "7d", utilization, resetAt, at })
const observation = (utilization: number, resetAt: number, at: number) =>
  ObserveClaim.make({ pool: "anthropic", provider: "claude", credentialID: "a", windows: [week(utilization, resetAt)], at })

const accountOf = (state: ModelState): AccountStatus => ({
  credentialID: "a",
  live: 0,
  load: 0,
  noRoom: false,
  reading: { at: state.readAt, windows: [{ name: "5h", utilization: 0.2, resetAt: state.now + HOUR }, week(state.read, state.readResetAt)] },
})

const claimOf = (index: number, at: number, outcome: Outcome, before: ReadonlyArray<QuotaWindow>, after: Option.Option<ReadonlyArray<QuotaWindow>>): Claim => ({
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
  ...Option.match(after, { onNone: () => ({}), onSome: (windows) => ({ after: windows }) }),
  weekly: "kept",
})

/** The Resets aggregate deciding `command` on `resets` at `now`, its events folded in. */
const decided = (resets: ResetsState, command: ObserveClaim | ReserveSpend | WithdrawSpend, now: number): ResetsState =>
  decideSpend(resets, command, now).reduce((state: ResetsState, event: Event) => evolve(state, event), resets)

/** A claim settled: kept as the store keeps it, oldest first. */
const settled = (resets: ResetsState, claim: Claim): ResetsState => ({ ...resets, claims: [...resets.claims, claim] })

/** What the pool decides of a dispatch now, on the account as read and the claims and reservations kept. */
const poolOf = (state: ModelState, resets: ResetsState) => {
  const account = accountOf(state)
  return dispatchPace([account], state.now, plansOf(state, resets), COST, MODEL)
}
/** The plans the pool reads (`Pool.plansOf`): each account's line moved by its observed claim, with the shares reserved on it. */
const planned = (account: AccountStatus, resets: ResetsState, now: number) => pacePlans("claude", [account], resets.claims, now, resets.spends)
const plansOf = (state: ModelState, resets: ResetsState) => planned(accountOf(state), resets, state.now)

// ── The steps ──

interface World {
  readonly state: ModelState
  resets: ResetsState
  claims: number
}

/** The clock moves on; past the reset a new period starts, its real week low, no recovery or pending claim carried into it. */
const advance = (world: World, random: Random) => {
  const { state } = world
  state.now += Math.ceil(random() * 6 * HOUR)
  while (state.now >= state.resetAt) {
    state.resetAt += WEEK
    state.actual = random() * 0.05
    state.recovery = Option.none()
    state.pending = Option.none()
    state.reserved = 0
  }
}

/** A short wait: requests in one breath, the reading not yet taken again. */
const tick = (world: World, random: Random) => {
  world.state.now += Math.ceil(random() * 5 * MINUTE)
}

/**
 * A reading is taken: the pool reads the real week. A claim waiting for its
 * observation takes it as such (`ObserveClaim`, as `Pool.take` sends it).
 */
const read = (world: World) => {
  const { state } = world
  state.read = state.actual
  state.readAt = state.now
  state.readResetAt = state.resetAt
  const waiting = awaitingObservation(world.resets.claims, "claude", "a", state.now)
  if (Option.isSome(waiting) && state.now > waiting.value.at)
    world.resets = decided(world.resets, observation(state.read, state.readResetAt, state.now), state.now)
  // The model: a reading taken after a claim that went through and within 30 minutes of it confirms it when the week is
  // lower in its period; one that is not keeps it waiting, and past the 30 minutes the wait ends with nothing.
  const due = Option.filter(state.pending, (pending) => state.now > pending.at)
  Option.map(due, (pending) => {
    if (state.now > pending.at + OBSERVE) state.pending = Option.none()
    else if (pending.resetAt === state.resetAt && state.read < pending.before - 1e-9) {
      state.recovery = Option.some({ at: pending.at, from: state.read })
      state.reserved = 0
      state.pending = Option.none()
    }
  })
}

/** Another actor's spend (a peer, a phone): the real week moves, no room is given. */
const spendElsewhere = (world: World, random: Random) => {
  world.state.actual = Math.min(1, world.state.actual + random() * 0.05)
}

/** What the reading after a claim shows, by its kind. */
const afterOf = (kind: After, state: ModelState, before: number): Option.Option<ReadonlyArray<QuotaWindow>> => {
  switch (kind) {
    case "absent":
      return Option.none()
    case "stale":
      return Option.some([carried(state.read, state.readResetAt, state.readAt)])
    case "rolled":
      return Option.some([week(state.actual, state.resetAt + WEEK)])
    case "fresh":
    case "unchanged":
      return Option.some([week(state.actual, state.resetAt)])
    case "lagging":
      return Option.some([week(before, state.resetAt)])
  }
}

/**
 * A claim, its outcome and what the reading after it showed. A `reset` lowers
 * the real week; an `already-redeemed` lowers it too when another actor's
 * refund shows meanwhile, which is not this claim's room.
 */
const claim = (world: World, random: Random) => {
  const { state } = world
  const outcome = pick<Outcome>(random, ["reset", "reset", "already-redeemed", "failed"])
  const after = pick<After>(random, ["fresh", "fresh", "absent", "stale", "unchanged", "rolled", "lagging"])
  const before = state.actual
  const lowers = outcome !== "failed" && after !== "unchanged" && before > 0.01
  // Given back, the week drops by up to half of what it was: often still past the even line, on the claim's room.
  state.actual = before * (1 - Number(lowers) * random() * 0.5)
  const windows = afterOf(after, state, before)
  world.resets = settled(world.resets, claimOf(world.claims, state.now, outcome, [week(before, state.resetAt)], windows))
  world.claims++
  // A claim's own reading after it is a reading the pool takes in; a lagging one shows the week before the claim.
  const taken = Option.flatMap(windows, (shown) => Arr.findFirst(shown, (window) => window.resetAt === state.resetAt && Option.isNone(Option.fromUndefinedOr(window.at))))
  Option.map(taken, (window) => {
    state.read = window.utilization
    state.readAt = state.now
    state.readResetAt = state.resetAt
  })
  // The model: a newer claim ends the wait of the one before it.
  state.pending = Option.none()
  if (outcome !== "reset" || after === "rolled") return
  // Its own reading after it shows the week lower in its period: confirmed. Any other (absent, carried over, unchanged,
  // lagging) leaves it waiting for a later reading that does.
  if ((after === "fresh" || after === "unchanged") && state.actual < before - 1e-9) {
    state.recovery = Option.some({ at: state.now, from: state.actual })
    state.reserved = 0
  } else state.pending = Option.some({ at: state.now, before, resetAt: state.resetAt })
}

/** A request at its dispatch, decided by the pool and by the model; admitted on a claim's room, it reserves its share first. */
const dispatch = (world: World, random: Random, seen: (pool: string, model: string) => void) => {
  const { state } = world
  const pace = poolOf(state, world.resets)
  const want = expected(state)
  seen(Option.getOrElse(Option.fromUndefinedOr(pace.admission), () => "ordinary"), want)
  if (!pace.ok) return
  if (pace.admission === "backed") {
    const spend: Spend = { id: `s${world.claims}-${state.now}-${random()}`, claim: "", credentialID: "a", at: state.now, cost: COST }
    const plan = Option.flatMap(Option.fromUndefinedOr(plansOf(state, world.resets)["a"]), (found) => Option.fromUndefinedOr(found.rebase))
    const key = Option.getOrElse(Option.flatMap(plan, (rebase) => Option.fromUndefinedOr(rebase.key)), () => "")
    world.resets = decided(world.resets, ReserveSpend.make({ spend: { ...spend, claim: key } }), state.now)
    expect(reservationHolds(world.resets, "claude", accountOf(state), state.now, spend.id)).toBe(true)
    state.reserved += COST
    // Safety, whatever the readings lag: with its share reserved, the week as the pool may know it is still within the line.
    expect(knownOf(state)).toBeLessThanOrEqual(lineOf(state) + 1e-9)
  }
  // The real cost is the provider's, never more than the share reserved for it.
  state.actual = Math.min(1, state.actual + random() * COST)
}

describe("reset-backed admission at the dispatch, a generated sequence against an independent model", () => {
  test("every dispatch: the pool admits exactly when the model does, readings lagging the requests, backed room never spent twice", () => {
    const totals = { dispatches: 0, backed: 0, heldBacked: 0, stale: 0, confirmedLate: 0, confirmedAfterQuiet: 0 }
    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = generator(seed)
      const now = START + random() * 3 * DAY
      const first = 0.3 + random() * 0.7
      const world: World = {
        state: { now, actual: first, resetAt: START + 4 * DAY, read: first, readAt: now, readResetAt: START + 4 * DAY, recovery: Option.none(), pending: Option.none(), reserved: 0 },
        resets: { waits: {}, resets: {}, claims: [] },
        claims: 0,
      }
      for (let index = 0; index < STEPS; index++) {
        const label = `seed ${seed} step ${index}: real ${world.state.actual.toFixed(4)}, read ${world.state.read.toFixed(4)}, line ${lineOf(world.state).toFixed(4)}`
        const roll = random()
        if (roll < 0.12) advance(world, random)
        else if (roll < 0.3) tick(world, random)
        else if (roll < 0.45) read(world)
        else if (roll < 0.53) spendElsewhere(world, random)
        else if (roll < 0.65) claim(world, random)
        else
          dispatch(world, random, (pool, model) => {
            expect(pool, label).toBe(model)
            totals.dispatches++
            totals.backed += Number(pool === "backed")
            totals.heldBacked += Number(pool === "held" && Option.isSome(recoveryOf(world.state)) && freshOf(world.state))
            totals.stale += Number(!freshOf(world.state))
          })
        totals.confirmedLate += Number(world.resets.claims.some((item) => Option.isSome(Option.fromUndefinedOr(item.observed))))
        totals.confirmedAfterQuiet += Number(world.resets.claims.some((item) => Option.isSome(Option.fromUndefinedOr(item.observed)) && Option.isSome(Option.fromUndefinedOr(item.after))))
      }
    }
    // The sequences reached every kind of room: ordinary, backed, backed room used up, unread, and a late observation.
    expect(totals.backed).toBeGreaterThan(20)
    expect(totals.heldBacked).toBeGreaterThan(0)
    expect(totals.stale).toBeGreaterThan(0)
    expect(totals.confirmedLate).toBeGreaterThan(0)
    // A claim read unchanged right after it (the provider lagging), confirmed by a later timely reading.
    expect(totals.confirmedAfterQuiet).toBeGreaterThan(0)
  })

  test("two requests on one reading and one 4-point slot: one is admitted and reserves, the other is held, until a reading covers it", () => {
    const resetAt = START + 3.5 * DAY
    const state: ModelState = { now: START, actual: 0.66, resetAt, read: 0.66, readAt: START, readResetAt: resetAt, recovery: Option.some({ at: START, from: 0.66 }), pending: Option.none(), reserved: 0 }
    const claimed = claimOf(1, START, "reset", [week(1, resetAt)], Option.some([week(0.66, resetAt)]))
    const world: World = { state, resets: { waits: {}, resets: {}, claims: [claimed] }, claims: 1 }
    const random = generator(7)
    const seen: Array<string> = []
    dispatch(world, random, (pool) => seen.push(pool))
    dispatch(world, random, (pool) => seen.push(pool))
    expect(seen).toEqual(["backed", "held"])
    // A reading taken later still lags: it shows less than was reserved, and gives nothing back.
    state.now += MINUTE
    state.actual = 0.67
    read(world)
    dispatch(world, random, (pool) => seen.push(pool))
    expect(seen).toEqual(["backed", "held", "held"])
  })

  test("racing instances on one host: of two reservations on one slot, never both hold, in every order of their writes and reads", () => {
    const resetAt = START + 3.5 * DAY
    const state: ModelState = { now: START, actual: 0.66, resetAt, read: 0.66, readAt: START, readResetAt: resetAt, recovery: Option.none(), pending: Option.none(), reserved: 0 }
    const claimed = claimOf(1, START, "reset", [week(1, resetAt)], Option.some([week(0.66, resetAt)]))
    const base: ResetsState = { waits: {}, resets: {}, claims: [claimed] }
    const spendOf = (id: string): Spend => ({ id, claim: claimed.key, credentialID: "a", at: START, cost: COST })
    // Each instance writes, then reads back and withdraws a share that does not hold. Every interleaving of the four steps:
    const orders = [
      ["wa", "ra", "wb", "rb"],
      ["wa", "wb", "ra", "rb"],
      ["wa", "wb", "rb", "ra"],
      ["wb", "wa", "ra", "rb"],
      ["wb", "wa", "rb", "ra"],
      ["wb", "rb", "wa", "ra"],
    ]
    for (const order of orders) {
      let resets = base
      const held = new Map<string, boolean>()
      for (const step of order) {
        const id = step.slice(1)
        if (step.startsWith("w")) resets = decided(resets, ReserveSpend.make({ spend: spendOf(id) }), START)
        else {
          const holds = reservationHolds(resets, "claude", accountOf(state), START, id)
          held.set(id, holds)
          if (!holds) resets = decided(resets, WithdrawSpend.make({ id }), START)
        }
      }
      const kept = [...held.values()].filter(Boolean).length
      expect(kept, order.join(" ")).toBeLessThanOrEqual(1)
      expect(Option.getOrElse(Option.fromUndefinedOr(resets.spends), () => []), order.join(" ")).toHaveLength(kept)
    }
  })

  test("an already-redeemed answer with another actor's refund visible after it backs nothing; a delayed reading of a claim that went through does", () => {
    const resetAt = START + 3.5 * DAY
    const at = (used: number, readAt: number): AccountStatus => ({
      credentialID: "a",
      live: 0,
      load: 0,
      noRoom: false,
      reading: { at: readAt, windows: [{ name: "5h", utilization: 0.2, resetAt: readAt + HOUR }, week(used, resetAt)] },
    })
    const plan = (resets: ResetsState, readAt: number) => planned(at(0.66, readAt), resets, readAt)
    const foreign: ResetsState = { waits: {}, resets: {}, claims: [claimOf(1, START, "already-redeemed", [week(1, resetAt)], Option.some([week(0.66, resetAt)]))] }
    expect(dispatchPace([at(0.66, START)], START, plan(foreign, START), COST, MODEL)).toMatchObject({ ok: false, admission: "held" })
    // Went through; its reading after it unread. The first reading after it observes it, once.
    const own: ResetsState = { waits: {}, resets: {}, claims: [claimOf(2, START, "reset", [week(1, resetAt)], Option.none())] }
    expect(dispatchPace([at(1, START)], START, plan(own, START), COST, MODEL)).toMatchObject({ ok: false })
    const observed = decided(own, observation(0.66, resetAt, START + MINUTE), START + MINUTE)
    expect(dispatchPace([at(0.66, START + MINUTE)], START + MINUTE, plan(observed, START + MINUTE), COST, MODEL)).toMatchObject({ ok: true, admission: "backed" })
    // A later reading is no second observation: the first stays the claim's.
    expect(decided(observed, observation(0.2, resetAt, START + 2 * MINUTE), START + 2 * MINUTE)).toEqual(observed)
  })

  test("a claim that went through, read unchanged right after it, stays pending until a timely reading shows its recovery; never past 30 minutes", () => {
    const resetAt = START + 3.5 * DAY
    const at = (used: number, readAt: number): AccountStatus => ({
      credentialID: "a",
      live: 0,
      load: 0,
      noRoom: false,
      reading: { at: readAt, windows: [{ name: "5h", utilization: 0.2, resetAt: readAt + HOUR }, week(used, resetAt)] },
    })
    const plan = (resets: ResetsState, used: number, readAt: number) => planned(at(used, readAt), resets, readAt)
    // Went through; its reading right after it fresh and unchanged: pending, no room.
    const lagging: ResetsState = { waits: {}, resets: {}, claims: [claimOf(3, START, "reset", [week(1, resetAt)], Option.some([week(1, resetAt)]))] }
    expect(Option.map(awaitingObservation(lagging.claims, "claude", "a", START + MINUTE), (claim) => claim.key)).toEqual(Option.some("k3"))
    expect(dispatchPace([at(1, START + MINUTE)], START + MINUTE, plan(lagging, 1, START + MINUTE), COST, MODEL)).toMatchObject({ ok: false })
    // Another unchanged reading is no observation: it stays pending.
    const quiet = decided(lagging, observation(1, resetAt, START + 5 * MINUTE), START + 5 * MINUTE)
    expect(quiet).toEqual(lagging)
    expect(Option.isSome(awaitingObservation(quiet.claims, "claude", "a", START + 5 * MINUTE))).toBe(true)
    // A reading of another period is no recovery of the claim's.
    expect(decided(quiet, observation(0.02, resetAt + WEEK, START + 6 * MINUTE), START + 6 * MINUTE)).toEqual(lagging)
    // A timely lower reading in the same period is its recovery: backed room.
    const recovered = decided(quiet, observation(0.66, resetAt, START + 10 * MINUTE), START + 10 * MINUTE)
    expect(dispatchPace([at(0.66, START + 10 * MINUTE)], START + 10 * MINUTE, plan(recovered, 0.66, START + 10 * MINUTE), COST, MODEL)).toMatchObject({ ok: true, admission: "backed" })
    // The same reading past the 30 minutes is not the claim's: no room, and no longer pending.
    const late = decided(quiet, observation(0.66, resetAt, START + 31 * MINUTE), START + 31 * MINUTE)
    expect(late).toEqual(lagging)
    expect(Option.isNone(awaitingObservation(late.claims, "claude", "a", START + 31 * MINUTE))).toBe(true)
    expect(dispatchPace([at(0.66, START + 31 * MINUTE)], START + 31 * MINUTE, plan(late, 0.66, START + 31 * MINUTE), COST, MODEL)).toMatchObject({ ok: false })
    // An already-redeemed answer read unchanged and then lower is never pending, never room.
    const foreign: ResetsState = { waits: {}, resets: {}, claims: [claimOf(4, START, "already-redeemed", [week(1, resetAt)], Option.some([week(1, resetAt)]))] }
    expect(Option.isNone(awaitingObservation(foreign.claims, "claude", "a", START + MINUTE))).toBe(true)
    expect(decided(foreign, observation(0.66, resetAt, START + 10 * MINUTE), START + 10 * MINUTE)).toEqual(foreign)
  })
})
