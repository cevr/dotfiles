// `bun run daily`'s config merge: ours replaces only what it owns, and the roles cross families.
import { describe, expect, test } from "bun:test"
import { mergeCli, mergeServer, roleModels, serviceEnv } from "../scripts/daily.ts"

const MODS = "/repo/opencode/mods"
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
  })
})

describe("the TUI config", () => {
  test("loads Prime first, sets the Prime theme and keeps the other keys", () => {
    const merged = mergeCli({ theme: { name: "system", mode: "dark" }, session: { sidebar: "auto" }, plugins: [`${MODS}/prime`, "/x"] }, [`${MODS}/prime`, `${MODS}/status`], [MODS])
    expect(merged).toEqual({ theme: { name: "prime", mode: "dark" }, session: { sidebar: "auto" }, plugins: [`${MODS}/prime`, `${MODS}/status`, "/x"] })
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

describe("the service's environment", () => {
  test("drops the caller's Anthropic routing and keeps everything else", () => {
    const env = serviceEnv({
      PATH: "/bin",
      HOME: "/home",
      ANTHROPIC_BASE_URL: "http://localhost:3456",
      ANTHROPIC_INSECURE: "1",
      EMPTY: undefined,
    })
    expect(env).toEqual({ PATH: "/bin", HOME: "/home" })
  })
})
