// `bun run daily`'s settings in the global configs (never a plugin entry), its entries, and its fork steps.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseTTL } from "../mods/idle-compact/cache.ts"
import { type Catalog, loginStoreDir } from "../testbeds/gamut/gamut.ts"
import { gitClone, gitInit } from "../tests/git-repo.ts"
import { keptScratch, scratch as scratchDir } from "../tests/scratch.ts"
import { hostLocks } from "../mods/work/process/landing.ts"
import { SERVER_PLUGINS } from "../mods/update/trees.ts"
import { settingsFor } from "../mods/update/process/install.ts"
import { BUILTIN_BTW_OFF, BUILTIN_AUTOMATION_OFF, CLAUDE_CACHE_TTL, digestEntry, DOTFILES, forkSteps, hostCli, hostServer, installDotfiles, installedFile, lacksCliDefault, mailEntry, moveFork, orchestrateEntry, peersOf, plannerModel, pluginDir, poolEntry, residentConfig, residentDir, roleLines, roleModels, serverEntries, treeSettings, writeSettings } from "./daily.ts"
import type { PluginEntry } from "./daily.ts"
import { ATTEMPTS, type CheckResult, exposedTests, HELD_BRANCH, mergeUpstream, syncFork, type Options as UpstreamOptions, unlocked } from "./upstream.ts"

const MODS = "/repo/opencode/mods"
const CHECKOUTS = { dotfiles: "/repo", fork: "/fork" }

/** JSON text, either way. */
const JsonText = Schema.fromJsonString(Schema.Unknown)
const parseJson = Schema.decodeUnknownSync(JsonText)
const jsonOf = Schema.encodeSync(JsonText)

/** A small seeded generator (mulberry32), so a failing seed replays. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** A catalog of two Opus releases and a Fable: the role models' source. */
const CATALOG = {
  anthropic: { models: {
    "claude-opus-5-0": { family: "claude-opus", release_date: "2026-03-01" },
    "claude-opus-5-5": { family: "claude-opus", release_date: "2026-09-22" },
    "claude-fable-5-2": { family: "claude-fable", release_date: "2026-11-09" },
  } },
} satisfies Catalog

/** A config as JSON, its objects by key. */
type Json = Schema.Json
const JsonObject = Schema.Record(Schema.String, Schema.Json)
const isObject = Schema.is(JsonObject)
/** A config's top-level object; none for a value that is not one. */
const asObject = (value: Json) => Option.getOrElse(Option.liftPredicate(value, isObject), () => ({}))
/** The owner's TUI config with by-hand daily's defaults in what it lacks (`hostCli`), as JSON. */
const cliWith = (owner: Json): Json => Schema.decodeUnknownSync(Schema.Json)(hostCli(asObject(owner)))

/** Every leaf of a config by its dotted path; an empty object holds none, an array is one leaf. */
const leaves = (value: Json, path: ReadonlyArray<string> = []): Array<[string, Json]> =>
  Option.match(Option.liftPredicate(value, isObject), {
    onNone: (): Array<[string, Json]> => [[path.join("."), value]],
    onSome: (object) => Object.entries(object).flatMap(([key, each]) => leaves(each, [...path, key])),
  })

/**
 * The fold of the tree's document over the owner's global one, leaf by leaf, the tree's leaf winning at its
 * path: the fork's fold for these shapes, proven on fork 07bb11e0 and by tests/settings-follow.test.ts. The
 * server folds each agent field by field (core `config/plugin/agent.ts`) and a provider's settings key by key
 * (`Provider.mergeOverlay`); the TUI deep-merges records key by key (cli `config/config.ts` `mergeRecords`).
 */
const fold = (owner: Json, tree: Json): ReadonlyMap<string, Json> => new Map([...leaves(owner), ...leaves(tree)])
const valueAt = (config: Json, path: string): Option.Option<Json> => Option.fromIterable(leaves(config).filter(([at]) => at === path).map(([, value]) => value))

const ROLES = ["planner", "implementor", "verifier", "worker"]
/** The keys a build names, and wins: each role's model and Claude's cache lifetime. */
const SERVER_NAMED = [...ROLES.map((role) => `agents.${role}.model`), "providers.anthropic.settings.cache.ttl"]
/** The keys by-hand daily sets in the owner's TUI config only where it has none. */
const CLI_DEFAULTS: Array<[string, Json]> = [["theme.name", "prime"], ["tabs.scope", "window"]]

/** One of `values`, by the generator. */
const pickOf = (next: () => number) => <A>(values: ReadonlyArray<A>): A => Option.getOrThrow(Arr.get(values, (next() * values.length) | 0))
/** Each field of `fields` or not, by the generator. */
const someOf = (next: () => number) => (fields: { readonly [key: string]: Json }): Json => Object.fromEntries(Object.entries(fields).filter(() => next() < 0.5))

/** A generated owner's server config: hand-set role fields and models, other agents, provider settings, unrelated keys. */
const ownerServer = (next: () => number): Json => {
  const [pick, some] = [pickOf(next), someOf(next)]
  const agent = () => some({ model: pick(["anthropic/claude-opus-4-1", "openai/sol-6", "anthropic/claude-opus-5-5"]), steps: pick([3, 9]), description: "mine", temperature: pick([0.2, 0.7]), color: "#123456" })
  return some({
    model: pick(["anthropic/claude-opus-5-5#medium", "openai/sol-6"]),
    autoupdate: pick([false, true, "notify"]),
    mcp: { local: { type: "local", command: ["x"] } },
    plugins: ["/elsewhere/plugin"],
    agents: some({ planner: agent(), implementor: agent(), verifier: agent(), worker: agent(), build: agent(), orchestrator: agent() }),
    providers: some({
      anthropic: some({ name: "Claude", settings: some({ timeout: 60_000, cache: some({ ttl: pick(["5m", "1h"]), other: 1 }) }) }),
      openai: { settings: { reasoningEffort: "high" } },
    }),
  })
}

/** A generated owner's TUI config. */
const ownerCli = (next: () => number): Json => {
  const some = someOf(next)
  return some({ $schema: "https://opencode.ai/tui.json", theme: some({ mode: "dark", name: "opencode-classic" }), tabs: some({ layout: "vertical", scope: "cwd" }), session: { sidebar: "auto" }, plugin: ["x"] })
}

