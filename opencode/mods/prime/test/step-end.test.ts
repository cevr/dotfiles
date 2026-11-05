// How a step that ended badly reads in the transcript: gent's session rows,
// from the error and retry the host keeps on the assistant message.
import { describe, expect, test } from "bun:test"
import { ERROR_LINES, stepEndRow } from "../src/view"

describe("a step's end row", () => {
  test("a step that ended well draws nothing", () => {
    expect(stepEndRow({}, 0, "details")).toBeUndefined()
  })

  test("a retry counts down to its attempt, muted behind ↻, with the first line of its reason", () => {
    const retry = { attempt: 2, at: 10_000, error: { message: "Rate limit exceeded\nretry-after: 3" } }
    expect(stepEndRow({ retry }, 7_200, "details")).toEqual({
      glyph: "↻",
      tone: "muted",
      text: "Retrying in 3s · attempt 2 · Rate limit exceeded",
    })
    expect(stepEndRow({ retry }, 10_000, "details")?.text).toBe("Retrying now · attempt 2 · Rate limit exceeded")
    // A retry outranks the error it retries.
    expect(stepEndRow({ retry, error: { type: "provider", message: "boom" } }, 0, "details")?.glyph).toBe("↻")
  })

  test("the reader's interrupt is ■ in the warning tone, not an error", () => {
    expect(stepEndRow({ error: { type: "aborted", message: "Step interrupted" } }, 0, "details")).toEqual({
      glyph: "■",
      tone: "warning",
      text: "Interrupted",
    })
  })

  test("an error is ✗ with its first lines below All, then the count of the rest; All shows it whole", () => {
    const message = Array.from({ length: ERROR_LINES + 3 }, (_, index) => `line ${index + 1}`).join("\n")
    const capped = stepEndRow({ error: { type: "provider", message } }, 0, "details")
    expect(capped?.glyph).toBe("✗")
    expect(capped?.tone).toBe("error")
    expect(capped?.text.split("\n")).toEqual(["line 1", "line 2", "line 3", "line 4", "… +3 lines (ctrl+o)"])
    expect(stepEndRow({ error: { type: "provider", message } }, 0, "all")?.text).toBe(message)
  })
})
