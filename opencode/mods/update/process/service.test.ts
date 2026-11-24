import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Health, healthOf } from "../health.ts"
import { proven, recordText } from "../record.ts"
import { accountsOf, configuredBy, configuredOf, connectedOf, listedOf, pooledOf, providersOf, serverConfigsOf } from "./service.ts"

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
    expect(providersOf([config])).toEqual(["anthropic", "openai", "fable"])
    expect(providersOf([`{"model":"no-provider"}`])).toEqual([])
    // Each place a model sits names its provider on its own.
    expect(providersOf([`{"model":"anthropic/claude-opus-5-5","agents":{"plain":{"steps":3}}}`])).toEqual(["anthropic"])
    expect(providersOf([`{"agents":{"worker":{"model":"openai/sol-6"}}}`])).toEqual(["openai"])
    expect(providersOf([`{"plugins":[{"package":"/d/cmd/orchestrate","options":{"planner":{"model":"fable/claude-fable-5-2"}}}]}`])).toEqual(["fable"])
    expect(providersOf([""])).toEqual([])
  })

  test("over the global config and the tree's, as the fork folds them: the last config's model per agent and default, every planner", () => {
    const globalConfig = `{"model":"groq/fast","agents":{"worker":{"model":"openai/sol-6","steps":4},"build":{"model":"xai/grok"}}}`
    const tree = `{"model":"anthropic/claude-opus-5-5","agents":{"worker":{"model":"anthropic/claude-opus-5-5"},"planner":{"model":"fable/claude-fable-5-2"}}}`
    // The owner's hand-set worker model and default lose to the tree's; his other agent's model stands.
    expect(providersOf([globalConfig, tree]).toSorted()).toEqual(["anthropic", "fable", "xai"])
    // In the other order the global would win: the order is the fork's load order, never a union.
    expect(providersOf([tree, globalConfig]).toSorted()).toEqual(["fable", "groq", "openai", "xai"])
  })

  test("the logins: providers whose pool lists an account, and integrations with a connection", () => {
    expect(pooledOf(`{"output":{"anthropic":{"accounts":[]},"openai":{"accounts":[{"credentialID":"c"}]}}}`)).toEqual(["openai"])
    expect(pooledOf("Error")).toEqual([])
    const integrations = `{"location":{"directory":"/r"},"data":[{"id":"anthropic","name":"Anthropic","methods":[],"connections":[]},{"id":"openai","name":"OpenAI","methods":[],"connections":[{"type":"credential","id":"x","label":"l","method":"oauth"}]},{"id":"groq","name":"Groq","methods":[],"connections":[{"type":"env","name":"GROQ_API_KEY"}]}]}`
    expect(connectedOf(integrations)).toEqual(Option.some(["openai", "groq"]))
    expect(connectedOf("not json")).toEqual(Option.none())
  })
})

describe("the configs the health check reads, on a tree build", () => {
  const VERSION = "2.3.0-prime.056a7066.1c82e080"
  const record = recordText(proven({ version: VERSION, command: [`/s/opencode-${VERSION}`], dotfiles: "d".repeat(40), fork: "f".repeat(40) }))

  test("are the global server config and the installed build's tree's, which the fork binds over it", () => {
    expect(serverConfigsOf("/h/.config/opencode/opencode.json", Option.some(record))).toEqual(["/h/.config/opencode/opencode.json", `/s/opencode-${VERSION}.plugins/config/opencode.json`])
    expect(serverConfigsOf("/h/.config/opencode/opencode.json", Option.none())).toEqual(["/h/.config/opencode/opencode.json"])
  })

  test("after the strip our plugins are configured by the tree's config alone, and the providers come from both", () => {
    const stripped = `{"model":"anthropic/claude-opus","plugins":["/elsewhere/plugin"]}`
    const tree = `{"plugins":["/s/t.plugins/entries/server/pool","/elsewhere/plugin"],"agents":{"planner":{"model":"openai/gpt"}}}`
    expect(configuredBy([stripped, tree])).toEqual({ configured: ["/elsewhere/plugin", "/s/t.plugins/entries/server/pool"], providers: ["anthropic", "openai"] })
  })

  const reading = (providers: ReadonlyArray<string>, logins: ReadonlyArray<string>) => ({ configured: [], listed: [], accounts: Option.some(1), providers, logins, placement: Option.none() })

  test("a role model the owner set by hand and the tree overrides fails no build, though its provider has no login", () => {
    const globalConfig = `{"agents":{"worker":{"model":"openai/sol-6","steps":4}}}`
    const tree = `{"agents":{"worker":{"model":"anthropic/claude-opus-5-5"}}}`
    expect(healthOf(reading(configuredBy([globalConfig, tree]).providers, ["anthropic"]), ["anthropic", "openai"])).toEqual(Health.Healthy())
  })

  test("the tree's own role model with no login fails the build that had one before, and is reported when there was none", () => {
    const globalConfig = `{"agents":{"worker":{"model":"anthropic/claude-opus-5-5"}}}`
    const tree = `{"agents":{"worker":{"model":"fable/claude-fable-5-2"}}}`
    const providers = configuredBy([globalConfig, tree]).providers
    expect(Health.$is("Sick")(healthOf(reading(providers, ["anthropic"]), ["anthropic", "fable"]))).toBe(true)
    expect(healthOf(reading(providers, ["anthropic"]), ["anthropic"])).toEqual(Health.Unsigned({ providers: ["fable"] }))
  })
})
