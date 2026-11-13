// The workbox's hc (herdr-core) side, run through the real scripts with a
// scratch HOME and a PATH of stub commands that answer from a fixture and
// record their arguments. Nothing here touches the real host: every stub
// writes only under the scratch folder.
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const repo = join(import.meta.dir, "..", "..")
const workbox = join(repo, "workbox")
const scratchRoot = mkdtempSync(join(tmpdir(), "hc-workbox-test-"))
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }))

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

const run = async (cmd: string[], env: Record<string, string>, cwd = repo) => {
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
      "",
    ].join("\n"),
  )
  writeFileSync(join(home, "hc-status.json"), `${statusJson(host)}\n`)
}

// systemctl answers the values bootstrap and workbox-health expect of a healthy
// host, so only the cases under test vary.
const systemctlBody = `. "$HOME/host.env"
case "$*" in
  "--user is-enabled --quiet hc-core.service") exit "$HC_ENABLED_EXIT" ;;
  "--user is-active --quiet herdr-bite.service"|"--user is-enabled --quiet herdr-bite.service") exit "$HERDR_ACTIVE_EXIT" ;;
  "--user show $HC_UNIT -p OOMPolicy --value") echo "$HC_OOM" ;;
  *" -p Slice --value") echo bite.slice ;;
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

// Every command workbox-health and bootstrap --check call by name, beyond the
// POSIX tools they share with the Mac.
const quietCommands = [
  "btrfs", "bun", "curl", "git", "hunk", "mongosh", "node", "redis-cli", "rift", "sideshow", "sqlite3",
  "syncthing", "tailscale", "workbox-release-valve", "workbox-rift-storage", "workrift", "zsh", "getent",
  "ss", "gh", "aws", "mati-grafana", "install-node", "linear", "sentry", "okra", "codex", "claude", "loginctl",
  "cmp",
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

// ---------------------------------------------------------------- 1. health

const hcLabels = [
  "hc command",
  "hc core answers",
  "hc core 0.1.21 or newer",
  "hc core keeps running after logout",
  "hc-core.service enabled",
  "hc core keeps running after a terminal's OOM",
]

const runHealth = async (host: Host) => {
  const home = hostHome("health", host)
  const log = join(home, "calls.log")
  const result = await run(["/bin/sh", join(workbox, "bin", "workbox-health")], {
    HOME: home,
    PATH: "/usr/bin:/bin",
    TMPDIR: home,
  })
  const lines = result.stdout.split("\n")
  const hc = Object.fromEntries(
    hcLabels.map((label) => {
      const line = lines.find((l) => l.slice(6) === label)
      return [label, line?.startsWith("PASS") ? "pass" : line?.startsWith("FAIL") ? "fail" : "missing"]
    }),
  )
  return { stdout: result.stdout, hc, calls: calls(log) }
}

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

/** The core runs in its own hc-serve unit, which keeps running after a terminal's OOM. */
const coreUnitSafe = (host: Host) =>
  host.hcAnswers && /^hc-serve-.*\.service$/.test(host.coreUnit) && host.oomPolicy === "continue"

describe("workbox-health", () => {
  test("today (herdr and an hc core both running) and Saturday (herdr gone) are green on every hc check", async () => {
    for (const host of [today, saturday]) {
      const { hc } = await runHealth(host)
      expect(hc).toEqual(Object.fromEntries(hcLabels.map((l) => [l, "pass"])))
    }
  }, 30_000)

  test("over every host state: the hc checks pass exactly when the core answers at 0.1.21+, keeps running after logout, hc-core.service is enabled and the core's own hc-serve unit has OOMPolicy=continue; no result depends on herdr", async () => {
    const hosts: Host[] = []
    for (const herdrActive of [true, false])
      for (const herdrPresent of [true, false])
        for (const hcAnswers of [true, false])
          for (const version of ["0.1.20", "0.1.21"])
            for (const keeps of [true, false, null] as Keeps[])
              for (const hcEnabled of [true, false])
                for (const coreUnit of ["hc-serve-b8ee8d13.service", "app-other.scope"])
                  for (const oomPolicy of ["continue", "stop"])
                    hosts.push({ herdrActive, herdrPresent, hcAnswers, version, keeps, hcEnabled, coreUnit, oomPolicy })
    expect(hosts.length).toBe(384)

    const results = await pool(hosts, 4, runHealth)
    const byHcState = new Map<string, string>()
    hosts.forEach((host, i) => {
      const { hc, stdout, calls } = results[i]!
      const allPass = Object.values(hc).every((v) => v === "pass")
      const expected =
        host.hcAnswers && host.version === "0.1.21" && host.keeps === true && host.hcEnabled && coreUnitSafe(host)
      expect({ host, allPass }).toEqual({ host, allPass: expected })
      // Each check reads its own input: the OOM check fails on a wrong unit or policy alone.
      expect({ host, oom: hc["hc core keeps running after a terminal's OOM"] }).toEqual({
        host,
        oom: coreUnitSafe(host) ? "pass" : "fail",
      })
      expect(Object.values(hc)).not.toContain("missing")
      // herdr is never asked, and the whole report is the same whatever herdr's state.
      expect(calls.filter((c) => c.startsWith("herdr "))).toEqual([])
      const key = JSON.stringify([host.hcAnswers, host.version, host.keeps, host.hcEnabled, host.coreUnit, host.oomPolicy])
      const seen = byHcState.get(key)
      if (seen === undefined) byHcState.set(key, stdout)
      else expect(stdout).toBe(seen)
    })
  }, 600_000)

  test("versions compare as numbers, not text", async () => {
    const cases: [string, boolean][] = [
      ["0.1.9", false],
      ["0.1.100", true],
      ["0.2.0", true],
      ["1.0.0", true],
      ["0.1.21-rc.1", true],
      ["", false],
    ]
    const results = await pool(cases, 4, ([version]) => runHealth({ ...today, version }))
    cases.forEach(([version, ok], i) => {
      expect({ version, result: results[i]!.hc["hc core 0.1.21 or newer"] }).toEqual({ version, result: ok ? "pass" : "fail" })
    })
  }, 60_000)
})

// ---------------------------------------------------------------- 2. bootstrap

const bootstrapCheck = async (host: Host) => {
  const home = hostHome("check", host)
  const log = join(home, "calls.log")
  symlinkSync(join(workbox, "zshenv"), join(home, ".zshenv"))
  symlinkSync(join(workbox, "zshrc"), join(home, ".zshrc"))
  const result = await run(["/bin/sh", join(workbox, "bootstrap.sh"), "--check"], {
    HOME: home,
    PATH: `${join(home, ".local", "bin")}:/usr/bin:/bin`,
    TMPDIR: home,
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
  for (const file of ["bun-tools.txt", "hunk-config.toml", "backup.env", "zshenv", "zshrc", "herdr-config.toml"])
    cpSync(join(workbox, file), join(box, file))
  for (const name of readdirSync(join(workbox, "bin"))) stub(join(box, "bin"), name, log)
  stub(join(tree, "claude", "mods", "fx-ui"), "install.sh", log)
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
  stub(stubs, "claude", log, "echo 'sideshow sideshow@sideshow'")
  // herdr.dev's installer, printed by curl and run by sh, puts hc in ~/.local/bin.
  const installer = join(root, "hc-installer")
  writeFileSync(installer, `mkdir -p "$HOME/.local/bin" && cp '${join(hostBin(true), "hc")}' "$HOME/.local/bin/hc"\n`)
  stub(stubs, "curl", log, `case "$*" in
  "-fsSL https://releases.herdr.dev/core/install.sh") cat '${installer}' ;;
