// `bun run daily`'s config merge: ours replaces only what it owns, and the roles cross families.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseTTL } from "../mods/idle-compact/cache.ts"
import { anthropicAuthPlugin } from "../testbeds/anthropic-auth.ts"
import { BUILTIN_BTW_OFF, CLAUDE_CACHE_TTL, launcher, mergeCli, mergeServer, orchestrateEntry, peersOf, pluginDir, poolEntry, roleModels } from "./daily.ts"

const MODS = "/repo/opencode/mods"
const CMD = "/repo/opencode/cmd"
const AUTH = "/home/.local/share/opencode-prime/anthropic-auth"

describe("the server config", () => {
  test("puts our plugins first, replaces our old entries and keeps everyone else's", () => {
    const existing = {
      model: "openai/gpt-6.1-sol",
      plugins: [`${MODS}/codex`, { package: `${MODS}/pool`, options: { old: true } }, "/elsewhere/plugin", AUTH],
      agents: { verifier: { description: "mine" }, build: { model: "x/y" } },
    }
    const merged = mergeServer(existing, [AUTH, { package: `${MODS}/pool` }, `${MODS}/orchestrate`], { verifier: "openai/gpt-6.1-sol" }, [MODS, AUTH])
    expect(merged.plugins).toEqual([AUTH, { package: `${MODS}/pool` }, `${MODS}/orchestrate`, "/elsewhere/plugin"])
    expect(merged.agents).toEqual({ verifier: { description: "mine", model: "openai/gpt-6.1-sol" }, build: { model: "x/y" } })
    expect(merged.model).toBe("openai/gpt-6.1-sol")
    expect(merged.autoupdate).toBe(false)
    expect(merged.providers).toEqual({ anthropic: { settings: { cache: { ttl: "1h" } } } })
  })

  test("a plugin that moved from mods/ to its cmd/ composition root replaces its old entry, never doubles it", () => {
    expect(anthropicAuthPlugin.endsWith("/opencode/cmd/anthropic-auth")).toBe(true)
    const existing = { plugins: [`${MODS}/anthropic-auth`, "/elsewhere/plugin"] }
    const merged = mergeServer(existing, [`${CMD}/anthropic-auth`], {}, [MODS, CMD])
    expect(merged.plugins).toEqual([`${CMD}/anthropic-auth`, "/elsewhere/plugin"])
  })

  test("sets Claude's prompt cache to an hour and keeps the other provider settings", () => {
    const existing = {
      providers: {
        openai: { settings: { reasoningEffort: "high" } },
        anthropic: { name: "Claude", settings: { timeout: 60_000, cache: { ttl: "5m" } } },
      },
    }
    const merged = mergeServer(existing, [], {}, [MODS])
    expect(CLAUDE_CACHE_TTL).toBe("1h")
    expect(merged.providers).toEqual({
      openai: { settings: { reasoningEffort: "high" } },
      anthropic: { name: "Claude", settings: { timeout: 60_000, cache: { ttl: "1h" } } },
    })
  })
})

