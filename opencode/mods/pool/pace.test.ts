// The pool's pace: whether a new agent may start now, from its accounts' readings.
import { expect, test } from "bun:test"
import { dispatchPace, eligibleFor, NO_INFLIGHT, poolPace } from "./pace.ts"
import type { AccountStatus } from "./status.ts"
const now = Date.parse("2026-11-04T15:00:00Z")
const day = 86400000
const account = (used: number, reset = now + 3.5 * day): AccountStatus => ({ credentialID: "a", live: 1, load: 0, noRoom: false, reading: { at: now, windows: [{ name: "7d", utilization: used, resetAt: reset }, { name: "5h", utilization: 0.1, resetAt: now + 3600000 }] } })

test("weekly pace holds ahead-of-time use and opens once the pool catches up", () => {
  // Half the week: 49.5% target plus 5 percentage points of leeway.
  const held = poolPace([account(0.7)], now)
  expect(held.ok).toBe(false)
  expect(held.reason).toContain("weekly pace")
  expect(held.retryAt).toBeGreaterThan(now)
  expect(poolPace([account(0.7)], held.retryAt ?? Number.NaN).ok).toBe(true)
  expect(poolPace([account(0.5)], now).ok).toBe(true)
})
test("it pools accounts, honors short-window holds and never treats a reset reading as spent", () => {
  expect(poolPace([account(0.7), { ...account(0.2), credentialID: "b" }], now).ok).toBe(true)
  const held = { ...account(0.2), hold: { kind: "rate-limit" as const, at: now, until: now + 10000 } }
  expect(poolPace([held], now)).toMatchObject({ ok: false, retryAt: now + 10000 })
  expect(poolPace([account(1, now - 1)], now).ok).toBe(true)
  expect(poolPace([], now)).toMatchObject({ ok: true, measured: false })
})
test("a model's own weekly window holds only that model's starts; the main windows hold every start", () => {
  const fable = (used: number, scoped: number, five = 0.1): AccountStatus => ({
    ...account(used),
    reading: {
      at: now,
      windows: [
        { name: "7d", utilization: used, resetAt: now + 3.5 * day },
        { name: "5h", utilization: five, resetAt: now + 3600000 },
        { name: "7d:Fable", utilization: scoped, resetAt: now + 2 * day },
      ],
    },
  })
  // Fable's week spent: an Opus start (or one naming no model) goes ahead...
  expect(poolPace([fable(0.3, 1)], now).ok).toBe(true)
  expect(poolPace([fable(0.3, 1)], now, undefined, "claude-opus-5-5").ok).toBe(true)
  // ...a Fable start waits for Fable's reset.
  expect(poolPace([fable(0.3, 1)], now, undefined, "claude-fable-5-2")).toMatchObject({ ok: false, measured: true, retryAt: now + 2 * day })
  // Another account with Fable room takes the start.
  expect(poolPace([fable(0.3, 1), { ...fable(0.3, 0.4), credentialID: "b" }], now, undefined, "claude-fable-5-2").ok).toBe(true)
  // Fable spends the main windows too: a full 5-hour window or a held account holds a Fable start with room of its own.
  expect(poolPace([fable(0.3, 0.2, 0.95)], now, undefined, "claude-fable-5-2")).toMatchObject({ ok: false, retryAt: now + 3600000 })
  const held = { ...fable(0.3, 0.2), hold: { kind: "rate-limit" as const, at: now, until: now + 10000 } }
  expect(poolPace([held], now, undefined, "claude-fable-5-2")).toMatchObject({ ok: false, retryAt: now + 10000 })
  // A Fable window that has reset holds nothing.
  expect(poolPace([fable(0.3, 1)], now + 2 * day, undefined, "claude-fable-5-2").ok).toBe(true)
})
test("agents started in the fleet count until they settle, so a wave holds the next start before the readings show it", () => {
  const minute = 60000
  const inflight = (starts: ReadonlyArray<number>) => ({ starts, cost: 0.005, settleMs: 10 * minute })
  // 54% read against 54.5% allowed: room for one start, not for two.
  expect(poolPace([account(0.54)], now, inflight([now - minute])).ok).toBe(true)
  const held = poolPace([account(0.54)], now, inflight([now - 3 * minute, now - minute]))
  expect(held).toMatchObject({ ok: false, measured: true })
  expect(held.reason).toBe(
    "the pool's weekly pace is over: its 1 account's week is at 54.0% used of 100%, plus 1.0% of the week counted for 2 agents started in the last 10 min; " +
      "the spend-evenly line is 54.5% used of 100% now, and the start holds past it",
  )
  // It opens when the older start settles, not later: by then its spend is in the readings.
  expect(held.retryAt).toBe(now + 7 * minute + 1)
  // Without readings the starts cannot be weighed: the pace stays unmeasured and open.
  expect(poolPace([{ ...account(0.54), reading: { at: now, windows: [] } }], now, inflight([now, now, now]))).toMatchObject({ ok: true, measured: false })
})

