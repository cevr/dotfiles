// The pool's pace: whether a new agent may start now, from its accounts' readings.
import { expect, test } from "bun:test"
import { Array as Arr, Option } from "effect"
import { dispatchPace, eligibleFor, type HoldReason, NO_INFLIGHT, poolPace, RequestHeld, requestHeldMessage } from "./pace.ts"
import { carryOver, type QuotaReading } from "./quota.ts"
import type { AccountStatus } from "./status.ts"
const now = Date.parse("2026-11-04T15:00:00Z")
const day = 86400000
const minute = 60_000
const hour = 60 * minute
const account = (used: number, reset = now + 3.5 * day): AccountStatus => ({ credentialID: "a", live: 1, load: 0, noRoom: false, reading: { at: now, windows: [{ name: "7d", utilization: used, resetAt: reset }, { name: "5h", utilization: 0.1, resetAt: now + 3600000 }] } })

test("new launches cover their own estimate and frozen estimates of earlier launches", () => {
  const fresh = account(0.044, now + 7 * day)
  const quote = (starts: ReadonlyArray<number>, costs: ReadonlyArray<number>, nextCost: number) =>
    poolPace([fresh], now, { starts, costs, cost: 0.005, nextCost, settleMs: 10 * minute }, "claude-opus-5-5")
  expect(quote([], [], 0.005).ok).toBe(true)
  expect(quote([], [], 0.007)).toMatchObject({ ok: false, reasonCode: "even-line" })
  expect(quote([now], [0.005], 0.005)).toMatchObject({ ok: false, reasonCode: "even-line" })
  // A later, cheaper forecast does not reprice the launch already admitted.
  expect(quote([now], [0.006], 0.001)).toMatchObject({ ok: false, reasonCode: "even-line" })
})

test("orchestrator priority bypasses weekly pace and safety margins but keeps evidence and hard limits", () => {
  const send = (accounts: ReadonlyArray<AccountStatus>, model = "claude-opus-5-5") =>
    dispatchPace(accounts, now, {}, 0.005, model, { priority: true })
  for (const used of [0.75, 0.99, 0.999]) {
    const accounts = [account(used)]
    expect(dispatchPace(accounts, now, {}, 0.005, "claude-opus-5-5").ok).toBe(false)
    expect(send(accounts)).toMatchObject({ ok: true, eligible: ["a"], admission: "ordinary" })
  }
  expect(send([account(1)]).ok).toBe(false)
  expect(send([{ ...account(0.75), reading: { at: now, windows: [{ name: "5h", utilization: 1, resetAt: now + hour }, { name: "7d", utilization: 0.75, resetAt: now + day }] } }]).ok).toBe(false)
  expect(send([{ ...account(0.75), reading: { at: now, windows: [{ name: "7d", utilization: 0.75, resetAt: now + day }] } }]).ok).toBe(false)
  expect(send([{ ...account(0.75), hold: { kind: "signin", at: now, until: now + hour } }]).ok).toBe(false)
  expect(send([{ ...account(0.75), reading: { at: now, windows: [{ name: "5h", utilization: 0.1, resetAt: now + hour }, { name: "7d", utilization: 0.75, resetAt: now + day }, { name: "7d:Fable", utilization: 1, resetAt: now + day }] } }], "claude-fable-5-2").ok).toBe(false)
  expect(dispatchPace([account(0.75)], now, {}, 0.005, "claude-opus-5-5", { priority: true, auxiliary: "title" }).ok).toBe(false)
})

