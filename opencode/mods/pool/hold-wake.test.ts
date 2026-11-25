import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import {
  appendSubagentNote,
  decide,
  Decision,
  delivered,
  dueAt,
  failed,
  heldUntil,
  MAX_WAKE_FAILURES,
  needsCheck,
  retryDelay,
  sameHold,
  type SessionRole,
  SUBAGENT_RESUME_NOTE,
  WAKE_RETRY_MAX_MS,
  WAKE_RETRY_MS,
  wakeDeliveryId,
} from "./hold-wake.ts"
import { HoldReason, type WirePace } from "./pace.ts"
import { HeldSend } from "./refuse.ts"

const BASE = 1_700_000_000_000
const MINUTE = 60_000
const RETRY = BASE + 10 * MINUTE
const RECHECK = RETRY + 5 * MINUTE

const SESSIONS: ReadonlyArray<SessionRole> = ["subagent", "root", "gone"]
const CLOCKS: ReadonlyArray<readonly [string, number]> = [
  ["before", RETRY - 1],
  ["at", RETRY],
  ["between", RETRY + 2 * MINUTE],
  ["at-recheck", RECHECK],
  ["after", RECHECK + 2 * MINUTE],
]
const MODELS: ReadonlyArray<Option.Option<string>> = [Option.none(), Option.some("claude-opus-4-6")]
const WOKEN: ReadonlyArray<Option.Option<number>> = [Option.none(), Option.some(RETRY)]
const STEPS: ReadonlyArray<Option.Option<string>> = [Option.none(), Option.some("step_1")]
const RECHECKS: ReadonlyArray<Option.Option<number>> = [Option.none(), Option.some(RECHECK)]
const FAILURES: ReadonlyArray<Option.Option<number>> = [Option.none(), Option.some(1), Option.some(MAX_WAKE_FAILURES - 1), Option.some(MAX_WAKE_FAILURES)]

const pacesAt = (now: number): ReadonlyArray<readonly [string, Option.Option<WirePace>]> => [
  ["none", Option.none()],
  ["admit-measured", Option.some<WirePace>({ ok: true, measured: true, reason: "within pace" })],
  ["admit-unmeasured", Option.some<WirePace>({ ok: true, measured: false, reason: "no weekly window" })],
  ["held-future", Option.some<WirePace>({ ok: false, measured: true, reason: "still held", reasonCode: "account-held", retryAt: now + 5 * MINUTE })],
  ["held-stale", Option.some<WirePace>({ ok: false, measured: true, reason: "stale time", reasonCode: "quota-limit", retryAt: now })],
]

const optional = <K extends string, A>(key: K, value: Option.Option<A>) =>
  Option.match(value, { onNone: () => ({}), onSome: (present) => ({ [key]: present }) as Record<K, A> })

interface Shape {
  readonly reasonCode: HoldReason
  readonly model: Option.Option<string>
  readonly wokenAt: Option.Option<number>
  readonly stepID: Option.Option<string>
  readonly recheckAt: Option.Option<number>
  readonly wakeFailures: Option.Option<number>
}

const makeRow = (shape: Shape): HeldSend =>
  HeldSend.make({
    sessionID: "ses_child",
    providerID: "anthropic",
    reasonCode: shape.reasonCode,
    retryAt: RETRY,
    ...optional("model", shape.model),
    ...optional("wokenAt", shape.wokenAt),
    ...optional("stepID", shape.stepID),
    ...optional("recheckAt", shape.recheckAt),
    ...optional("wakeFailures", shape.wakeFailures),
  })

/** The decision as the rules state it, from the shape the row was built from (not from the row's own fields). */
const expectedDecision = (shape: Shape, session: SessionRole, now: number, pace: Option.Option<WirePace>): string => {
  if (Option.isSome(shape.wokenAt) || Option.isSome(shape.stepID) || Option.isNone(shape.model)) return "Drop"
  if (Option.exists(shape.wakeFailures, (count) => count >= MAX_WAKE_FAILURES) || session !== "subagent") return "Drop"
  const due = Option.getOrElse(shape.recheckAt, () => RETRY)
  if (now < due || Option.isNone(pace)) return "Wait"
  return pace.value.ok ? "Wake" : "Hold"
}

