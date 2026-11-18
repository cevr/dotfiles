// The workbox's hc (herdr-core) side, run through the real scripts with a
// scratch HOME and a PATH of stub commands that answer from a fixture and
// record their arguments. Nothing here touches the real host: every path a
// script writes (HOME, TMPDIR, WORKBOX_WORKSPACES_DIR, the working folder) is
// under the scratch folder, and `run` refuses to start a script otherwise.
// 2026-11-18: bootstrap's hard-coded /workspaces/bite let each run repoint the
// real Bite base's .env at a scratch HOME this file then deleted.
import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

const repo = join(import.meta.dir, "..", "..")
const workbox = join(repo, "workbox")

/** `path` with its symbolic links resolved, a dangling one too, as far as it exists. */
const resolved = (path: string): string => {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  if (parent === path) return path
  const real = join(resolved(parent), basename(path))
  const target = linkTarget(real)
  return target === null ? real : resolved(resolve(dirname(real), target))
}
const linkTarget = (path: string) => {
  try {
    return readlinkSync(path)
  } catch {
    return null
  }
}
const isInside = (path: string, root: string) => {
  const real = resolved(path)
  return real === root || real.startsWith(`${root}/`)
}

const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), "hc-workbox-test-")))
for (const real of ["/workspaces", homedir()].map(resolved))
  if (isInside(scratchRoot, real)) throw new Error(`hc.test: scratch folder ${scratchRoot} is inside ${real}; set TMPDIR to /tmp`)
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }))