test("weekly-only admission needs fresh explicit absence, retains it through headers, and obeys a returning five-hour limit", () => {
  const weekly = { name: "7d", utilization: 0.2, resetAt: now + 3.5 * day }
  const absent: QuotaReading = { at: now, windows: [weekly], absent: [{ name: "5h", at: now }] }
  const dispatch = (reading: QuotaReading, at = now, model = "claude-opus-5-5") =>
    dispatchPace([{ ...account(0.2), reading }], at, {}, 0.04, model)
  expect(dispatch(absent)).toMatchObject({ ok: true, admission: "ordinary", eligible: ["a"] })
  // Partial headers preserve the proof's original age; they never renew it.
  const headers = (at: number): QuotaReading => ({ at, windows: [weekly], status: "allowed" })
  expect(dispatch(carryOver(absent, headers(now + minute)), now + minute).ok).toBe(true)
  expect(dispatch(carryOver(absent, headers(now + 31 * minute)), now + 31 * minute)).toMatchObject({ ok: false, reasonCode: "usage-unread" })
  expect(dispatch(headers(now))).toMatchObject({ ok: false, reasonCode: "usage-unread" })
  expect(dispatch({ ...absent, absent: [{ name: "5h", at: now + minute }] })).toMatchObject({ ok: false, reasonCode: "usage-unread" })
  // A returned limit applies immediately; partial headers cannot restore the retired exemption.
  const limited: QuotaReading = { at: now + minute, windows: [weekly, { name: "5h", utilization: 0.95, resetAt: now + hour }] }
  const returned = carryOver(absent, limited)
  expect(returned).not.toHaveProperty("absent")
  expect(dispatch(returned, now + minute)).toMatchObject({ ok: false, reasonCode: "quota-limit" })
  // REPORTED, then UNKNOWN (headers without it): the last reported window binds until its own reset.
  expect(dispatch(carryOver(returned, headers(now + 2 * minute)), now + 2 * minute)).toMatchObject({ ok: false, reasonCode: "quota-limit", retryAt: now + hour })
  // Another explicit removal retires the former limit, without inventing a zero-use window.
  const removedAgain = carryOver(returned, { ...absent, at: now + 2 * minute, absent: [{ name: "5h", at: now + 2 * minute }] })
  expect(removedAgain.windows).toEqual([weekly])
  expect(dispatch(removedAgain, now + 2 * minute).ok).toBe(true)
  expect(dispatch({ ...absent, windows: [{ ...weekly, utilization: 1 }] })).toMatchObject({ ok: false, reasonCode: "quota-limit" })
  expect(dispatch({ ...absent, windows: [{ ...weekly, utilization: 0.7 }] })).toMatchObject({ ok: false, reasonCode: "even-line" })
  expect(dispatch(absent, now, "claude-fable-5-2")).toMatchObject({ ok: false, reasonCode: "usage-unread" })
  expect(dispatch({ ...absent, windows: [weekly, { name: "7d:Fable", utilization: 0.1, resetAt: now + day }] }, now, "claude-fable-5-2").ok).toBe(true)
})

test("a dispatch needs the model's defined and learned windows through generated reading histories", () => {
  const scopes = [
    { model: "claude-fable-5-2", window: "7d:Fable", defined: true },
    { model: "claude-lyric-5", window: "7d:Lyric", defined: false },
  ]
  const present = { event: "present", use: Option.some(0.1) }
  const events = [present, { event: "absent", use: Option.none() }, { event: "failed", use: Option.none() }, { event: "spent", use: Option.some(1) }]
  const histories = Arr.cartesianWith(Arr.cartesian(events, events), events, ([a, b], c) => [a, b, c, present])
  const start = { ...NO_INFLIGHT, cost: 0.04 }
  for (const [{ model, window, defined }, history] of Arr.cartesian(scopes, histories)) {
    let reading = Option.none<QuotaReading>()
    let observed = Option.none<{ readonly at: number; readonly resetAt: number; readonly utilization: number }>()
    let usageReads = 0
    for (const [index, { event, use }] of history.entries()) {
      const at = now + index * 20 * minute
      const resetAt = at + 25 * minute
      if (Option.isSome(use)) observed = Option.some({ at, resetAt, utilization: use.value })
      // The base limits are supplied by recent response headers even when the usage endpoint fails.
      const short = { name: "5h", utilization: 0.1, resetAt: at + hour }
      const weekly = { name: "7d", utilization: 0.2, resetAt: now + 3 * day }
      const scoped = Option.toArray(Option.map(use, (utilization) => ({ name: window, utilization, resetAt })))
      const source: QuotaReading = { at, windows: [weekly, short, ...scoped] }
      const sample = Option.filter(Option.some({ at, samples: 1 as const }), () => event !== "failed")
      if (Option.isSome(sample)) usageReads += 1
      const incoming = Option.match(sample, { onNone: () => source, onSome: (usage) => ({ ...source, usage }) })
      const next = carryOver(Option.getOrUndefined(reading), incoming)
      const backed = carryOver(Option.getOrUndefined(reading), { ...incoming, windows: [{ ...weekly, utilization: 0.66 }, short, ...scoped] })
      reading = Option.some(next)
      const accounts = [{ ...account(0.2), reading: next }]
      const maySend = Option.match(observed, {
        onNone: () => !defined,
        onSome: (last) => at < last.resetAt && at - last.at <= 30 * minute && last.utilization < 1,
      })
      const context = `${model}: ${history.map((step) => step.event).join(", ")}, step ${index}`
      const outcome = dispatchPace(accounts, at, {}, 0.04, model)
      expect(outcome.ok, context).toBe(maySend)
      expect(poolPace(accounts, at, start, model), context).toEqual(outcome)
      const charged = { ...start, starts: [at - 1], settleMs: minute }
      expect(poolPace(accounts, at, charged, model), context).toEqual(dispatchPace(accounts, at, {}, 0.04, model, { inflight: charged }))
      const plans = { a: { rebase: { at: now - minute, from: 0.66, key: "owned" } } }
      const resetAccounts = [{ ...account(0.66), reading: backed }]
      const resetOutcome = dispatchPace(resetAccounts, at, plans, 0.04, model)
      expect(resetOutcome.ok, context).toBe(maySend)
      expect(poolPace(resetAccounts, at, start, model, plans), context).toEqual(resetOutcome)
      if (!outcome.ok) {
        const unsupported = defined && Option.isNone(observed) && usageReads >= 2
        if (unsupported) {
          expect(outcome).toMatchObject({ reasonCode: "model-unreported" })
          expect(outcome.reason).toContain("Use another model or login; time alone will not clear this hold")
        } else {
          expect(outcome.reasonCode).toBeOneOf(["usage-unread", "model-limit"])
          expect(outcome.retryAt).toBeGreaterThan(at)
        }
      }
      expect(dispatchPace(accounts, at, {}, 0.04, "claude-opus-5-5")).toMatchObject({ ok: true, eligible: ["a"] })
    }
  }
})

