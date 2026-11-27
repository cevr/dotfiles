import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import {
  Answer,
  appendSubagentNote,
  type Child,
  decide,
  Decision,
  delivered,
  dueAt,
  failed,
  goneNoticeId,
  heldUntil,
  needsCheck,
  orchestrator,
  repaired,
  retryDelay,
  ROOT_WAKE_TEXT,
  sameHold,
  type SessionRole,
  SUBAGENT_RESUME_NOTE,
  told,
  WAKE_RETRY_MAX_MS,
  WAKE_RETRY_MS,
  WAKE_TEXT,
  wakeable,
  wakeDeliveryId,
  wakeText,
} from "./hold-wake.ts"
import { HoldReason } from "./pace.ts"
import { HeldSend } from "./refuse.ts"

const BASE = 1_700_000_000_000
const MINUTE = 60_000
const RETRY = BASE + 10 * MINUTE
const RECHECK = RETRY + 5 * MINUTE

const SESSIONS: ReadonlyArray<SessionRole> = ["subagent", "root", "gone", "unknown"]
const CLOCKS: ReadonlyArray<readonly [string, number]> = [
  ["before", RETRY - 1],
  ["at", RETRY],
  ["between", RETRY + 2 * MINUTE],
  ["at-recheck", RECHECK],
  ["after", RECHECK + 2 * MINUTE],
]
const MODELS: ReadonlyArray<Option.Option<string>> = [Option.none(), Option.some("claude-opus-4-6")]
const WOKEN: ReadonlyArray<Option.Option<number>> = [Option.none(), Option.some(RETRY)]
const TOLD: ReadonlyArray<Option.Option<number>> = [Option.none(), Option.some(RETRY)]
const STEPS: ReadonlyArray<Option.Option<string>> = [Option.none(), Option.some("step_1")]
const RECHECKS: ReadonlyArray<Option.Option<number>> = [Option.none(), Option.some(RECHECK)]
const PARENTS: ReadonlyArray<Option.Option<string>> = [Option.none(), Option.some("ses_root")]
const FAILURES: ReadonlyArray<Option.Option<number>> = [Option.none(), Option.some(1), Option.some(10_000)]
const ORCHESTRATORS: ReadonlyArray<boolean> = [false, true]

const answersAt = (now: number): ReadonlyArray<readonly [string, Option.Option<Answer>]> => [
  ["none", Option.none()],
  ["admitted", Option.some(Answer.cases.Admitted.make({}))],
  ["held-future", Option.some(Answer.cases.Held.make({ retryAt: now + 5 * MINUTE }))],
  ["held-stale", Option.some(Answer.cases.Held.make({ retryAt: now }))],
]

/** The fields a row is built from, each present or absent. */
interface RowFields {
  readonly reasonCode: HoldReason
  readonly model: Option.Option<string>
  readonly wokenAt: Option.Option<number>
  readonly toldAt: Option.Option<number>
  readonly stepID: Option.Option<string>
  readonly recheckAt: Option.Option<number>
  readonly parentID: Option.Option<string>
  readonly wakeFailures: Option.Option<number>
  readonly orchestrator: boolean
}

const makeRow = (fields: RowFields): HeldSend =>
  HeldSend.make({
    sessionID: "ses_child",
    providerID: "anthropic",
    reasonCode: fields.reasonCode,
    retryAt: RETRY,
    ...Option.match(fields.model, { onNone: () => ({}), onSome: (model) => ({ model }) }),
    ...Option.match(fields.wokenAt, { onNone: () => ({}), onSome: (wokenAt) => ({ wokenAt }) }),
    ...Option.match(fields.toldAt, { onNone: () => ({}), onSome: (toldAt) => ({ toldAt }) }),
    ...Option.match(fields.stepID, { onNone: () => ({}), onSome: (stepID) => ({ stepID }) }),
    ...Option.match(fields.recheckAt, { onNone: () => ({}), onSome: (recheckAt) => ({ recheckAt }) }),
    ...Option.match(fields.parentID, { onNone: () => ({}), onSome: (parentID) => ({ parentID }) }),
    ...Option.match(fields.wakeFailures, { onNone: () => ({}), onSome: (wakeFailures) => ({ wakeFailures }) }),
    ...Option.match(Option.liftPredicate(true as const, () => fields.orchestrator), { onNone: () => ({}), onSome: (orchestrator) => ({ orchestrator }) }),
  })

const FRESH: RowFields = {
  reasonCode: "account-held", model: Option.some("m"), wokenAt: Option.none(), toldAt: Option.none(), stepID: Option.none(),
  recheckAt: Option.none(), parentID: Option.some("ses_root"), wakeFailures: Option.none(), orchestrator: false,
}