// The variables that name a place a script writes. A bootstrap run must set
// all three: its defaults are the real /workspaces and HOME.
const writtenPathKeys = ["HOME", "TMPDIR", "WORKBOX_WORKSPACES_DIR", "WORKBOX_BACKUP_CONFIG", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"]
const bootstrapKeys = ["HOME", "TMPDIR", "WORKBOX_WORKSPACES_DIR"]

/** Throws before a script starts when it could write outside the scratch folder. */
const guard = (cmd: string[], env: Record<string, string>, cwd: string) => {
  const outside = [
    ...writtenPathKeys.filter((key) => key in env && !isInside(env[key]!, scratchRoot)).map((key) => `${key}=${env[key]}`),
    ...(isInside(cwd, scratchRoot) ? [] : [`cwd=${cwd}`]),
    ...(cmd.some((part) => basename(part) === "bootstrap.sh") ? bootstrapKeys.filter((key) => !(key in env)).map((key) => `${key} unset`) : []),
  ]
  if (outside.length > 0) throw new Error(`hc.test: ${cmd.join(" ")} could write outside ${scratchRoot}: ${outside.join(", ")}`)
}

const which = (name: string) => Bun.which(name) ?? ""
const jq = which("jq")

let scratchCount = 0
const scratch = (label: string) => {
  const dir = join(scratchRoot, `${label}-${scratchCount++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * A stub that appends `<name> <args>` to `log` (by default `$HOME/calls.log`),
 * then runs `body` (sh). macOS checks each new executable on its first run, so
 * stubs shared between cases are made once and read the case from `$HOME`.
 */
const stub = (dir: string, name: string, log: string | null, body = "exit 0") => {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  const target = log === null ? `"$HOME/calls.log"` : `'${log}'`
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> ${target}\n${body}\n`)
  chmodSync(file, 0o755)
}

const link = (dir: string, name: string, target: string) => {
  mkdirSync(dir, { recursive: true })
  symlinkSync(target, join(dir, name))
}

const run = async (cmd: string[], env: Record<string, string>, cwd = scratchRoot) => {
  guard(cmd, env, cwd)
  const proc = Bun.spawn(cmd, { env, cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

const calls = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [])

// ---------------------------------------------------------------- host fixture

type Keeps = true | false | null
type Host = {
  herdrActive: boolean
  herdrPresent: boolean
  hcAnswers: boolean
  version: string
  keeps: Keeps
  hcEnabled: boolean
  /** The user unit `ps -o uunit=` names for the core's pid. */
  coreUnit: string
  /** That unit's OOMPolicy, whatever unit it is. */
  oomPolicy: string
  /** Whether each user timer has its next run set; false as a timer on OnUnitActiveSec after a user manager restart. */
  timersArmed?: boolean
}

const statusJson = (host: Host) =>
  JSON.stringify({
    core: { id: "0123", name: "bite-cristian" },
    finished: 0,
    holder: null,
    holders: [],
    installed_by: null,
    keeps_running_after_logout: host.keeps,
    live: 0,
    logout_linger_user: "exedev",
    pid: 4242,
    uptime_ms: 1000,
    version: host.version,
  })

/** Writes the case into the scratch HOME, where the shared stubs read it. */
const writeHost = (home: string, host: Host) => {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, "host.env"),
    [
      `HC_ANSWERS=${host.hcAnswers ? 1 : 0}`,
      `HC_ENABLED_EXIT=${host.hcEnabled ? 0 : 1}`,
      `HERDR_ACTIVE_EXIT=${host.herdrActive ? 0 : 3}`,
      `HC_UNIT=${host.coreUnit}`,
      `HC_OOM=${host.oomPolicy}`,
      `TIMER_NEXT='${host.timersArmed === false ? "" : "Tue 2026-11-17 06:00:00 UTC"}'`,
      "",
    ].join("\n"),
  )
  writeFileSync(join(home, "hc-status.json"), `${statusJson(host)}\n`)
}

// systemctl answers the values bootstrap --check expects of a healthy
// host, so only the cases under test vary.
const systemctlBody = `. "$HOME/host.env"
case "$*" in
  "--user is-enabled --quiet hc-core.service") exit "$HC_ENABLED_EXIT" ;;
  "--user is-active --quiet herdr-bite.service"|"--user is-enabled --quiet herdr-bite.service") exit "$HERDR_ACTIVE_EXIT" ;;
  "--user show $HC_UNIT -p OOMPolicy --value") echo "$HC_OOM" ;;
  *" -p Slice --value") echo bite.slice ;;
  *".timer -p NextElapseUSecRealtime -p NextElapseUSecMonotonic --value") printf '%s\\n%s\\n' "$TIMER_NEXT" 0 ;;
  "show bite.slice -p MemoryMin --value") echo 268435456 ;;
  "show bite.slice -p MemoryLow --value") echo 536870912 ;;
  "show user-"*" -p MemoryMax --value") echo 55834574848 ;;
  "show user-"*" -p MemorySwapMax --value") echo 1073741824 ;;
  *" -p MemorySwapMax --value") echo 0 ;;
  "show tailscaled.service -p MemoryMin --value") echo 134217728 ;;
  "show tailscaled.service -p MemoryLow --value") echo 268435456 ;;
  "show tailscaled.service -p OOMScoreAdjust --value") echo -900 ;;
  "show systemd-resolved.service -p MemoryMin --value") echo 33554432 ;;
  "show systemd-resolved.service -p MemoryLow --value") echo 67108864 ;;
  "show systemd-resolved.service -p OOMScoreAdjust --value") echo -800 ;;
  "show bite-workbox-sshd.service -p MemoryMin --value") echo 33554432 ;;
  "show bite-workbox-sshd.service -p MemoryLow --value") echo 67108864 ;;
  "show bite-workbox-sshd.service -p OOMScoreAdjust --value") echo -900 ;;
  *" --value") echo 0 ;;
esac
exit 0`

const hcBody = `. "$HOME/host.env"
if [ "$HC_ANSWERS" != 1 ]; then
  printf '%s\\n' '{"error":{"kind":"unavailable","message":"no core"}}' >&2
  exit 1
fi
case "$*" in
  "server status --json"|"server start"*) cat "$HOME/hc-status.json" ;;
esac
exit 0`

const psBody = `. "$HOME/host.env"
case "$*" in
  "-o uunit= -p 4242") echo " $HC_UNIT" ;;
  *) exit 1 ;;
esac`

// Every command bootstrap --check calls by name, beyond the POSIX tools it
// shares with the Mac.
const quietCommands = [
  "btrfs", "bun", "curl", "git", "hunk", "mongosh", "node", "redis-cli", "sideshow", "sqlite3",
  "syncthing", "tailscale", "work", "workbox-rift-storage", "workrift", "zsh", "install-node", "loginctl", "cmp",
]

/** The host's commands, made once for each {herdr present, hc present}. */
const hostBins = new Map<string, string>()
const hostBin = (herdrPresent: boolean, hcPresent = true) => {
  const key = `${herdrPresent}-${hcPresent}`
  const known = hostBins.get(key)
  if (known) return known
  const dir = scratch(`bin-${key}`)
  for (const name of quietCommands) stub(dir, name, null)
  stub(dir, "systemctl", null, systemctlBody)
  if (hcPresent) stub(dir, "hc", null, hcBody)
  stub(dir, "ps", null, psBody)
  stub(dir, "df", null, "printf 'Use%%\\n 50%%\\n'")
  stub(dir, "swapon", null, "echo /swapfile")
  stub(dir, "findmnt", null, "echo rw,nosuid,nodev,size=8388608k")
  stub(
    dir,
    "readlink",
    null,
    `if [ "$1" = /etc/resolv.conf ]; then echo ../run/systemd/resolve/stub-resolv.conf; else exec /usr/bin/readlink "$@"; fi`,
  )
  if (herdrPresent) stub(dir, "herdr", null, "echo 'config: ok'")
  link(dir, "jq", jq)
  hostBins.set(key, dir)
  return dir
}

/** A scratch HOME for `host` whose ~/.local/bin is the shared host commands. */
const hostHome = (label: string, host: Host) => {
  const home = scratch(label)
  writeHost(home, host)
  mkdirSync(join(home, ".local"))
  symlinkSync(hostBin(host.herdrPresent), join(home, ".local", "bin"))
  return home
}

// ---------------------------------------------------------------- 1. bootstrap

const pool = async <T, R>(items: T[], width: number, f: (item: T) => Promise<R>) => {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await f(items[i]!)
      }
    }),
  )
  return out
}