esac`)
  const result = await run(["/bin/sh", join(box, "bootstrap.sh")], {
    HOME: home,
    USER: "exedev",
    PATH: `${stubs}:${hostBin(host.herdrPresent, hcInstalled)}:${join(home, ".local", "bin")}:/usr/bin:/bin`,
    TMPDIR: root,
  })
  return { ...result, home, calls: calls(log) }
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
      expect(existsSync(join(result.home, ".config", "herdr", "config.toml"))).toBe(false)
      expect(existsSync(join(result.home, ".config", "bite-workbox", "herdr-plugins.txt"))).toBe(false)
    }
  }, 60_000)
})

// ---------------------------------------------------------------- 3. backup

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

// ---------------------------------------------------------------- 4. release valve

describe("workbox-release-valve", () => {
  test("protects the hc core and a terminal's holder, not a workload", async () => {
    const root = scratch("valve")
    const stubs = join(root, "stubs")
    const proc = join(root, "proc")
    const log = join(root, "calls.log")
    mkdirSync(join(proc, "pressure"), { recursive: true })
    writeFileSync(join(proc, "loadavg"), "0.50 0.40 0.30 1/100 999\n")
    writeFileSync(join(proc, "meminfo"), "MemAvailable: 8388608 kB\nSwapTotal: 1048576 kB\nSwapFree: 1048576 kB\n")
    writeFileSync(join(proc, "pressure", "memory"), "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n")
    writeFileSync(join(proc, "pressure", "cpu"), "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n")
    // pid ppid pgid comm rss args. The holder's line is the one measured on the
    // workbox (`ps -eo args`, 2026-11-13). A Bun child shares each protected
    // group, so each group is a candidate the valve has to skip.
    const table = [
      "1 0 1 systemd 9000 /sbin/init",
      "584 1 584 systemd 9000 /usr/lib/systemd/systemd --user",
      "210268 584 210268 herdr-core 50000 /home/exedev/.local/bin/herdr-core serve",
      "210270 210268 210268 bun 40000 bun /home/exedev/core-child.ts",
      "235769 584 235769 herdr-core 8000 /home/exedev/.local/bin/herdr-core hold --socket /run/user/1000/herdr-core/default.holder.8545ab7e.sock",
      "235771 235769 235769 bun 40000 bun /home/exedev/holder-child.ts",
      "300000 584 300000 bun 900000 bun run dev",
    ]
    writeFileSync(join(root, "ps.txt"), `${table.join("\n")}\n`)
    stub(stubs, "uname", log, "echo Linux")
    stub(stubs, "ps", log, `case "$*" in
  "-e -o pid=,ppid=,pgid=,comm=,rss=,args=") cat '${join(root, "ps.txt")}' ;;
  "-o pgid= -p "*) echo ' 99999' ;;