test("a past 5-hour reset needs a new reading, even with a fresh weekly window", () => {
  const read = (at: number, resetAt: number, utilization: number): AccountStatus => ({
    ...account(0.2),
    reading: { at, windows: [{ name: "7d", utilization: 0.2, resetAt: now + 3 * day }, { name: "5h", utilization, resetAt }] },
  })
  for (const reset of [now - 60_000, now]) {
    expect(dispatchPace([read(now, reset, 1)], now, {}, 0.04)).toMatchObject({ ok: false, eligible: [], retryAt: now + 60_000 })
  }
  expect(dispatchPace([read(now + 60_000, now + 30_000, 1)], now, {}, 0.04)).toMatchObject({ ok: false, eligible: [], retryAt: now + 60_000 })
  expect(dispatchPace([read(now, now + 60_000, 0)], now, {}, 0.04)).toMatchObject({ ok: true, eligible: ["a"] })
})

test("seed 10286377: a login that cannot be read until sign-in does not hide the pool's first usable remedy", () => {
  const model = "claude-fable-5-2"
  const scope = { name: "7d:Fable", utilization: 0.2, resetAt: now + day }
  const fresh = { at: now, windows: [
    { name: "7d", utilization: 0.2, resetAt: now + 3.5 * day },
    { name: "5h", utilization: 0.1, resetAt: now + hour },
  ] }
  const basis = { ...account(0.2), reading: fresh }
  const withScope = { ...fresh, windows: [...fresh.windows, scope] }
  const signin = { kind: "signin" as const, at: now - hour, until: now - minute }
  const states = ["signin", "unreported", "stale", "temporary"] as const
  type Blocker = typeof states[number]
  const blocked = (credentialID: string, state: Blocker, overlap: boolean): AccountStatus => {
    if (state === "signin") return { ...basis, credentialID, reading: { at: now - hour, windows: [], refusal: signin } }
    if (state === "unreported") {
      const at = Option.getOrElse(Option.filter(Option.some(now - hour), () => overlap), () => now)
      return { ...basis, credentialID, reading: { ...fresh, at, usage: { at, samples: 2 } } }
    }
    if (state === "temporary") return { ...basis, credentialID, reading: withScope, hold: { kind: "rate-limit", at: now, until: now + minute } }
    return { ...basis, credentialID, reading: { ...withScope, at: now - hour } }
  }
  for (const [[left, right], overlap] of Arr.cartesian(Arr.cartesian(states, states), [false, true])) {
    const facts = [left, right]
    const candidates = facts.map((state, i) => blocked(String(i), state, overlap))
    const dispatch = (accounts: ReadonlyArray<AccountStatus>, at = now, selected = model) => dispatchPace(accounts, at, {}, 0.04, selected)
    const answer = dispatch(candidates)
    expect(poolPace(candidates, now, { ...NO_INFLIGHT, cost: 0.04 }, model)).toEqual(answer)
    expect(answer.ok).toBe(false)
    if (answer.ok) continue
    // Independent oracle: a good refresh or elapsed hold is a no-action way
    // forward. If neither exists, a different model or a sign-in is necessary.
    const first = Arr.findFirst(["stale", "temporary", "unreported", "signin"] as const, (state) => facts.includes(state))
    if (Option.isNone(first)) continue
    const reason = { stale: "usage-unread", temporary: "account-held", unreported: "model-unreported", signin: "account-held" } as const satisfies Record<Blocker, HoldReason>
    expect(answer.reasonCode).toBe(reason[first.value])
    if (first.value === "unreported" || first.value === "signin") {
      expect(answer.reason).toMatch(/time alone will not clear|Sign in/)
      const unchanged = dispatch(candidates, answer.retryAt)
      expect(unchanged).toMatchObject({ ok: false, reasonCode: answer.reasonCode })
    }
    const fixed = facts.indexOf(first.value)
    const remedied = candidates.map((item, i) => {
      if (i !== fixed) return item
      if (first.value === "stale") return { ...item, reading: withScope }
      // Sign-in alone removes the refusal, not the independent lack of quota
      // evidence: the next reason must say to read the newly usable account.
      if (first.value === "signin") return { ...item, reading: { at: now, windows: [] } }
      return item
    })
    if (first.value === "signin") {
      expect(answer.signIn).toEqual(["0", "1"])
      expect(dispatch(remedied)).toMatchObject({ ok: false, reasonCode: "usage-unread" })
      const authenticated = candidates.map((item, i) => {
        if (i === fixed) return { ...item, reading: withScope }
        return item
      })
      expect(dispatch(authenticated)).toMatchObject({ ok: true, eligible: [String(fixed)] })
    }
    if (first.value === "unreported") {
      const next = dispatch(remedied, now, "claude-opus-5-5")
      if (overlap) expect(next).toMatchObject({ ok: false, reasonCode: "usage-unread" })
      else expect(next.ok).toBe(true)
    }
    if (first.value === "stale") expect(dispatch(remedied)).toMatchObject({ ok: true, eligible: [String(fixed)] })
    if (first.value === "temporary") expect(dispatch(remedied, answer.retryAt)).toMatchObject({ ok: true, eligible: expect.arrayContaining([String(fixed)]) })
  }
  const absent = dispatchPace([], now, {}, 0.04, model)
  expect(absent).toMatchObject({ ok: false, reasonCode: "logins-unavailable", reason: expect.stringContaining("add or restore a login") })
  expect(dispatchPace([basis], now, {}, 0.04, "claude-opus-5-5").ok).toBe(true)
})