const today: Host = {
  herdrActive: true,
  herdrPresent: true,
  hcAnswers: true,
  version: "0.1.21",
  keeps: true,
  hcEnabled: true,
  coreUnit: "hc-serve-b8ee8d13.service",
  oomPolicy: "continue",
}
const saturday: Host = { ...today, herdrActive: false, herdrPresent: false }

const bootstrapCheck = async (host: Host) => {
  const home = hostHome("check", host)
  const log = join(home, "calls.log")
  symlinkSync(join(workbox, "zshenv"), join(home, ".zshenv"))
  symlinkSync(join(workbox, "zshrc"), join(home, ".zshrc"))
  const result = await run(["/bin/sh", join(workbox, "bootstrap.sh"), "--check"], {
    HOME: home,
    PATH: `${join(home, ".local", "bin")}:/usr/bin:/bin`,
    TMPDIR: home,
    WORKBOX_WORKSPACES_DIR: join(home, "workspaces"),
  })
  return { ...result, calls: calls(log) }
}

/** A copy of the dotfiles tree bootstrap reads, with every script it runs replaced by a stub. */
const bootstrapTree = (root: string, log: string) => {
  const tree = join(root, "dotfiles")
  const box = join(tree, "workbox")
  mkdirSync(box, { recursive: true })
  cpSync(join(workbox, "bootstrap.sh"), join(box, "bootstrap.sh"))
  cpSync(join(workbox, "systemd"), join(box, "systemd"), { recursive: true })
  for (const file of ["hunk-config.toml", "backup.env", "zshenv", "zshrc", "herdr-config.toml"])
    cpSync(join(workbox, file), join(box, file))
  for (const name of readdirSync(join(workbox, "bin"))) stub(join(box, "bin"), name, log)
  stub(join(tree, "claude", "mods", "fx-ui"), "install.sh", log)
  // The real install-bin.sh: it installs the stubbed bin/ into ~/.local/bin, as bootstrap did itself before.
  cpSync(join(workbox, "install-bin.sh"), join(box, "install-bin.sh"))
  return box
}