test("admission, as a property over boundary partitions of 5h, week and a model's own week, both models and an unknown reset: one rule for the pace and the eligible accounts, against an independent oracle", () => {
  // The even line at the explicit midweek clock: 0.99 × 3.5/7 + 0.05 = 0.545.
  const LINE = 0.545
  const near = (edge: number) => [edge - 1e-6, edge, edge + 1e-6]
  const fives = [0, ...near(0.9), 1]
  const weeks = [0, ...near(LINE), ...near(0.99), 1]
  const owns = [0, ...near(1)]
  const models = ["claude-opus-5-5", "claude-fable-5-2"] as const
  // A model's own week with its reset known, or unknown (a reading that names none).
  const ownWindows = (own: number) => [
    { label: "known", window: { name: "7d:Fable", utilization: own, resetAt: now + 2 * day } },
    { label: "unknown", window: { name: "7d:Fable", utilization: own } },
  ]
  const cases = fives.flatMap((five) =>
    weeks.flatMap((week) => owns.flatMap((own) => models.flatMap((model) => ownWindows(own).map((scoped) => ({ five, week, own, model, scoped }))))),
  )
  for (const { five, week, own, model, scoped } of cases) {
    const read: AccountStatus = {
      credentialID: "a",
      live: 0,
      load: 0,
      noRoom: false,
      reading: {
        at: now,
        windows: [{ name: "5h", utilization: five, resetAt: now + 3600000 }, { name: "7d", utilization: week, resetAt: now + 3.5 * day }, scoped.window],
      },
    }
    // The oracle, written from the rule's words, not its code: a window of the model's own at 100% with a
    // known reset holds that model; 5h at 90% or the week at 99% holds every model; past the even line holds softly.
    const ownHolds = model === "claude-fable-5-2" && own >= 1 && scoped.label === "known"
    const hard = ownHolds || five >= 0.9 || week >= 0.99
    const soft = !hard && week > LINE + 1e-9
    const pace = poolPace([read], now, NO_INFLIGHT, model)
    expect(
      { ok: pace.ok, measured: pace.measured, soft: pace.soft === true, held: pace.admission === "held", opens: pace.ok || pace.retryAt! > now, eligible: eligibleFor([read], now, model).length },
      `5h ${five}, week ${week}, Fable ${own} (reset ${scoped.label}), ${model}`,
    ).toEqual({ ok: !hard && !soft, measured: true, soft, held: hard || soft, opens: true, eligible: Number(!hard) })
    expect(pace.admission).toBeOneOf(["held", "ordinary"])
  }
  expect(cases).toHaveLength(fives.length * weeks.length * owns.length * models.length * 2)
})