/** Whether the pool may ever send anything for a row built from `fields`, as the rules state it (not read from the row). Failures never end it. */
const live = (fields: RowFields): boolean =>
  Option.isNone(fields.wokenAt) && Option.isNone(fields.toldAt) && Option.isNone(fields.stepID) && Option.isSome(fields.model)

/** The decision as the rules state it, from the fields the row was built from. */
const expectedDecision = (fields: RowFields, session: SessionRole, now: number, answer: Option.Option<Answer>): string => {
  // A root is woken only when it orchestrated at the hold; then it goes on as a subagent does.
  if (!live(fields) || (session === "root" && !fields.orchestrator)) return "Drop"
  if (now < Option.getOrElse(fields.recheckAt, () => RETRY)) return "Wait"
  if (session === "unknown") return "Retry"
  if (session === "gone") return Option.match(fields.parentID, { onNone: () => "Drop", onSome: () => "Tell" })
  return Option.match(answer, { onNone: () => "Wait", onSome: (given) => Option.getOrElse(Option.map(Option.liftPredicate(given, Answer.guards.Admitted), () => "Wake"), () => "Hold") })
}

/** Every combination of the row's fields. */
const everyRow: ReadonlyArray<RowFields> = HoldReason.literals.flatMap((reasonCode) =>
  MODELS.flatMap((model) =>
    WOKEN.flatMap((wokenAt) =>
      TOLD.flatMap((toldAt) =>
        STEPS.flatMap((stepID) =>
          RECHECKS.flatMap((recheckAt) =>
            PARENTS.flatMap((parentID) =>
              FAILURES.flatMap((wakeFailures) =>
                ORCHESTRATORS.map((orchestrator) => ({ reasonCode, model, wokenAt, toldAt, stepID, recheckAt, parentID, wakeFailures, orchestrator })),
              ),
            ),
          ),
        ),
      ),
    ),
  ),
)

const labelOf = (fields: RowFields, clock: string, session: SessionRole, answer: string) =>
  [
    fields.reasonCode,
    `model=${Option.isSome(fields.model)}`,
    `woken=${Option.isSome(fields.wokenAt)}`,
    `told=${Option.isSome(fields.toldAt)}`,
    `step=${Option.isSome(fields.stepID)}`,
    `recheck=${Option.isSome(fields.recheckAt)}`,
    `parent=${Option.isSome(fields.parentID)}`,
    `failures=${Option.getOrElse(fields.wakeFailures, () => 0)}`,
    `orchestrator=${fields.orchestrator}`,
    clock,
    session,
    answer,
  ].join("/")

/** One case of the domain: the decision, its id or recheck, and whether `needsCheck` agrees. */
const checkCase = (fields: RowFields, session: SessionRole, [clock, now]: readonly [string, number], [answerName, answer]: readonly [string, Option.Option<Answer>]) => {
  const row = makeRow(fields)
  const label = labelOf(fields, clock, session, answerName)
  const actual = decide({ row, session, now, answer })
  expect([label, actual._tag]).toEqual([label, expectedDecision(fields, session, now, answer)])
  // A wake carries the hold's one id, a word to the parent its own; a recheck is strictly later than now.
  if (Decision.guards.Wake(actual)) expect([label, actual.id]).toEqual([label, wakeDeliveryId("ses_child", RETRY)])
  if (Decision.guards.Tell(actual)) expect([label, actual]).toEqual([label, Decision.cases.Tell.make({ parentID: "ses_root", id: goneNoticeId("ses_child", RETRY) })])
  if (Decision.guards.Hold(actual)) expect([label, actual.recheckAt > now]).toEqual([label, true])
  // needsCheck is false only where nothing can be sent or recorded.
  if (!needsCheck(row, now)) expect([label, Decision.guards.Drop(actual) || Decision.guards.Wait(actual)]).toEqual([label, true])
}

