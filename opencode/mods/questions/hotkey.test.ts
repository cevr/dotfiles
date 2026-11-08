import { expect, test } from "bun:test"
import { opens } from "./hotkey.ts"

const pressed = { sessionID: "ses_a", open: 2, composer: "" }

test("on an empty composer with questions open, the hotkey opens the session's questions", () => {
  expect(opens(pressed)).toBe("ses_a")
  // No editor has the focus: nothing to select either.
  expect(opens({ ...pressed, composer: undefined })).toBe("ses_a")
})

test("with text in the composer the key goes on to the composer, which selects", () => {
  expect(opens({ ...pressed, composer: "draft" })).toBeUndefined()
  expect(opens({ ...pressed, composer: " " })).toBeUndefined()
})

test("with no session or no open question, the key goes on", () => {
  expect(opens({ ...pressed, sessionID: undefined })).toBeUndefined()
  expect(opens({ ...pressed, open: 0 })).toBeUndefined()
})