describe("the settings a build carries in its tree", () => {
  test("over generated owner configs, the tree's overlay folded over the owner's global config gives the build's value for each key it names and the owner's for every other", () => {
    const tree = treeSettings(CATALOG)
    for (let seed = 1; seed <= 400; seed++) {
      const owner = ownerServer(random(seed))
      const folded = fold(owner, tree)
      // The build names exactly these keys.
      expect([seed, leaves(tree).map(([path]) => path).toSorted()]).toEqual([seed, SERVER_NAMED.toSorted()])
      // The build's value for each, over whatever the owner set.
      expect([seed, SERVER_NAMED.map((path) => folded.get(path))]).toEqual([seed, SERVER_NAMED.map((path) => Option.getOrThrow(valueAt(tree, path)))])
      // The owner's for every other leaf, his hand-set role fields among them.
      const others = leaves(owner).filter(([path]) => !SERVER_NAMED.includes(path))
      expect([seed, others.map(([path]) => [path, folded.get(path)])]).toEqual([seed, others])
    }
  })

  test("are each role's newest Opus and Claude's hour-long cache, and nothing else: no theme, no tab scope", () => {
    const opus = { model: "anthropic/claude-opus-5-5" }
    expect(treeSettings(CATALOG)).toEqual({ agents: { planner: opus, implementor: opus, verifier: opus, worker: opus }, providers: { anthropic: { settings: { cache: { ttl: "1h" } } } } })
  })

  test("follow a new Opus release: two catalogs that differ in the newest Opus give two builds two role models", () => {
    const later = { anthropic: { models: { ...CATALOG.anthropic.models, "claude-opus-6-0": { family: "claude-opus", release_date: "2026-12-01" } } } } satisfies Catalog
    expect([treeSettings(CATALOG), treeSettings(later)].map((settings) => valueAt(settings, "agents.worker.model"))).toEqual([Option.some("anthropic/claude-opus-5-5"), Option.some("anthropic/claude-opus-6-0")])
  })

  test("today's host config: folding the build's overlay over it changes no effective value, and by-hand daily adds nothing to its cli.json", () => {
    // The Mac's global configs as they stand (their shape, read 2026-11-20; no secret in them).
    const opus = { model: "anthropic/claude-opus-5-5" }
    const server = { agents: { planner: opus, implementor: opus, verifier: opus, worker: opus }, autoupdate: false, mcp: { local: { type: "local" } }, model: "anthropic/claude-opus-5-5#medium", plugins: ["/elsewhere/plugin"], providers: { anthropic: { settings: { cache: { ttl: "1h" } } } } }
    const cli = { $schema: "https://opencode.ai/tui.json", session: { sidebar: "auto" }, tabs: { scope: "window" }, theme: { name: "prime" } }
    expect([...fold(server, treeSettings(CATALOG))]).toEqual([...leaves(server)])
    expect([lacksCliDefault(cli), cliWith(cli)]).toEqual([false, cli])
    // The one change on purpose: a role model set by hand in the global file loses to the build's.
    const handSet = { ...server, agents: { ...server.agents, worker: { model: "openai/sol-6", steps: 4 } } }
    const folded = fold(handSet, treeSettings(CATALOG))
    expect([folded.get("agents.worker.model"), folded.get("agents.worker.steps")]).toEqual(["anthropic/claude-opus-5-5", 4])
  })

  test("the stage says which role models the build carries, and that they win over a hand-set one", () => {
    const overlay = jsonOf({ ...treeSettings(CATALOG), plugins: [orchestrateEntry("/t/orchestrate", CHECKOUTS, plannerModel(CATALOG))] })
    expect(roleLines(overlay)).toEqual([
      "roles (this build's, over a role model set by hand in ~/.config/opencode/opencode.json): planner anthropic/claude-opus-5-5, implementor anthropic/claude-opus-5-5, verifier anthropic/claude-opus-5-5, worker anthropic/claude-opus-5-5",
      "planner first: anthropic/claude-fable-5-2, then Opus, then Codex when the pool holds it",
    ])
    expect(roleLines("")).toEqual(["roles: the tree's overlay names none"])
  })
})

describe("the TUI config by hand", () => {
  test("over generated owner configs: the Prime theme and the window scope only where he has none, every value he has kept, nothing else added, and a write only when a default is added", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const owner = ownerCli(random(seed))
      const next = new Map(leaves(cliWith(owner)))
      // Every value of his stays, a picked theme or scope among them.
      expect([seed, leaves(owner).map(([path]) => [path, next.get(path)])]).toEqual([seed, leaves(owner)])
      // A default only where he has none, and nothing else added.
      const missing = CLI_DEFAULTS.filter(([path]) => Option.isNone(valueAt(owner, path)))
      expect([seed, Object.fromEntries([...next].filter(([path]) => Option.isNone(valueAt(owner, path))))]).toEqual([seed, Object.fromEntries(missing)])
      // Written only when one is added.
      expect([seed, lacksCliDefault(asObject(owner))]).toEqual([seed, missing.length > 0])
    }
  })
})