describe("hold-wake decision domain", () => {
  test("enumerates the entire input domain: reason, model, woken, Step, recheck, failures, session, clock and pace", () => {
    let checked = 0
    for (const reasonCode of HoldReason.literals)
      for (const model of MODELS)
        for (const wokenAt of WOKEN)
          for (const stepID of STEPS)
            for (const recheckAt of RECHECKS)
              for (const wakeFailures of FAILURES) {
                const shape = { reasonCode, model, wokenAt, stepID, recheckAt, wakeFailures }
                const row = makeRow(shape)
                for (const session of SESSIONS)
                  for (const [clockName, now] of CLOCKS)
                    for (const [paceName, pace] of pacesAt(now)) {
                      checked += 1
                      const actual = decide({ row, session, now, pace })
                      const label = `${reasonCode}/model=${Option.isSome(model)}/woken=${Option.isSome(wokenAt)}/step=${Option.isSome(stepID)}/recheck=${Option.isSome(recheckAt)}/failures=${Option.getOrElse(wakeFailures, () => 0)}/${clockName}/${session}/${paceName}`
                      expect([label, actual._tag]).toEqual([label, expectedDecision(shape, session, now, pace)])
                      // A wake carries the hold's one id; a recheck is strictly later than now.
                      if (Decision.guards.Wake(actual)) expect([label, actual.id]).toEqual([label, wakeDeliveryId("ses_child", RETRY)])
                      if (Decision.guards.Hold(actual)) expect([label, actual.recheckAt > now]).toEqual([label, true])
                      // needsCheck is false only where no Wake or Hold can come.
                      if (!needsCheck(row, now)) expect([label, Decision.guards.Wake(actual) || Decision.guards.Hold(actual)]).toEqual([label, false])
                    }
              }
    expect(checked).toBe(
      HoldReason.literals.length * MODELS.length * WOKEN.length * STEPS.length * RECHECKS.length * FAILURES.length * SESSIONS.length * CLOCKS.length * 5,
    )
  })

  test("a row only this pool wrote has a due time: no model, woken, a Step's, or out of attempts never wakes", () => {
    const row = makeRow({ reasonCode: "account-held", model: Option.some("m"), wokenAt: Option.none(), stepID: Option.none(), recheckAt: Option.none(), wakeFailures: Option.none() })
    expect(dueAt(row)).toEqual(Option.some(RETRY))
    const { model: _model, ...legacy } = row
    expect(dueAt(HeldSend.make(legacy))).toEqual(Option.none())
    expect(dueAt({ ...row, recheckAt: RECHECK })).toEqual(Option.some(RECHECK))
    // A recheck never moves the due time before the hold's own time.
    expect(dueAt({ ...row, recheckAt: RETRY - MINUTE })).toEqual(Option.some(RETRY))
    expect(heldUntil({ ...row, recheckAt: RECHECK })).toBe(RECHECK)
    expect(heldUntil(row)).toBe(RETRY)
  })
})

