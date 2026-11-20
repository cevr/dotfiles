import { describe, expect, test } from "bun:test"
import { envelopesInJson } from "./envelopes.ts"

// Notices as JSON strings, as a model request carries them: since upstream e51247f626, and before.
const NEW_SHELL = String.raw`"<background-result kind=\"shell\" id=\"sh_1\" state=\"completed\" command=\"ls\">\nok\n</background-result>"`
const OLD_SUBAGENT = String.raw`"<subagent sessionID=\"ses_1\" state=\"completed\" description=\"d\">\nAll done\n</subagent>"`

describe("envelopesInJson", () => {
  test("finds the notices in a request's strings, in either envelope, with their bodies", () => {
    const request = `{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":${NEW_SHELL}}]},{"role":"user","content":${OLD_SUBAGENT}},{"n":1,"ok":true,"none":null}]}`
    expect(envelopesInJson(request).map((each) => [each.kind, each.form, each.body])).toEqual([
      ["shell", "background-result", "ok"],
      ["subagent", "kind", "All done"],
    ])
  })

  test("finds none in text that is not JSON", () => {
    expect(envelopesInJson('not json <background-result kind="shell">\nok\n</background-result>')).toEqual([])
  })
})