const runBootstrap = async (host: Host, hcInstalled: boolean) => {
  const root = scratch("bootstrap")
  const home = join(root, "home")
  const stubs = join(root, "stubs")
  const log = join(home, "calls.log")
  writeHost(home, host)
  const box = bootstrapTree(root, log)
  // The ones a full run adds to what --check calls.
  stub(stubs, "uname", log, "echo Linux")
  stub(stubs, "sudo", log)
  stub(stubs, "tailscale", log, `case "$*" in
  "ip -4") echo 100.64.0.1 ;;
  "status --json") echo '{"BackendState":"Running"}' ;;
esac`)
  // herdr.dev's installer, printed by curl and run by sh, puts hc in ~/.local/bin.
  const installer = join(root, "hc-installer")
  writeFileSync(installer, `mkdir -p "$HOME/.local/bin" && cp '${join(hostBin(true), "hc")}' "$HOME/.local/bin/hc"\n`)
  stub(stubs, "curl", log, `case "$*" in
  "-fsSL https://releases.herdr.dev/core/install.sh") cat '${installer}' ;;
esac`)
  // A Bite base made by `workrift init`, which bootstrap gives its .env link.
  const workspaces = join(root, "workspaces")
  mkdirSync(join(workspaces, "bite"), { recursive: true })
  writeFileSync(join(workspaces, "bite", ".rift"), "")
  const result = await run(["/bin/sh", join(box, "bootstrap.sh")], {
    HOME: home,
    USER: "exedev",
    PATH: `${stubs}:${hostBin(host.herdrPresent, hcInstalled)}:${join(home, ".local", "bin")}:/usr/bin:/bin`,
    TMPDIR: root,
    WORKBOX_WORKSPACES_DIR: workspaces,
  })
  return { ...result, home, workspaces, calls: calls(log) }
}

