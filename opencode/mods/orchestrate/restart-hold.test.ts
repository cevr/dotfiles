// Which model requests wait for the Sabbath rest's end: a turn's whose restart notice was written in the rest.
import { expect, test } from "bun:test"
import { DateTime, Option } from "effect"
import { heldUntil, RESTART_NOTICE } from "./restart-hold.ts"
import { KNOWLTON, rest } from "./sabbath.ts"

/** Friday 30 October 2026, 19:00 in Knowlton: after sunset, in the rest. */
const FRIDAY_EVENING = Date.parse("2026-10-30T23:00:00Z")
/** The same Friday, 14:00 in Knowlton: before sunset. */
const FRIDAY_AFTERNOON = Date.parse("2026-10-30T18:00:00Z")
/** Wednesday 4 November 2026: no rest. */
const WEDNESDAY = Date.parse("2026-11-04T15:00:00Z")
const END = rest(FRIDAY_EVENING, KNOWLTON).end

const notice = (created: number | string | DateTime.DateTime) => ({ type: "synthetic", text: "The server restarted while you were working.", metadata: { notice: RESTART_NOTICE }, time: { created } })
const user = { type: "user", text: "go", time: { created: FRIDAY_AFTERNOON } }
const assistant = { type: "assistant", content: [{ type: "text", text: "working" }] }
const idle = { type: "idle", outcome: "succeeded" }

test("a turn a restart in the rest resumed waits for the rest's end, whatever form the notice's time comes in", () => {
  for (const created of [FRIDAY_EVENING - 60_000, DateTime.makeUnsafe(FRIDAY_EVENING), "2026-10-30T23:00:00.000Z"])
    expect(heldUntil([user, assistant, notice(created), assistant], FRIDAY_EVENING, KNOWLTON)).toEqual(Option.some(END))
  // Later in the rest, still the same end; the half hour after sunset is the rest's too.
  expect(heldUntil([user, notice(FRIDAY_EVENING)], END - 60_000, KNOWLTON)).toEqual(Option.some(END))
})

test("outside the rest, a turn resumed before it, a turn a prompt started, and a resumed turn that ended ask at once", () => {
  expect(heldUntil([user, notice(WEDNESDAY)], WEDNESDAY, KNOWLTON)).toEqual(Option.none())
  // Resumed on Friday afternoon, it runs on into the rest as any turn does.
  expect(heldUntil([user, notice(FRIDAY_AFTERNOON), assistant], FRIDAY_EVENING, KNOWLTON)).toEqual(Option.none())
  expect(heldUntil([user, assistant], FRIDAY_EVENING, KNOWLTON)).toEqual(Option.none())
  // The resumed turn went idle; the turn now is a prompt's.
  expect(heldUntil([notice(FRIDAY_EVENING), assistant, idle, user], FRIDAY_EVENING, KNOWLTON)).toEqual(Option.none())
  // Another synthetic notice is no restart, and a notice with no time reads as none.
  expect(heldUntil([{ ...notice(FRIDAY_EVENING), metadata: { notice: "other" } }], FRIDAY_EVENING, KNOWLTON)).toEqual(Option.none())
  expect(heldUntil([{ type: "synthetic", metadata: { notice: RESTART_NOTICE }, time: { created: "not a time" } }], FRIDAY_EVENING, KNOWLTON)).toEqual(Option.none())
  // Once the rest ends, the turn goes on.
  expect(heldUntil([user, notice(FRIDAY_EVENING)], END, KNOWLTON)).toEqual(Option.none())
})
