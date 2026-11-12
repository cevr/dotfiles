// A credential id from before the login store's rename, renamed wherever the
// pool's state names it: alone, inside its keys, its values and the limit
// file's rows.
import { describe, expect, test } from "bun:test"
import { LEGACY_PREFIX as OLD, renameText, renameValue } from "./legacy-ids.ts"

describe("a legacy credential id", () => {
  test("is renamed where an id starts: the text's start, after a key separator, or URI-encoded", () => {
    expect(renameText(`${OLD}work`)).toBe("store:work")
    expect(renameText(`anthropic/hold/${OLD}work`)).toBe("anthropic/hold/store:work")
    expect(renameText(`claude:anthropic:${OLD}work:123`)).toBe("claude:anthropic:store:work:123")
    expect(renameText(`anthropic|${OLD}work|5h|0`)).toBe("anthropic|store:work|5h|0")
    expect(renameText(encodeURIComponent(`claude:anthropic:${OLD}work:123`))).toBe(encodeURIComponent("claude:anthropic:store:work:123"))
  })

  test("leaves every other text alone, an agent's name among them", () => {
    for (const text of ["agent:work", "urgent:x", "cred_abc", "store:work", "anthropic/step/000000000000001/ses_1", "a/b"]) expect(renameText(text)).toBe(text)
  })

  test("is renamed in a value's strings and keys, at any depth", () => {
    expect(renameValue({ credentialID: `${OLD}work`, rows: { [`anthropic|${OLD}work|5h|0`]: { credentialID: `${OLD}work`, rise: 1 } }, list: [`${OLD}a`, 2, true] })).toEqual({
      credentialID: "store:work",
      rows: { "anthropic|store:work|5h|0": { credentialID: "store:work", rise: 1 } },
      list: ["store:a", 2, true],
    })
    expect(renameValue({ credentialID: "cred_abc", list: [1, "x"] })).toEqual({ credentialID: "cred_abc", list: [1, "x"] })
  })
})
