import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { appendSubagentNote, decide, Decision, needsCheck, type SessionRole, SUBAGENT_RESUME_NOTE, wakeDeliveryId } from "./hold-wake.ts"
import { HoldReason, nextRetryAt, type WirePace } from "./pace.ts"
import { HeldSend } from "./refuse.ts"

const BASE = 1_700_000_000_000
const MINUTE = 60_000
const RETRY = BASE + 10 * MINUTE

const SESSIONS: ReadonlyArray<SessionRole> = ["subagent", "root", "gone"]
const CLOCKS: ReadonlyArray<readonly [string, number]> = [
  ["before", RETRY - 1],
  ["at", RETRY],
  ["after", RETRY + 2 * MINUTE],
]
const MODELS: ReadonlyArray<Option.Option<string>> = [Option.none(), Option.some("claude-opus-4-6")]
const WOKEN: ReadonlyArray<Option.Option<number>> = [Option.none(), Option.some(RETRY)]
const STEPS: ReadonlyArray<Option.Option<string>> = [Option.none(), Option.some("step_1")]

const pacesAt = (now: number): ReadonlyArray<readonly [string, Option.Option<WirePace>]> => [
  ["none", Option.none()],
  ["admit-measured", Option.some<WirePace>({ ok: true, measured: true, reason: "within pace" })],
  ["admit-unmeasured", Option.some<WirePace>({ ok: true, measured: false, reason: "no weekly window" })],
  ["held-future", Option.some<WirePace>({ ok: false, measured: true, reason: "still held", reasonCode: "account-held", retryAt: now + 5 * MINUTE })],
  ["held-stale", Option.some<WirePace>({ ok: false, measured: true, reason: "stale time", reasonCode: "quota-limit", retryAt: now })],
]

const makeRow = (
  reasonCode: HoldReason,
  model: Option.Option<string>,
  wokenAt: Option.Option<number>,
  stepID: Option.Option<string>,
): HeldSend =>
  HeldSend.make({
    sessionID: "ses_child",
    providerID: "anthropic",
    reasonCode,
    retryAt: RETRY,
    ...Option.match(model, { onNone: () => ({}), onSome: (value) => ({ model: value }) }),
    ...Option.match(wokenAt, { onNone: () => ({}), onSome: (value) => ({ wokenAt: value }) }),
    ...Option.match(stepID, { onNone: () => ({}), onSome: (value) => ({ stepID: value }) }),
  })

const expectedDecision = (
  row: HeldSend,
  session: SessionRole,
  now: number,
  pace: Option.Option<WirePace>,
): Decision => {
  if (Option.isSome(Option.fromUndefinedOr(row.wokenAt)) || Option.isSome(Option.fromUndefinedOr(row.stepID)) || session !== "subagent")
    return Decision.cases.Drop.make({})
  if (now < row.retryAt || Option.isNone(pace)) return Decision.cases.Wait.make({})
  if (pace.value.ok) return Decision.cases.Wake.make({})
  return Decision.cases.Hold.make({ retryAt: nextRetryAt(now, [pace.value.retryAt]) })
}

const checkRowAcrossDomain = (row: HeldSend, prefix: string): number => {
  let count = 0
  for (const session of SESSIONS) {
    for (const [clockName, now] of CLOCKS) {
      for (const [paceName, pace] of pacesAt(now)) {
        count += 1
        const actual = decide({ row, session, now, pace })
        const expected = expectedDecision(row, session, now, pace)
        const label = `${prefix}/${clockName}/${session}/${paceName}`
        expect([label, actual]).toEqual([label, expected])
        if (Decision.guards.Hold(actual)) expect(actual.retryAt).toBeGreaterThan(now)
      }
    }
  }
  return count
}

describe("hold-wake decision domain", () => {
  test("enumerates the entire input domain across session role, clock, wokenAt, stepID, model, reasonCode, and pace", () => {
    let checked = 0
    for (const reasonCode of HoldReason.literals) {
      for (const model of MODELS) {
        for (const wokenAt of WOKEN) {
          for (const stepID of STEPS) {
            const row = makeRow(reasonCode, model, wokenAt, stepID)
            checked += checkRowAcrossDomain(row, `${reasonCode}/woken=${Option.isSome(wokenAt)}/step=${Option.isSome(stepID)}`)
          }
        }
      }
    }
    expect(checked).toBe(HoldReason.literals.length * MODELS.length * WOKEN.length * STEPS.length * SESSIONS.length * CLOCKS.length * 5)
  })

  test("needsCheck is false only when decide can never return Wake or Hold", () => {
    const actsOnRow = (decision: Decision) => Decision.guards.Wake(decision) || Decision.guards.Hold(decision)
    for (const wokenAt of WOKEN) {
      for (const stepID of STEPS) {
        const row = makeRow("account-held", Option.some("claude-opus-4-6"), wokenAt, stepID)
        for (const [, now] of CLOCKS) {
          if (needsCheck(row, now)) continue
          for (const session of SESSIONS)
            for (const [, pace] of pacesAt(now)) expect(actsOnRow(decide({ row, session, now, pace }))).toBe(false)
        }
      }
    }
  })
})

describe("HeldSend schema backward compatibility", () => {
  const decode = Schema.decodeUnknownSync(HeldSend)

  test("decodes rows written by the installed pool without model or wokenAt", () => {
    const legacy = decode({ sessionID: "ses_legacy", providerID: "anthropic", reasonCode: "account-held", retryAt: RETRY })
    expect(legacy).toEqual({ sessionID: "ses_legacy", providerID: "anthropic", reasonCode: "account-held", retryAt: RETRY })
  })

  test("decodes rows with model and wokenAt", () => {
    const full = decode({
      sessionID: "ses_sub",
      providerID: "anthropic",
      model: "claude-opus-4-6",
      reasonCode: "even-line",
      retryAt: RETRY,
      wokenAt: RETRY + 5_000,
    })
    expect(full.model).toBe("claude-opus-4-6")
    expect(full.wokenAt).toBe(RETRY + 5_000)
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
