// `bun run fleet-install`: installs the fleet (the MacBook, then the workbox) from origin/main and
// the fork's origin/prime-look with one command. The rules are in scripts/fleet.ts; this file is
// the command and the outside world.
//
//   bun run fleet-install [--reason <why>] [--force] [--upstream] [--wait]
//       Asks for an install: one line in the fleet's requests, then the coordinator starts, or the
//       running one takes it. On the Mac the coordinator is a one-shot launchd job (never
//       `launchctl submit`, whose KeepAlive reruns it), outside the OpenCode server's process tree,
//       since the Mac's install restarts that server; on any other host the request goes to the
//       Mac over ssh. `--force` installs a host already on the target, `--upstream` merges
//       upstream OpenCode into the fork first (the daily install), `--wait` follows the run and
//       prints each host's line.
//   bun scripts/fleet-install.ts run
//       The coordinator (what the launchd job runs): passes over the hosts until no request waits
//       (scripts/fleet.ts `coordinate`). Each host's step: the Mac's runs here, the workbox's over
//       `ssh bite-workbox` in a transient systemd unit of its own, so neither its server's restart
//       nor a plugin reload can stop it. After a pass that installed, the Mac's `upstream.json`
//       (the TUI's corner) is copied to the workbox, whose fork has no upstream remote.
//   bun scripts/fleet-install.ts host [--force] [--upstream]
//       One host's step, run by scripts/fleet/host-sync.sh once the dotfiles checkout reached
//       origin/main: skip when the stamp names the target, else `bun install`, the
//       fork's links and `bun run daily`, which writes the stamp. Its last line is the result.
//
// Everything is under ~/.local/state/opencode-fleet: `fleet.log` (one line per host per pass),
// `runs/<time>.log` (each pass's whole output), `last.json`, `requests.jsonl`, `installed.json`
// (the host's stamp). Nothing else tells of it: no notification, no message to a session.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join, resolve } from "node:path"
import {
  CHECKOUT,
  coordinate,
  coordinatorOf,
  files,
  type Flags,
  type FleetHost,
  forkTarget,
  HOSTS,
  hostInstall,
  hostKey,
  hostOf,
  type HostResult,
  parseResult,
  pendingIn,
  readStamp,
  requestLine,
  resultLine,
  STATE,
  stampFile,
} from "./fleet.ts"
import { BRANCH, FORK_OWNER } from "./upstream.ts"

const OPENCODE = resolve(import.meta.dir, "..")
const HOST_SYNC = join(import.meta.dir, "fleet/host-sync.sh")
/** ssh that never prompts, gives up on a host it cannot reach, and notices a link that died mid-install. */
const SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4"] as const
/** The coordinator's launchd label. */
export const LABEL = "dev.cvr.opencode-fleet-install"

/** A word as one shell word. */
export const quote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`

const flagArgs = (flags: Flags) => [...(flags.force ? ["--force"] : []), ...(flags.upstream ? ["--upstream"] : [])]

/**
 * The command that runs `host`'s step over ssh: host-sync.sh (copied there first) in a transient
 * user unit, waited on and piped back. A unit of that name already running means an install runs
 * there now; systemd refuses the second.
 */
export const remoteCommand = (host: FleetHost, flags: Flags): string =>
  [
    "systemd-run --user --pipe --wait --quiet --collect --unit opencode-fleet-install",
    `--setenv=PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"`,
    `--setenv=FLEET_HOST=${host.name}`,
    `bash "$HOME/${STATE}/host-sync.sh" ${host.sync} "$HOME/${CHECKOUT}"`,
    ...flagArgs(flags),
  ].join(" ")

/** The one-shot launchd job that runs the coordinator: once at load, never again (no KeepAlive). */
export const plist = (input: { readonly bun: string; readonly script: string; readonly log: string; readonly env: Readonly<Record<string, string>> }): string => {
  const esc = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  const strings = (items: ReadonlyArray<string>) => items.map((item) => `<string>${esc(item)}</string>`).join("")
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0"><dict>`,
    `<key>Label</key><string>${LABEL}</string>`,
    `<key>ProgramArguments</key><array>${strings([input.bun, input.script, "run"])}</array>`,
    `<key>EnvironmentVariables</key><dict>${Object.entries(input.env)
      .map(([key, value]) => `<key>${esc(key)}</key><string>${esc(value)}</string>`)
      .join("")}</dict>`,
    `<key>RunAtLoad</key><true/>`,
    `<key>KeepAlive</key><false/>`,
    `<key>AbandonProcessGroup</key><true/>`,
    `<key>StandardOutPath</key><string>${esc(input.log)}</string>`,
    `<key>StandardErrorPath</key><string>${esc(input.log)}</string>`,
    `</dict></plist>`,
    "",
  ].join("\n")
}

