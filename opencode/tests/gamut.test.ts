// accept: one at a time (it runs gamut's real TUI end to end under deadlines).
// gamut's pure parts (arguments, presets, config, environment, the run's
// database, the wait), the scripted model, and one end-to-end run of the
// commands against a real OpenCode on the `sim` preset. The end-to-end test
// needs OPENCODE_DEV, the fork, like tests/prime.test.ts.
import { Database } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { poolPlugin } from "../testbeds/anthropic-auth.ts"
import {
  type Catalog,
  checkKeyNames,
  cliConfig,
  DEFAULT_FORK,
  forkLaunch,
  formatReport,
  isSettled,
  loginsToCopy,
  loginStep,
  loginStoreDir,
  newestRelease,
  NO_RECORD,
  openTurnSessions,
  parseCount,
  parseUpArgs,
  PRESETS,
  pluginPaths,
  projectConfig,
  providersNeeded,
  redact,
  resolvePreset,
  rewriteRoster,
  runEnv,
  runPaths,
  runRecord,
  runReport,
  screenText,
  selection,
  sendAwaitsTurn,
  serverPlugins,
  storeAccounts,
  testSummary,
  WAIT_START,
  waitStep,
} from "../testbeds/gamut/gamut.ts"
import { replyEvents, SIM_COMMAND, SIM_TITLE, simReply } from "../testbeds/gamut/sim-model.ts"
import { scratch } from "./scratch.ts"

const root = join(import.meta.dir, "..")

describe("up's arguments", () => {
  test("a preset, a prompt and the switches", () => {
    expect(parseUpArgs(["deepseek", "--prompt", "fix task 1", "--installed"])).toEqual({
      preset: "deepseek",
      prompt: "fix task 1",
      installed: true,
      build: true,
    })
    expect(parseUpArgs(["--no-build", "sim"])).toEqual({ preset: "sim", prompt: undefined, installed: false, build: false })
  })

  test("a flag given twice, a flag with no value, an unknown flag and a missing preset are refused", () => {
    expect(() => parseUpArgs(["sim", "--prompt", "a", "--prompt", "b"])).toThrow("--prompt is given more than once")
    expect(() => parseUpArgs(["sim", "--prompt"])).toThrow("--prompt needs a value")
    expect(() => parseUpArgs(["sim", "--prompt", "--installed"])).toThrow("--prompt needs a value")
    expect(() => parseUpArgs(["sim", "--remote", "x"])).toThrow("unknown flag --remote")
    expect(() => parseUpArgs(["--installed"])).toThrow("up needs a preset")
    expect(() => parseUpArgs(["sim", "deepseek"])).toThrow("up takes one preset")
  })

  test("a count is a positive whole number", () => {
    expect(parseCount("wait seconds", "90")).toBe(90)
    expect(() => parseCount("wait seconds", "0")).toThrow("positive whole number")
    expect(() => parseCount("wait seconds", "1.5")).toThrow("positive whole number")
  })

  test("key names are checked before any is pressed", () => {
    expect(() => checkKeyNames(["esc", "down", "enter"])).not.toThrow()
    expect(() => checkKeyNames(["esc", "nope"])).toThrow("no key named nope")
    expect(() => checkKeyNames([])).toThrow("at least one key name")
  })

  test("a slash command may start no turn; a prompt starts one", () => {
    expect(sendAwaitsTurn("fix it")).toBe(true)
    expect(sendAwaitsTurn("  /help")).toBe(false)
  })
})

