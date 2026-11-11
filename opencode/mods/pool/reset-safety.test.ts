// When a reset may be spent without the owner (resets.ts), as properties: the
// round-1 verifier's probes (batch 2026-11-11e, round-1-findings.md B1, M1,
// M2, M3), each over the inputs it varied.
//
// - B1: one account takes one claim at a time. After a claim, nothing more is
//   claimed, offered or asked on it until a reading newer than the claim shows
//   what it did; one spent reading never spends two grants. The request id
//   comes from the account, the window and its period, not the grant.
// - M1: an automatic claim needs fresh evidence: a reading and a list of the
//   grants read within FRESH_MS, and a known natural reset after the grant's
//   expiry. Cached or unread data never authorizes spending.
// - M2: a reset is worth what it restores: zero restored is never claimed.
// - M3: a declined offer suppresses its account, kind and week, whichever
//   window ranks first later.
// - `auto: false` claims nothing on its own; offers and questions go on.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fold } from "@dotfiles/decider/decider"
import { carryOver, type QuotaWindow, type ResetCredit } from "./quota.ts"
import {
  type Command,
  effectOf,
  type Event,
  EXPIRING_MS,
  expiringKey,
  FRESH_MS,
  MIN_RESTORE,
  NoteWait,
  offerKey,
  type PoolView,
  type Ratio,
  RETRY_MS,
  Resets,
  type ResetsState,
  Review,
  SettleClaim,
  staleReason,
  TakeAnswer,
} from "./resets.ts"
import type { AccountStatus } from "./status.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const T0 = Date.parse("2026-11-11T12:00:00Z")

const run = (commands: ReadonlyArray<readonly [number, Command]>, state: ResetsState = Resets.initial) =>
  Effect.runSync(
    Effect.gen(function* () {
      let current = state
      const events: Array<Event> = []
      for (const [now, command] of commands) {
        const decided = yield* Resets.decide(current, command, now)
        events.push(...decided)
        current = fold(Resets, decided, current)
      }
      return { events, state: current }
    }),
  )

const claimsOf = (events: ReadonlyArray<Event>) => events.flatMap((event) => (event._tag === "ClaimDue" ? [event.reset] : []))
const asksOf = (events: ReadonlyArray<Event>) => events.flatMap((event) => (event._tag === "OwnerAsked" ? [event.reset] : []))

const window = (name: string, utilization: number, resetAt?: number, more: Partial<QuotaWindow> = {}): QuotaWindow => ({
  name,
  utilization,
  ...(resetAt === undefined ? {} : { resetAt }),
  ...more,
})

/** An account `a` whose windows were read at `at`, with its grants read with them, or carried over from a reading at `listed`. */
const account = (windows: ReadonlyArray<QuotaWindow>, credits: ReadonlyArray<ResetCredit>, at = T0, listed?: number): AccountStatus => ({
  credentialID: "a",
  load: 0,
  live: 0,
  noRoom: false,
  reading: { at, windows, resets: { ...(listed === undefined ? {} : { at: listed }), available: credits.length, credits } },
})

const grant = (id: string, expiresAt: number, fields: Partial<ResetCredit>): ResetCredit => ({ id, count: 1, usable: true, expiresAt, requiresLimit: false, ...fields })
const WEEKLY: Partial<ResetCredit> = { clears: ["seven_day"], kind: "weekly" }
const SESSION: Partial<ResetCredit> = { clears: ["five_hour"], kind: "session" }
const FULL: Partial<ResetCredit> = { clears: ["five_hour", "seven_day"], kind: "full" }
const FABLE: Partial<ResetCredit> = { clears: ["five_hour", "seven_day_overage_included"], kind: "fable", givesBack: true }

const view = (accounts: ReadonlyArray<AccountStatus>, ratios: Readonly<Record<string, Ratio>> = {}, provider: "claude" | "codex" = "claude"): PoolView => ({
  id: provider === "claude" ? "anthropic" : "openai",
  provider,
  accounts,
  labels: Object.fromEntries(accounts.map((item) => [item.credentialID, item.credentialID])),
  ratios,
})

