// `bun run daily`'s config merge: ours replaces only what it owns, and the roles cross families.
import { describe, expect, test } from "bun:test"
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseTTL } from "../mods/idle-compact/cache.ts"
import { anthropicAuthPlugin } from "../testbeds/anthropic-auth.ts"
import { BUILTIN_BTW_OFF, BUILTIN_SCHEDULE_OFF, CLAUDE_CACHE_TTL, installedFile, launcher, mailEntry, mergeCli, mergeServer, orchestrateEntry, peersOf, plannerModel, pluginDir, poolEntry, residentConfig, residentDir, roleModels } from "./daily.ts"
import { exposedTests, HELD_BRANCH, mergeUpstream, syncFork, type Options as UpstreamOptions } from "./upstream.ts"

const MODS = "/repo/opencode/mods"
const CMD = "/repo/opencode/cmd"
const AUTH = "/home/.local/share/opencode-prime/anthropic-auth"
const CHECKOUTS = { dotfiles: "/repo", fork: "/fork" }

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

describe("background compaction", () => {
  test("turns the fork's flag on in the server config and keeps the other experimental settings", () => {
    const existing = { experimental: { todo: true, background_compaction: false } }
    expect(mergeServer(existing, [], {}, [MODS]).experimental).toEqual({ todo: true, background_compaction: true })
    expect(mergeServer({}, [], {}, [MODS]).experimental).toEqual({ background_compaction: true })
  })

  const fork = process.env.OPENCODE_DEV
  test.skipIf(!fork)("names a flag the fork defines (OPENCODE_DEV)", () => {
    const registry = readFileSync(join(fork ?? "", "packages/schema/src/config/flag.ts"), "utf8")
    expect(registry).toMatch(/^\s+background_compaction:/m)
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

  test("mail listens on the Tailscale address on the owner's hosts only, and nowhere without one", () => {
    expect(mailEntry(`${MODS}/mail`, { host: "bite-cristian", tailscale: "100.64.0.2" })).toEqual({
      package: `${MODS}/mail`,
      options: { listen: { hostname: "100.64.0.2" } },
    })
    expect(mailEntry(`${MODS}/mail`, { host: "Cristians-MacBook-Pro.local", tailscale: undefined })).toBe(`${MODS}/mail`)
    expect(mailEntry(`${MODS}/mail`, { host: "ci-runner", tailscale: "100.64.0.9" })).toBe(`${MODS}/mail`)
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

  test("orchestrate asks the pool first for a Codex provider's agents, and names the checkouts an accepted verdict records the verified target from", () => {
    const entry = orchestrateEntry(`${MODS}/orchestrate`, CHECKOUTS)
    expect(entry).toEqual({ package: `${MODS}/orchestrate`, options: { codex: { pool: true }, fleet: CHECKOUTS } })
    // It replaces the bare entry an older run wrote, as every entry from our dirs is.
    expect(mergeServer({ plugins: [`${MODS}/orchestrate`] }, [entry], {}, [MODS]).plugins).toEqual([entry])
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
    // The planner A/B's option an earlier run wrote goes with its entry.
    const earlier = { package: `${MODS}/orchestrate`, options: { codex: { pool: true }, experiment: { role: "planner", model: "anthropic/claude-fable-5-1", share: 0.2 } } }
    expect(mergeServer({ plugins: [earlier, "/x"] }, [entry], {}, [MODS]).plugins).toEqual([entry, "/x"])
    // A catalog with no Fable names no first model, and the entry names none: the planner runs on Opus.
    expect(plannerModel({ anthropic: { models: {} } } as never)).toBeUndefined()
    expect(mergeServer({ plugins: [earlier] }, [orchestrateEntry(`${MODS}/orchestrate`, CHECKOUTS, undefined)], {}, [MODS]).plugins).toEqual([
      { package: `${MODS}/orchestrate`, options: { codex: { pool: true }, fleet: CHECKOUTS } },
    ])
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

describe("the server config's built-in schedule plugin", () => {
  test("is turned off once, however many runs merged it, so neither its tools nor /schedule are offered", () => {
    expect(BUILTIN_SCHEDULE_OFF).toBe("-opencode.tool.schedule")
    const once = mergeServer({ plugins: ["/x"] }, [`${MODS}/wake`, BUILTIN_SCHEDULE_OFF], {}, [MODS])
    expect(mergeServer(once, [`${MODS}/wake`, BUILTIN_SCHEDULE_OFF], {}, [MODS]).plugins).toEqual([`${MODS}/wake`, BUILTIN_SCHEDULE_OFF, "/x"])
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
  /** The test's own git env: a scratch config handed to each child, never written to this process's env. */
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "daily test",
    GIT_AUTHOR_EMAIL: "daily@test.invalid",
    GIT_COMMITTER_NAME: "daily test",
    GIT_COMMITTER_EMAIL: "daily@test.invalid",
  }
  /** `mergeUpstream` and `syncFork` run git with the process's env, so each repository's own config keeps the owner's identity, signing and hooks out of their commits and pushes. */
  const repoConfig = (hooks: string) =>
    `[user]\n\tname = daily test\n\temail = daily@test.invalid\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[core]\n\thooksPath = ${hooks}\n`

  const git = (dir: string, ...args: string[]) => {
    const ran = Bun.spawnSync(["git", "-C", dir, ...args], { env, stdout: "pipe", stderr: "pipe" })
    if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`)
    return ran.stdout.toString().trim()
  }
  /** Commits `files` on `branch` of the bare repo `remote` through a scratch clone. */
  const commitTo = (remote: string, branch: string, files: Record<string, string>) => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "daily-push-")))
    git(scratch, "clone", "--quiet", "--branch", branch, remote, ".")
    for (const [file, text] of Object.entries(files)) writeFileSync(join(scratch, file), text)
    git(scratch, "add", "-A")
    git(scratch, "commit", "--quiet", "-m", `change ${Object.keys(files).join(" ")}`)
    git(scratch, "push", "--quiet", "origin", branch)
  }

  /** upstream/dev and origin/prime-look share one root commit; the fork has prime-look checked out. */
  const fixture = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "daily-upstream-")))
    const upstream = join(root, "upstream.git")
    const origin = join(root, "origin.git")
    const seed = join(root, "seed")
    for (const dir of [upstream, origin, seed]) mkdirSync(dir)
    git(upstream, "init", "--quiet", "--bare")
    git(origin, "init", "--quiet", "--bare")
    git(seed, "init", "--quiet", "-b", "dev")
    writeFileSync(join(seed, "a.txt"), "one\n")
    git(seed, "add", "-A")
    git(seed, "commit", "--quiet", "-m", "root")
    git(seed, "push", "--quiet", upstream, "dev")
    git(seed, "push", "--quiet", origin, "dev:prime-look")
    const fork = join(root, "fork")
    git(root, "clone", "--quiet", "--branch", "prime-look", origin, fork)
    git(fork, "remote", "add", "upstream", upstream)
    const hooks = join(root, "no-hooks")
    mkdirSync(hooks)
    for (const config of [join(upstream, "config"), join(origin, "config"), join(fork, ".git/config")]) appendFileSync(config, repoConfig(hooks))
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
      worktree: join(root, "state/upstream-merge"),
      report: join(root, "state/upstream-conflict.md"),
      log: () => {},
      ...overrides,
    })
    const head = (dir: string, ref: string) => git(dir, "rev-parse", ref)
    return { root, upstream, origin, fork, calls, options, head }
  }

  test("up to date: nothing merges, nothing runs, and a stale report goes", async () => {
    const f = fixture()
    const before = f.head(f.fork, "prime-look")
    mkdirSync(join(f.root, "state"))
    writeFileSync(f.options().report, "# old conflict\n")
    expect(await mergeUpstream(f.options())).toEqual({ kind: "up-to-date" })
    expect(f.head(f.fork, "prime-look")).toBe(before)
    expect(f.calls).toEqual([])
    expect(existsSync(f.options().report)).toBe(false)
  })

  test("a clean merge whose checks pass fast-forwards prime-look to it and pushes it to origin", async () => {
    const f = fixture()
    commitTo(f.upstream, "dev", { "b.txt": "upstream\n" })
    commitTo(f.origin, "prime-look", { "c.txt": "ours\n" })
    git(f.fork, "pull", "--quiet", "--ff-only", "origin", "prime-look")
    const before = f.head(f.fork, "prime-look")
    const outcome = await mergeUpstream(f.options())
    expect(outcome).toMatchObject({ kind: "merged", from: before, commits: 1, pushed: true })
    const merge = f.head(f.fork, "prime-look")
    expect(merge).not.toBe(before)
    // A merge commit: ours first, upstream's second, checked in the worktree, never in the fork.
    expect(git(f.fork, "rev-list", "--parents", "-n", "1", merge).split(" ")).toEqual([merge, before, f.head(f.upstream, "dev")])
    expect(f.calls).toEqual([f.options().worktree])
    expect(f.head(f.origin, "prime-look")).toBe(merge)
    // The fork had prime-look checked out, so its working tree followed.
    expect(readFileSync(join(f.fork, "b.txt"), "utf8")).toBe("upstream\n")
    expect(existsSync(f.options().report)).toBe(false)
  })

  test("a conflict aborts, leaves prime-look and origin unchanged, and reports the files", async () => {
    const f = fixture()
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
    const f = fixture()
    commitTo(f.upstream, "dev", { "b.txt": "upstream\n" })
    const before = f.head(f.fork, "prime-look")
    const outcome = await mergeUpstream(
      f.options({ checks: async () => ({ ok: false, check: "typecheck packages/tui", log: "error TS2304: Cannot find name 'x'" }) }),
    )
    expect(outcome).toMatchObject({ kind: "red", check: "typecheck packages/tui" })
    expect(f.head(f.fork, "prime-look")).toBe(before)
    expect(f.head(f.origin, "prime-look")).toBe(before)
    expect(f.head(f.fork, HELD_BRANCH)).toBe(outcome.kind === "red" ? outcome.merge : "")
    const report = readFileSync(f.options().report, "utf8")
    expect(report).toContain("typecheck packages/tui")
    expect(report).toContain("error TS2304")
    expect(existsSync(join(f.fork, "b.txt"))).toBe(false)
  })

  test("the workbox, and --no-upstream, skip it without fetching", async () => {
    const f = fixture()
    commitTo(f.upstream, "dev", { "b.txt": "upstream\n" })
    expect(await mergeUpstream(f.options({ host: "bite-cristian" }))).toMatchObject({ kind: "skipped" })
    expect(await mergeUpstream(f.options({ skip: true }))).toEqual({ kind: "skipped", reason: "--no-upstream" })
    expect(Bun.spawnSync(["git", "-C", f.fork, "rev-parse", "-q", "--verify", "refs/remotes/upstream/dev"], { env }).exitCode).not.toBe(0)
    expect(existsSync(f.options().worktree)).toBe(false)
  })

  test("a dry run says what would merge and changes nothing", async () => {
    const f = fixture()
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
    const f = fixture()
    const stale = f.head(f.fork, "prime-look")
    commitTo(f.origin, "prime-look", { "c.txt": "pushed elsewhere\n" })
    writeFileSync(join(f.fork, "scratch.txt"), "untracked\n")
    const lines: string[] = []
    expect(syncFork({ fork: f.fork, dryRun: false, log: (line) => lines.push(line) })).toMatchObject({ kind: "fast-forwarded", from: stale, commits: 1 })
    expect(f.head(f.fork, "prime-look")).toBe(f.head(f.origin, "prime-look"))
    expect(readFileSync(join(f.fork, "c.txt"), "utf8")).toBe("pushed elsewhere\n")
    expect(readFileSync(join(f.fork, "scratch.txt"), "utf8")).toBe("untracked\n")
    expect(lines.join("\n")).toContain("fast-forwarded")
    const pushed = f.head(f.origin, "prime-look")
    commitTo(f.upstream, "dev", { "b.txt": "upstream\n" })
    // The merge starts from origin's head, not the stale one, and lands as a fast-forward of origin.
    expect(await mergeUpstream(f.options())).toMatchObject({ kind: "merged", from: pushed, pushed: true })
    expect(git(f.fork, "rev-parse", "prime-look^1")).toBe(pushed)
    // Current: nothing to do.
    expect(syncFork({ fork: f.fork, dryRun: false, log: () => {} })).toEqual({ kind: "current" })
  })

  test("a fork with local commits or tracked changes is left alone, and says so", () => {
    const f = fixture()
    commitTo(f.origin, "prime-look", { "c.txt": "pushed elsewhere\n" })
    writeFileSync(join(f.fork, "d.txt"), "local\n")
    git(f.fork, "add", "d.txt")
    git(f.fork, "commit", "--quiet", "-m", "local only")
    const diverged = f.head(f.fork, "prime-look")
    const lines: string[] = []
    expect(syncFork({ fork: f.fork, dryRun: false, log: (line) => lines.push(line) })).toMatchObject({ kind: "left" })
    expect(f.head(f.fork, "prime-look")).toBe(diverged)
    expect(lines.join("\n")).toContain("1 commit not on origin")

    const g = fixture()
    commitTo(g.origin, "prime-look", { "c.txt": "pushed elsewhere\n" })
    const before = g.head(g.fork, "prime-look")
    writeFileSync(join(g.fork, "a.txt"), "edited\n")
    const said: string[] = []
    expect(syncFork({ fork: g.fork, dryRun: false, log: (line) => said.push(line) })).toMatchObject({ kind: "left" })
    expect(g.head(g.fork, "prime-look")).toBe(before)
    expect(readFileSync(join(g.fork, "a.txt"), "utf8")).toBe("edited\n")
    expect(said.join("\n")).toContain("uncommitted changes")
  })

  test("a dry run says it would fast-forward and moves nothing", () => {
    const f = fixture()
    const before = f.head(f.fork, "prime-look")
    commitTo(f.origin, "prime-look", { "c.txt": "pushed elsewhere\n" })
    expect(syncFork({ fork: f.fork, dryRun: true, log: () => {} })).toEqual({ kind: "would-fast-forward", commits: 1 })
    expect(f.head(f.fork, "prime-look")).toBe(before)
  })

  test("with a target commit, the fork fast-forwards to it and no further, though origin is past it", () => {
    const f = fixture()
    commitTo(f.origin, "prime-look", { "c.txt": "verified\n" })
    const verified = f.head(f.origin, "prime-look")
    commitTo(f.origin, "prime-look", { "c.txt": "not verified yet\n" })
    expect(syncFork({ fork: f.fork, dryRun: false, to: verified, log: () => {} })).toMatchObject({ kind: "fast-forwarded", to: verified, commits: 1 })
    expect(f.head(f.fork, "prime-look")).toBe(verified)
    expect(syncFork({ fork: f.fork, dryRun: false, to: verified, log: () => {} })).toEqual({ kind: "current" })
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

describe("the installed build's record", () => {
  test("lives in OpenCode's state directory, which XDG_STATE_HOME moves", () => {
    expect(installedFile("/h", {})).toBe("/h/.local/state/opencode/installed.json")
    expect(installedFile("/h", { XDG_STATE_HOME: "/x" })).toBe("/x/opencode/installed.json")
  })
})

describe("the opencode launcher", () => {
  test("runs the binary with the caller's arguments and without its Anthropic routing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "launcher it's-"))
    const binary = join(dir, "opencode-fake")
    writeFileSync(binary, '#!/bin/sh\necho "base=${ANTHROPIC_BASE_URL:-unset} insecure=${ANTHROPIC_INSECURE:-unset} home=$HOME args=$*"\n')
    chmodSync(binary, 0o755)
    const link = join(dir, "opencode")
    writeFileSync(link, launcher(binary, "/home/x/.local/state/opencode-prime/resident"), { mode: 0o755 })
    const run = Bun.spawnSync([link, "run", "hello"], {
      env: { ...process.env, HOME: "/home/x", ANTHROPIC_BASE_URL: "http://localhost:3456", ANTHROPIC_INSECURE: "1" },
    })
    expect(run.stdout.toString().trim()).toBe("base=unset insecure=unset home=/home/x args=run hello")
  })

  test("after a service start or restart, asks the service for its resident location; a failed start stops there", () => {
    const dir = mkdtempSync(join(tmpdir(), "launcher-"))
    const binary = join(dir, "opencode-fake")
    writeFileSync(binary, '#!/bin/sh\necho "ran $*"\n')
    chmodSync(binary, 0o755)
    const link = join(dir, "opencode")
    writeFileSync(link, launcher(binary, "/home/x/state/it's resident"), { mode: 0o755 })
    for (const verb of ["start", "restart"]) {
      const run = Bun.spawnSync([link, "service", verb], { env: { ...process.env } })
      expect([run.exitCode, run.stdout.toString().trim().split("\n")]).toEqual([0, [`ran service ${verb}`]])
    }
    // The boot's own output is dropped; what it was asked shows through a binary that prints to stderr.
    writeFileSync(binary, '#!/bin/sh\necho "ran $*" >&2\n')
    const booted = Bun.spawnSync([link, "service", "restart"], { env: { ...process.env } })
    expect(booted.stderr.toString().trim().split("\n")).toEqual(["ran service restart", "ran api GET /api/location -H x-opencode-directory:%2Fhome%2Fx%2Fstate%2Fit%27s%20resident"])
    writeFileSync(binary, '#!/bin/sh\necho "ran $*"\n[ "$1" = service ] && exit 3\nexit 0\n')
    const failed = Bun.spawnSync([link, "service", "start"], { env: { ...process.env } })
    expect([failed.exitCode, failed.stdout.toString().trim()]).toEqual([3, "ran service start"])
    expect(residentDir("/home/x")).toBe("/home/x/.local/state/opencode-prime/resident")
    expect(residentConfig).toEqual({ experimental: { location_idle_timeout: false } })
  })
})