// ── Processes ──────────────────────────────────────────────────────────

const run = (cmd: ReadonlyArray<string>, options: { readonly cwd?: string; readonly env?: Record<string, string | undefined>; readonly stdin?: string } = {}) => {
  const ran = Bun.spawnSync([...cmd], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : Bun.file(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: ran.exitCode, out: ran.stdout.toString().trim(), err: ran.stderr.toString().trim() }
}

/** Runs `cmd`, every line of its output appended to `log` as it comes; answers its exit code and output. */
const follow = async (cmd: ReadonlyArray<string>, log: string, env: Record<string, string> = {}, stdin?: string) => {
  const child = Bun.spawn([...cmd], {
    env: { ...process.env, ...env },
    stdin: stdin === undefined ? "ignore" : Bun.file(stdin),
    stdout: "pipe",
    stderr: "pipe",
  })
  let output = ""
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true })
      output += text
      appendFileSync(log, text)
    }
  }
  await Promise.all([drain(child.stdout), drain(child.stderr)])
  return { code: await child.exited, output }
}

/** Whether `pid` runs, read from `ps` (no signal is sent). */
const alive = (pid: number) => Number.isInteger(pid) && pid > 0 && run(["ps", "-p", String(pid), "-o", "pid="]).out !== ""

const lockHolder = (lock: string): number | undefined => {
  if (!existsSync(lock)) return undefined
  const pid = Number(readFileSync(lock, "utf8").trim())
  return alive(pid) ? pid : undefined
}

const parseFlags = (argv: ReadonlyArray<string>): Flags => ({ force: argv.includes("--force"), upstream: argv.includes("--upstream") })

const say = (line: string) => console.log(line)

// ── The host step ──────────────────────────────────────────────────────