describe("the server config", () => {
  test("by hand gets no auto-update alone, every other key kept as it is: the role models, the providers, the plugins", () => {
    const existing = {
      model: "openai/gpt-6.1-sol",
      plugins: [`${MODS}/codex`, "/elsewhere/plugin"],
      agents: { verifier: { description: "mine", model: "openai/x" }, build: { model: "x/y" } },
      providers: { anthropic: { settings: { cache: { ttl: "5m" } } } },
    }
    const merged = hostServer(existing)
    expect(merged).toEqual({ ...existing, autoupdate: false })
    expect(merged.plugins).toBe(existing.plugins)
  })

  test("the writer never changes plugins: over generated configs, ours and foreign entries, bare and with options, any order or none, the plugin list comes out as it went in", () => {
    const ENTRIES: ReadonlyArray<PluginEntry> = [
      pluginDir("guard"),
      { package: pluginDir("pool"), options: { cacheLifeMs: 1 } },
      "/elsewhere/plugin",
      { package: "/elsewhere/configured", options: { keep: true } },
      BUILTIN_AUTOMATION_OFF,
      BUILTIN_BTW_OFF,
      "-opencode.tool.schedule",
      "/home/x/.local/share/opencode-prime/opencode-2.3.0-prime.aaaaaaaa.bbbbbbbb.tree.plugins/entries/server/pool",
    ]
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed)
      const plugins = ENTRIES.filter(() => next() < 0.5).toSorted(() => next() - 0.5)
      const existing = { plugins, theme: { name: "x" }, agents: { worker: { model: "a/b" } } }
      const before = jsonOf(existing)
      expect([seed, hostServer(existing).plugins]).toEqual([seed, plugins])
      expect(jsonOf(existing)).toBe(before)
    }
    // A config with no plugins key gets none.
    expect("plugins" in hostServer({})).toBe(false)
  })

  test("a stage writes no global config; a by-hand run writes the settings and no plugin entry", () => {
    const source = readFileSync(join(DOTFILES, "opencode/scripts/daily.ts"), "utf8")
    const main = source.slice(source.indexOf("if (import.meta.main) {"))
    const byHand = main.slice(main.indexOf('if (from.kind !== "tree") {'), main.indexOf("// Step 2, from the build's tree"))
    const stage = main.slice(main.indexOf("// Step 2, from the build's tree"))
    const calls = (text: string, names: ReadonlyArray<string>) => names.reduce((sum, name) => sum + text.split(`${name}(`).length - 1, 0)
    const from = source.indexOf("export const writeSettings = (")
    const writer = source.slice(from, source.indexOf("\n}\n", from))
    expect({
      byHand: calls(byHand, ["settingsByHand"]),
      stage: calls(stage, ["settingsByHand", "writeSettings", "writeTree"]),
      writerNamesPlugins: writer.includes("plugins"),
    }).toEqual({ byHand: 1, stage: 0, writerNamesPlugins: false })
  })

  test("a from-scratch host's settings by hand: no auto-update, the Prime theme and the window scope, the theme's file and the resident config, no role model and no plugins key; a second write touches no file, nor one over the owner's own picks", () => {
    using scratch = scratchDir("daily-settings-")
    const home = realpathSync(scratch.path)
    writeSettings(home)
    const config = join(home, ".config/opencode")
    const [server, cli] = [join(config, "opencode.json"), join(config, "cli.json")]
    const files = [server, cli, join(config, "themes/prime.json"), join(residentDir(home), "opencode.json")]
    const read = (path: string) => readFileSync(path, "utf8")
    expect(parseJson(read(server))).toEqual({ autoupdate: false })
    expect(parseJson(read(cli))).toEqual({ theme: { name: "prime" }, tabs: { scope: "window" } })
    // Each dated far back first: a write would date it now.
    const stamped = () => {
      for (const path of files) utimesSync(path, 946684800, 946684800)
      return files.map((path) => [read(path), statSync(path).mtimeMs])
    }
    const stamps = stamped()
    writeSettings(home)
    expect(files.map((path) => [read(path), statSync(path).mtimeMs])).toEqual(stamps)
    // The owner picks another theme and scope in the TUI, which writes cli.json in its own format: a later run writes nothing over them.
    writeFileSync(cli, `{\n    "$schema": "https://opencode.ai/tui.json",\n    "tabs": { "scope": "cwd" },\n    "theme": { "mode": "dark", "name": "opencode-classic" }\n}\n`)
    const picked = stamped()
    writeSettings(home)
    expect(files.map((path) => [read(path), statSync(path).mtimeMs])).toEqual(picked)
  })

  test("lists Prime's server half before memory, so its reply style precedes memory's digest, which stays last", () => {
    const at = (name: string) => SERVER_PLUGINS.indexOf(name)
    expect({ prime: at("prime") >= 0, beforeMemory: at("prime") < at("memory"), memoryLast: at("memory") > at("cache") }).toEqual({ prime: true, beforeMemory: true, memoryLast: true })
  })

  test("the build sets Claude's prompt cache to an hour, and the fold keeps the owner's other provider settings", () => {
    const existing = {
      providers: {
        openai: { settings: { reasoningEffort: "high" } },
        anthropic: { name: "Claude", settings: { timeout: 60_000, cache: { ttl: "5m" } } },
      },
    }
    expect(CLAUDE_CACHE_TTL).toBe("1h")
    expect([...fold(existing, treeSettings(CATALOG))].filter(([path]) => path.startsWith("providers."))).toEqual([
      ["providers.openai.settings.reasoningEffort", "high"],
      ["providers.anthropic.name", "Claude"],
      ["providers.anthropic.settings.timeout", 60_000],
      ["providers.anthropic.settings.cache.ttl", "1h"],
    ])
  })
})

describe("background compaction", () => {
  test("is default on in the fork (upstream #64290): daily removes the retired flag it wrote, and keeps the other experimental settings", () => {
    expect(hostServer({ experimental: { todo: true, background_compaction: true } }).experimental).toEqual({ todo: true })
    expect(hostServer({ experimental: { background_compaction: true } })).not.toHaveProperty("experimental")
    expect(hostServer({})).not.toHaveProperty("experimental")
  })

  const fork = process.env.OPENCODE_DEV
  test.skipIf(!fork)("the fork defines no background_compaction flag any more (OPENCODE_DEV)", () => {
    const registry = readFileSync(join(fork ?? "", "packages/schema/src/config/flag.ts"), "utf8")
    expect(registry).not.toMatch(/^\s+background_compaction:/m)
  })
})

describe("the pool's entry", () => {
  test("gives the pool the cache lifetime the config gives Claude, so a session stays on its cache's login as long as the cache lives", () => {
    const entry = poolEntry(`${MODS}/pool`, undefined)
    const ttl = Option.getOrThrow(Option.filter(valueAt(treeSettings(CATALOG), "providers.anthropic.settings.cache.ttl"), Schema.is(Schema.String)))
    expect(entry).toEqual({ package: `${MODS}/pool`, options: { cacheLifeMs: 3_600_000 } })
    // The ttl as OpenCode's cache settings write it, read by the cache mods' own parser.
    expect(parseTTL(ttl)).toMatchObject({ _tag: "Some", value: 3_600_000 })
  })

  test("adds the login store as a source when it has one", () => {
    expect(poolEntry(`${MODS}/pool`, "/home/.local/share/opencode-prime/pool-auth")).toEqual({
      package: `${MODS}/pool`,
      options: { cacheLifeMs: 3_600_000, sources: [{ kind: "store", dir: "/home/.local/share/opencode-prime/pool-auth" }] },
    })
  })

  test("on the MacBook and the workbox alike, the pool reads the login store in the home's opencode-prime data", () => {
    for (const [host, home] of [
      ["Cristians-MacBook-Pro.local", "/Users/cvr"],
      ["bite-cristian", "/home/exedev"],
    ] as const) {
      expect(poolEntry(`${MODS}/pool`, loginStoreDir(home), { host })).toMatchObject({
        options: { sources: [{ kind: "store", dir: `${home}/.local/share/opencode-prime/pool-auth` }] },
      })
    }
  })
})