/** A second account with room, so the pool is never wholly held (that is the held start's question, not these rules). */
const roomy: AccountStatus = { ...account([window("5h", 0.1, T0 + 3 * HOUR), window("7d", 0.1, T0 + 5 * DAY)], []), credentialID: "room" }

const review = (accounts: ReadonlyArray<AccountStatus>, now = T0, state: ResetsState = Resets.initial, auto?: boolean, ratios: Readonly<Record<string, Ratio>> = {}) =>
  run([[now, Review.make({ pools: [view([...accounts, roomy], ratios)], ...(auto === undefined ? {} : { auto }) })]], state)

describe("M1: an automatic claim needs fresh evidence", () => {
  test("over the reading's age × the grants' listing × the natural reset × the use: claimed iff all are fresh and known, and the window outlives the grant", () => {
    const expiresAt = T0 + 2 * HOUR
    const ages = [0, 5 * MINUTE, FRESH_MS - 1, FRESH_MS, 2 * HOUR, 2 * DAY, 8 * DAY]
    // Grants listed with the reading (no `at` of their own), or carried over from an older reading (`carryOver` names its time).
    const listings = ["with the reading", "carried from FRESH_MS before", "carried from two days before"] as const
    const resets = [undefined, expiresAt - 1, expiresAt, expiresAt + 1, T0 + 3 * DAY]
    for (const age of ages)
      for (const listing of listings)
        for (const resetAt of resets)
          for (const used of [0.5, 1]) {
            const at = T0 - age
            const listed = listing === "with the reading" ? undefined : listing === "carried from FRESH_MS before" ? T0 - FRESH_MS : T0 - 2 * DAY
            const { events } = review([account([window("7d", used, resetAt)], [grant("g", expiresAt, WEEKLY)], at, listed)])
            // Carried from FRESH_MS before is at the edge: no longer fresh.
            const due = age < FRESH_MS && listing === "with the reading" && resetAt !== undefined && resetAt > expiresAt
            const label = `age ${age / MINUTE} min, grants ${listing}, natural reset ${resetAt === undefined ? "unread" : (resetAt - T0) / HOUR + " h"}, used ${used}`
            expect(claimsOf(events).length, label).toBe(due ? 1 : 0)
          }
  })

  test("a claim that never came back is sent again only on fresh evidence", () => {
    const expiresAt = T0 + 3 * HOUR
    const first = review([account([window("7d", 1, T0 + 3 * DAY)], [grant("g", expiresAt, WEEKLY)])])
    expect(claimsOf(first.events)).toHaveLength(1)
    const later = T0 + RETRY_MS
    // The reading the claim was decided on, now stale: no retry.
    expect(claimsOf(review([account([window("7d", 1, T0 + 3 * DAY)], [grant("g", expiresAt, WEEKLY)])], later, first.state).events)).toEqual([])
    // A fresh one: the same claim again, under the same request id.
    const again = claimsOf(review([account([window("7d", 1, T0 + 3 * DAY)], [grant("g", expiresAt, WEEKLY)], later)], later, first.state).events)
    expect(again.map((reset) => reset.requestID)).toEqual([claimsOf(first.events)[0]!.requestID])
  })
})