test("a claim's observed rebase admits as backed room, bounded by the week observed after it; a reset in hand adds none", () => {
  const resetAt = now + 3.5 * day
  const at = (used: number) => account(used, resetAt)
  const opus = "claude-opus-5-5"
  // At 70%, past the 54.5% even line: held, a reset in hand or not (the plan carries none).
  expect(poolPace([at(0.7)], now, NO_INFLIGHT, opus, {})).toMatchObject({ ok: false, soft: true, admission: "held" })
  // Claimed an hour ago, observed at 66% after it: the line starts again there, so 70% is room the claim gave back.
  const rebased = { a: { rebase: { at: now - 3600000, from: 0.66 } } }
  expect(poolPace([at(0.7)], now, NO_INFLIGHT, opus, rebased)).toMatchObject({ ok: true, admission: "backed" })
  // Spending past what it gave back holds again.
  expect(poolPace([at(0.72)], now, NO_INFLIGHT, opus, rebased)).toMatchObject({ ok: false, soft: true, admission: "held" })
  // Under the even line the room is ordinary, whatever the plan.
  expect(poolPace([at(0.5)], now, NO_INFLIGHT, opus, rebased)).toMatchObject({ ok: true, admission: "ordinary" })
})
test("a dispatch takes no invalid week, and no absent or stale window of the model's own, as room", () => {
  const minute = 60000
  const fable = "claude-fable-5-2"
  /** An account read now; with `fable`, its Fable window too, read `fable` ms ago. */
  const read = (credentialID: string, weekReset: number, fable: ReadonlyArray<number> = []): AccountStatus => ({
    credentialID,
    live: 0,
    load: 0,
    noRoom: false,
    reading: {
      at: now,
      windows: [
        { name: "7d", utilization: 0.2, resetAt: weekReset },
        { name: "5h", utilization: 0.1, resetAt: now + 3600000 },
        ...fable.map((ago) => ({ name: "7d:Fable", utilization: 0.2, resetAt: now + 2 * day, at: now - ago })),
      ],
    },
  })
  // A week resetting more than 7 days ahead, or never: held with a reason and a time to ask again, never ordinary.
  for (const reset of [now + 9 * day, now - 1]) {
    const held = dispatchPace([read("a", reset)], now, {}, 0.04, "claude-opus-5-5")
    expect(held).toMatchObject({ ok: false, admission: "held", eligible: [], retryAt: now + minute })
    expect(held.reason).toContain("not within the next 7 days")
  }
  // Beside a valid account, the invalid one is never eligible.
  expect(dispatchPace([read("a", now + 9 * day), read("b", now + 3.5 * day)], now, {}, 0.04, "claude-opus-5-5")).toMatchObject({ ok: true, admission: "ordinary", eligible: ["b"] })
  // Fable's own window absent on one account where another reads one: that account is no Fable room; Opus is unaffected.
  const pair = [{ ...read("a", now + 3.5 * day, [0]), hold: { kind: "rate-limit" as const, at: now, until: now + 10000 } }, read("b", now + 3.5 * day)]
  const absent = dispatchPace(pair, now, {}, 0.04, fable)
  expect(absent).toMatchObject({ ok: false, eligible: [] })
  expect(absent.reason).toContain("no 7d:Fable window")
  expect(dispatchPace(pair, now, {}, 0.04, "claude-opus-5-5")).toMatchObject({ ok: true, eligible: ["b"] })
  // Stale (carried over 31 minutes): held; read 29 minutes ago: room.
  const stale = dispatchPace([read("a", now + 3.5 * day, [31 * minute])], now, {}, 0.04, fable)
  expect(stale).toMatchObject({ ok: false, eligible: [], retryAt: now + minute })
  expect(stale.reason).toContain("7d:Fable window was read more than 30 min ago")
  expect(dispatchPace([read("a", now + 3.5 * day, [29 * minute])], now, {}, 0.04, fable)).toMatchObject({ ok: true, admission: "ordinary", eligible: ["a"] })
})
