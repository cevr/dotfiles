// The subagents tool has no wait: a subagent reports to its parent when it is
// done, so a call asking to wait is refused with that hint.
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as OpenCodeSubagents from "./subagents.ts"

describe("the subagents tool", () => {
  test("refuses a wait with the hint that a finished subagent's report arrives as the next message", () => {
    const refused = Schema.decodeUnknownExit(OpenCodeSubagents.Input)({ action: "wait", sessionID: "ses_a", ms: 1_500_000 })
    expect(String(refused)).toContain(`there is no "wait". ${OpenCodeSubagents.NO_WAIT}`)
    expect(OpenCodeSubagents.NO_WAIT).toStartWith("A finished subagent's report arrives as your next message")
    expect(OpenCodeSubagents.description).toContain(OpenCodeSubagents.NO_WAIT)
    expect(OpenCodeSubagents.description).not.toContain('action: "wait"')
  })
})