describe("M2: a reset is worth what it restores", () => {
  test("over kinds × windows × Fable's share source × reset ordering: every automatic claim restores at least MIN_RESTORE of a window that outlives the grant", () => {
    const expiresAt = T0 + 2 * HOUR
    const credits = [WEEKLY, SESSION, FULL, FABLE]
    const shares = [{ weeklyUsed: 0 }, { weeklyUsed: 0.3 }, { ofWeekly: 0.5 }, {}] as const
    let claimed = 0
    for (const fields of credits)
      for (const five of [0.2, 1])
        for (const fiveResets of [T0 + HOUR, T0 + 3 * HOUR])
          for (const week of [0.5, 1])
            for (const own of [0, 0.12, 1])
              for (const ownResets of [T0 + HOUR, T0 + 3 * DAY])
                for (const share of shares) {
                  const credit = grant("g", expiresAt, fields)
                  const item = account(
                    [window("5h", five, fiveResets), window("7d", week, T0 + 3 * DAY), window("7d:Fable", own, ownResets, share)],
                    [credit],
                  )
                  const due = claimsOf(review([item]).events)
                  const useful = effectOf("claude", item, credit).some(
                    (give) => give.resetAt !== undefined && give.resetAt > expiresAt && give.from - give.to >= MIN_RESTORE,
                  )
                  if (due.length > 0) claimed++
                  expect(due.length === 0 || useful, `${fields.kind} 5h ${five} week ${week} Fable ${own} share ${JSON.stringify(share)}`).toBe(true)
                }
    // The property is not vacuous: some cases claim.
    expect(claimed).toBeGreaterThan(0)
  })

  test("the verifier's case: the shared week spent, Fable's reported part 0%, Fable's week and the 5-hour window resetting before the grant ends: nothing claimed", () => {
    const credit = grant("g", T0 + 2 * HOUR, FABLE)
    const item = account([window("5h", 0.2, T0 + HOUR), window("7d:Fable", 0.12, T0 + HOUR, { weeklyUsed: 0 }), window("7d", 1, T0 + 3 * DAY)], [credit])
    expect(claimsOf(review([item]).events)).toEqual([])
  })
})

