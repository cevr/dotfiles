// The ledger's reading of the call log, its answered rule, and its lines.
import { expect, test } from "bun:test"
import { DateTime, Option } from "effect"
import { callsIn, closed, ledgerText, LINES, unanswered, unreadTables, UNITS_NAMED } from "./ledger.ts"
import { handBackOf } from "./unit-log.ts"

const at = (second: number) => `2026-11-04T15:00:0${second}.000Z`
const ms = (second: number) => DateTime.toEpochMillis(DateTime.makeUnsafe(at(second)))

test("a new start's child comes from its done line; a follow-up names its child; another session's calls and a broken line are skipped", () => {
  const text = [
    `{"kind":"call","at":"${at(1)}","sessionID":"root","callID":"c1","agent":"implementor","description":"implementor alpha r1"}`,
    `{"kind":"done","at":"${at(1)}","sessionID":"root","callID":"c1","child":"ses_a","status":"running"}`,
    `{"kind":"call","at":"${at(2)}","sessionID":"other","callID":"c2","agent":"worker","child":"ses_x"}`,
    "{ not json",
    `{"kind":"call","at":"${at(5)}","sessionID":"root","callID":"c3","agent":"implementor","child":"ses_a","description":"implementor alpha r2"}`,
    `{"kind":"latched","at":"${at(6)}","sessionID":"root","callID":"c4","agent":"verifier","child":"ses_v","description":"verifier beta r1"}`,
  ].join("\n")
  const calls = callsIn(text, "root")
  expect(calls.children).toEqual([
    { child: "ses_v", agent: "verifier", description: Option.some("verifier beta r1"), startedAt: ms(6), calledAt: ms(6) },
    { child: "ses_a", agent: "implementor", description: Option.some("implementor alpha r1"), startedAt: ms(1), calledAt: ms(5) },
  ])
  expect([...calls.units]).toEqual([
    ["alpha", ms(5)],
    ["beta", ms(6)],
  ])
  expect(callsIn("", "root").children).toEqual([])
})

test("a hand-back waits on the root until a later call goes to its child or its unit; accepted, closed and plain answers never wait", () => {
  const child = { child: "ses_a", agent: "implementor", description: Option.none(), startedAt: 1_000, calledAt: 1_000 }
  const ready = Option.fromUndefinedOr(handBackOf("implementor", "implementor alpha r2: ready /r/alpha/round-2-request.md"))
  const open = () => true
  const none = new Map<string, number>()
  expect(unanswered(child, 2_000, ready, none, open)).toBe(true)
  expect(unanswered(child, 2_000, ready, new Map([["alpha", 3_000]]), open)).toBe(false)
  expect(unanswered({ ...child, calledAt: 3_000 }, 2_000, ready, none, open)).toBe(false)
  expect(unanswered(child, 2_000, ready, none, () => false)).toBe(false)
  expect(unanswered(child, 2_000, Option.fromUndefinedOr(handBackOf("verifier", "verifier batch-1 r1: accepted /r/batch-1-findings.md")), none, open)).toBe(false)
  expect(unanswered(child, 2_000, Option.fromUndefinedOr(handBackOf("implementor", "Done, all green.")), none, open)).toBe(false)
  expect([closed("merged abcdef1"), closed("dropped"), closed("ready"), closed("implement")]).toEqual([true, true, false, false])
})

test("each part says none when empty, and a long part is counted past its lines", () => {
  expect(ledgerText({ queue: [], wakes: [], jobs: [] }, [])).toBe(
    [
      "Your ledger, as it stood at the compaction:",
      "Queue: nothing open.",
      "Subagents: none running, latched or waiting on you.",
      "Wakes, monitors and jobs: none.",
    ].join("\n"),
  )
  const queue = Array.from({ length: LINES + 2 }, (_, n) => ({ text: `item ${n}`, state: "next", detail: Option.none<string>() }))
  const text = ledgerText({ queue, wakes: [{ kind: "monitor", note: "CI", dueAt: ms(9) }], jobs: [{ note: "gate", state: "running" }] }, [])
  expect(text).toContain(`- [next] item ${LINES - 1}\n- and 2 more`)
  expect(text).toContain("Wakes, monitors and jobs:\n- monitor CI, due 2026-11-04T15:00:09Z\n- job gate: running")
})

test("unread tables name the error and the newest units started, counting the earlier ones", () => {
  const started = Array.from({ length: UNITS_NAMED + 3 }, (_, n) => `u${n}`)
  expect(unreadTables("bun failed", started)).toContain(`The units you started steps of: ${started.slice(3).join(", ")} and 3 earlier.`)
  expect(unreadTables("bun failed", ["alpha"])).toStartWith("orchestrate: the run tables could not be read: bun failed.\nThe units you started steps of: alpha.")
})
