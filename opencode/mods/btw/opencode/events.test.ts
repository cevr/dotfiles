import { expect, test } from "bun:test"
import { sessionOf } from "./events.ts"

test("an event is about the session its data names, and no session without one", () => {
  expect(sessionOf({ type: "session.text.delta", data: { sessionID: "ses_1", delta: "a" } })).toBe("ses_1")
  expect(sessionOf({ type: "session.execution.succeeded", data: { sessionID: "ses_2" } })).toBe("ses_2")
  expect(sessionOf({ type: "server.connected", data: {} })).toBeUndefined()
  expect(sessionOf({ type: "x", data: { sessionID: 3 } })).toBeUndefined()
  expect(sessionOf({ type: "x" })).toBeUndefined()
  expect(sessionOf(null)).toBeUndefined()
})