describe("bootstrap", () => {
  test("--check passes today and on Saturday, and never runs herdr", async () => {
    for (const host of [today, saturday]) {
      const result = await bootstrapCheck(host)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("Workbox bootstrap checks passed.")
      expect(result.code).toBe(0)
      expect(result.calls.filter((c) => c.startsWith("herdr "))).toEqual([])
      expect(result.calls).toContain("hc server status --json")
    }
  }, 30_000)

  test("--check fails when a user timer is active with no next run (2026-11-13: OnUnitActiveSec after a user manager restart)", async () => {
    const checked = await bootstrapCheck({ ...today, timersArmed: false })
    expect({ code: checked.code === 0 ? 0 : "failed", passed: checked.stdout.includes("checks passed") }).toEqual({ code: "failed", passed: false })
  }, 30_000)

  test("--check compares hc versions as numbers, not text", async () => {
    const cases: [string, boolean][] = [
      ["0.1.9", false],
      ["0.1.20", false],
      ["0.1.21", true],
      ["0.1.100", true],
      ["0.2.0", true],
      ["1.0.0", true],
      ["0.1.21-rc.1", true],
      ["", false],
    ]
    const results = await pool(cases, 4, ([version]) => bootstrapCheck({ ...today, version }))
    cases.forEach(([version, ok], i) => {
      expect({ version, passed: results[i]!.code === 0 }).toEqual({ version, passed: ok })
    })
  }, 60_000)

  test("--check fails on each wrong hc input alone: no core, hc-core.service not enabled, keeps unknown, the core outside an hc-serve unit, OOMPolicy=stop", async () => {
    const wrong: Host[] = [
      { ...today, hcAnswers: false },
      { ...today, hcEnabled: false },
      { ...today, keeps: null },
      { ...today, coreUnit: "app-other.scope" },
      { ...today, oomPolicy: "stop" },
      { ...saturday, coreUnit: "app-other.scope" },
      { ...saturday, oomPolicy: "stop" },
    ]
    for (const host of wrong) {
      const result = await bootstrapCheck(host)
      expect({ host, code: result.code === 0 ? 0 : "failed", passed: result.stdout.includes("checks passed") }).toEqual({
        host,
        code: "failed",
        passed: false,
      })
    }
  }, 60_000)

  test("a full run enables hc-core.service and opencode.service, leaves herdr alone and never restarts a core", async () => {
    for (const [host, hcInstalled] of [[today, true], [saturday, true], [saturday, false]] as const) {
      const result = await runBootstrap(host, hcInstalled)
      // On the Mac, bootstrap's grep of /etc/fstab finds no file; nothing else may complain.
      const stderr = result.stderr.split("\n").filter((l) => l && !l.includes("/etc/fstab"))
      expect({ hcInstalled, code: result.code, stderr }).toEqual({ hcInstalled, code: 0, stderr: [] })
      const all = result.calls.join("\n")
      expect(all).not.toContain("migrate-herdr-to-systemd")
      expect(all).not.toContain("install-herdr-plugins")
      expect(all).not.toMatch(/^herdr /m)
      expect(all).not.toMatch(/(stop|disable|mask|kill).*herdr-bite/)
      expect(all).not.toMatch(/^hc server (stop|restart)/m)
      expect(result.calls).toContain("systemctl --user enable --now hc-core.service")
      expect(result.calls).toContain("systemctl --user enable opencode.service")
      const installs = result.calls.filter((c) => c.includes("releases.herdr.dev/core/install.sh"))
      expect(installs).toEqual(hcInstalled ? [] : ["curl -fsSL https://releases.herdr.dev/core/install.sh"])
      expect(existsSync(join(result.home, ".config", "systemd", "user", "hc-core.service"))).toBe(true)
      expect(existsSync(join(result.home, ".config", "systemd", "user", "opencode.service"))).toBe(true)
      // hc holds the terminals: no herdr server unit is installed.
      expect(existsSync(join(result.home, ".config", "systemd", "user", "herdr-bite.service"))).toBe(false)
      expect(existsSync(join(result.home, ".config", "herdr", "config.toml"))).toBe(false)
      expect(existsSync(join(result.home, ".config", "bite-workbox", "herdr-plugins.txt"))).toBe(false)
      // The Bite base under WORKBOX_WORKSPACES_DIR, never /workspaces/bite, gets the .env link and the warm step.
      const bite = join(result.workspaces, "bite")
      expect(readlinkSync(join(bite, ".env"))).toBe(join(result.home, ".config", "bite-workbox", "bite-env", ".env"))
      expect(result.calls).toContain(
        `git -C ${bite} config workrift.warm TURBO_CACHE=local:rw TURBO_CACHE_DIR=${result.workspaces}/.cache/turbo bun run compile`,
      )
      expect(all).not.toMatch(/(^|\s)\/workspaces\//m)
    }
  }, 60_000)

  test("the guard refuses a bootstrap run whose paths leave the scratch folder", async () => {
    const home = scratch("guard")
    const env = { HOME: home, TMPDIR: home, WORKBOX_WORKSPACES_DIR: join(home, "workspaces") }
    const script = join(workbox, "bootstrap.sh")
    for (const [label, bad] of [
      ["no WORKBOX_WORKSPACES_DIR", { HOME: home, TMPDIR: home }],
      ["the real /workspaces", { ...env, WORKBOX_WORKSPACES_DIR: "/workspaces" }],
      ["a real HOME", { ...env, HOME: homedir() }],
      ["a link out of scratch", { ...env, WORKBOX_WORKSPACES_DIR: join(home, "escape", "bite") }],
    ] as const) {
      if (label === "a link out of scratch") symlinkSync("/nonexistent/loop-probe-x", join(home, "escape"))
      await expect(run(["/bin/sh", script, "--check"], bad)).rejects.toThrow(/could write outside/)
    }
    await expect(run(["/bin/sh", script, "--check"], env, workbox)).rejects.toThrow(/cwd=/)
  })
})

// ---------------------------------------------------------------- 2. backup

const runBackup = async (dirs: string[]) => {
  const root = scratch("backup")
  const home = join(root, "home")
  const stubs = join(root, "stubs")
  const log = join(root, "calls.log")
  const uploaded = join(root, "uploaded.tar.gz")
  for (const file of dirs) {
    mkdirSync(dirname(join(home, file)), { recursive: true })
    writeFileSync(join(home, file), "{}\n")
  }
  const config = join(root, "backup.env")
  writeFileSync(config, "AWS_PROFILE=test\nAWS_REGION=us-east-1\nWORKBOX_BACKUP_BUCKET=test-bucket\n")
  // put-object keeps --body; get-object writes it back to its last argument.
  stub(stubs, "aws", log, `case "$1 $2" in
  "s3api put-object") while [ "$#" -gt 0 ]; do [ "$1" = --body ] && cp "$2" '${uploaded}'; shift; done ;;
  "s3api get-object") for last; do :; done; cp '${uploaded}' "$last" ;;
esac`)
  stub(stubs, "sqlite3", log)
  const result = await run(["/bin/sh", join(workbox, "bin", "backup-state")], {
    HOME: home,
    PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: root,
    WORKBOX_BACKUP_CONFIG: config,
  })
  const out = join(root, "out")
  mkdirSync(out)
  const list = async (archive: string) =>
    (await run(["tar", "-tzf", archive], { PATH: "/usr/bin:/bin" })).stdout.split("\n").filter(Boolean)
  let archives: string[] = []
  if (existsSync(uploaded)) {
    await run(["tar", "-xzf", uploaded, "-C", out], { PATH: "/usr/bin:/bin" })
    archives = readdirSync(join(out, "snapshot", "archives")).sort()
  }
  return { ...result, archives, list: (name: string) => list(join(out, "snapshot", "archives", name)) }
}

const hcFiles = [".config/herdr-core/config.toml", ".local/state/herdr-core/default/terminals.json"]
const herdrFiles = [".config/herdr/config.toml", ".local/state/herdr/session.json"]

describe("backup-state", () => {
  test("hc state alone: hc-state.tar.gz holds terminals.json, and no herdr archive", async () => {
    const result = await runBackup(hcFiles)
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" })
    expect(result.archives).toEqual(["claude-sessions.tar.gz", "hc-state.tar.gz"])
    expect(await result.list("hc-state.tar.gz")).toContain(".local/state/herdr-core/default/terminals.json")
  })

  test("hc and herdr state: both archives", async () => {
    const result = await runBackup([...hcFiles, ...herdrFiles])
    expect(result.code).toBe(0)
    expect(result.archives).toEqual(["claude-sessions.tar.gz", "hc-state.tar.gz", "herdr-state.tar.gz"])
    expect(await result.list("hc-state.tar.gz")).toContain(".local/state/herdr-core/default/terminals.json")
    expect(await result.list("herdr-state.tar.gz")).toContain(".config/herdr/config.toml")
  })

  test("a fresh box with no hc or herdr state still backs up", async () => {
    const result = await runBackup([])
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" })
    expect(result.archives).toEqual(["claude-sessions.tar.gz", "hc-state.tar.gz"])
  })
})

// ---------------------------------------------------------------- 3. herdr config (the Mac's)

describe("herdr-config.toml", () => {
  test.skipIf(!which("herdr"))("herdr accepts the config (a scratch HOME)", async () => {
    const home = scratch("herdr-config")
    mkdirSync(join(home, ".config", "herdr"), { recursive: true })
    cpSync(join(workbox, "herdr-config.toml"), join(home, ".config", "herdr", "config.toml"))
    const result = await run([which("herdr"), "config", "check"], {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PATH: "/usr/bin:/bin",
    })
    expect({ code: result.code, out: result.stdout.trim() }).toEqual({ code: 0, out: "config: ok" })
  })
})

// ---------------------------------------------------------------- 4. units

describe("unit files", () => {
  test("hc-core.service is a oneshot at default.target that only runs `hc server start`", () => {
    const unit = readFileSync(join(workbox, "systemd", "user", "hc-core.service"), "utf8")
    const keys = unit.split("\n").filter((l) => /^[A-Za-z]+=/.test(l))
    expect(keys).toContain("Type=oneshot")
    expect(keys).toContain("ExecStart=%h/.local/bin/hc server start")
    expect(keys).toContain("WantedBy=default.target")
    expect(keys.filter((k) => k.startsWith("ExecStart="))).toHaveLength(1)
    // hc moves the core out of this unit; nothing here may stop it.
    expect(keys.filter((k) => /^(ExecStop|Restart|RemainAfterExit)=/.test(k))).toEqual([])
  })

  test("opencode.service starts and stops the OpenCode service as a oneshot at default.target", () => {
    const unit = readFileSync(join(workbox, "systemd", "user", "opencode.service"), "utf8")
    const keys = unit.split("\n").filter((l) => /^[A-Za-z]+=/.test(l))
    for (const key of [
      "Type=oneshot",
      "RemainAfterExit=yes",
      "ExecStart=%h/.local/bin/opencode service start",
      "ExecStop=%h/.local/bin/opencode service stop",
      "After=network-online.target",
      "Wants=network-online.target",
      "WantedBy=default.target",
    ])
      expect(keys).toContain(key)
  })

  test.skipIf(!which("systemd-analyze"))("systemd-analyze verify accepts both units", async () => {
    // A scratch HOME whose ~/.local/bin holds the commands the units start, as verify checks they exist.
    const home = scratch("systemd-analyze")
    for (const name of ["hc", "opencode"]) stub(join(home, ".local", "bin"), name, join(home, "calls.log"))
    for (const unit of ["hc-core.service", "opencode.service"]) {
      const result = await run(
        ["systemd-analyze", "--user", "verify", join(workbox, "systemd", "user", unit)],
        { PATH: process.env.PATH ?? "", HOME: home, XDG_RUNTIME_DIR: scratch("systemd-analyze-run") },
      )
      expect({ unit, code: result.code, stderr: result.stderr }).toEqual({ unit, code: 0, stderr: "" })
    }
  })
})
