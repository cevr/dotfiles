// pane-restore against a fake herdr, a fake hc and a fake OpenCode server
// (fake.ts): the shims on PATH run it, so the CLI runs exactly as on a host.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import type { World } from "./fake.ts"

const MAIN = join(import.meta.dir, "main.ts")
const FAKE = join(import.meta.dir, "fake.ts")

let root = ""
let worldPath = ""

const pane = (pane_id: string, tab_id: string, workspace_id: string, cwd: string) => ({ pane_id, tab_id, workspace_id, cwd, terminal_title: "" })

/** Two workspaces: wA with two tabs (an OpenCode TUI in each), wB with an OpenCode TUI and a plain shell. */
const snapshot = {
  workspaces: [
    { workspace_id: "wA", number: 1, label: "dotfiles" },
    { workspace_id: "wB", number: 2, label: "manna" },
  ],
  tabs: [
    { tab_id: "wA:t1", workspace_id: "wA", number: 1, label: "main" },
    { tab_id: "wA:tC", workspace_id: "wA", number: 2, label: "second" },
    { tab_id: "wB:t2", workspace_id: "wB", number: 1, label: "apps" },
    { tab_id: "wB:t3", workspace_id: "wB", number: 2, label: "shell" },
  ],
  panes: [
    pane("wA:p1P", "wA:t1", "wA", "/w/dotfiles"),
    pane("wA:p2", "wA:tC", "wA", "/w/dotfiles/sub"),
    pane("wB:p6", "wB:t2", "wB", "/w/manna"),
    pane("wB:p7", "wB:t3", "wB", "/w/manna"),
  ],
  agents: [
    { agent: "opencode", pane_id: "wA:p1P" },
    { agent: "opencode", pane_id: "wA:p2" },
    { agent: "opencode", pane_id: "wB:p6" },
  ],
}

/**
 * herdr's own record (session.json): panes keyed by raw id, public numbers in
 * Crockford base 32 (54 is `1P`). wA:p1P has the 0.9.5 `agent_resume`, wB:p6 the
 * official `agent_session`; wA:p2 has none, so only its argv names its session.
 */
const herdrState = {
  version: 3,
  workspaces: [
    {
      id: "wA",
      public_pane_numbers: { "1": 54, "2": 2 },
      public_tab_numbers: [1, 12],
      tabs: [
        { layout: { Pane: 1 }, panes: { "1": { cwd: "/w/dotfiles", agent_resume: { source: "dotfiles:opencode", agent: "opencode", argv: ["opencode", "-s", "ses_A1"] } } } },
        { layout: { Pane: 2 }, panes: { "2": { cwd: "/w/dotfiles/sub" } } },
      ],
    },
    {
      id: "wB",
      public_pane_numbers: { "3": 6, "4": 7 },
      public_tab_numbers: [2, 3],
      tabs: [
        { layout: { Pane: 3 }, panes: { "3": { cwd: "/w/manna", agent_session: { source: "herdr:opencode", agent: "opencode", kind: "id", value: "ses_B6" } } } },
        { layout: { Pane: 4 }, panes: { "4": { cwd: "/w/manna" } } },
      ],
    },
  ],
}

const OPENCODE = "/Users/x/.local/share/opencode-prime/opencode-2.3.0-prime"
const world = (): World => ({
  herdr: {
    snapshot,
    processes: {
      // The state names ses_A1; a stale argv (the TUI switched sessions) loses to it.
      "wA:p1P": [[OPENCODE, "-s", "ses_OLD"]],
      "wA:p2": [["/bin/sh", "-c", "exec opencode '-s' 'ses_A2'"], [OPENCODE, "-s", "ses_A2"]],
      "wB:p6": [[OPENCODE]],
      "wB:p7": [["-zsh"]],
    },
    machines: {
      Workbox: {
        snapshot: {
          workspaces: [{ workspace_id: "w1", number: 1, label: "bite" }],
          tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "" }],
          panes: [pane("w1:pF", "w1:t1", "w1", "/home/u")],
          agents: [{ agent: "opencode", pane_id: "w1:pF" }],
        },
        processes: { "w1:pF": [[OPENCODE, "--session", "ses_W1"]] },
      },
    },
  },
  hc: { terminals: [] },
  opencode: { sessions: ["ses_A1", "ses_A2", "ses_B6", "ses_W1"] },
  calls: [],
})

const readWorld = () => JSON.parse(readFileSync(worldPath, "utf8")) as World
const writeWorld = (w: World) => writeFileSync(worldPath, JSON.stringify(w, null, 2))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pane-restore-test-"))
  const bin = join(root, "bin")
  mkdirSync(bin)
  for (const tool of ["herdr", "hc", "opencode"]) {
    const shim = join(bin, tool)
    writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' ${tool} "$@"\n`)
    chmodSync(shim, 0o755)
  }
  mkdirSync(join(root, "home/.config/herdr"), { recursive: true })
  writeFileSync(join(root, "home/.config/herdr/session.json"), JSON.stringify(herdrState))
  worldPath = join(root, "world.json")
  writeWorld(world())
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  root = ""
})