describe("B1: one claim at a time per account", () => {
  const spent = (at = T0, used = 1) => account([window("7d", used, T0 + 3 * DAY)], [grant("g1", T0 + 2 * HOUR, WEEKLY), grant("g2", T0 + 2 * HOUR, WEEKLY)], at)

  test("one spent reading with two expiring grants claims one; nothing more until a reading newer than the claim, and then only if still worth it", () => {
    const first = review([spent()])
    expect(claimsOf(first.events).map((reset) => reset.creditID)).toEqual(["g1"])
    const settled = run([[T0 + MINUTE, SettleClaim.make({ key: claimsOf(first.events)[0]!.key, outcome: "reset", before: [] })]], first.state)
    // The same reading, reviewed after the claim: it predates the claim, so it says nothing of its effect.
    expect(claimsOf(review([spent()], T0 + 2 * MINUTE, settled.state).events)).toEqual([])
    // A reading after the claim shows the week emptied: g2 restores nothing and stays.
    expect(claimsOf(review([spent(T0 + 2 * MINUTE, 0)], T0 + 3 * MINUTE, settled.state).events)).toEqual([])
    // Spent again later the same week, with fresh evidence: the window period was claimed for already, so not again on its own.
    expect(claimsOf(review([spent(T0 + HOUR)], T0 + HOUR, settled.state).events)).toEqual([])
  })

  test("the key names the account, the window and its period, and the request id the account, the kind and its period: not the grant a host picked", () => {
    const one = claimsOf(review([account([window("7d", 1, T0 + 3 * DAY)], [grant("g1", T0 + 2 * HOUR, WEEKLY), grant("g2", T0 + 3 * HOUR, WEEKLY)])]).events)[0]!
    const other = claimsOf(review([account([window("7d", 1, T0 + 3 * DAY)], [grant("g1", T0 + 3 * HOUR, WEEKLY), grant("g2", T0 + 2 * HOUR, WEEKLY)])]).events)[0]!
    expect(one.key).toBe(expiringKey("claude", "a", "7d", T0 + 3 * DAY))
    expect([one.creditID, other.creditID]).toEqual(["g1", "g2"])
    expect(other.key).toBe(one.key)
    expect(other.requestID).toBe(one.requestID)
    // A restart keeps it: the state round-trips through JSON and the retry is the same claim.
    const state = JSON.parse(JSON.stringify(review([spent()]).state)) as ResetsState
    const retried = claimsOf(review([spent(T0 + RETRY_MS)], T0 + RETRY_MS, state).events)
    expect(retried.map((reset) => reset.requestID)).toEqual([one.requestID])
  })

  test("an open offer on an account a claim is now due on is withdrawn, and its later yes spends nothing", () => {
    const early = T0 - 2 * DAY
    const item = (at: number) => account([window("5h", 0.2, at + 3 * HOUR), window("7d", 0.9, T0 + 4 * DAY)], [grant("g", T0 + 2 * HOUR, WEEKLY)], at)
    const offered = run([
      [early, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [early, Review.make({ pools: [view([item(early), roomy])] })],
    ])
    const ask = asksOf(offered.events)[0]
    expect(ask?.why).toBe("offer")
    const expiry = review([item(T0)], T0, offered.state)
    expect(expiry.events.map((event) => event._tag)).toEqual(["AskWithdrawn", "ClaimDue"])
    expect(expiry.events[0]).toMatchObject({ key: ask!.key })
    expect(claimsOf(run([[T0 + 1, TakeAnswer.make({ key: ask!.key, answer: "Claim it" })]], expiry.state).events)).toEqual([])
  })

  test("a yes on an offer whose account was claimed on meanwhile withdraws instead of claiming", () => {
    const early = T0 - 2 * DAY
    const item = account([window("5h", 0.2, early + 3 * HOUR), window("7d", 0.95, T0 + 4 * DAY)], [grant("g", T0 + 60 * DAY, WEEKLY)], early)
    const offered = run([
      [early, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [early, Review.make({ pools: [view([item, roomy])] })],
    ])
    const ask = asksOf(offered.events)[0]!
    // Another claim on the account is in flight (a Codex-like held claim, an expiring one): the yes waits for nothing and spends nothing.
    const busy: ResetsState = {
      ...offered.state,
      resets: { ...offered.state.resets, other: { ...ask, key: "other", creditID: "g2", why: "expiring", stage: "claiming", at: T0, attempts: 1 } },
    }
    const answered = run([[T0 + 1, TakeAnswer.make({ key: ask.key, answer: "Claim it" })]], busy)
    expect(claimsOf(answered.events)).toEqual([])
    expect(answered.events.map((event) => event._tag)).toEqual(["AskWithdrawn"])
  })
})

describe("B1 across pools and hosts: an account is its login, and a claim is judged again on the provider's reading", () => {
  /** A pool `id` listing `accounts`, the same logins as another pool may. */
  const pool = (id: string, accounts: ReadonlyArray<AccountStatus>, provider: "claude" | "codex" = "claude"): PoolView => ({ ...view(accounts, {}, provider), id })

  test("one login listed by two pools, in either order, Claude's expiring grant or Codex's held start: one claim", () => {
    const spent = account([window("7d", 1, T0 + 3 * DAY)], [grant("g1", T0 + 2 * HOUR, WEEKLY), grant("g2", T0 + 2 * HOUR, WEEKLY)])
    for (const ids of [
      ["pool-a", "pool-b"],
      ["pool-b", "pool-a"],
    ] as const) {
      const claude = run([[T0, Review.make({ pools: ids.map((id) => pool(id, [spent, roomy])) })]])
      expect(claimsOf(claude.events), ids.join(" then ")).toHaveLength(1)
      // Codex: every account spent and a start waiting in each pool.
      const codex = run([
        ...ids.map((id) => [T0, NoteWait.make({ pool: id, sessionID: "ses_root" })] as const),
        [T0, Review.make({ pools: ids.map((id) => pool(id, [account([window("7d", 1, T0 + 3 * DAY)], [grant("c", T0 + 20 * DAY, {})])], "codex")) })],
      ])
      expect(claimsOf(codex.events), `codex ${ids.join(" then ")}`).toHaveLength(1)
    }
  })

  test("one login listed by two pools with a start waiting in each: one offer, not one per pool", () => {
    const item = account([window("5h", 0.2, T0 + 3 * HOUR), window("7d", 0.95, T0 + 4 * DAY)], [grant("w", T0 + 60 * DAY, WEEKLY)])
    const { events } = run([
      [T0, NoteWait.make({ pool: "pool-a", sessionID: "ses_a" })],
      [T0, NoteWait.make({ pool: "pool-b", sessionID: "ses_b" })],
      [T0, Review.make({ pools: [pool("pool-a", [item, roomy]), pool("pool-b", [item, roomy])], auto: false })],
    ])
    expect(asksOf(events)).toHaveLength(1)
  })

  test("a yes on an offer made in one pool, after the login was claimed on through another pool: withdrawn, nothing claimed", () => {
    const offer = account([window("5h", 0.2, T0 + 3 * HOUR), window("7d", 0.95, T0 + 6 * DAY)], [grant("w", T0 + 60 * DAY, WEEKLY)])
    const offered = run([
      [T0, NoteWait.make({ pool: "pool-a", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [pool("pool-a", [offer, roomy])], auto: false })],
    ])
    const ask = asksOf(offered.events)[0]!
    const spent = account([window("7d", 1, T0 + 3 * DAY)], [grant("g", T0 + 2 * HOUR, WEEKLY)], T0 + 1)
    const other = run([[T0 + 1, Review.make({ pools: [pool("pool-a", [offer, roomy]), pool("pool-b", [spent, roomy])] })]], offered.state)
    expect(claimsOf(other.events)).toHaveLength(1)
    // The claim through the other pool withdraws the question (its account is the login, not the pool); the yes after it spends nothing.
    expect(other.events.filter((event) => event._tag === "AskWithdrawn")).toMatchObject([{ key: ask.key }])
    const yes = run([[T0 + 2, TakeAnswer.make({ key: ask.key, answer: "Claim it" })]], other.state)
    expect(claimsOf(yes.events)).toEqual([])
  })

  test("two hosts reading one account apart (windows ranked otherwise, grants listed in another order) that both claim send one request id, per kind", () => {
    const expiresAt = T0 + 2 * HOUR
    const grids = [0.2, 0.8, 1].flatMap((five) => [0.8, 1].map((seven) => [five, seven] as const))
    for (const grants of [
      [grant("g1", expiresAt, FULL), grant("g2", expiresAt, FULL)],
      [grant("g1", expiresAt, SESSION), grant("g2", expiresAt, WEEKLY), grant("g3", expiresAt, FULL)],
    ])
      for (const [leftFive, leftSeven] of grids)
        for (const [rightFive, rightSeven] of grids) {
          const read = (five: number, seven: number, credits: ReadonlyArray<ResetCredit>) =>
            account([window("5h", five, T0 + 4 * HOUR), window("7d", seven, T0 + 3 * DAY)], credits)
          const decided = [read(leftFive, leftSeven, grants), read(rightFive, rightSeven, grants.toReversed())].flatMap((host) => claimsOf(review([host]).events))
          const byKind = new Map<string, Set<string>>()
          for (const reset of decided) byKind.set(reset.kind ?? "", (byKind.get(reset.kind ?? "") ?? new Set()).add(reset.requestID))
          for (const [kind, ids] of byKind) expect(ids.size, `${kind}: left ${leftFive}/${leftSeven}, right ${rightFive}/${rightSeven}`).toBe(1)
        }
  })

  test("decided on divergent host readings, sent one after the other, each judged again on the provider's reading: no grant spent for nothing, and full grants spend one", () => {
    const WINDOW_OF: Readonly<Record<string, string>> = { five_hour: "5h", seven_day: "7d" }
    const expiresAt = T0 + 2 * HOUR
    const grids = [0.2, 0.8, 1].flatMap((five) => [0.8, 1].map((seven) => [five, seven] as const))
    const kinds = [
      ["full", [grant("g1", expiresAt, FULL), grant("g2", expiresAt, FULL)]],
      ["mixed", [grant("g1", expiresAt, SESSION), grant("g2", expiresAt, WEEKLY), grant("g3", expiresAt, FULL)]],
    ] as const
    let sentAny = 0
    for (const [kind, grants] of kinds)
      for (const truth of grids)
        for (const [leftFive, leftSeven] of grids)
          for (const [rightFive, rightSeven] of grids) {
            // Each host's own fresh reading, the grants listed in another order: each decides alone, its own store.
            const read = (five: number, seven: number, credits: ReadonlyArray<ResetCredit>) =>
              account([window("5h", five, T0 + 4 * HOUR), window("7d", seven, T0 + 3 * DAY)], credits)
            const decided = [read(leftFive, leftSeven, grants), read(rightFive, rightSeven, grants.toReversed())].flatMap((host) => claimsOf(review([host]).events))
            // The provider: the account as it is, its grants spent as claims arrive.
            const windows = new Map([
              ["5h", truth[0]],
              ["7d", truth[1]],
            ])
            const left = new Map(grants.map((item) => [item.id, item.count]))
            const sent: Array<{ readonly creditID: string; readonly restored: number }> = []
            for (const reset of decided) {
              const now = T0 + 1
              const credits = grants.map((item) => ({ ...item, count: left.get(item.id) ?? 0, usable: (left.get(item.id) ?? 0) > 0 }))
              const fresh = account(
                [...windows].map(([name, utilization]) => window(name, utilization, name === "5h" ? T0 + 4 * HOUR : T0 + 3 * DAY)),
                credits.filter((item) => item.usable),
                now,
              )
              if (staleReason(view([fresh, roomy]), fresh, reset, now) !== undefined) continue
              const credit = grants.find((item) => item.id === reset.creditID)!
              left.set(credit.id, (left.get(credit.id) ?? 0) - 1)
              let restored = 0
              for (const name of credit.clears ?? []) {
                const at = WINDOW_OF[name]!
                restored = Math.max(restored, windows.get(at) ?? 0)
                windows.set(at, 0)
              }
              sent.push({ creditID: credit.id, restored })
            }
            sentAny += sent.length
            const label = `${kind}: truth ${truth}, left ${leftFive}/${leftSeven}, right ${rightFive}/${rightSeven}, sent ${JSON.stringify(sent)}`
            expect(
              sent.every((claim) => claim.restored >= MIN_RESTORE),
              label,
            ).toBe(true)
            if (kind === "full") expect(sent.length, label).toBeLessThanOrEqual(1)
          }
    expect(sentAny).toBeGreaterThan(0)
  })
})

describe("M1 per field: each window and share is as fresh as its own read", () => {
  test("a Fable window carried over from an older reading, with the week and the grants read fresh, spends nothing, whatever its share's source; read fresh, the same window does", () => {
    const expiresAt = T0 + 2 * HOUR
    const shares = [{ weeklyUsed: 0.5 }, { ofWeekly: 1 }, {}] as const
    for (const share of shares)
      for (const age of [0, FRESH_MS - 1, FRESH_MS, 2 * HOUR, 2 * DAY]) {
        const fable = window("7d:Fable", 1, T0 + 3 * DAY, share)
        const old = { at: T0 - age, windows: [fable] }
        const next = { at: T0, windows: [window("7d", 0.2, T0 + 3 * DAY)], resets: { available: 1, credits: [grant("f", expiresAt, FABLE)] } }
        const reading = carryOver(old, next, T0)
        const label = `share ${JSON.stringify(share)}, Fable window read ${age / MINUTE} min before`
        const { events } = review([{ ...account([], []), reading }])
        if (age >= FRESH_MS) expect(claimsOf(events), label).toEqual([])
      }
    // Control: read with the rest, the Fable window's share is spend evidence.
    const read = account([window("7d", 0.2, T0 + 3 * DAY), window("7d:Fable", 1, T0 + 3 * DAY, { weeklyUsed: 0.5 })], [grant("f", expiresAt, FABLE)])
    expect(claimsOf(review([read]).events)).toHaveLength(1)
  })

  test("a window that names its own read time is judged by it, not by the reading's: stale, it is no evidence", () => {
    const expiresAt = T0 + 2 * HOUR
    for (const age of [0, FRESH_MS - 1, FRESH_MS, 2 * DAY]) {
      const item = account([window("5h", 0.1, T0 + 3 * HOUR), window("7d", 1, T0 + 3 * DAY, { at: T0 - age })], [grant("g", expiresAt, WEEKLY)])
      expect(claimsOf(review([item]).events).length, `the week read ${age / MINUTE} min before`).toBe(age < FRESH_MS ? 1 : 0)
    }
  })
})

describe("M3: a declined offer suppresses its account, kind and week", () => {
  const credit = grant("g", T0 + 60 * DAY, { ...FABLE, clears: ["seven_day_overage_included"] })
  const item = (own: number, week: number, weekResets = T0 + 6 * DAY) =>
    account([window("7d:Fable", own, weekResets, { ofWeekly: 1 }), window("7d", week, weekResets)], [credit])

  test("after a no, no reading of the same week asks again, whichever window ranks first; a new week or another kind may", () => {
    const first = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [view([item(1, 0.95), roomy])] })],
    ])
    const ask = asksOf(first.events)[0]!
    expect(ask.key).toBe(offerKey("claude", "a", "fable", T0 + 6 * DAY))
    const declined = run([[T0 + 1, TakeAnswer.make({ key: ask.key, answer: "Don't claim" })]], first.state).state
    for (const own of [0.3, 0.5, 0.9, 1])
      for (const week of [0.9, 0.95, 1]) {
        const next = run([
          [T0 + MINUTE, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
          [T0 + MINUTE, Review.make({ pools: [view([item(own, week), roomy])] })],
        ], declined)
        expect(asksOf(next.events), `Fable ${own}, week ${week}`).toEqual([])
      }
    // The next week: offerable again.
    const nextWeek = T0 + 7 * DAY
    const later = run([
      [nextWeek, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [nextWeek, Review.make({ pools: [view([account([window("7d:Fable", 1, nextWeek + 6 * DAY, { ofWeekly: 1 }), window("7d", 0.95, nextWeek + 6 * DAY)], [credit], nextWeek), roomy])] })],
    ], declined)
    expect(asksOf(later.events)).toHaveLength(1)
    // Another kind the same week: offerable.
    const weekly = run([
      [T0 + MINUTE, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0 + MINUTE, Review.make({ pools: [view([account([window("7d", 0.95, T0 + 6 * DAY)], [grant("w", T0 + 60 * DAY, WEEKLY)]), roomy])] })],
    ], declined)
    expect(asksOf(weekly.events).map((reset) => reset.kind)).toEqual(["weekly"])
  })
})