test("the closed set of pace holds names what must change, and opens when it does", () => {
  const opus = "claude-opus-5-5"
  const fable = "claude-fable-5-2"
  const start = { ...NO_INFLIGHT, cost: 0.04 }
  const waysBack = {
    "account-held": "all pool accounts are held",
    "model-limit": "the first resets",
    "quota-limit": "the first resets",
    "even-line": "spend-evenly line",
    "usage-unread": "no reading",
    "model-unreported": "Use another model or login; time alone will not clear this hold",
    "reset-room": "room from a claimed reset",
    "auxiliary": "does not spend the room a claimed reset gave back",
  } satisfies Record<Exclude<HoldReason, "logins-unavailable" | "placement-changed" | "store-unavailable" | "record-unreadable" | "fleet-busy" | "fleet-unavailable">, string>
  const observed = new Set<string>()
  for (const [offset, span] of Arr.cartesian([0, minute, 5 * minute], [15 * minute, hour, 2 * hour])) {
    const at = now + offset
    const shortReset = at + span
    const weekReset = at + 3.5 * day
    const read = (time: number, week: number, short: number, scoped: ReadonlyArray<number> = []): AccountStatus => ({
      ...account(week),
      reading: {
        at: time,
        usage: { at: time, samples: 2 },
        windows: [
          { name: "7d", utilization: week, resetAt: weekReset },
          { name: "5h", utilization: short, resetAt: time + span },
          ...scoped.map((utilization) => ({ name: "7d:Fable", utilization, resetAt: time + day })),
        ],
      },
    })
    const check = (
      state: AccountStatus, code: keyof typeof waysBack, model: string,
      plans: Parameters<typeof poolPace>[4] = {},
      policy: Parameters<typeof dispatchPace>[5] = {},
    ) => {
      const held = dispatchPace([state], at, plans, start.cost, model, policy)
      expect(poolPace([state], at, start, model, plans, policy)).toEqual(held)
      expect(held).toMatchObject({ ok: false, reasonCode: code, eligible: [] })
      if (held.ok) return at
      observed.add(held.reasonCode)
      expect(held.reason).toContain(waysBack[code])
      expect(held.retryAt).toBeGreaterThan(at)
      return held.retryAt
    }
    const hold = { kind: "rate-limit" as const, at, until: shortReset }
    expect(check({ ...read(at, 0.2, 0.2), hold }, "account-held", opus)).toBe(shortReset)
    expect(check(read(at, 0.2, 1), "quota-limit", opus)).toBe(shortReset)
    expect(dispatchPace([read(shortReset, 0.2, 0)], shortReset, {}, start.cost, opus).ok).toBe(true)
    const modelReset = check(read(at, 0.2, 0.2, [1]), "model-limit", fable)
    expect(dispatchPace([read(modelReset, 0.2, 0.2, [0])], modelReset, {}, start.cost, fable).ok).toBe(true)
    const refresh = check({ credentialID: "a", live: 0, load: 0, noRoom: false }, "usage-unread", opus)
    expect(dispatchPace([read(refresh, 0.2, 0.2)], refresh, {}, start.cost, opus).ok).toBe(true)
    const unreported = check(read(at, 0.2, 0.2), "model-unreported", fable)
    expect(unreported).toBe(at + minute)
    expect(dispatchPace([read(unreported, 0.2, 0.2)], unreported, {}, start.cost, fable)).toMatchObject({ ok: false, reasonCode: "model-unreported" })
    expect(dispatchPace([read(at, 0.2, 0.2)], at, {}, start.cost, opus).ok).toBe(true)
    expect(dispatchPace([read(unreported, 0.2, 0.2, [0.1])], unreported, {}, start.cost, fable).ok).toBe(true)
    const ordinary = check(read(at, 0.7, 0.2), "even-line", opus)
    expect(dispatchPace([read(ordinary, 0.7, 0.2)], ordinary, {}, start.cost, opus).admission).toBe("ordinary")
    const plans = { a: { rebase: { at, from: 0.68, key: "owned" } } }
    const backing = check(read(at, 0.7, 0.2), "reset-room", opus, plans)
    expect(dispatchPace([read(backing, 0.7, 0.2)], backing, plans, start.cost, opus).admission).toBe("backed")
    const auxiliary = { auxiliary: "title" as const }
    const title = check(read(at, 0.7, 0.2), "auxiliary", opus, plans, auxiliary)
    expect(dispatchPace([read(title, 0.7, 0.2)], title, plans, start.cost, opus, auxiliary).admission).toBe("ordinary")
  }
  expect(observed).toEqual(new Set(Object.keys(waysBack)))
})