esac`)
    const result = await run(["/bin/sh", join(workbox, "bin", "workbox-release-valve")], {
      HOME: root,
      PATH: `${stubs}:/usr/bin:/bin`,
      TMPDIR: root,
      WORKBOX_PROC_ROOT: proc,
    })
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" })
    expect(result.stdout).toContain("mode=preview")
    expect(result.stdout).toContain("skip_group=210268 reason=protected_process")
    expect(result.stdout).toContain("skip_group=235769 reason=protected_process")
    expect(result.stdout).toContain("target_group=300000 ")
    expect(result.stdout).not.toMatch(/target_group=(210268|235769) /)
    expect(result.stdout).toContain("target_groups=1")
  })
})

// ---------------------------------------------------------------- 5. Hunk plugin gone

describe("the Hunk plugin is gone", () => {
  test("no plugin list, no installer, no herdr-hunk keys", async () => {
    const tracked = (await run(["git", "ls-files", "workbox"], { PATH: process.env.PATH ?? "" })).stdout
    expect(tracked.split("\n").filter((f) => f.includes("herdr-plugins"))).toEqual([])
    expect(tracked).not.toContain("install-herdr-plugins")
    for (const file of ["workbox/herdr-config.toml", "install.sh", "workbox/bootstrap.sh", "workbox/bin/workbox-health"])
      expect({ file, hunk: readFileSync(join(repo, file), "utf8").includes("herdr-hunk") }).toEqual({ file, hunk: false })
    // Hunk itself stays.
    expect(readFileSync(join(workbox, "bootstrap.sh"), "utf8")).toMatch(/\bhunk\b/)
    expect(existsSync(join(workbox, "hunk-config.toml"))).toBe(true)
    expect((await run(["/bin/sh", "-n", join(repo, "install.sh")], { PATH: "/usr/bin:/bin" })).code).toBe(0)
  })

  test.skipIf(!which("herdr"))("herdr accepts the new config (a scratch HOME)", async () => {
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

// ---------------------------------------------------------------- 6. units

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
    for (const unit of ["hc-core.service", "opencode.service"]) {
      const result = await run(
        ["systemd-analyze", "--user", "verify", join(workbox, "systemd", "user", unit)],
        { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      )
      expect({ unit, code: result.code, stderr: result.stderr }).toEqual({ unit, code: 0, stderr: "" })
    }
  })
})