describe("the pool's fleet", () => {
  test("on the MacBook and the workbox, paces OpenAI on the ChatGPT account and reads the other host over SSH", () => {
    expect(poolEntry(`${MODS}/pool`, undefined, { host: "Cristians-MacBook-Pro.local" })).toEqual({
      package: `${MODS}/pool`,
      options: {
        cacheLifeMs: 3_600_000,
        paced: { openai: "openai" },
        fleet: { host: "Cristians-MacBook-Pro.local", peers: [{ name: "workbox", ssh: "bite-workbox" }] },
      },
    })
    expect(peersOf("bite-cristian")).toEqual([{ name: "macbook", ssh: "cvr@cristians-macbook-pro" }])
    expect(peersOf("cristians-macbook-pro")).toEqual([{ name: "workbox", ssh: "bite-workbox" }])
  })

  test("mail listens on the Tailscale address on the owner's hosts only, and nowhere without one", () => {
    expect(mailEntry(`${MODS}/mail`, { host: "bite-cristian", tailscale: "100.64.0.2" })).toEqual({
      package: `${MODS}/mail`,
      options: { listen: { hostname: "100.64.0.2" } },
    })
    expect(mailEntry(`${MODS}/mail`, { host: "Cristians-MacBook-Pro.local", tailscale: undefined })).toBe(`${MODS}/mail`)
    expect(mailEntry(`${MODS}/mail`, { host: "ci-runner", tailscale: "100.64.0.9" })).toBe(`${MODS}/mail`)
  })

  test("on his hosts the digest's morning is his zone (the workbox is UTC), reading on the tailnet needs pairing, named outright, and each names itself and the other as its peer; elsewhere the host's zone and the plugin's paired default", () => {
    const his = { package: `${MODS}/digest`, options: { timezone: "America/Montreal", tailnetRead: "paired" } }
    expect(digestEntry(`${MODS}/digest`, { host: "bite-cristian" })).toEqual({ ...his, options: { ...his.options, name: "workbox", peers: [{ name: "macbook", host: "cristians-macbook-pro" }] } })
    expect(digestEntry(`${MODS}/digest`, { host: "Cristians-MacBook-Pro.local" })).toEqual({ ...his, options: { ...his.options, name: "macbook", peers: [{ name: "workbox", host: "bite-cristian" }] } })
    expect(digestEntry(`${MODS}/digest`, { host: "ci-runner" })).toBe(`${MODS}/digest`)
  })

  test("a tree's overlay replaces an earlier build's tailnetRead \"member\" with \"paired\": its plugin list comes whole from the host's facts", () => {
    const facts = { host: "bite-cristian", tailscale: Option.some("100.64.0.2"), fleet: CHECKOUTS, catalog: CATALOG, store: Option.none(), settings: settingsFor({ host: "bite-cristian", home: "/h", state: "/s", checkout: "/repo", fork: "/fork", bun: "/bun", resident: "/r", launcher: "/l" }) }
    // The overlay's plugins are serverEntries' list, written whole (writeTree's writeJson); an earlier build's entry does not survive.
    const earlier = { package: "/t/digest", options: { timezone: "America/Montreal", tailnetRead: "member" } }
    const plugins = serverEntries(facts, (name) => `/t/${name}`)
    expect(plugins).toContainEqual({ package: "/t/digest", options: { timezone: "America/Montreal", tailnetRead: "paired", name: "workbox", peers: [{ name: "macbook", host: "cristians-macbook-pro" }] } })
    expect(plugins).not.toContainEqual(earlier)
  })

  test("another host has no peers, and still paces OpenAI", () => {
    expect(poolEntry(`${MODS}/pool`, "/g", { host: "ci-runner" })).toMatchObject({
      options: {
        sources: [{ kind: "store", dir: "/g" }],
        paced: { openai: "openai" },
        fleet: { host: "ci-runner", peers: [] },
      },
    })
  })

  test("orchestrate asks the pool first for a Codex provider's agents, and names the checkouts an accepted verdict records the verified target from", () => {
    const entry = orchestrateEntry(`${MODS}/orchestrate`, CHECKOUTS)
    expect(entry).toEqual({ package: `${MODS}/orchestrate`, options: { codex: { pool: true }, fleet: CHECKOUTS } })
  })

  test("orchestrate's entry names the newest Fable as the planner's first model, and replaces an earlier run's options whole", () => {
    const catalog = { anthropic: { models: {
      "claude-fable-5-1": { family: "claude-fable", release_date: "2026-09-01" },
      "claude-fable-5-2": { family: "claude-fable", release_date: "2026-11-09" },
      "claude-opus-5-5": { family: "claude-opus", release_date: "2026-09-22" },
    } } }
    const planner = plannerModel(catalog as never)
    expect(planner).toBe("anthropic/claude-fable-5-2")
    const entry = orchestrateEntry(`${MODS}/orchestrate`, CHECKOUTS, planner)
    expect(entry).toEqual({ package: `${MODS}/orchestrate`, options: { codex: { pool: true }, fleet: CHECKOUTS, planner: { model: "anthropic/claude-fable-5-2" } } })
    // A catalog with no Fable names no first model, and the entry names none: the planner runs on Opus.
    expect(plannerModel({ anthropic: { models: {} } } as never)).toBeUndefined()
    expect(orchestrateEntry(`${MODS}/orchestrate`, CHECKOUTS, undefined)).toEqual({ package: `${MODS}/orchestrate`, options: { codex: { pool: true }, fleet: CHECKOUTS } })
  })
})

describe("the TUI config's defaults", () => {
  test("set the Prime theme only where the owner has none, and keep his other theme keys", () => {
    expect(cliWith({ theme: { mode: "dark" }, session: { sidebar: "auto" }, plugins: [`${MODS}/prime`, "/x"] })).toEqual({ theme: { name: "prime", mode: "dark" }, session: { sidebar: "auto" }, plugins: [`${MODS}/prime`, "/x"], tabs: { scope: "window" } })
    expect(cliWith({ theme: { name: "system", mode: "dark" }, tabs: { scope: "cwd" } })).toEqual({ theme: { name: "system", mode: "dark" }, tabs: { scope: "cwd" } })
  })

  test("keep each window's tabs its own where the owner chose no scope, keeping the other tab settings", () => {
    expect(cliWith({ tabs: { layout: "vertical" } })).toEqual({ tabs: { scope: "window", layout: "vertical" }, theme: { name: "prime" } })
  })
})

describe("the server plugins", () => {
  test("daily's server list names work, not rift, from its cmd/ root", () => {
    expect([SERVER_PLUGINS.filter((name) => name === "work").length, SERVER_PLUGINS.filter((name) => name === "rift").length]).toEqual([1, 0])
    expect(pluginDir("work").endsWith("/opencode/cmd/work")).toBe(true)
  })

  test("the built-in automation plugin is turned off by its name after upstream's rename", () => {
    expect(BUILTIN_AUTOMATION_OFF).toBe("-opencode.tool.automation")
  })
})