const CATALOG: Catalog = {
  anthropic: {
    models: {
      "claude-haiku-4-5": { family: "claude-haiku", release_date: "2025-10-15" },
      "claude-haiku-5-5": {
        family: "claude-haiku",
        release_date: "2026-10-07",
        capabilities: { reasoning: { effort: ["low", "medium", "high", "xhigh", "max"] } },
      },
      "claude-opus-5-5": { family: "claude-opus", release_date: "2026-10-20" },
    },
  },
  "opencode-go": {
    models: {
      "glm-5.2": { family: "glm", release_date: "2026-06-13", capabilities: { reasoning: { effort: ["high", "max"] } } },
      "glm-5.3": {
        family: "glm",
        release_date: "2026-08-14",
        capabilities: { reasoning: { effort: ["low", "high", "max"] } },
      },
      "glm-6-preview": { family: "glm", release_date: "2026-10-30", status: "deprecated" },
      "deepseek-v4.1-flash": {
        family: "deepseek-flash",
        release_date: "2026-09-10",
        capabilities: { reasoning: { effort: ["low", "high", "max"] } },
      },
    },
  },
}

test("the default fork is the prime-look Rift beside the dotfiles checkout", () => {
  const dotfiles = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: import.meta.dir }).stdout.toString().trim()
  expect(DEFAULT_FORK).toBe(join(dirname(dotfiles), ".rifts/opencode/prime-look"))
})