const run = (...args: string[]) => {
  const result = Bun.spawnSync([process.execPath, MAIN, ...args], {
    env: {
      PATH: `${join(root, "bin")}:/usr/bin:/bin`,
      HOME: join(root, "home"),
      XDG_STATE_HOME: join(root, "state"),
      PANE_RESTORE_WORLD: worldPath,
    },
  })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

const host = hostname().split(".")[0]

const saved = (stdout: string) => {
  const path = stdout.trim().split("\n").at(-1) ?? ""
  return { path, file: JSON.parse(readFileSync(path, "utf8")) }
}

describe("save", () => {
  test("records every pane with its workspace, tab, hcm tab key, cwd and the session its TUI has open", () => {
    const result = run("save")
    expect(result.code).toBe(0)
    const { path, file } = saved(result.stdout)
    expect(path.startsWith(join(root, "state/pane-restore", `${host}-`))).toBe(true)
    expect(readdirSync(join(root, "state/pane-restore"))).toHaveLength(1)
    expect(file.host).toBe(host)
    expect(file.panes).toEqual([
      { workspace: { id: "wA", label: "dotfiles" }, tab: { id: "wA:t1", label: "main", index: 0 }, from: "wA/0", pane: "wA:p1P", cwd: "/w/dotfiles", session: "ses_A1", source: "herdr-state" },
      { workspace: { id: "wA", label: "dotfiles" }, tab: { id: "wA:tC", label: "second", index: 1 }, from: "wA/1", pane: "wA:p2", cwd: "/w/dotfiles/sub", session: "ses_A2", source: "argv" },
      { workspace: { id: "wB", label: "manna" }, tab: { id: "wB:t2", label: "apps", index: 0 }, from: "wB/0", pane: "wB:p6", cwd: "/w/manna", session: "ses_B6", source: "herdr-state" },
      { workspace: { id: "wB", label: "manna" }, tab: { id: "wB:t3", label: "shell", index: 1 }, from: "wB/1", pane: "wB:p7", cwd: "/w/manna", session: null, source: null },
    ])
    // It only reads: the herdr calls are the snapshot and process info.
    const herdrCalls = readWorld().calls.filter((c) => c[0] === "herdr").map((c) => c.slice(1, 3).join(" "))
    expect(new Set(herdrCalls)).toEqual(new Set(["api snapshot", "pane process-info"]))
  })

  test("a session id that is not an OpenCode id is not recorded", () => {
    const w = world()
    w.herdr.processes["wA:p2"] = [[OPENCODE, "-s", "x; rm -rf /nonexistent/loop-probe-x"]]
    writeWorld(w)
    const { file } = saved(run("save").stdout)
    expect(file.panes[1].session).toBeNull()
  })

  test("--session reads that herdr session and its own record", () => {
    // The named session's record lives in sessions/<name>; the default one has no sessions here.
    mkdirSync(join(root, "home/.config/herdr/sessions/bite"), { recursive: true })
    writeFileSync(join(root, "home/.config/herdr/sessions/bite/session.json"), JSON.stringify(herdrState))
    writeFileSync(join(root, "home/.config/herdr/session.json"), JSON.stringify({ workspaces: [] }))
    const { file } = saved(run("save", "--session", "bite").stdout)
    expect(file.panes.map((p: { session: string | null }) => p.session)).toEqual(["ses_A1", "ses_A2", "ses_B6", null])
    expect(readWorld().calls.filter((c) => c[0] === "herdr").every((c) => c[1] === "--session" && c[2] === "bite")).toBe(true)
  })

  test("--machine reads that herdr machine, from its TUIs' arguments", () => {
    const result = run("save", "--machine", "Workbox")
    expect(result.code).toBe(0)
    const { path, file } = saved(result.stdout)
    expect(path).toContain("/pane-restore/Workbox-")
    expect(file.machine).toBe("Workbox")
    expect(file.panes).toEqual([
      { workspace: { id: "w1", label: "bite" }, tab: { id: "w1:t1", label: "", index: 0 }, from: "w1/0", pane: "w1:pF", cwd: "/home/u", session: "ses_W1", source: "argv" },
    ])
    expect(readWorld().calls.every((c) => c[0] !== "herdr" || c[1] === "--machine")).toBe(true)
  })
})

describe("check", () => {
  test("passes when every saved session opens through the server", () => {
    const { path } = saved(run("save").stdout)
    const result = run("check", path)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("3 of 3 sessions open")
  })

  test("names each session the server no longer has, and fails", () => {
    const { path } = saved(run("save").stdout)
    const w = readWorld()
    w.opencode.sessions = ["ses_A1", "ses_B6"]
    writeWorld(w)
    const result = run("check", path)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain("missing ses_A2 (wA:p2, /w/dotfiles/sub)")
    expect(result.stdout).toContain("2 of 3 sessions open")
  })

  test("with no file, checks this host's newest save", () => {
    run("save")
    expect(run("check").code).toBe(0)
  })
})

describe("restore", () => {
  const terminal = (address: string, from: string, labels: Record<string, string> = {}, foreground: { name: string; argv: string[] } | null = { name: "zsh", argv: ["-zsh"] }) => ({
    address,
    state: "live",
    labels: { "migrate.from": from, ...labels },
    foreground,
  })

  test("labels each moved OpenCode pane's hc terminal with its resume command, once, and never types", () => {
    const { path } = saved(run("save").stdout)
    const w = readWorld()
    w.hc.terminals = [
      terminal("t1", "wA/0"),
      terminal("t2", "wA/1", {}, { name: "vim", argv: ["vim"] }),
      terminal("t3", "wB/1"),
      // wB/0 has no hc terminal: hcm apply has not moved it.
    ]
    w.calls = []
    writeWorld(w)

    const first = run("restore", path)
    expect(first.code).toBe(1)
    expect(first.stdout).toContain("restored wA:p1P → t1: migrate.resume=opencode --session ses_A1")
    expect(first.stdout).toContain("skipped wA:p2 → t2: runs vim")
    expect(first.stdout).toContain("failed wB:p6: no hc terminal from wB/0 (run hcm apply first)")
    expect(first.stdout).not.toContain("wB:p7")
    const after = readWorld()
    expect(after.hc.terminals.find((t) => t.address === "t1")?.labels["migrate.resume"]).toBe("opencode --session ses_A1")
    expect(after.hc.terminals.find((t) => t.address === "t2")?.labels["migrate.resume"]).toBeUndefined()
    expect(after.hc.terminals.find((t) => t.address === "t3")?.labels["migrate.resume"]).toBeUndefined()
    // Only `hc ls` and `hc label`: nothing is typed into any terminal.
    expect(new Set(after.calls.filter((c) => c[0] === "hc").map((c) => c[1]))).toEqual(new Set(["ls", "label"]))
    expect(after.calls.some((c) => c[0] === "herdr")).toBe(false)

    after.calls = []
    writeWorld(after)
    const second = run("restore", path)
    expect(second.stdout).toContain("skipped wA:p1P → t1: already labelled")
    expect(readWorld().calls.some((c) => c[0] === "hc" && c[1] === "label")).toBe(false)
  })

  test("leaves a resume hcm already set, a finished terminal, and a session the server lost", () => {
    const { path } = saved(run("save").stdout)
    const w = readWorld()
    w.hc.terminals = [
      terminal("t1", "wA/0", { "migrate.resume": "claude --resume abc" }),
      { ...terminal("t2", "wA/1"), state: "finished", foreground: null },
      terminal("t3", "wB/0"),
    ]
    w.opencode.sessions = ["ses_A1", "ses_A2"]
    writeWorld(w)
    const result = run("restore", path)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain("skipped wA:p1P → t1: already resumes claude --resume abc")
    expect(result.stdout).toContain("failed wA:p2 → t2: terminal finished")
    expect(result.stdout).toContain("failed wB:p6 → t3: session ses_B6 does not open through the server")
    expect(readWorld().hc.terminals.every((t) => t.labels["migrate.resume"] !== "opencode --session ses_B6")).toBe(true)
  })

  test("exits 0 when every pane is restored or skipped", () => {
    const { path } = saved(run("save").stdout)
    const w = readWorld()
    w.hc.terminals = [terminal("t1", "wA/0"), terminal("t2", "wA/1"), terminal("t3", "wB/0")]
    writeWorld(w)
    const result = run("restore", path)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("3 restored, 0 skipped, 0 failed")
    expect(readWorld().hc.terminals.map((t) => t.labels["migrate.resume"])).toEqual([
      "opencode --session ses_A1",
      "opencode --session ses_A2",
      "opencode --session ses_B6",
    ])
  })
})

describe("restore --herdr", () => {
  /** herdr after a restart: the saved panes are back as idle shells unless a test says otherwise. */
  const restarted = (w: World, processes: Record<string, string[][]> = {}) => {
    w.herdr.processes = { "wA:p1P": [["-zsh"]], "wA:p2": [["-zsh"]], "wB:p6": [["-zsh"]], "wB:p7": [["-zsh"]], ...processes }
    w.calls = []
    return w
  }
  const runs = () => readWorld().calls.filter((c) => c[0] === "herdr" && c.includes("run"))

  test("starts `opencode --session <id>` in each saved pane that is an idle shell, and skips one that runs something", () => {
    const { path } = saved(run("save").stdout)
    const w = restarted(readWorld(), { "wA:p2": [["vim", "notes.md"]] })
    w.herdr.snapshot = { ...snapshot, panes: snapshot.panes.filter((p) => p.pane_id !== "wB:p6") }
    writeWorld(w)

    const first = run("restore", "--herdr", path)
    expect(first.code).toBe(1)
    expect(first.stdout).toContain("restored wA:p1P: opencode --session ses_A1")
    expect(first.stdout).toContain("skipped wA:p2: runs vim")
    expect(first.stdout).toContain("failed wB:p6: pane not found")
    expect(first.stdout).not.toContain("wB:p7")
    expect(first.stdout).toContain("1 restored, 1 skipped, 1 failed")
    expect(runs()).toEqual([["herdr", "pane", "run", "wA:p1P", "opencode --session ses_A1"]])
    expect(readWorld().calls.some((c) => c[0] === "hc")).toBe(false)

    // Run again: the pane now runs that session, so nothing is typed twice.
    const again = readWorld()
    again.calls = []
    writeWorld(again)
    const second = run("restore", "--herdr", path)
    expect(second.stdout).toContain("skipped wA:p1P: already open")
    expect(runs()).toEqual([])
  })

  test("skips a session already open in another pane, and fails one the server lost", () => {
    const { path } = saved(run("save").stdout)
    const w = restarted(readWorld(), { "wB:p7": [[OPENCODE, "-s", "ses_A1"]] })
    w.opencode.sessions = ["ses_A1", "ses_A2"]
    writeWorld(w)
    const result = run("restore", "--herdr", path)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain("skipped wA:p1P: already open in wB:p7")
    expect(result.stdout).toContain("restored wA:p2: opencode --session ses_A2")
    expect(result.stdout).toContain("failed wB:p6: session ses_B6 does not open through the server")
    expect(runs()).toEqual([["herdr", "pane", "run", "wA:p2", "opencode --session ses_A2"]])
  })

  test("exits 0 when every saved session is back", () => {
    const { path } = saved(run("save").stdout)
    writeWorld(restarted(readWorld()))
    const result = run("restore", "--herdr", path)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("3 restored, 0 skipped, 0 failed")
  })

  test("targets the herdr the save read: a machine's newest save, or the named session", () => {
    run("save", "--machine", "Workbox")
    const w = readWorld()
    w.herdr.machines!.Workbox!.processes = { "w1:pF": [["-zsh"]] }
    w.calls = []
    writeWorld(w)
    const machine = run("restore", "--herdr", "--machine", "Workbox")
    expect(machine.code).toBe(0)
    expect(runs()).toEqual([["herdr", "--machine", "Workbox", "pane", "run", "w1:pF", "opencode --session ses_W1"]])

    mkdirSync(join(root, "home/.config/herdr/sessions/bite"), { recursive: true })
    writeFileSync(join(root, "home/.config/herdr/sessions/bite/session.json"), JSON.stringify(herdrState))
    const { path } = saved(run("save", "--session", "bite").stdout)
    writeWorld(restarted(readWorld()))
    const named = run("restore", "--herdr", path)
    expect(named.stdout).toContain("3 restored, 0 skipped, 0 failed")
    expect(readWorld().calls.filter((c) => c[0] === "herdr").every((c) => c[1] === "--session" && c[2] === "bite")).toBe(true)
  })
})

describe("runbooks", () => {
  const book = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8")
  const CLI = "bun ~/Developer/personal/dotfiles/pane-restore/main.ts"
  // The hc path is herdr-core's cutover (hc-cutover): it reads this unit's save with `--save`.
  const CUTOVER = "bun ~/Developer/personal/dotfiles/herdr-core/cutover.ts"

  test("the Mac runbook saves and checks before the move, and checks and moves the panes into hc after", () => {
    const mac = book("mac/developer-volume/RUNBOOK.md")
    const needed = [`${CLI} save`, `${CLI} check`, `${CUTOVER} pre`, "hcm apply", `${CUTOVER} labels --snapshot <saved> --save <save>`, `${CUTOVER} resume`, `${CUTOVER} verify`]
    expect(needed.filter((text) => !mac.includes(text))).toEqual([])
  })

  test("the workbox runbook saves herdr's bite session, and restores into herdr now or hc after the cutover", () => {
    const workbox = book("linux/workbox-btrfs/RUNBOOK.md")
    const needed = [`${CLI} save --session bite`, `${CLI} check`, `${CLI} restore --herdr`, `${CUTOVER} pre --session bite`, "hcm apply", `${CUTOVER} labels --snapshot <saved> --save <save> --session bite`, `${CUTOVER} resume --session bite`, `${CUTOVER} verify`]
    expect(needed.filter((text) => !workbox.includes(text))).toEqual([])
  })
})