describe("what the row records", () => {
  const row = makeRow({ reasonCode: "account-held", model: Option.some("m"), wokenAt: Option.none(), stepID: Option.none(), recheckAt: Option.none(), wakeFailures: Option.none() })

  test("a delivery marks it woken and keeps the hold's time and id", () => {
    const after = delivered(row, RETRY + 1)
    expect(after).toEqual({ ...row, wokenAt: RETRY + 1 })
    expect(sameHold(row, after)).toBe(true)
    expect(dueAt(after)).toEqual(Option.none())
  })

  test("each failed delivery counts and backs off, bounded, and the hold's id never changes", () => {
    let current: HeldSend = row
    let now = RETRY
    const waits: Array<number> = []
    for (let attempt = 1; attempt <= MAX_WAKE_FAILURES; attempt += 1) {
      const decision = decide({ row: current, session: "subagent", now, pace: Option.some<WirePace>({ ok: true, measured: true, reason: "ok" }) })
      expect(decision).toEqual(Decision.cases.Wake.make({ id: wakeDeliveryId("ses_child", RETRY) }))
      current = failed(current, now)
      expect(current.wakeFailures).toBe(attempt)
      expect(current.retryAt).toBe(RETRY)
      waits.push(Option.getOrThrow(dueAt(current).pipe(Option.orElse(() => Option.some(now)))) - now)
      now = Option.getOrElse(dueAt(current), () => now)
    }
    expect(dueAt(current)).toEqual(Option.none())
    expect(waits.slice(0, -1)).toEqual(Array.from({ length: MAX_WAKE_FAILURES - 1 }, (_, index) => retryDelay(index + 1)))
    expect(retryDelay(1)).toBe(WAKE_RETRY_MS)
    expect(retryDelay(2)).toBe(2 * WAKE_RETRY_MS)
    expect(retryDelay(MAX_WAKE_FAILURES)).toBe(WAKE_RETRY_MAX_MS)
  })

  test("a newer hold of the session is not the hold that was woken", () => {
    expect(sameHold(row, { ...row, retryAt: RETRY + 1 })).toBe(false)
    expect(sameHold(row, { ...row, sessionID: "ses_other" })).toBe(false)
    expect(sameHold(row, { ...row, recheckAt: RECHECK, wakeFailures: 2 })).toBe(true)
  })
})

describe("HeldSend schema backward compatibility", () => {
  const decode = Schema.decodeUnknownSync(HeldSend)

  test("decodes rows written by the installed pool without the wake's fields", () => {
    const legacy = decode({ sessionID: "ses_legacy", providerID: "anthropic", reasonCode: "account-held", retryAt: RETRY })
    expect(legacy).toEqual({ sessionID: "ses_legacy", providerID: "anthropic", reasonCode: "account-held", retryAt: RETRY })
  })

  test("decodes rows with every wake field", () => {
    const full = decode({
      sessionID: "ses_sub",
      providerID: "anthropic",
      model: "claude-opus-4-6",
      reasonCode: "even-line",
      retryAt: RETRY,
      recheckAt: RECHECK,
      wakeFailures: 2,
      wokenAt: RECHECK + 5_000,
    })
    expect(full).toMatchObject({ model: "claude-opus-4-6", recheckAt: RECHECK, wakeFailures: 2, wokenAt: RECHECK + 5_000 })
  })
})

describe("wakeDeliveryId", () => {
  const HOST_MSG_ID = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/

  test("builds host-compatible deterministic ids from sessionID and retryAt", () => {
    const id = wakeDeliveryId("ses_child_a", RETRY)
    expect(id).toMatch(HOST_MSG_ID)
    expect(id).toBe(wakeDeliveryId("ses_child_a", RETRY))
    expect(wakeDeliveryId("ses_child_a", RETRY + 0.9)).toBe(id)
    expect(wakeDeliveryId("ses_child_b", RETRY)).not.toBe(id)
    expect(wakeDeliveryId("ses_child_a", RETRY + 1)).not.toBe(id)
  })

  test("orders ids ascending with retryAt and clamps negative timestamps to zero", () => {
    const earlier = wakeDeliveryId("ses_child_a", RETRY)
    const later = wakeDeliveryId("ses_child_a", RETRY + 60_000)
    expect(later > earlier).toBe(true)
    expect(wakeDeliveryId("ses_child_a", -50)).toBe(wakeDeliveryId("ses_child_a", 0))
    expect(wakeDeliveryId("ses_child_a", 0)).toMatch(HOST_MSG_ID)
  })
})

describe("appendSubagentNote", () => {
  test("appends the self-resume notice once", () => {
    const base = "dotfiles-opencode.pool: the request is held: all pool accounts are held; it may go again at 12:00 PM EST."
    const once = appendSubagentNote(base)
    expect(once).toBe(`${base}${SUBAGENT_RESUME_NOTE}`)
    expect(appendSubagentNote(once)).toBe(once)
  })
})