describe("the role models", () => {
  const catalog = {
    anthropic: { models: {
      "claude-opus-5-0": { family: "claude-opus", release_date: "2026-03-01" },
      "claude-opus-5-5": { family: "claude-opus", release_date: "2026-09-22" },
      "claude-haiku-5-5": { family: "claude-haiku", release_date: "2026-10-07" },
    } },
    openai: { models: {
      "gpt-6-sol": { family: "gpt-sol", release_date: "2026-06-01" },
      "gpt-6.1-sol": { family: "gpt-sol", release_date: "2026-09-29" },
      "gpt-7-sol": { family: "gpt-sol", release_date: "2026-12-01", status: "deprecated" },
    } },
  }
  test("the newest Opus runs every role, the verifier too", () => {
    expect(roleModels(catalog as never)).toEqual({
      planner: "anthropic/claude-opus-5-5",
      implementor: "anthropic/claude-opus-5-5",
      verifier: "anthropic/claude-opus-5-5",
      worker: "anthropic/claude-opus-5-5",
    })
  })
})

describe("the upstream merge", () => {
  // Real git on local repositories: `upstream` and `origin` are bare repos beside the fork, so
  // nothing touches the network. A scratch git config keeps the owner's hooks and signing out.
  /**
   * The test's own git env, handed to every git child (its own and `mergeUpstream`'s and `syncFork`'s),
   * never written to this process's env: no global or system config, no inherited GIT_* variable.
   */
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "daily test",
    GIT_AUTHOR_EMAIL: "daily@test.invalid",
    GIT_COMMITTER_NAME: "daily test",
    GIT_COMMITTER_EMAIL: "daily@test.invalid",
  }
  const sync = (options: Omit<Parameters<typeof syncFork>[0], "env">) => syncFork({ ...options, env })

  const git = (dir: string, ...args: string[]) => {
    const ran = Bun.spawnSync(["git", "-C", dir, ...args], { env, stdout: "pipe", stderr: "pipe" })
    if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`)
    return ran.stdout.toString().trim()
  }
  /** Commits `files` on `branch` of the bare repo `remote` through a scratch clone. */
  const commitTo = (remote: string, branch: string, files: Record<string, string>) => {
    using clone = scratchDir("daily-push-")
    const scratch = realpathSync(clone.path)
    gitClone(remote, scratch, ["--quiet", "--branch", branch], env)
    for (const [file, text] of Object.entries(files)) writeFileSync(join(scratch, file), text)
    git(scratch, "add", "-A")
    git(scratch, "commit", "--quiet", "-m", `change ${Object.keys(files).join(" ")}`)
    git(scratch, "push", "--quiet", "origin", branch)
  }

  /** upstream/dev and origin/prime-look share one root commit; the fork has prime-look checked out. Held with `using`, its repositories go when the test ends. */
  const fixture = () => {
    const held = scratchDir("daily-upstream-")
    const root = realpathSync(held.path)
    const upstream = join(root, "upstream.git")
    const origin = join(root, "origin.git")
    const seed = join(root, "seed")
    gitInit(upstream, ["--quiet", "--bare"], env)
    gitInit(origin, ["--quiet", "--bare"], env)
    gitInit(seed, ["--quiet", "-b", "dev"], env)
    writeFileSync(join(seed, "a.txt"), "one\n")
    git(seed, "add", "-A")
    git(seed, "commit", "--quiet", "-m", "root")
    git(seed, "push", "--quiet", upstream, "dev")
    git(seed, "push", "--quiet", origin, "dev:prime-look")
    const fork = join(root, "fork")
    gitClone(origin, fork, ["--quiet", "--branch", "prime-look"], env)
    git(fork, "remote", "add", "upstream", upstream)
    const calls: string[] = []
    const options = (overrides: Partial<UpstreamOptions> = {}): UpstreamOptions => ({
      fork,
      host: "Cristians-MacBook-Pro.local",
      skip: false,
      dryRun: false,
      checks: async (dir) => {
        calls.push(dir)
        return { ok: true }
      },
      landing: unlocked,
      worktree: join(root, "state/upstream-merge"),
      report: join(root, "state/upstream-conflict.md"),
      log: () => {},
      ...overrides,
      env,
    })
    const head = (dir: string, ref: string) => git(dir, "rev-parse", ref)
    return { root, upstream, origin, fork, calls, options, head, [Symbol.dispose]: held[Symbol.dispose] }
  }

  test("up to date: nothing merges, nothing runs, and a stale report goes", async () => {
    using f = fixture()
    const before = f.head(f.fork, "prime-look")
    mkdirSync(join(f.root, "state"))
    writeFileSync(f.options().report, "# old conflict\n")
    expect(await mergeUpstream(f.options())).toEqual({ kind: "up-to-date" })
    expect(f.head(f.fork, "prime-look")).toBe(before)
    expect(f.calls).toEqual([])
    expect(existsSync(f.options().report)).toBe(false)
  })

  test("a clean merge whose checks pass goes to origin by its fetch URL, past the push URL work gives an adopted copy (post-land 2026-11-16), and only then fast-forwards prime-look, inside `landing` alone", async () => {
    using f = fixture()
    // work's rule on every workspace, the adopted fork among them: a push by the remote's name is refused.
    git(f.fork, "config", "remote.origin.pushurl", "no-push:workspaces-never-push-origin")
    // Upstream's lockfile change reaches the checkout's packages: the fast-forward installs it there.
    commitTo(f.upstream, "dev", { "b.txt": "upstream\n", "bun.lock": "{ lock: upstream }\n" })
    commitTo(f.origin, "prime-look", { "c.txt": "ours\n" })
    git(f.fork, "pull", "--quiet", "--ff-only", "origin", "prime-look")
    const before = f.head(f.fork, "prime-look")
    const seen: string[] = []
    const installs: string[] = []
    const install = (dir: string) => {
      installs.push(`${dir} ${readFileSync(join(dir, "bun.lock"), "utf8").trim()}`)
      return { ok: true, err: "" }
    }
    const landing = <A>(step: () => A): A => {
      seen.push(f.head(f.fork, "prime-look"))
      const answer = step()
      seen.push(f.head(f.fork, "prime-look"), f.head(f.origin, "prime-look"))
      return answer
    }
    const outcome = await mergeUpstream(f.options({ landing, install }))
    expect(installs).toEqual([`${f.fork} { lock: upstream }`])
    expect(outcome).toMatchObject({ kind: "merged", from: before, commits: 1 })
    const merge = f.head(f.fork, "prime-look")
    expect(merge).not.toBe(before)
    // origin holds the merge before the checkout moves to it.
    expect(seen).toEqual([before, merge, merge])
    // A merge commit: ours first, upstream's second, checked in the worktree, never in the fork.
    expect(git(f.fork, "rev-list", "--parents", "-n", "1", merge).split(" ")).toEqual([merge, before, f.head(f.upstream, "dev")])
    expect(f.calls).toEqual([f.options().worktree])
    expect(f.head(f.origin, "prime-look")).toBe(merge)
    // origin/prime-look moved as a push by the remote's name would move it.
    expect(git(f.fork, "rev-parse", "refs/remotes/origin/prime-look")).toBe(merge)
    // The fork had prime-look checked out, so its working tree followed.
    expect(readFileSync(join(f.fork, "b.txt"), "utf8")).toBe("upstream\n")
    expect(existsSync(f.options().report)).toBe(false)
  })

  test("a conflict aborts, leaves prime-look and origin unchanged, and reports the files", async () => {
    using f = fixture()
    commitTo(f.upstream, "dev", { "a.txt": "upstream\n" })
    commitTo(f.origin, "prime-look", { "a.txt": "ours\n" })
    git(f.fork, "pull", "--quiet", "--ff-only", "origin", "prime-look")
    const before = f.head(f.fork, "prime-look")
    const lines: string[] = []
    const outcome = await mergeUpstream(f.options({ log: (line) => lines.push(line) }))
    expect(outcome).toMatchObject({ kind: "conflict", files: ["a.txt"] })
    expect(f.head(f.fork, "prime-look")).toBe(before)
    expect(f.head(f.origin, "prime-look")).toBe(before)
    expect(f.calls).toEqual([])
    expect(lines).toContain("  a.txt")
    expect(readFileSync(f.options().report, "utf8")).toContain("- a.txt")
    // No merge left half-done in the worktree, and the fork's own tree untouched.
    expect(existsSync(join(f.options().worktree, ".git"))).toBe(true)
    expect(Bun.spawnSync(["git", "-C", f.options().worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD"], { env }).exitCode).not.toBe(0)
    expect(readFileSync(join(f.fork, "a.txt"), "utf8")).toBe("ours\n")
  })

  test("red checks leave prime-look and origin unchanged, keep the merge on a branch and report the check", async () => {
    using f = fixture()
    commitTo(f.upstream, "dev", { "b.txt": "upstream\n" })
    const before = f.head(f.fork, "prime-look")
    const landed: string[] = []
    const outcome = await mergeUpstream(
      f.options({
        checks: async () => ({ ok: false, check: "typecheck packages/tui", log: "error TS2304: Cannot find name 'x'" }),
        landing: (step) => {
          landed.push("called")
          return step()
        },
      }),
    )
    expect(outcome).toMatchObject({ kind: "red", check: "typecheck packages/tui" })
    expect(landed).toEqual([])
    expect(f.head(f.fork, "prime-look")).toBe(before)
    expect(f.head(f.origin, "prime-look")).toBe(before)
    expect(f.head(f.fork, HELD_BRANCH)).toBe(outcome.kind === "red" ? outcome.merge : "")
    const report = readFileSync(f.options().report, "utf8")
    expect(report).toContain("typecheck packages/tui")
    expect(report).toContain("error TS2304")
    expect(existsSync(join(f.fork, "b.txt"))).toBe(false)
  })

  /** The fork's checkout as it stands: its branch's commit and its working tree's status. */
  const checkoutOf = (f: ReturnType<typeof fixture>) => ({ head: f.head(f.fork, "prime-look"), status: git(f.fork, "status", "--porcelain") })
  /** The step's outcome, as an Effect the test's generator yields. */
  const merged = (options: UpstreamOptions) => Effect.promise(() => mergeUpstream(options))
  /** A check that passes. */
  const green = () => Effect.runPromise(Effect.succeed<CheckResult>({ ok: true }))

  // Post-land 2026-11-20, twice: prime-look fast-forwarded to the merge, then the push failed, and the
  // shared checkout sat on a merge no remote held while origin moved on without it.
  test("a push origin refuses leaves prime-look, its working tree and origin where they were, keeps the merge and reports the cause once", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        using f = fixture()
        commitTo(f.upstream, "dev", { "b.txt": "upstream\n" })
        const hook = join(f.origin, "hooks/pre-receive")
        writeFileSync(hook, "#!/bin/sh\necho 'refused by the test hook' >&2\nexit 1\n")
        chmodSync(hook, 0o755)
        const before = checkoutOf(f)
        const lines: string[] = []
        const outcome = yield* merged(f.options({ log: (line) => lines.push(line) }))
        expect(outcome).toMatchObject({ kind: "stuck", merge: f.head(f.fork, HELD_BRANCH) })
        expect(checkoutOf(f)).toEqual(before)
        expect(existsSync(join(f.fork, "b.txt"))).toBe(false)
        expect(f.head(f.origin, "prime-look")).toBe(before.head)
        expect(readFileSync(f.options().report, "utf8")).toContain("refused by the test hook")
        const said = lines.filter((line) => line.includes("push"))
        expect(said).toHaveLength(1)
        expect(said[0]).toContain("refused by the test hook")
      }),
    ))

  test("origin moving during the merge: the step starts over from origin's head and lands on top of it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        using f = fixture()
        commitTo(f.upstream, "dev", { "b.txt": "upstream\n" })
        const calls: string[] = []
        const checks = (dir: string) => {
          if (calls.length === 0) commitTo(f.origin, "prime-look", { "c.txt": "pushed meanwhile\n" })
          calls.push(dir)
          return green()
        }
        const outcome = yield* merged(f.options({ checks }))
        const merge = f.head(f.origin, "prime-look")
        const moved = git(f.origin, "rev-parse", "prime-look^1")
        expect(outcome).toEqual({ kind: "merged", from: moved, merge, commits: 1 })
        expect(calls).toHaveLength(2)
        expect(git(f.fork, "rev-list", "--parents", "-n", "1", merge).split(" ")).toEqual([merge, moved, f.head(f.upstream, "dev")])
        // The checkout went straight to origin's merge: never on a commit origin lacks.
        expect(f.head(f.fork, "prime-look")).toBe(merge)
        expect(readFileSync(join(f.fork, "c.txt"), "utf8")).toBe("pushed meanwhile\n")
        expect(readFileSync(join(f.fork, "b.txt"), "utf8")).toBe("upstream\n")
      }),
    ))

  test("origin moving on every try: the step gives up with prime-look and its working tree where they were, and says why", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        using f = fixture()
        commitTo(f.upstream, "dev", { "b.txt": "upstream\n" })
        const before = checkoutOf(f)
        let tries = 0
        const checks = () => {
          commitTo(f.origin, "prime-look", { "c.txt": `pushed meanwhile ${++tries}\n` })
          return green()
        }
        const outcome = yield* merged(f.options({ checks }))
        expect(outcome).toMatchObject({ kind: "stuck", reason: expect.stringContaining(`origin prime-look moved during each of ${ATTEMPTS} merges`) })
        expect(tries).toBe(ATTEMPTS)
        expect(checkoutOf(f)).toEqual(before)
        expect(existsSync(join(f.fork, "c.txt"))).toBe(false)
        expect(readFileSync(f.options().report, "utf8")).toContain("origin kept moving")
      }),
    ))

  test("a prime-look with commits origin lacks is not merged: the merge would publish them", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        using f = fixture()
        commitTo(f.upstream, "dev", { "b.txt": "upstream\n" })
        writeFileSync(join(f.fork, "d.txt"), "local\n")
        git(f.fork, "add", "d.txt")
        git(f.fork, "commit", "--quiet", "-m", "local only")
        const before = checkoutOf(f)
        const origin = f.head(f.origin, "prime-look")
        expect(yield* merged(f.options())).toMatchObject({ kind: "skipped", reason: expect.stringContaining("1 commit not on origin") })
        expect(checkoutOf(f)).toEqual(before)
        expect(f.head(f.origin, "prime-look")).toBe(origin)
        expect(f.calls).toEqual([])
      }),
    ))

  test("the workbox, and --no-upstream, skip it without fetching", async () => {
    using f = fixture()
    commitTo(f.upstream, "dev", { "b.txt": "upstream\n" })
    expect(await mergeUpstream(f.options({ host: "bite-cristian" }))).toMatchObject({ kind: "skipped" })
    expect(await mergeUpstream(f.options({ skip: true }))).toEqual({ kind: "skipped", reason: "--no-upstream" })
    expect(Bun.spawnSync(["git", "-C", f.fork, "rev-parse", "-q", "--verify", "refs/remotes/upstream/dev"], { env }).exitCode).not.toBe(0)
    expect(existsSync(f.options().worktree)).toBe(false)
  })

  test("a dry run says what would merge and changes nothing", async () => {
    using f = fixture()
    commitTo(f.upstream, "dev", { "b.txt": "upstream\n" })
    const before = f.head(f.fork, "prime-look")
    expect(await mergeUpstream(f.options({ dryRun: true }))).toMatchObject({ kind: "would-merge", commits: 1 })
    expect(f.head(f.fork, "prime-look")).toBe(before)
    expect(existsSync(f.options().worktree)).toBe(false)
    expect(f.calls).toEqual([])
  })

  // The fork checkout can fall behind origin when prime-look moved from another checkout; merging
  // upstream into the stale branch redoes conflicts origin already resolved and builds old code.
  test("a fork behind origin fast-forwards to origin/prime-look, untracked files kept, so the merge starts from it", async () => {
    using f = fixture()
    const stale = f.head(f.fork, "prime-look")
    commitTo(f.origin, "prime-look", { "c.txt": "pushed elsewhere\n" })
    writeFileSync(join(f.fork, "scratch.txt"), "untracked\n")
    const lines: string[] = []
    expect(sync({ fork: f.fork, dryRun: false, log: (line) => lines.push(line) })).toMatchObject({ kind: "fast-forwarded", from: stale, commits: 1 })
    expect(f.head(f.fork, "prime-look")).toBe(f.head(f.origin, "prime-look"))
    expect(readFileSync(join(f.fork, "c.txt"), "utf8")).toBe("pushed elsewhere\n")
    expect(readFileSync(join(f.fork, "scratch.txt"), "utf8")).toBe("untracked\n")
    expect(lines.join("\n")).toContain("fast-forwarded")
    const pushed = f.head(f.origin, "prime-look")
    commitTo(f.upstream, "dev", { "b.txt": "upstream\n" })
    // The merge starts from origin's head, not the stale one, and lands as a fast-forward of origin.
    expect(await mergeUpstream(f.options())).toMatchObject({ kind: "merged", from: pushed })
    expect(git(f.fork, "rev-parse", "prime-look^1")).toBe(pushed)
    // Current: nothing to do.
    expect(sync({ fork: f.fork, dryRun: false, log: () => {} })).toEqual({ kind: "current" })
  })

  // 2026-11-20: prime-look moved to a commit with another lockfile and no install; its old packages
  // hung Code Mode and turned tests/image.test.ts red.
  test("a fast-forward whose bun.lock changed installs it in the checkout, and one whose bun.lock did not installs nothing", () => {
    using f = fixture()
    commitTo(f.origin, "prime-look", { "bun.lock": "{ lock: 1 }\n" })
    git(f.fork, "pull", "--quiet", "--ff-only", "origin", "prime-look")
    const installs: string[] = []
    const install = (dir: string) => {
      installs.push(`${dir} ${readFileSync(join(dir, "bun.lock"), "utf8").trim()}`)
      return { ok: true, err: "" }
    }
    commitTo(f.origin, "prime-look", { "c.txt": "no lock change\n" })
    expect(sync({ fork: f.fork, dryRun: false, log: () => {}, install })).toMatchObject({ kind: "fast-forwarded" })
    expect(installs).toEqual([])
    commitTo(f.origin, "prime-look", { "bun.lock": "{ lock: 2 }\n" })
    expect(sync({ fork: f.fork, dryRun: false, log: () => {}, install })).toMatchObject({ kind: "fast-forwarded" })
    expect(installs).toEqual([`${f.fork} { lock: 2 }`])
    // A failed install is said, and the move stands.
    commitTo(f.origin, "prime-look", { "bun.lock": "{ lock: 3 }\n" })
    const lines: string[] = []
    const failing = () => ({ ok: false, err: "error: lockfile had changes, but lockfile is frozen" })
    expect(sync({ fork: f.fork, dryRun: false, log: (line) => lines.push(line), install: failing })).toMatchObject({ kind: "fast-forwarded" })
    expect(f.head(f.fork, "prime-look")).toBe(f.head(f.origin, "prime-look"))
    expect(lines.join("\n")).toContain(`bun install --frozen-lockfile in ${f.fork} failed`)
  })

  test("a fork with local commits or tracked changes is left alone, and says so", () => {
    using f = fixture()
    commitTo(f.origin, "prime-look", { "c.txt": "pushed elsewhere\n" })
    writeFileSync(join(f.fork, "d.txt"), "local\n")
    git(f.fork, "add", "d.txt")
    git(f.fork, "commit", "--quiet", "-m", "local only")
    const diverged = f.head(f.fork, "prime-look")
    const lines: string[] = []
    expect(sync({ fork: f.fork, dryRun: false, log: (line) => lines.push(line) })).toMatchObject({ kind: "left" })
    expect(f.head(f.fork, "prime-look")).toBe(diverged)
    expect(lines.join("\n")).toContain("1 commit not on origin")

    using g = fixture()
    commitTo(g.origin, "prime-look", { "c.txt": "pushed elsewhere\n" })
    const before = g.head(g.fork, "prime-look")
    writeFileSync(join(g.fork, "a.txt"), "edited\n")
    const said: string[] = []
    expect(sync({ fork: g.fork, dryRun: false, log: (line) => said.push(line) })).toMatchObject({ kind: "left" })
    expect(g.head(g.fork, "prime-look")).toBe(before)
    expect(readFileSync(join(g.fork, "a.txt"), "utf8")).toBe("edited\n")
    expect(said.join("\n")).toContain("uncommitted changes")
  })

  test("a dry run says it would fast-forward and moves nothing", () => {
    using f = fixture()
    const before = f.head(f.fork, "prime-look")
    commitTo(f.origin, "prime-look", { "c.txt": "pushed elsewhere\n" })
    expect(sync({ fork: f.fork, dryRun: true, log: () => {} })).toEqual({ kind: "would-fast-forward", commits: 1 })
    expect(f.head(f.fork, "prime-look")).toBe(before)
  })

  test("with a target commit, the fork fast-forwards to it and no further, though origin is past it", () => {
    using f = fixture()
    commitTo(f.origin, "prime-look", { "c.txt": "verified\n" })
    const verified = f.head(f.origin, "prime-look")
    commitTo(f.origin, "prime-look", { "c.txt": "not verified yet\n" })
    expect(sync({ fork: f.fork, dryRun: false, to: verified, log: () => {} })).toMatchObject({ kind: "fast-forwarded", to: verified, commits: 1 })
    expect(f.head(f.fork, "prime-look")).toBe(verified)
    expect(sync({ fork: f.fork, dryRun: false, to: verified, log: () => {} })).toEqual({ kind: "current" })
  })

  test("the checks run Prime's, the TUI's CPU, mail and orchestrate acceptance tests", () => {
    const tests = exposedTests(resolve(import.meta.dir, ".."))
    expect(tests).toContain("./tests/prime-rows.test.ts")
    expect(tests).toContain("./tests/tui-cpu.test.ts")
    expect(tests).toContain("./tests/mail.test.ts")
    expect(tests).toContain("./tests/orchestrate.test.ts")
    expect(tests).not.toContain("./tests/mail-peer.test.ts")
    expect(tests.every((file) => /\/(prime-[^/]+|tui-cpu|mail|orchestrate)\.test\.ts$/.test(file))).toBe(true)
  })
})

describe("the fork move", () => {
  const kept = keptScratch(true, "daily-move-")
  /** The land's locks of a host whose cache is a fresh scratch folder. */
  const scratchLocks = () => hostLocks({ XDG_CACHE_HOME: kept.dir("cache-") })
  const moved = () => ({ kind: "fast-forwarded", from: "a", to: "b", commits: 1 }) as const
  const none = () => {}

  test(
    "a failed install after the move to origin is logged, lets go of the land's checks lock, and fails daily with the install's own error (a lock never let go times the test out)",
    () => {
      const locks = scratchLocks()
      const failed = { install: "bun install --frozen-lockfile: exit 1" }
      const lines: Array<string> = []
      expect(moveFork(locks.move, moved, Effect.succeed("b\n"), Effect.die(failed), (line) => lines.push(line))).rejects.toBe(failed)
      expect(lines).toEqual(["daily: the fork's install after its move to b failed; daily stops before the build"])
      return moveFork(locks.move, () => ({ kind: "current" }), Effect.succeed("b"), Effect.die("installed"), none)
    },
    2000,
  )

  test("each step daily runs on prime-look starts and ends while its lock is held: the move and its install under the checks lock, the fork tests under the accept lock, the install after a merge under the checks lock", () => {
    const events: Array<string> = []
    /** A lock that records when it is taken and, once the step it was handed has settled, let go. */
    const recording =
      (lock: string) =>
      <A,>(step: () => Promise<A>) =>
        Effect.runPromise(
          Effect.sync(() => events.push(`${lock} taken`)).pipe(
            Effect.andThen(Effect.promise(step)),
            Effect.ensuring(Effect.sync(() => events.push(`${lock} let go`))),
          ),
        )
    /** An asynchronous step: its start, a pause, its end. */
    const timed = <A,>(name: string, value: A) =>
      Effect.sync(() => events.push(`${name} starts`)).pipe(
        Effect.andThen(Effect.sleep("5 millis")),
        Effect.andThen(Effect.sync(() => events.push(`${name} ends`))),
        Effect.as(value),
      )
    const sync = () => {
      events.push("sync")
      return moved()
    }
    const steps = forkSteps({ move: recording("checks"), tests: recording("accept") }, { sync, head: Effect.succeed("b"), install: timed("install", "installed"), checks: (dir) => timed("tests", dir), log: none })
    expect(steps.move()).resolves.toEqual(moved())
    expect(events.splice(0)).toEqual(["checks taken", "sync", "install starts", "install ends", "checks let go"])
    expect(steps.checks("merge")).resolves.toBe("merge")
    expect(events.splice(0)).toEqual(["accept taken", "tests starts", "tests ends", "accept let go"])
    expect(steps.reinstall()).resolves.toBe("installed")
    expect(events.splice(0)).toEqual(["checks taken", "install starts", "install ends", "checks let go"])
  })

  test("installs the dotfiles workspace only after registering the merge driver in daily's own checkout, the dotfiles root; a checkout that routes nothing to the driver fails before the install", () => {
    expect(DOTFILES).toBe(resolve(".."))
    const installs: Array<string> = []
    expect(installDotfiles(resolve("."), Effect.sync(() => installs.push("install")))).rejects.toThrow("routes no file to the merge driver effect-debt")
    expect(installs).toEqual([])
  })

  test(
    "installs nothing when the fork did not move",
    kept.test(() => expect(moveFork(scratchLocks().move, () => ({ kind: "current" }), Effect.succeed("b"), Effect.die("installed"), none)).resolves.toEqual({ kind: "current" })),
  )

  test(
    "installs nothing when the fork moved but is checked out elsewhere",
    kept.test(() => expect(moveFork(scratchLocks().move, moved, Effect.succeed("c"), Effect.die("installed"), none)).resolves.toEqual(moved())),
  )
})

describe("the installed build's record", () => {
  test("lives in OpenCode's state directory, which XDG_STATE_HOME moves", () => {
    expect(installedFile("/h", {})).toBe("/h/.local/state/opencode/installed.json")
    expect(installedFile("/h", { XDG_STATE_HOME: "/x" })).toBe("/x/opencode/installed.json")
  })
})

describe("the resident location", () => {
  test("is a directory of its own whose config keeps it loaded", () => {
    expect(residentDir("/home/x")).toBe("/home/x/.local/state/opencode-prime/resident")
    expect(residentConfig).toEqual({ experimental: { location_idle_timeout: false } })
  })
})