describe("auto: false, the owner's kill switch", () => {
  test("claims nothing on its own, Claude's or Codex's, fresh evidence or not; offers and a held start's question go on", () => {
    const expiring = account([window("7d", 1, T0 + 3 * DAY)], [grant("g", T0 + 2 * HOUR, WEEKLY)])
    expect(claimsOf(review([expiring], T0, Resets.initial, false).events)).toEqual([])
    expect(claimsOf(review([expiring], T0, Resets.initial, true).events)).toHaveLength(1)
    // Codex: every account held and a start waiting claims a credit unless auto is off.
    const codex = view([{ ...account([window("7d", 1, T0 + 3 * DAY)], [{ id: "c", count: 1, usable: true, status: "available", expiresAt: T0 + 20 * DAY }]), credentialID: "x" }], {}, "codex")
    for (const auto of [true, false]) {
      const { events } = run([
        [T0, NoteWait.make({ pool: "openai", sessionID: "ses_root" })],
        [T0, Review.make({ pools: [codex], auto })],
      ])
      expect(claimsOf(events).length, `auto ${auto}`).toBe(auto ? 1 : 0)
    }
    // An offer is still asked.
    const offer = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [view([account([window("5h", 0.2, T0 + 3 * HOUR), window("7d", 0.95, T0 + 6 * DAY)], [grant("w", T0 + 60 * DAY, WEEKLY)]), roomy])], auto: false })],
    ])
    expect(asksOf(offer.events).map((reset) => reset.why)).toEqual(["offer"])
  })

  test("a yes still claims: the owner's answer is not automatic", () => {
    const offer = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [view([account([window("5h", 0.2, T0 + 3 * HOUR), window("7d", 0.95, T0 + 6 * DAY)], [grant("w", T0 + 60 * DAY, WEEKLY)]), roomy])], auto: false })],
    ])
    const key = asksOf(offer.events)[0]!.key
    expect(claimsOf(run([[T0 + 1, TakeAnswer.make({ key, answer: "Claim it" })]], offer.state).events)).toHaveLength(1)
  })
})

test("EXPIRING_MS is the last day", () => expect(EXPIRING_MS).toBe(DAY))
