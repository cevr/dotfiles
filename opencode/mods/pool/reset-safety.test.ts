// When a reset may be spent without the owner (resets.ts), as properties: the
// round-1 verifier's probes (batch 2026-11-11e, round-1-findings.md B1, M1,
// M2, M3), each over the inputs it varied.
//
// - B1: one account takes one claim at a time. After a claim, nothing more is
//   claimed on it until a reading newer than the claim shows what it did; one
//   spent reading never spends two grants, and a window period takes one
//   claim. The request id comes from the account, the kind and its period,
//   not the grant.
// - M1: a claim the pool decides on its own needs fresh evidence: a reading
//   and a list of the grants read within FRESH_MS, and a known natural reset.
//   Cached or unread data never authorizes spending.
// - M2: a reset is worth what it restores: less than MIN_RESTORE is never claimed.
// - `auto: false` claims nothing on its own.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fold } from "@dotfiles/decider/decider"
import { carryOver, type QuotaWindow, type ResetCredit } from "./quota.ts"
import { NATURAL_MS } from "./claim-rule.ts"
import {
  claimOut,
  type Command,
  effectOf,
  type Event,
  EXPIRING_MS,
  expiringKey,
  FRESH_MS,
  MIN_RESTORE,
  NoteSend,
  NoteWait,
  type PoolView,
  type Ratio,
  RETRY_MS,
  Resets,
  type ResetsState,
  Review,
  SETTLE_MS,
  SettleClaim,
  ResetsForgotten,
  staleReason,
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

const view = (accounts: ReadonlyArray<AccountStatus>, ratios: Readonly<Record<string, Ratio>> = {}, provider: "claude" | "codex" = "claude", inflight = 0): PoolView => ({
  id: provider === "claude" ? "anthropic" : "openai",
  provider,
  accounts,
  labels: Object.fromEntries(accounts.map((item) => [item.credentialID, item.credentialID])),
  ratios,
  inflight,
})

/** A second account with room: held work goes there, so only an expiring reset is claimed. */
const roomy: AccountStatus = { ...account([window("5h", 0.1, T0 + 3 * HOUR), window("7d", 0.1, T0 + 5 * DAY)], []), credentialID: "room" }

const review = (accounts: ReadonlyArray<AccountStatus>, now = T0, state: ResetsState = Resets.initial, auto?: boolean, ratios: Readonly<Record<string, Ratio>> = {}) =>
  run([[now, Review.make({ pools: [view([...accounts, roomy], ratios)], ...(auto === undefined ? {} : { auto }) })]], state)

describe("M1: a claim on its own needs fresh evidence", () => {
  test("over the reading's age × the grants' listing × the natural reset × the use: claimed iff all are fresh and known", () => {
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
            const due = age < FRESH_MS && listing === "with the reading" && resetAt !== undefined && resetAt - T0 > NATURAL_MS
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
  test("over kinds × windows × Fable's share source × reset ordering: every claim on its own restores at least MIN_RESTORE of a window not about to reset by itself", () => {
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
                    (give) => give.resetAt !== undefined && give.resetAt - T0 > NATURAL_MS && give.from - give.to >= MIN_RESTORE,
                  )
                  if (due.length > 0) claimed++
                  expect(due.length === 0 || useful, `${fields.kind} 5h ${five} week ${week} Fable ${own} share ${JSON.stringify(share)}`).toBe(true)
                }
    // The property is not vacuous: some cases claim.
    expect(claimed).toBeGreaterThan(0)
  })

  test("the verifier's case: the shared week spent, Fable's reported part 0%: in its last hours the grant goes on the 5-hour window it gives back most of, never on the week it gives nothing", () => {
    const credit = grant("g", T0 + 2 * HOUR, FABLE)
    const item = account([window("5h", 0.2, T0 + HOUR), window("7d:Fable", 0.12, T0 + HOUR, { weeklyUsed: 0 }), window("7d", 1, T0 + 3 * DAY)], [credit])
    expect(claimsOf(review([item]).events).map((reset) => reset.key)).toEqual([expiringKey("claude", "a", "5h", T0 + HOUR)])
    // Inside 30 minutes of that window's own reset: waited for.
    const soon = account([window("5h", 0.2, T0 + 20 * MINUTE), window("7d:Fable", 0.05, T0 + 20 * MINUTE, { weeklyUsed: 0 }), window("7d", 1, T0 + 3 * DAY)], [credit])
    expect(claimsOf(review([soon]).events)).toEqual([])
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

  test("an older pool's question, still recorded, is never worked: nothing is claimed from it, and it is forgotten in time", () => {
    const first = review([spent()])
    const [due] = claimsOf(first.events)
    const asked: ResetsState = { ...first.state, resets: { [due!.key]: { ...due!, stage: "asked", why: "offer" } } }
    expect(claimsOf(review([spent(T0 + RETRY_MS)], T0 + RETRY_MS, asked).events)).toEqual([])
    const later = T0 + 8 * DAY
    expect(review([], later, asked).events).toEqual([ResetsForgotten.make({ keys: [due!.key] })])
  })
})

describe("B1 across pools and hosts: an account is its login, and a claim is judged again on the provider's reading", () => {
  /** A pool `id` listing `accounts`, the same logins as another pool may. */
  const pool = (id: string, accounts: ReadonlyArray<AccountStatus>, provider: "claude" | "codex" = "claude", inflight = 0): PoolView => ({ ...view(accounts, {}, provider, inflight), id })

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
        [T0, Review.make({ pools: ids.map((id) => pool(id, [account([window("7d", 1, T0 + 3 * DAY)], [grant("c", T0 + 20 * DAY, { count: 2 })])], "codex", 6)) })],
      ])
      expect(claimsOf(codex.events), `codex ${ids.join(" then ")}`).toHaveLength(1)
    }
  })

  test("one login listed by two pools with a start waiting in each: one claim for the held work, not one per pool", () => {
    const item = account([window("5h", 0.2, T0 + 3 * HOUR), window("7d", 1, T0 + 4 * DAY)], [grant("w", T0 + 60 * DAY, { ...WEEKLY, count: 2 })])
    const { events } = run([
      [T0, NoteWait.make({ pool: "pool-a", sessionID: "ses_a" })],
      [T0, NoteWait.make({ pool: "pool-b", sessionID: "ses_b" })],
      [T0, Review.make({ pools: [pool("pool-a", [item], "claude", 6), pool("pool-b", [item], "claude", 6)] })],
    ])
    expect(claimsOf(events)).toHaveLength(1)
  })

  test("two hosts reading one account apart (windows ranked otherwise, the same grants listed in another order) decide one request id, per kind; not the guard: the spend authority is the fleet's lease (spend-authority.test.ts)", () => {
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

describe("auto: false, the owner's kill switch", () => {
  test("claims nothing on its own, Claude's or Codex's, expiring or for held work (a push's approved resets still go: push.test.ts)", () => {
    const expiring = account([window("7d", 1, T0 + 3 * DAY)], [grant("g", T0 + 2 * HOUR, WEEKLY)])
    expect(claimsOf(review([expiring], T0, Resets.initial, false).events)).toEqual([])
    expect(claimsOf(review([expiring], T0, Resets.initial, true).events)).toHaveLength(1)
    // Codex: every account held and a start waiting, with work running, claims a credit unless auto is off.
    const codex = view([{ ...account([window("7d", 1, T0 + 3 * DAY)], [{ id: "c", count: 2, usable: true, status: "available", expiresAt: T0 + 20 * DAY }]), credentialID: "x" }], {}, "codex", 6)
    for (const auto of [true, false]) {
      const { events } = run([
        [T0, NoteWait.make({ pool: "openai", sessionID: "ses_root" })],
        [T0, Review.make({ pools: [codex], auto })],
      ])
      expect(claimsOf(events).length, `auto ${auto}`).toBe(auto ? 1 : 0)
      expect(events.filter((event) => event._tag === "ClaimWeighed"), `auto ${auto}`).toEqual([])
    }
  })
})

describe("a claim sent is remembered across a restart (claimOut)", () => {
  test("no claim of the provider goes out on a reading taken before SETTLE_MS after one this host sent: on the account, or for a peer's ask, any; another account or provider may", () => {
    const { state } = run([[T0, Review.make({ pools: [view([account([window("5h", 1, T0 + 4 * HOUR), window("7d", 1, T0 + 3 * DAY)], [grant("g1", T0 + 2 * HOUR, FULL)])])] })]])
    const key = Object.keys(state.resets)[0]!
    const sent = run([[T0 + 10, NoteSend.make({ key })]], state)
    expect(sent.events).toEqual([{ _tag: "ClaimSent", key, at: T0 + 10 }])
    expect(claimOut(sent.state, "claude", T0 + 10 + SETTLE_MS - 1)).toContain("may not show yet")
    expect(claimOut(sent.state, "claude", T0 + 10 + SETTLE_MS)).toBeUndefined()
    expect(claimOut(sent.state, "codex", T0 + 11)).toBeUndefined()
    expect(claimOut(sent.state, "claude", T0 + 11, "a")).toContain("may not show yet")
    expect(claimOut(sent.state, "claude", T0 + 11, "b")).toBeUndefined()
    // Settled, it is still remembered.
    const settled = run([[T0 + 20, SettleClaim.make({ key, outcome: "reset", before: [] })]], sent.state)
    expect(claimOut(settled.state, "claude", T0 + 30)).toContain("may not show yet")
    // A claim not claiming is not marked sent.
    expect(run([[T0 + 30, NoteSend.make({ key })]], settled.state).events).toEqual([])
  })
})

test("EXPIRING_MS is the last day", () => expect(EXPIRING_MS).toBe(DAY))