describe("hold-wake decision domain", () => {
  test("enumerates the entire input domain: reason, model, woken, told, Step, recheck, parent, failures, orchestrator, session, clock and answer", () => {
    let checked = 0
    for (const fields of everyRow)
      for (const session of SESSIONS)
        for (const clock of CLOCKS)
          for (const answer of answersAt(clock[1])) {
            checkCase(fields, session, clock, answer)
            checked += 1
          }
    expect(checked).toBe(
      HoldReason.literals.length * MODELS.length * WOKEN.length * TOLD.length * STEPS.length * RECHECKS.length * PARENTS.length * FAILURES.length * ORCHESTRATORS.length *
        SESSIONS.length * CLOCKS.length * 4,
    )
  })

  test("a row only this pool wrote has a due time: no model, woken, told, or a Step's never sends; failures never end it", () => {
    const row = makeRow(FRESH)
    expect(dueAt(row)).toEqual(Option.some(RETRY))
    const { model: _model, ...legacy } = row
    expect(dueAt(HeldSend.make(legacy))).toEqual(Option.none())
    expect(dueAt({ ...row, recheckAt: RECHECK })).toEqual(Option.some(RECHECK))
    // A recheck never moves the due time before the hold's own time.
    expect(dueAt({ ...row, recheckAt: RETRY - MINUTE })).toEqual(Option.some(RETRY))
    expect(dueAt({ ...row, wakeFailures: 1_000_000, recheckAt: RECHECK })).toEqual(Option.some(RECHECK))
    expect(dueAt(told(row, RETRY))).toEqual(Option.none())
    expect(heldUntil({ ...row, recheckAt: RECHECK })).toBe(RECHECK)
    expect(heldUntil(row)).toBe(RETRY)
  })
})

describe("what the row records", () => {
  const row = makeRow(FRESH)

  test("a delivery marks it woken and keeps the hold's time and id", () => {
    const after = delivered(row, RETRY + 1)
    expect(after).toEqual({ ...row, wokenAt: RETRY + 1 })
    expect(sameHold(row, after)).toBe(true)
    expect(dueAt(after)).toEqual(Option.none())
  })

  test("failed attempts back off, doubling to the longest wait and staying there, for as long as the row lives; the hold's id never changes", () => {
    let current: HeldSend = row
    let now = RETRY
    const waits: Array<number> = []
    for (let attempt = 1; attempt <= 200; attempt += 1) {
      const decision = decide({ row: current, session: "subagent", now, answer: Option.some(Answer.cases.Admitted.make({})) })
      expect(decision).toEqual(Decision.cases.Wake.make({ id: wakeDeliveryId("ses_child", RETRY) }))
      current = failed(current, now)
      expect(current.wakeFailures).toBe(attempt)
      expect(current.retryAt).toBe(RETRY)
      const due = Option.getOrThrow(dueAt(current))
      waits.push(due - now)
      now = due
    }
    expect(waits.slice(0, 5)).toEqual([WAKE_RETRY_MS, 2 * WAKE_RETRY_MS, 4 * WAKE_RETRY_MS, 8 * WAKE_RETRY_MS, 16 * WAKE_RETRY_MS])
    expect(waits.slice(5).every((wait) => wait === WAKE_RETRY_MAX_MS)).toBe(true)
    expect(retryDelay(1)).toBe(WAKE_RETRY_MS)
    expect(retryDelay(Number.MAX_SAFE_INTEGER)).toBe(WAKE_RETRY_MAX_MS)
  })

  test("a host that does not answer is a failed attempt, never a gone child", () => {
    expect(decide({ row, session: "unknown", now: RETRY, answer: Option.none() })).toEqual(Decision.cases.Retry.make({}))
    expect(decide({ row: { ...row, wakeFailures: 50 }, session: "unknown", now: RETRY, answer: Option.none() })).toEqual(Decision.cases.Retry.make({}))
  })

  test("a gone child's parent is told with an id of its own, once; the row then sends nothing more", () => {
    const decision = decide({ row, session: "gone", now: RETRY, answer: Option.none() })
    expect(decision).toEqual(Decision.cases.Tell.make({ parentID: "ses_root", id: goneNoticeId("ses_child", RETRY) }))
    expect(goneNoticeId("ses_child", RETRY)).not.toBe(wakeDeliveryId("ses_child", RETRY))
    expect(decide({ row: told(row, RETRY), session: "gone", now: RETRY, answer: Option.none() })).toEqual(Decision.cases.Drop.make({}))
  })

  test("a newer hold of the session is not the hold that was woken", () => {
    expect(sameHold(row, { ...row, retryAt: RETRY + 1 })).toBe(false)
    expect(sameHold(row, { ...row, sessionID: "ses_other" })).toBe(false)
    expect(sameHold(row, { ...row, recheckAt: RECHECK, wakeFailures: 2 })).toBe(true)
  })
})

