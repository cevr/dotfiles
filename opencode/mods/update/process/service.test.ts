import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { accountsOf, configuredOf, connectedOf, listedOf, pooledOf, providersOf } from "./service.ts"

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

  test("the providers the config's models use: the default model, each agent's, the planner's", () => {
    const config = `{"model":"anthropic/claude-opus-5-5#medium","plugins":["/d/cmd/guard",{"package":"/d/cmd/orchestrate","options":{"codex":{"pool":true},"planner":{"model":"fable/claude-fable-5-2"}}},{"package":"/d/cmd/pool","options":{"planner":3}}],"agents":{"planner":{"model":"anthropic/claude-opus-5-5"},"worker":{"model":"openai/sol-6"},"plain":{"steps":3}}}`
    expect(providersOf(config)).toEqual(["anthropic", "openai", "fable"])
    expect(providersOf(`{"model":"no-provider"}`)).toEqual([])
    expect(providersOf("")).toEqual([])
  })

  test("the logins: providers whose pool lists an account, and integrations with a connection", () => {
    expect(pooledOf(`{"output":{"anthropic":{"accounts":[]},"openai":{"accounts":[{"credentialID":"c"}]}}}`)).toEqual(["openai"])
    expect(pooledOf("Error")).toEqual([])
    const integrations = `{"location":{"directory":"/r"},"data":[{"id":"anthropic","name":"Anthropic","methods":[],"connections":[]},{"id":"openai","name":"OpenAI","methods":[],"connections":[{"type":"credential","id":"x","label":"l","method":"oauth"}]},{"id":"groq","name":"Groq","methods":[],"connections":[{"type":"env","name":"GROQ_API_KEY"}]}]}`
    expect(connectedOf(integrations)).toEqual(Option.some(["openai", "groq"]))
    expect(connectedOf("not json")).toEqual(Option.none())
  })
})