test("each held dispatch in a generated history states a future time, and re-evaluates at it", () => {
  const timings = Arr.cartesian([hour, 2 * hour, 4 * hour], [0.58, 0.64, 0.72, 0.83])
  const usage = Arr.cartesian([0.2, 0.95, 1], [0, 0.02, 0.05])
  for (const [[resetIn, weekly], [short, spent]] of Arr.cartesian(timings, usage)) {
    let at = now
    const shortReset = now + resetIn
    const weekReset = now + 3.5 * day
    const plan = { a: { rebase: { at: now - hour, from: weekly - 0.01, spent } } }
    const read = (credentialID: string, use: number, five: number): AccountStatus => {
      let week = { name: "7d", utilization: use, resetAt: weekReset }
      let session = { name: "5h", utilization: five, resetAt: shortReset }
      if (at >= weekReset) week = { ...week, utilization: 0, resetAt: weekReset + 7 * day }
      if (at >= shortReset) session = { ...session, utilization: 0, resetAt: at + 5 * hour }
      return { ...account(use), credentialID, reading: { at, windows: [week, session] } }
    }
    for (let step = 0; step < 6; step++) {
      const plans = Option.getOrElse(Option.filter(Option.some(plan), () => at < weekReset), () => ({}))
      const answer = dispatchPace([read("a", weekly, short), read("b", 0.58, 0.2)], at, plans, 0.04)
      if (step === 0 && weekly === 0.58 && short === 0.95 && spent === 0)
        expect(answer).toMatchObject({ ok: false, retryAt: shortReset })
      if (answer.ok) break
      expect(answer.reason).not.toBe("")
      expect(Number.isFinite(answer.retryAt)).toBe(true)
      expect(answer.retryAt).toBeGreaterThan(at)
      at = answer.retryAt
    }
  }
})

