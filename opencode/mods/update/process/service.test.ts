import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { accountsOf, configuredOf, listedOf } from "./service.ts"

describe("what the restarted service says, as the handoff reads it", () => {
  test("its plugin list: each local plugin's directory, and the error of one that failed", () => {
    const text = `{"location":{"directory":"/r"},"data":[{"id":"opencode.agent","source":{"type":"builtin"},"features":{"server":true},"state":{"status":"active"}},{"id":"dotfiles-opencode.pool","source":{"type":"local","path":"/d/opencode/cmd/pool"},"features":{"server":true},"state":{"status":"failed","error":"Cannot find package"}},{"source":{"type":"local","path":"/d/opencode/cmd/guard"},"features":{},"state":{"status":"active"}}]}`
    expect(listedOf(text)).toEqual(
      Option.some([
        { path: Option.none(), failed: Option.none() },
        { path: Option.some("/d/opencode/cmd/pool"), failed: Option.some("Cannot find package") },
        { path: Option.some("/d/opencode/cmd/guard"), failed: Option.none() },
      ]),
    )
    expect(listedOf("not json")).toEqual(Option.none())
  })

  test("the pool's status answer: its accounts over every pool", () => {
    expect(accountsOf(`{"output":{"anthropic":{"accounts":[{"credentialID":"a","load":0}, {"credentialID":"b"}]},"openai":{"accounts":[{"credentialID":"c"}]}}}`)).toEqual(Option.some(3))
    expect(accountsOf(`{"output":{}}`)).toEqual(Option.some(0))
    expect(accountsOf("Error: no RPC dotfiles-opencode.pool")).toEqual(Option.none())
  })

  test("the server config's local plugins: the entries that are directories, bare or with options", () => {
    expect(configuredOf(`{"plugins":["/d/cmd/guard",{"package":"/d/cmd/pool","options":{}},"-opencode.tool.schedule","some-npm-plugin"]}`)).toEqual(["/d/cmd/guard", "/d/cmd/pool"])
    expect(configuredOf("")).toEqual([])
  })
})