describe("the pool's entry", () => {
  test("gives the pool the cache lifetime the config gives Claude, so a session stays on its cache's login as long as the cache lives", () => {
    const entry = poolEntry(`${MODS}/pool`, undefined)
    const ttl = (mergeServer({}, [entry], {}, [MODS]).providers as { anthropic: { settings: { cache: { ttl: string } } } }).anthropic.settings.cache.ttl
    expect(entry).toEqual({ package: `${MODS}/pool`, options: { cacheLifeMs: 3_600_000 } })
    // The ttl as OpenCode's cache settings write it, read by the cache mods' own parser.
    expect(parseTTL(ttl)).toMatchObject({ _tag: "Some", value: 3_600_000 })
  })

  test("adds gent's store as a source when it has one", () => {
    expect(poolEntry(`${MODS}/pool`, "/home/.local/share/gent/auth")).toEqual({
      package: `${MODS}/pool`,
      options: { cacheLifeMs: 3_600_000, sources: [{ kind: "gent", dir: "/home/.local/share/gent/auth" }] },
    })
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

  test("another host has no peers, and still paces OpenAI", () => {
    expect(poolEntry(`${MODS}/pool`, "/g", { host: "ci-runner" })).toMatchObject({
      options: {
        sources: [{ kind: "gent", dir: "/g" }],
        paced: { openai: "openai" },
        fleet: { host: "ci-runner", peers: [] },
      },
    })
  })

  test("orchestrate asks the pool first for a Codex provider's agents, so they pace on every host's spend", () => {
    const entry = orchestrateEntry(`${MODS}/orchestrate`)
    expect(entry).toEqual({ package: `${MODS}/orchestrate`, options: { codex: { pool: true } } })
    // It replaces the bare entry an older run wrote, as every entry from our dirs is.
    expect(mergeServer({ plugins: [`${MODS}/orchestrate`] }, [entry], {}, [MODS]).plugins).toEqual([entry])
  })
})

describe("the TUI config", () => {
  test("loads Prime first, sets the Prime theme and keeps the other keys", () => {
    const merged = mergeCli({ theme: { name: "system", mode: "dark" }, session: { sidebar: "auto" }, plugins: [`${MODS}/prime`, "/x"] }, [`${MODS}/prime`, `${MODS}/status`], [MODS])
    expect(merged).toEqual({ theme: { name: "prime", mode: "dark" }, session: { sidebar: "auto" }, plugins: [`${MODS}/prime`, `${MODS}/status`, "/x"] })
  })

  test("Prime loads from its cmd/ composition root, and that entry replaces the old mods/prime one", () => {
    expect(pluginDir("prime").endsWith("/opencode/cmd/prime")).toBe(true)
    const existing = { theme: { name: "prime", mode: "dark" }, plugins: [`${MODS}/prime`, `${MODS}/status`, "/x"] }
    const merged = mergeCli(existing, [`${CMD}/prime`, `${CMD}/status`], [MODS, CMD])
    expect(merged.plugins).toEqual([`${CMD}/prime`, `${CMD}/status`, "/x"])
  })
})

describe("the TUI config's built-in /btw", () => {
  test("is turned off once, however many runs merged it", () => {
    const once = mergeCli({ plugins: ["/x"] }, [`${MODS}/btw`, BUILTIN_BTW_OFF], [MODS])
    expect(mergeCli(once, [`${MODS}/btw`, BUILTIN_BTW_OFF], [MODS]).plugins).toEqual([`${MODS}/btw`, BUILTIN_BTW_OFF, "/x"])
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
  test("newest Opus plans and implements; the verifier is the newest sol", () => {
    expect(roleModels(catalog as never)).toEqual({
      planner: "anthropic/claude-opus-5-5",
      implementor: "anthropic/claude-opus-5-5",
      verifier: "openai/gpt-6.1-sol",
    })
  })
})

describe("the opencode launcher", () => {
  test("runs the binary with the caller's arguments and without its Anthropic routing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "launcher it's-"))
    const binary = join(dir, "opencode-fake")
    writeFileSync(binary, '#!/bin/sh\necho "base=${ANTHROPIC_BASE_URL:-unset} insecure=${ANTHROPIC_INSECURE:-unset} home=$HOME args=$*"\n')
    chmodSync(binary, 0o755)
    const link = join(dir, "opencode")
    writeFileSync(link, launcher(binary), { mode: 0o755 })
    const run = Bun.spawnSync([link, "service", "restart"], {
      env: { ...process.env, HOME: "/home/x", ANTHROPIC_BASE_URL: "http://localhost:3456", ANTHROPIC_INSECURE: "1" },
    })
    expect(run.stdout.toString().trim()).toBe("base=unset insecure=unset home=/home/x args=service restart")
  })
})