describe("presets", () => {
  test("a family resolves to its newest release that is not deprecated", () => {
    expect(newestRelease(CATALOG, "opencode-go", "glm")).toBe("glm-5.3")
    expect(newestRelease(CATALOG, "opencode-go", "kimi")).toBeUndefined()
  })

  test("every preset resolves, and only the sim preset needs no login", () => {
    const needs: Record<string, ReadonlyArray<string>> = { sim: [], haiku: ["anthropic"], "haiku-store": ["anthropic"] }
    for (const [name, preset] of Object.entries(PRESETS)) {
      const resolved = resolvePreset(preset, CATALOG)
      expect(providersNeeded(resolved)).toEqual(needs[name] ?? ["opencode-go"])
    }
    // haiku-store copies no login: the pool reads the login store's accounts in place.
    expect(loginsToCopy(PRESETS["haiku-store"]!, resolvePreset(PRESETS["haiku-store"]!, CATALOG))).toEqual([])
    expect(loginsToCopy(PRESETS.haiku!, resolvePreset(PRESETS.haiku!, CATALOG))).toEqual(["anthropic"])
    const mixed = resolvePreset(PRESETS["glm-deepseek"]!, CATALOG)
    expect(selection(mixed.orchestrator)).toBe("opencode-go/glm-5.3#high")
    expect(selection(mixed.worker)).toBe("opencode-go/deepseek-v4.1-flash#high")
    expect(selection(mixed.worker, false)).toBe("opencode-go/deepseek-v4.1-flash")
  })

  test("Claude Haiku is the only model a preset spends a Claude account on, and none spends OpenAI", () => {
    for (const preset of Object.values(PRESETS)) {
      for (const slot of Object.values(preset.roles)) {
        expect(slot.model).not.toMatch(/^openai\//)
        if (slot.model.startsWith("anthropic/")) expect(slot.model).toBe("anthropic/claude-haiku")
      }
    }
    const haiku = resolvePreset(PRESETS.haiku!, CATALOG)
    for (const slot of Object.values(haiku)) expect(selection(slot)).toBe("anthropic/claude-haiku-5-5#high")
  })

  test("a family with no release, or an effort the release lacks, stops the run", () => {
    const glm = { model: "opencode-go/glm", effort: "xhigh" }
    expect(() => resolvePreset({ about: "", roles: { orchestrator: glm, worker: glm, verifier: glm } }, CATALOG)).toThrow(
      "has no xhigh effort",
    )
    expect(() => resolvePreset(PRESETS.deepseek!, {})).toThrow("no opencode-go/deepseek-flash release")
  })
})

describe("the run's config", () => {
  const sim = resolvePreset(PRESETS.sim!, {})
  const deepseek = resolvePreset(PRESETS.deepseek!, CATALOG)

  test("the sim preset serves its own provider on the run's port, in every role", () => {
    const config = projectConfig(sim, 4321)
    expect(config.model).toBe("sim/sim-model")
    expect(config.providers?.sim.settings.baseURL).toBe("http://127.0.0.1:4321/v1")
    expect(config.agents.build.model).toBe("sim/sim-model")
    expect(config.agents.general.model).toBe("sim/sim-model")
    expect(config.agents.verifier.model).toBe("sim/sim-model")
    expect(() => projectConfig(sim)).toThrow("needs the sim model's port")
  })

  test("a live preset pins each role's agents, and the helpers run without the variant", () => {
    const config = projectConfig(deepseek)
    expect(config.providers).toBeUndefined()
    expect(config.model).toBe("opencode-go/deepseek-v4.1-flash#high")
    expect(config.agents.plan.model).toBe("opencode-go/deepseek-v4.1-flash#high")
    expect(config.agents.explore.model).toBe("opencode-go/deepseek-v4.1-flash#high")
    expect(config.agents.title.model).toBe("opencode-go/deepseek-v4.1-flash")
    expect(config.agents.verifier.model).toBe("opencode-go/deepseek-v4.1-flash#high")
    // The verifier is the orchestrate mod's role; no separate reviewer agent remains.
    expect(config.agents).not.toHaveProperty("reviewer")
  })

  test("the TUI plugins load by absolute path from cli.json, Prime first, with the Prime theme", () => {
    const dir = scratch("ocg-plugins-").path
    try {
      for (const name of ["aaa", "prime", "zzz", "server-only", "no-package"]) mkdirSync(join(dir, name))
      const tui = JSON.stringify({ exports: { "./tui": "./src/index.tsx" } })
      for (const name of ["aaa", "prime", "zzz"]) writeFileSync(join(dir, name, "package.json"), tui)
      writeFileSync(join(dir, "server-only", "package.json"), JSON.stringify({ exports: { "./server": "./s.ts" } }))
      const plugins = pluginPaths(dir)
      expect(plugins).toEqual([join(dir, "prime"), join(dir, "aaa"), join(dir, "zzz")])
      expect(cliConfig(plugins)).toEqual({ plugins, theme: { name: "prime", mode: "dark" } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    const ours = pluginPaths(join(root, "cmd"))
    expect(ours[0]).toBe(join(root, "cmd/prime"))
    expect(ours).not.toContain(join(root, "cmd/pool"))
  })

  test("a Claude run loads the auth plugin, then the pool, from the project config", () => {
    const haiku = resolvePreset(PRESETS.haiku!, CATALOG)
    const plugins = serverPlugins(haiku, "/run/anthropic-auth")
    expect(plugins).toEqual(["/run/anthropic-auth", poolPlugin])
    const config = projectConfig(haiku, undefined, plugins)
    expect(config.plugins).toEqual(plugins)
    expect(config.model).toBe("anthropic/claude-haiku-5-5#high")
    expect(config.agents.title.model).toBe("anthropic/claude-haiku-5-5")
    // A run on another provider loads no server plugin.
    const deepseek = resolvePreset(PRESETS.deepseek!, CATALOG)
    expect(serverPlugins(deepseek, "/run/anthropic-auth")).toEqual([])
    expect("plugins" in projectConfig(deepseek)).toBe(false)
  })

  test("a run on the login store's accounts gives the pool the store, and runs Haiku alone", () => {
    const haiku = resolvePreset(PRESETS["haiku-store"]!, CATALOG)
    for (const slot of Object.values(haiku)) expect(selection(slot, false)).toBe("anthropic/claude-haiku-5-5")
    const plugins = serverPlugins(haiku, "/run/anthropic-auth", "/owner/.local/share/opencode-prime/pool-auth")
    expect(plugins).toEqual([
      "/run/anthropic-auth",
      { package: poolPlugin, options: { sources: [{ kind: "store", dir: "/owner/.local/share/opencode-prime/pool-auth" }] } },
    ])
    expect(projectConfig(haiku, undefined, plugins).plugins).toEqual(plugins)
    // The store is the caller's, never the run's own home: the same path on every host.
    expect(loginStoreDir("/h")).toBe("/h/.local/share/opencode-prime/pool-auth")
  })

  test("a login store with no account the pool can use is refused, saying why", () => {
    const dir = scratch("gamut-store-").path
    try {
      expect(() => storeAccounts(dir)).toThrow(`the login store holds no Claude account the pool can use at ${dir}; sign in to one`)
      mkdirSync(join(dir, ".slots/anthropic"), { recursive: true })
      const signIn = (owner: string | undefined) =>
        JSON.stringify({
          _tag: "Oauth",
          type: "oauth",
          access: "fake-access",
          refresh: "fake-refresh",
          expires: Date.now() + 3_600_000,
          ...(owner === undefined ? {} : { metadata: { owner } }),
        })
      writeFileSync(join(dir, ".slots/anthropic/linked"), signIn(undefined), { mode: 0o600 })
      expect(() => storeAccounts(dir)).toThrow("linked: a linked Claude Code login, which Claude Code refreshes itself")
      writeFileSync(join(dir, ".slots/anthropic/work"), signIn("store"), { mode: 0o600 })
      expect(storeAccounts(dir)).toEqual(["work"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a missing Claude login is added through the auth plugin; others through opencode2", () => {
    expect(loginStep("anthropic")).toBe("bun run gamut login anthropic")
    expect(loginStep("opencode-go")).toBe("opencode2 auth login opencode-go")
  })

  test("the roster block names the preset's models and keeps the text around it", () => {
    const agents = readFileSync(join(root, "testbeds/gamut/fixture/AGENTS.md"), "utf8")
    const rewritten = rewriteRoster(agents, deepseek)
    expect(rewritten).toContain('`agent: "general"`, pinned in `opencode.json` to `opencode-go/deepseek-v4.1-flash#high`')
    expect(rewritten.slice(0, agents.indexOf("<!-- roster -->"))).toBe(agents.slice(0, agents.indexOf("<!-- roster -->")))
    expect(rewritten.endsWith(agents.slice(agents.indexOf("<!-- /roster -->")))).toBe(true)
    expect(() => rewriteRoster("# no roster", deepseek)).toThrow("no roster block")
  })
})

describe("the run's environment", () => {
  const paths = runPaths("/scratch/run")
  const launch = forkLaunch("/fork", "/bin/bun")
  const caller = {
    PATH: "/usr/bin",
    LANG: "en_US.UTF-8",
    SHELL: "",
    HTTPS_PROXY: "http://proxy:8080",
    OPENAI_API_KEY: "sk-secret",
    ANTHROPIC_API_KEY: "sk-ant",
    HOME: "/Users/owner",
    OPENCODE_DEV: "/fork",
    ANTHROPIC_BASE_URL: "http://localhost:3456",
  }

  test("only the terminal basics and the proxy variables come from the caller", () => {
    const env = runEnv(caller, paths, launch, false)
    expect(env.PATH).toBe("/usr/bin")
    expect(env.HTTPS_PROXY).toBe("http://proxy:8080")
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENCODE_DEV).toBeUndefined()
    // A Claude proxy in the caller's shell would take the pool's choice of login away.
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    // An empty variable reads as unset.
    expect("SHELL" in env).toBe(false)
  })

  test("the run has its own home, database and config, and the fork's preload", () => {
    const env = runEnv(caller, paths, launch, true)
    expect(env.HOME).toBe("/scratch/run/home")
    expect(env.XDG_DATA_HOME).toBe("/scratch/run/home/.local/share")
    expect(env.OPENCODE_DB).toBe("/scratch/run/data/opencode.db")
    expect(env.OPENCODE_CONFIG_DIR).toBe("/scratch/run/config")
    expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1")
    expect(env.BUN_OPTIONS).toContain("--preload=/fork/packages/tui/node_modules/@opentui/solid/scripts/preload.js")
    expect(launch.base).toEqual(["/bin/bun", "/fork/packages/cli/src/index.ts"])
    expect(runEnv(caller, paths, launch, false).OPENCODE_DISABLE_MODELS_FETCH).toBeUndefined()
  })

  test("a failure line never shows a credential", () => {
    expect(redact("bad key sk-abcdef for sk-abcdef", ["sk-abcdef", "x"])).toBe("bad key <redacted> for <redacted>")
  })
})

describe("read and the test summary", () => {
  test("a read with no new rows says so, and names gone rows and an exit", () => {
    expect(screenText({ rows: [], gone: 0 }, false)).toBe("(no change)")
    expect(screenText({ rows: ["a"], gone: 2, exited: 0 }, false)).toBe(
      "a\n(2 rows of the last read are gone)\n(opencode exited 0)",
    )
    expect(screenText({ rows: [], gone: 0 }, true)).toBe("")
  })

  test("bun test's coloured summary reads as counts", () => {
    expect(testSummary("\x1b[0m\x1b[32m 11 pass\x1b[0m\n\x1b[31m 4 fail\x1b[0m\n")).toBe("11 pass, 4 fail")
    expect(testSummary("nothing")).toBe("? pass, ? fail")
  })
})

describe("wait", () => {
  const started = { started: true, open: [], stored: true }

  test("two idle reads in a row after a started turn settle; a changed screen starts over", () => {
    let progress = waitStep(WAIT_START, "screen", started, true)
    expect(isSettled(progress)).toBe(false)
    progress = waitStep(progress, "screen", started, true)
    progress = waitStep(progress, "screen", started, true)
    expect(isSettled(progress)).toBe(true)
    expect(waitStep(progress, "other", started, true).settledReads).toBe(0)
  })

  test("an open turn is never idle, and a prompt waits for its turn to start", () => {
    let progress = WAIT_START
    for (let i = 0; i < 10; i++) progress = waitStep(progress, "s", { ...started, open: ["ses_a"] }, true)
    expect(isSettled(progress)).toBe(false)
    for (let i = 0; i < 10; i++) progress = waitStep(progress, "s", NO_RECORD, true)
    expect(isSettled(progress)).toBe(false)
  })

  test("a slash command that stores nothing settles after quiet reads", () => {
    let progress = WAIT_START
    for (let i = 0; i < 6; i++) progress = waitStep(progress, "s", NO_RECORD, false)
    expect(isSettled(progress)).toBe(true)
  })
})

/** The columns of the fork's tables that gamut reads; the release lacks `time_busy` and has `session_pending`. */
const runDb = (release: boolean) => {
  const db = new Database(":memory:")
  db.run(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, cost REAL DEFAULT 0 NOT NULL,
    tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, ${release ? "" : "time_busy INTEGER,"} time_idle INTEGER)`)
  db.run(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
    seq INTEGER NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)`)
  db.run(`CREATE TABLE ${release ? "session_pending" : "session_inbox"} (id TEXT PRIMARY KEY, session_id TEXT NOT NULL)`)
  return db
}

const message = (db: Database, session: string, seq: number, type: string, time: number, data: unknown) =>
  db.run(`INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)`, [
    `${session}-${seq}`,
    session,
    type,
    seq,
    time,
    JSON.stringify(data),
  ])

describe("the run's database", () => {
  test("a turn is open from its start until its idle time, or while a message waits", () => {
    const db = runDb(false)
    db.run(`INSERT INTO session_v2 (id, parent_id, title, agent, time_created, time_updated, time_busy, time_idle)
      VALUES ('done', NULL, 't', 'build', 100, 300, 110, 300), ('busy', 'done', 't', 'general', 200, 400, 400, 300),
             ('queued', NULL, 't', 'build', 100, 300, 110, 300)`)
    db.run(`INSERT INTO session_inbox VALUES ('m1', 'queued')`)
    expect([...openTurnSessions(db)].sort()).toEqual(["busy", "queued"])
    expect(runRecord(db, 350)).toEqual({ started: true, open: expect.any(Array), stored: true })
    expect(runRecord(db, 500)).toEqual({ started: false, open: expect.any(Array), stored: false })
  })

  test("without time_busy, a user message after the last idle time opens the turn", () => {
    const db = runDb(true)
    db.run(`INSERT INTO session_v2 (id, parent_id, title, agent, time_created, time_updated, time_idle)
      VALUES ('a', NULL, 't', 'build', 100, 300, 300), ('b', NULL, 't', 'build', 100, 300, 300)`)
    message(db, "a", 1, "user", 250, { text: "hi" })
    message(db, "b", 1, "user", 350, { text: "again" })
    expect(openTurnSessions(db)).toEqual(["b"])
    db.run(`INSERT INTO session_pending VALUES ('p', 'a')`)
    expect([...openTurnSessions(db)].sort()).toEqual(["a", "b"])
  })

  test("the report counts turns, models, tool calls and errors per session, as a tree", () => {
    const db = runDb(false)
    db.run(`INSERT INTO session_v2 VALUES ('root', NULL, 'Fix tasks', 'build', 0.0123, 1500, 200, 1, 9, 2, 9),
      ('child', 'root', 'Task 1', 'general', 0.001, 300, 40, 3, 9, 4, 9)`)
    const model = { id: "deepseek-v4.1-flash", providerID: "opencode-go", variant: "high" }
    message(db, "root", 1, "user", 1, { text: "go" })
    message(db, "root", 2, "assistant", 2, {
      model,
      content: [
        { type: "tool", name: "shell", state: { status: "completed" } },
        { type: "tool", name: "subagent", state: { status: "completed" } },
        { type: "text", text: "done" },
      ],
    })
    message(db, "root", 3, "idle", 3, { outcome: "succeeded" })
    message(db, "child", 1, "user", 3, { text: "task 1" })
    message(db, "child", 2, "assistant", 4, {
      model,
      content: [{ type: "tool", name: "patch", state: { status: "error", error: "no match\nin file" } }],
      error: { type: "api", message: "rate limited" },
    })
    message(db, "child", 3, "idle", 5, { outcome: "failed" })
    const report = runReport(db)
    expect(report.models).toEqual({ "opencode-go/deepseek-v4.1-flash#high": 2 })
    expect(report.sessions.map((s) => [s.id, s.turns, s.tools])).toEqual([
      ["root", 1, { shell: 1, subagent: 1 }],
      ["child", 1, { patch: 1 }],
    ])
    expect(report.sessions[1]!.errors).toEqual(["patch: no match in file", "rate limited", "turn ended failed"])
    const text = formatReport(report)
    expect(text).toContain('  root  build  "Fix tasks"  turns 1  $0.0123  in 1.5k out 200')
    expect(text).toContain('    child  general  "Task 1"  turns 1')
    expect(text).toContain("  opencode-go/deepseek-v4.1-flash#high  2 replies")
    expect(text).toContain("  child  turn ended failed")
    expect(text).toContain("open turns  none")
  })
})

describe("the scripted model", () => {
  const shell = [{ function: { name: "shell" } }]

  test("it names a conversation, runs the suite once, then quotes the result", () => {
    expect(simReply({ messages: [{ role: "system", content: "You name conversations." }] })).toEqual({
      kind: "text",
      text: SIM_TITLE,
    })
    expect(simReply({ messages: [{ role: "user", content: "fix it" }], tools: shell })).toEqual({
      kind: "tool",
      name: "shell",
      input: { command: SIM_COMMAND },
    })
    expect(
      simReply({ messages: [{ role: "tool", content: "11 pass\n4 fail\nRan 15 tests across 5 files.\n" }], tools: shell }),
    ).toEqual({ kind: "text", text: "sim: the suite says Ran 15 tests across 5 files." })
    expect(simReply({ messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] })).toEqual({
      kind: "text",
      text: "sim: you said hello",
    })
  })

  test("a reply streams as chat completion chunks and ends with [DONE]", () => {
    const events = replyEvents({ kind: "tool", name: "shell", input: { command: "ls" } }, "sim-model", "x")
    expect(events.at(-1)).toBe("data: [DONE]\n\n")
    const chunks = events.slice(0, -1).map((event) => JSON.parse(event.slice("data: ".length)))
    expect(chunks.some((chunk) => chunk.choices[0]?.finish_reason === "tool_calls")).toBe(true)
    expect(chunks[1].choices[0].delta.tool_calls[0].function).toEqual({ name: "shell", arguments: '{"command":"ls"}' })
  })
})

// ── One run of the commands against a real OpenCode ──

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/gamut.test.ts: the end-to-end run skipped. Set OPENCODE_DEV to the fork to run it.")

describe.skipIf(!fork)("gamut on the sim preset", () => {
  // Made in beforeAll: a skipped describe still runs its body, so a dir made here would leak.
  let state = ""
  beforeAll(() => {
    state = join(scratch("ocg-gamut-e2e-").path, "state.json")
  })
  const gamut = (...args: string[]) => {
    const run = Bun.spawnSync(["bun", join(root, "testbeds/gamut/gamut.ts"), ...args], {
      env: { ...process.env, GAMUT_STATE: state },
      stdout: "pipe",
      stderr: "pipe",
    })
    return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() }
  }
  const workOf = (out: string) => /^work\s+(\S+)/m.exec(out)?.[1] ?? ""
  let work = ""

  afterAll(() => {
    // A failed step still leaves nothing behind.
    if (existsSync(state)) gamut("down")
    rmSync(join(state, ".."), { recursive: true, force: true })
  })

  test(
    "up, wait, read, send, status and down drive OpenCode with the Prime look",
    () => {
      const up = gamut("up", "sim", "--prompt", "run the tests")
      expect(up.err).toBe("")
      expect(up.code).toBe(0)
      work = workOf(up.out)
      expect(work).not.toBe("")
      const config = JSON.parse(readFileSync(join(work, "opencode.json"), "utf8"))
      const packages = config.plugins.map((entry: string | { package: string }) => typeof entry === "string" ? entry : entry.package)
      for (const dir of ["cmd/orchestrate", "cmd/status", "cmd/pool"]) expect(packages).toContain(join(root, dir))
      expect(config.agents.worker.model).toBe(config.agents.general.model)
      expect(config.agents.verifier.model).toBe(config.agents.build.model)

      expect(gamut("wait", "120")).toMatchObject({ code: 0, out: "idle\n" })
      const first = gamut("read")
      // The scripted turn ran the suite through the shell tool and quoted its last line.
      expect(first.out).toContain("run the tests")
      // The testbed keeps the owner's default (low) verbosity, which folds the turn's one shell call into a count;
      // `status` below reads the call itself (`shell 2`, the suite's result).
      expect(first.out).toMatch(/^ {2}\+ 1 command$/m)
      expect(first.out).toContain("sim: the suite says Ran 15 tests across 5 files.")
      // Prime's look, not the stock one: its tray line under the composer (model · context use), and no standing Ctrl+O hint over it.
      expect(first.out).toMatch(/^ +sim-model · \d+ \(\d+%\)$/m)
      expect(first.out).not.toContain("Ctrl+O to")

      expect(gamut("send", "hello there").code).toBe(0)
      expect(gamut("wait", "120")).toMatchObject({ code: 0, out: "idle\n" })
      expect(gamut("read", "--full").out).toContain("hello there")

      const status = gamut("status")
      expect(status.code).toBe(0)
      expect(status.out).toMatch(/sessions \(1\)\n {2}ses_\S+ {2}build {2}"Ledgerline red suite" {2}turns 2/)
      expect(status.out).toContain("sim/sim-model#default  4 replies")
      expect(status.out).toMatch(/ses_\S+ {2}shell 2/)
      expect(status.out).toContain("errors\n  none")
      expect(status.out).toContain("open turns  none")
      expect(status.out).toContain("bun test  11 pass, 4 fail")

      const down = gamut("down")
      expect(down.code).toBe(0)
      expect(gamut("status").err).toContain("no gamut run is up")
      expect(existsSync(work)).toBe(false)
    },
    240_000,
  )
})