test("a title waits for ordinary room, and its hold names that catch-up time", () => {
  // Single healthy login. 70% spent, 54.5% even line, 72% on a claim.
  const accounts = [account(0.7)]
  const plans = { a: { rebase: { at: now, from: 0.68 } } }
  expect(dispatchPace(accounts, now, plans, 0.02)).toMatchObject({ ok: true, admission: "backed" })
  const title = dispatchPace(accounts, now, plans, 0.02, "claude-opus-5-5", { auxiliary: "title" })
  expect(title.ok).toBe(false)
  if (title.ok) return
  const catchUp = now + Math.ceil((0.7 - 0.545) * 7 * day / 0.99) + 1
  expect(Number(title.retryAt)).toBe(catchUp)
  expect(requestHeldMessage(new RequestHeld({ sessionID: "title-fixture", reason: title.reason, reasonCode: title.reasonCode, retryAt: title.retryAt })))
    .toContain("a title request does not spend the room a claimed reset gave back; it may go again at Nov 5, 2026, 12:18:11 PM EST")
})

test("a push lifts the even line, not a model's required evidence or spent windows", () => {
  const model = "claude-fable-5-2"
  const fable = (id: string, used: number): AccountStatus => {
    const item = account(0.7)
    const windows = Option.match(Option.fromUndefinedOr(item.reading), { onNone: () => [], onSome: (reading) => reading.windows })
    return {
      ...item,
      credentialID: id,
      reading: { at: now, windows: [...windows, { name: "7d:Fable", utilization: used, resetAt: now + day }] },
    }
  }
  const accounts = [account(0.2), fable("b", 1), fable("c", 0.1)]
  expect(dispatchPace(accounts, now, {}, 0.04, model)).toMatchObject({ ok: false, eligible: [] })
  expect(dispatchPace(accounts, now, {}, 0.04, model, { liftEvenLine: true })).toMatchObject({ ok: true, eligible: ["c"] })
})

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
  const fable = (used: number, scoped: number, five = 0.1, observed = now): AccountStatus => ({
    ...account(used),
    reading: {
      at: observed,
      windows: [
        { name: "7d", utilization: used, resetAt: now + 3.5 * day },
        { name: "5h", utilization: five, resetAt: observed + hour },
        { name: "7d:Fable", utilization: scoped, resetAt: observed + 2 * day },
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
  // Rollover without fresh evidence cannot start the model, just as it cannot send a request.
  expect(poolPace([fable(0.3, 1)], now + 2 * day, NO_INFLIGHT, "claude-fable-5-2")).toMatchObject({ ok: false, reasonCode: "usage-unread" })
  expect(poolPace([fable(0.3, 0.1, 0.1, now + 2 * day)], now + 2 * day, undefined, "claude-fable-5-2").ok).toBe(true)
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
  expect(Number(held.retryAt)).toBe(now + 7 * minute + 1)
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
    // A model's unknown reset is not evidence. Else its own 100% holds that model,
    // the 5h at 90% or the week at 99% holds every model, and past the even line holds softly.
    const unread = model === "claude-fable-5-2" && scoped.label === "unknown"
    const ownHolds = model === "claude-fable-5-2" && own >= 1 && scoped.label === "known"
    const hard = ownHolds || five >= 0.9 || week >= 0.99
    const soft = !unread && !hard && week > LINE + 1e-9
    const pace = poolPace([read], now, NO_INFLIGHT, model)
    expect(
      { ok: pace.ok, measured: pace.measured, soft: pace.soft === true, held: pace.admission === "held", opens: pace.ok || pace.retryAt! > now, eligible: eligibleFor([read], now, model).length },
      `5h ${five}, week ${week}, Fable ${own} (reset ${scoped.label}), ${model}`,
    ).toEqual({ ok: !unread && !hard && !soft, measured: !unread, soft, held: unread || hard || soft, opens: true, eligible: Number(!hard) })
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