describe("an orchestrator root: at the hold, a subagent of its own is running, pool-held or latched", () => {
  const child = (over: Partial<Child>): Child => ({ busy: Option.none(), idle: Option.none(), metadata: {}, poolHeld: false, ...over })
  const mark = { hold: "pace", reason: "pace", opensAt: RETRY, recheckAt: RETRY, at: BASE }

  test("a running, pool-held or latched subagent makes it one; a finished, never-run or cancelled or failed latch does not", () => {
    expect(orchestrator([])).toBe(false)
    expect(orchestrator([child({ busy: Option.some(BASE) })])).toBe(true)
    expect(orchestrator([child({ busy: Option.some(BASE + 1), idle: Option.some(BASE) })])).toBe(true)
    expect(orchestrator([child({ poolHeld: true })])).toBe(true)
    expect(orchestrator([child({ metadata: { latch: mark } })])).toBe(true)
    expect(orchestrator([child({ busy: Option.some(BASE), idle: Option.some(BASE) })])).toBe(false)
    expect(orchestrator([child({ busy: Option.some(BASE), idle: Option.some(BASE + 1) })])).toBe(false)
    expect(orchestrator([child({ metadata: { latch: { ...mark, cancelledAt: BASE } } })])).toBe(false)
    expect(orchestrator([child({ metadata: { latch: { ...mark, failed: "no" } } })])).toBe(false)
    expect(orchestrator([child({ metadata: { latch: "garbage" } })])).toBe(false)
    expect(orchestrator([child({}), child({ poolHeld: true })])).toBe(true)
  })

  test("its row is woken with the hold's one id and told why; a root that did not orchestrate is dropped", () => {
    const row = { ...makeRow({ ...FRESH, parentID: Option.none() }), orchestrator: true as const }
    const admitted = Option.some(Answer.cases.Admitted.make({}))
    expect(wakeable(row, "root")).toBe(true)
    expect(wakeable(makeRow(FRESH), "root")).toBe(false)
    expect(decide({ row, session: "root", now: RETRY, answer: admitted })).toEqual(Decision.cases.Wake.make({ id: wakeDeliveryId("ses_child", RETRY) }))
    expect(decide({ row: makeRow(FRESH), session: "root", now: RETRY, answer: admitted })).toEqual(Decision.cases.Drop.make({}))
    // A gone root has no one to tell; a woken one is done.
    expect(decide({ row, session: "gone", now: RETRY, answer: Option.none() })).toEqual(Decision.cases.Drop.make({}))
    expect(decide({ row: delivered(row, RETRY), session: "root", now: RETRY, answer: admitted })).toEqual(Decision.cases.Drop.make({}))
    expect(wakeText("root")).toBe(ROOT_WAKE_TEXT)
    expect(wakeText("subagent")).toBe(WAKE_TEXT)
    expect(ROOT_WAKE_TEXT).toContain("has opened: the pool is admitting requests again")
    expect(ROOT_WAKE_TEXT).toContain("because it was running subagents of its own")
    expect(ROOT_WAKE_TEXT).toContain("without starting anything that turn did not ask for")
  })

  test("a damaged row keeps that it orchestrates", () => {
    expect(repaired("ses_child", { model: "m", retryAt: "soon", orchestrator: true }, RETRY)).toEqual(
      Option.some(HeldSend.make({ sessionID: "ses_child", providerID: "anthropic", model: "m", reasonCode: "record-unreadable", retryAt: RETRY, orchestrator: true })),
    )
  })
})

describe("a row that no longer decodes", () => {
  test("of the wake's kind (it names a model) is rebuilt from what can be read, its key naming the session", () => {
    expect(repaired("ses_child", { model: "m", retryAt: "soon", parentID: "ses_root", reasonCode: "even-line" }, RETRY)).toEqual(
      Option.some(HeldSend.make({ sessionID: "ses_child", providerID: "anthropic", model: "m", reasonCode: "even-line", retryAt: RETRY, parentID: "ses_root" })),
    )
    expect(repaired("ses_child", { model: "m", providerID: "sim", retryAt: RECHECK, reasonCode: 7 }, RETRY)).toEqual(
      Option.some(HeldSend.make({ sessionID: "ses_child", providerID: "sim", model: "m", reasonCode: "record-unreadable", retryAt: RECHECK })),
    )
  })

  test("of another kind, or one that decodes, is left as it is", () => {
    expect(repaired("ses_child", { retryAt: "soon" }, RETRY)).toEqual(Option.none())
    expect(repaired("ses_child", "garbage", RETRY)).toEqual(Option.none())
    expect(repaired("ses_child", makeRow(FRESH), RETRY)).toEqual(Option.none())
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
      parentID: "ses_root",
      reasonCode: "even-line",
      retryAt: RETRY,
      recheckAt: RECHECK,
      wakeFailures: 2,
      wokenAt: RECHECK + 5_000,
      toldAt: RECHECK + 6_000,
    })
    expect(full).toMatchObject({ model: "claude-opus-4-6", parentID: "ses_root", recheckAt: RECHECK, wakeFailures: 2, wokenAt: RECHECK + 5_000, toldAt: RECHECK + 6_000 })
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
    expect(goneNoticeId("ses_child_a", RETRY)).toMatch(HOST_MSG_ID)
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