const hostStep = async (argv: ReadonlyArray<string>) => {
  const home = homedir()
  const spec = hostOf(hostname())
  if (spec === undefined) {
    say(resultLine({ host: hostname(), outcome: "failed", line: `${hostname()}: failed, not a host of the fleet (scripts/fleet.ts HOSTS)` }))
    process.exit(1)
  }
  const checkout = resolve(OPENCODE, "..")
  const fork = join(home, spec.fork)
  const env = { OPENCODE_DEV: fork, ...Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, join(home, value)])) }
  const git = (dir: string, ...args: ReadonlyArray<string>) => run(["git", "-C", dir, ...args])
  const step = (name: string, cmd: ReadonlyArray<string>) => {
    say(`$ ${cmd.join(" ")}`)
    const ran = Bun.spawnSync([...cmd], { cwd: OPENCODE, env: { ...process.env, ...env }, stdin: "ignore", stdout: "inherit", stderr: "inherit" })
    return ran.exitCode === 0 ? undefined : `${name} exited ${ran.exitCode}`
  }
  const result = await hostInstall(
    {
      name: spec.name,
      ...(spec.host === FORK_OWNER
        ? {
            upstream: async () => {
              const failed = step("bun install", ["bun", "install", "--frozen-lockfile"]) ?? step("post-land", ["bun", "scripts/post-land.ts"])
              return failed === undefined ? "upstream: merged as post-land reports above" : `upstream: ${failed}; the install goes on`
            },
          }
        : {}),
      target: async () => {
        git(fork, "fetch", "--quiet", "origin", BRANCH)
        const head = git(fork, "rev-parse", "HEAD").out
        const origin = git(fork, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${BRANCH}`)
        const behind = origin.code === 0 && git(fork, "merge-base", "--is-ancestor", "HEAD", origin.out).code === 0
        return { checkout, dotfiles: git(checkout, "rev-parse", "HEAD").out, fork: forkTarget(head, origin.code === 0 ? origin.out : undefined, behind) }
      },
      stamp: () => (existsSync(join(home, ".local/bin/opencode")) ? readStamp(stampFile(home)) : undefined),
      install: async () => {
        // The links before and after the install, as daily does: an install drops links it did not make.
        const failed =
          step("link-fork", ["bun", "scripts/link-fork.ts"]) ??
          step("bun install", ["bun", "install", "--frozen-lockfile"]) ??
          step("link-fork", ["bun", "scripts/link-fork.ts"]) ??
          step("daily", ["bun", "scripts/daily.ts"])
        return failed === undefined ? { ok: true } : { ok: false, why: `${failed}; the log has its output` }
      },
      now: Date.now,
      log: say,
    },
    parseFlags(argv),
  )
  say(resultLine(result))
  process.exit(result.outcome === "failed" ? 1 : 0)
}

// ── The coordinator ────────────────────────────────────────────────────

const coordinatorRun = async () => {
  const home = homedir()
  const paths = files(home)
  mkdirSync(paths.runs, { recursive: true })
  const holder = lockHolder(paths.lock)
  if (holder !== undefined && holder !== process.pid) {
    say(`a coordinator already runs (pid ${holder}); it takes the waiting requests`)
    return
  }
  writeFileSync(paths.lock, String(process.pid))
  const runLog = join(paths.runs, `${new Date().toISOString().replaceAll(":", "-")}.log`)
  const stamp = () => new Date().toISOString()
  const log = (line: string) => {
    appendFileSync(paths.log, `${stamp()} ${line}\n`)
    appendFileSync(runLog, `== ${line}\n`)
    say(line)
  }
  const me = hostKey(hostname())
  const install = async (name: string, flags: Flags): Promise<HostResult> => {
    const spec = HOSTS.find((host) => host.name === name)!
    appendFileSync(runLog, `\n== ${name}: start ${stamp()}\n`)
    if (spec.host === me) {
      const ran = await follow(["bash", HOST_SYNC, spec.sync, join(home, CHECKOUT), ...flagArgs(flags)], runLog, { FLEET_HOST: spec.name })
      return parseResult(ran.output) ?? { host: name, outcome: "failed", line: `${name}: failed, its step exited ${ran.code} with no result; ${runLog}` }
    }
    const copied = run([...SSH, spec.ssh, `mkdir -p "$HOME/${STATE}" && cat > "$HOME/${STATE}/host-sync.sh"`], { stdin: HOST_SYNC })
    if (copied.code === 255) return { host: name, outcome: "unreachable", line: `${name}: unreachable over ssh ${spec.ssh} (${copied.err.split("\n").at(-1)})` }
    if (copied.code !== 0) return { host: name, outcome: "failed", line: `${name}: failed, copying host-sync.sh exited ${copied.code}: ${copied.err}` }
    const ran = await follow([...SSH, spec.ssh, remoteCommand(spec, flags)], runLog)
    const result = parseResult(ran.output)
    if (result !== undefined) return result
    if (ran.code === 255) return { host: name, outcome: "unreachable", line: `${name}: unreachable over ssh ${spec.ssh}` }
    if (/already (loaded|exists)/.test(ran.output)) return { host: name, outcome: "deferred", line: `${name}: deferred, an install already runs there` }
    return { host: name, outcome: "failed", line: `${name}: failed, its step exited ${ran.code} with no result; ${runLog}` }
  }
  const copyUpstream = async () => {
    const file = join(home, ".local/state/opencode-daily/upstream.json")
    if (!existsSync(file)) return "upstream.json: none here to copy"
    const others = HOSTS.filter((host) => host.host !== me)
    const copied = others.map((host) => ({
      host,
      code: run([...SSH, host.ssh, `mkdir -p "$HOME/.local/state/opencode-daily" && cat > "$HOME/.local/state/opencode-daily/upstream.json"`], { stdin: file }).code,
    }))
    return `upstream.json: ${copied.map(({ host, code }) => (code === 0 ? `copied to ${host.name}` : `not copied to ${host.name} (exit ${code})`)).join(", ")}`
  }
  const pending = () => pendingIn(paths.requests, paths.consumed)
  try {
    for (;;) {
      const results = await coordinate({
        hosts: HOSTS.map((host) => host.name),
        install,
        copyUpstream,
        log,
        pending,
        consume: (through) => {
          writeFileSync(paths.consumed, String(through))
          // The file keeps only what waits.
          writeFileSync(paths.requests, pending().map(requestLine).join(""))
        },
        now: Date.now,
        sleep: (ms) => Bun.sleep(ms),
      })
      writeFileSync(paths.last, `${JSON.stringify({ at: Date.now(), log: runLog, results }, null, 2)}\n`)
      rmSync(paths.lock, { force: true })
      // A request that came as the last pass ended saw the lock still held and started nothing: take it now.
      if (pending().length === 0 || lockHolder(paths.lock) !== undefined) return
      writeFileSync(paths.lock, String(process.pid))
    }
  } finally {
    if (lockHolder(paths.lock) === process.pid) rmSync(paths.lock, { force: true })
  }
}

// ── A request ──────────────────────────────────────────────────────────

/** Starts the coordinator as a one-shot launchd job; a finished one still loaded is removed first. */
const launch = (home: string): string => {
  const paths = files(home)
  const listed = run(["launchctl", "list"]).out.split("\n").map((line) => line.split("\t"))
  const loaded = listed.find((fields) => fields[2] === LABEL)
  if (loaded !== undefined && loaded[0] !== "-") return `the coordinator runs (pid ${loaded[0]}); it takes this request`
  if (loaded !== undefined) run(["launchctl", "remove", LABEL])
  const bun = Bun.which("bun") ?? join(home, ".bun/bin/bun")
  const path = [join(home, ".local/bin"), join(home, ".bun/bin"), "/opt/homebrew/bin", process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"].join(":")
  const file = join(paths.state, `${LABEL}.plist`)
  // The warm checkout's copy, whatever checkout asked: the coordinator installs from it.
  writeFileSync(file, plist({ bun, script: join(home, CHECKOUT, "opencode/scripts/fleet-install.ts"), log: join(paths.state, "coordinator.log"), env: { PATH: path, HOME: home } }))
  const started = run(["launchctl", "bootstrap", `gui/${process.getuid?.() ?? 501}`, file])
  if (started.code === 0) return `started the coordinator (launchd ${LABEL})`
  // Two requests at once: the second finds the first's job loaded, and its line waits for that job.
  if (lockHolder(paths.lock) !== undefined || run(["launchctl", "list", LABEL]).code === 0) return `the coordinator runs; it takes this request`
  // No GUI domain to load into (a request over ssh with no console login): a process group of its own,
  // detached from this one, which the Mac's install does not reach either.
  const log = Bun.file(join(paths.state, "coordinator.log"))
  const child = Bun.spawn([bun, join(home, CHECKOUT, "opencode/scripts/fleet-install.ts"), "run"], { env: { ...process.env, PATH: path }, stdin: "ignore", stdout: log, stderr: log, detached: true })
  child.unref()
  return `started the coordinator in its own process group (pid ${child.pid}; launchctl exit ${started.code}: ${started.err})`
}

const request = async (argv: ReadonlyArray<string>) => {
  const home = homedir()
  const paths = files(home)
  const at = argv.indexOf("--reason")
  const reason = at >= 0 && argv[at + 1] !== undefined ? argv[at + 1]! : "asked by hand"
  const flags = parseFlags(argv)
  const coordinator = coordinatorOf()
  if (hostKey(hostname()) !== coordinator.host) {
    const forwarded = run([...SSH, coordinator.ssh, `cd "$HOME/${CHECKOUT}/opencode" && bun scripts/fleet-install.ts request --reason ${quote(reason)} ${flagArgs(flags).join(" ")}`])
    say(forwarded.code === 0 ? `${coordinator.name}: ${forwarded.out}` : `the request did not reach ${coordinator.name} over ssh ${coordinator.ssh} (exit ${forwarded.code}): ${forwarded.err}`)
    process.exit(forwarded.code === 0 ? 0 : 1)
  }
  mkdirSync(paths.state, { recursive: true })
  const asked = Date.now()
  appendFileSync(paths.requests, requestLine({ at: asked, reason, ...(flags.force ? { force: true } : {}), ...(flags.upstream ? { upstream: true } : {}) }))
  const holder = lockHolder(paths.lock)
  say(holder !== undefined ? `the coordinator runs (pid ${holder}); it takes this request` : process.platform === "darwin" ? launch(home) : "no launchd here: run `bun scripts/fleet-install.ts run`")
  say(`log: ${paths.log}`)
  if (!argv.includes("--wait")) return
  for (const end = asked + 13 * 60 * 60_000; Date.now() < end; ) {
    await Bun.sleep(5_000)
    const last = existsSync(paths.last) ? (JSON.parse(readFileSync(paths.last, "utf8")) as { at: number; results: ReadonlyArray<HostResult> }) : undefined
    if (last !== undefined && last.at > asked) {
      for (const result of last.results) say(result.line)
      return
    }
  }
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2)
  if (command === "run") await coordinatorRun()
  else if (command === "host") await hostStep(rest)
  else await request(command === "request" || command === undefined ? rest : [command, ...rest])
}
