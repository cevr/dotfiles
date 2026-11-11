// The fleet install's rules (`bun run fleet-install`, scripts/fleet-install.ts): which host installs,
// in what order, when it waits for load, when it is already done, and what each says when it ends.
// Every outside effect is a seam (`HostSteps`, `FleetSteps`, `CoordinatorSteps`), so the tests run
// the whole flow on fake hosts and nothing here installs anything.
//
// - A host's install is `bun run daily` on that host, after its dotfiles checkout reached
//   origin/main (scripts/fleet/host-sync.sh). Daily writes the host's stamp at its end
//   (`installed.json`: the checkout, its commit, the fork commit and version it built), so a host
//   whose stamp already names the target (the checkout's commit, and the fork's origin/prime-look
//   when the checkout's HEAD is behind it) is skipped: the install is idempotent.
// - The hosts go one after another, the Mac first: it owns the fork, and its daily may merge
//   upstream into prime-look and push it, which the workbox then builds.
// - A host whose 1-minute load is at its gate or over defers; the coordinator tries the deferred
//   hosts again every `retryMs`, up to `giveUpMs`.
// - Requests coalesce: the coordinator starts a pass once no request came for `quietMs`, and a
//   request that comes during a pass starts one more pass after it.
// Only node built-ins and this folder's dependency-free files are imported: the host step runs
// before the checkout's `bun install`.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { FORK_OWNER } from "./upstream.ts"

/** A host of the fleet, as the coordinator reaches it and as its own step runs. */
export interface FleetHost {
  /** The name every line uses. */
  readonly name: string
  /** Its host name, lower case and without `.local`. */
  readonly host: string
  /** The ssh destination that reaches it from the other hosts. */
  readonly ssh: string
  /** The fork checkout daily builds, relative to the home directory. */
  readonly fork: string
  /**
   * How its dotfiles checkout reaches origin/main: `ff` fast-forwards only (the Mac, where the
   * work is committed); `reset` moves HEAD and puts back what Syncthing left behind (the workbox,
   * whose files Syncthing keeps in step with the Mac's, so a merge refuses files it already has).
   */
  readonly sync: "ff" | "reset"
  /** It installs only while its 1-minute load is under this. */
  readonly maxLoad: number
  /** What daily needs besides `OPENCODE_DEV`, relative to the home directory. */
  readonly env: Readonly<Record<string, string>>
}

/** The owner's hosts, in install order: the fork's owner first. */
export const HOSTS: ReadonlyArray<FleetHost> = [
  {
    name: "macbook",
    host: FORK_OWNER,
    ssh: "cvr@cristians-macbook-pro",
    fork: "Developer/personal/.rifts/opencode/prime-look",
    sync: "ff",
    // The owner's rule: install the Mac only when its 1-minute load is under 40.
    maxLoad: 40,
    env: {},
  },
  {
    name: "workbox",
    host: "bite-cristian",
    ssh: "bite-workbox",
    fork: "Developer/personal/opencode",
    sync: "reset",
    // Four per core of its 16; its load sits near 60 while it works.
    maxLoad: 64,
    env: { GAMUT_GENT_AUTH: ".gent/auth" },
  },
]

/** The dotfiles checkout every host installs from, relative to the home directory. */
export const CHECKOUT = "Developer/personal/dotfiles"

/** The fleet's state on each host, relative to the home directory. */
export const STATE = ".local/state/opencode-fleet"

export const hostKey = (host: string): string => host.toLowerCase().replace(/\.local$/, "")

/** The fleet's entry for `host` (a host name); none for a host outside the fleet. */
export const hostOf = (host: string): FleetHost | undefined => HOSTS.find((entry) => entry.host === hostKey(host))

/** The coordinator runs on the fork's owner; every other host forwards its requests there. */
export const coordinatorOf = (hosts: ReadonlyArray<FleetHost> = HOSTS): FleetHost => hosts[0]!

// ── Stamps ─────────────────────────────────────────────────────────────

/** What a host has installed, as daily wrote it at its end. */
export interface Stamp {
  readonly checkout: string
  readonly dotfiles: string
  readonly fork: string
  readonly version: string
  readonly at: string
}

/** What a host should run: the checkout and its commit, and the fork commit. */
export interface Target {
  readonly checkout: string
  readonly dotfiles: string
  readonly fork: string
}

export const stampFile = (home: string): string => join(home, STATE, "installed.json")

export const readStamp = (file: string): Stamp | undefined => {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<Stamp>
    return typeof value.checkout === "string" && typeof value.dotfiles === "string" && typeof value.fork === "string" && typeof value.version === "string"
      ? { checkout: value.checkout, dotfiles: value.dotfiles, fork: value.fork, version: value.version, at: String(value.at ?? "") }
      : undefined
  } catch {
    return undefined
  }
}

/** Written beside, then renamed over, so a reader never sees half a stamp. */
export const writeStamp = (file: string, stamp: Stamp): void => {
  mkdirSync(dirname(file), { recursive: true })
  const staged = `${file}.${process.pid}`
  writeFileSync(staged, `${JSON.stringify(stamp, null, 2)}\n`)
  renameSync(staged, file)
}

/** Whether `stamp` already is `target`. */
export const installedAt = (stamp: Stamp | undefined, target: Target): boolean =>
  stamp !== undefined && stamp.checkout === target.checkout && stamp.dotfiles === target.dotfiles && stamp.fork === target.fork

/**
 * The fork commit daily will build: origin's prime-look when the checkout's HEAD is behind it or at
 * it (daily fast-forwards to it), else the checkout's HEAD (commits origin lacks, which daily keeps).
 */
export const forkTarget = (head: string, origin: string | undefined, behind: boolean): string => (origin !== undefined && behind ? origin : head)

const short = (commit: string) => commit.slice(0, 8)

// ── One host's step ────────────────────────────────────────────────────

export type Outcome = "installed" | "skipped" | "deferred" | "failed" | "unreachable"

/** One host's end: its outcome and the line the log and the notice show. */
export interface HostResult {
  readonly host: string
  readonly outcome: Outcome
  readonly line: string
}

/** What the request asks of each host. */
export interface Flags {
  /** Install even when the stamp names the target. */
  readonly force: boolean
  /** First merge upstream OpenCode into the fork (the fork's owner only), as the daily install does. */
  readonly upstream: boolean
}

/** What a host's step reaches, so a test runs it with no checkout, no build and no service. */
export interface HostSteps {
  readonly name: string
  readonly maxLoad: number
  /** The 1-minute load now. */
  readonly load: () => number
  /** The fork's owner merges upstream (scripts/post-land.ts); answers its outcome line. Absent elsewhere. */
  readonly upstream?: () => Promise<string>
  readonly target: () => Promise<Target>
  /** The stamp, none when the launcher daily writes is gone. */
  readonly stamp: () => Stamp | undefined
  /** `bun install`, the fork's links and daily; daily writes the stamp. */
  readonly install: () => Promise<{ readonly ok: true } | { readonly ok: false; readonly why: string }>
  readonly now: () => number
  readonly log: (line: string) => void
}

const minutes = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`)

const gate = (steps: HostSteps): HostResult | undefined => {
  const load = steps.load()
  return load < steps.maxLoad ? undefined : { host: steps.name, outcome: "deferred", line: `${steps.name}: deferred, load ${load.toFixed(1)} is not under ${steps.maxLoad}` }
}

/** One host's install: its upstream merge when asked, the skip, the load gate, then daily. */
export const hostInstall = async (steps: HostSteps, flags: Flags): Promise<HostResult> => {
  if (flags.upstream && steps.upstream !== undefined) {
    const held = gate(steps)
    if (held !== undefined) return held
    steps.log(await steps.upstream())
  }
  const target = await steps.target()
  const stamp = steps.stamp()
  if (!flags.force && installedAt(stamp, target))
    return { host: steps.name, outcome: "skipped", line: `${steps.name}: already on ${stamp!.version} (dotfiles ${short(target.dotfiles)}, fork ${short(target.fork)})` }
  const held = gate(steps)
  if (held !== undefined) return held
  const began = steps.now()
  const ran = await steps.install()
  if (!ran.ok) return { host: steps.name, outcome: "failed", line: `${steps.name}: failed, ${ran.why}` }
  const after = steps.stamp()
  if (after === undefined) return { host: steps.name, outcome: "failed", line: `${steps.name}: failed, daily ended without writing its stamp` }
  return { host: steps.name, outcome: "installed", line: `${steps.name}: installed ${after.version} (dotfiles ${short(after.dotfiles)}) in ${minutes(steps.now() - began)}` }
}

/** The host step's last line, which the coordinator reads its result from. */
export const RESULT = "FLEET-RESULT "

export const resultLine = (result: HostResult): string => `${RESULT}${JSON.stringify(result)}`

/** The last result line in a host's output; none when it printed none. */
export const parseResult = (output: string): HostResult | undefined => {
  const line = output
    .split("\n")
    .filter((text) => text.startsWith(RESULT))
    .at(-1)
  if (line === undefined) return undefined
  try {
    const value = JSON.parse(line.slice(RESULT.length)) as Partial<HostResult>
    return typeof value.host === "string" && typeof value.outcome === "string" && typeof value.line === "string"
      ? { host: value.host, outcome: value.outcome as Outcome, line: value.line }
      : undefined
  } catch {
    return undefined
  }
}

// ── A pass over the fleet ──────────────────────────────────────────────

/** What a pass reaches: each host's step, wherever it runs, and the notices. */
export interface FleetSteps {
  /** The hosts' names, in install order. */
  readonly hosts: ReadonlyArray<string>
  /** Runs `host`'s step there and answers its result. */
  readonly install: (host: string, flags: Flags) => Promise<HostResult>
  /** Copies the Mac's `upstream.json` (the TUI's corner) to the other hosts; answers its line. */
  readonly copyUpstream: () => Promise<string>
  /** The owner's one-line notice that a host's install ended. */
  readonly notify: (line: string) => void
  readonly log: (line: string) => void
}

/** Each host of `only` (all when absent) in order; then, when one installed, `upstream.json` across. */
export const fleetPass = async (steps: FleetSteps, flags: Flags, only?: ReadonlySet<string>): Promise<ReadonlyArray<HostResult>> => {
  const results: Array<HostResult> = []
  for (const host of steps.hosts) {
    if (only !== undefined && !only.has(host)) continue
    const result = await steps.install(host, flags).catch((error: unknown): HostResult => ({ host, outcome: "failed", line: `${host}: failed, ${String(error)}` }))
    results.push(result)
    steps.log(result.line)
    if (result.outcome === "installed" || result.outcome === "failed") steps.notify(result.line)
  }
  if (results.some((result) => result.outcome === "installed")) steps.log(await steps.copyUpstream().catch((error: unknown) => `upstream.json: not copied, ${String(error)}`))
  return results
}

// ── Requests and the coordinator ───────────────────────────────────────

/** One request: when, why, and what it asks. */
export interface Request {
  readonly at: number
  readonly reason: string
  readonly force?: boolean
  readonly upstream?: boolean
}

export const requestLine = (request: Request): string => `${JSON.stringify(request)}\n`

/** Every request in the file's text that reads. */
export const requestsIn = (text: string): ReadonlyArray<Request> =>
  text.split("\n").flatMap((raw) => {
    try {
      const value = JSON.parse(raw) as Partial<Request>
      return typeof value.at === "number" && typeof value.reason === "string" ? [value as Request] : []
    } catch {
      return []
    }
  })

export interface Timing {
  /** A pass starts once no request came for this long. */
  readonly quietMs: number
  /** A deferred or unreachable host is tried again after this long. */
  readonly retryMs: number
  /** A host still deferred this long after its first try is given up on until the next request. */
  readonly giveUpMs: number
}

export const TIMING: Timing = { quietMs: 2 * 60_000, retryMs: 10 * 60_000, giveUpMs: 12 * 60 * 60_000 }

export interface CoordinatorSteps extends FleetSteps {
  /** The requests not yet consumed. */
  readonly pending: () => ReadonlyArray<Request>
  /** Every request at or before `through` is done. */
  readonly consume: (through: number) => void
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

const waits = (result: HostResult) => result.outcome === "deferred" || result.outcome === "unreachable"

/**
 * Runs passes until no request is pending: each pass covers every request up to its newest, and
 * runs once they went quiet. Hosts that deferred are tried again, alone, every `retryMs`, while no
 * new request comes; past `giveUpMs` they are given up on and the requests consumed.
 */
export const coordinate = async (steps: CoordinatorSteps, timing: Timing = TIMING): Promise<ReadonlyArray<HostResult>> => {
  const all: Array<HostResult> = []
  let retry: { readonly through: number; readonly hosts: ReadonlySet<string>; readonly since: number } | undefined
  for (;;) {
    const pending = steps.pending()
    if (pending.length === 0) return all
    const through = Math.max(...pending.map((request) => request.at))
    const quiet = through + timing.quietMs - steps.now()
    if (quiet > 0) {
      await steps.sleep(quiet)
      continue
    }
    // A newer request starts a whole pass again; otherwise only the hosts that waited go.
    if (retry !== undefined && retry.through !== through) retry = undefined
    const flags: Flags = { force: pending.some((request) => request.force === true), upstream: pending.some((request) => request.upstream === true) }
    steps.log(`pass for ${pending.length} request(s): ${[...new Set(pending.map((request) => request.reason))].join("; ")}${retry === undefined ? "" : ` (again for ${[...retry.hosts].join(", ")})`}`)
    const results = await fleetPass(steps, flags, retry?.hosts)
    all.push(...results)
    const waiting = results.filter(waits).map((result) => result.host)
    if (waiting.length === 0) {
      steps.consume(through)
      retry = undefined
      continue
    }
    const since = retry?.since ?? steps.now()
    if (steps.now() - since >= timing.giveUpMs) {
      const line = `gave up on ${waiting.join(", ")} after ${minutes(steps.now() - since)}; the next request tries again`
      steps.log(line)
      steps.notify(line)
      steps.consume(through)
      retry = undefined
      continue
    }
    retry = { through, hosts: new Set(waiting), since }
    await steps.sleep(timing.retryMs)
  }
}

// ── Files on disk ──────────────────────────────────────────────────────

/** The coordinator's files, under the fleet's state dir. */
export const files = (home: string) => {
  const state = join(home, STATE)
  return {
    state,
    requests: join(state, "requests.jsonl"),
    consumed: join(state, "consumed"),
    lock: join(state, "coordinator.pid"),
    log: join(state, "fleet.log"),
    runs: join(state, "runs"),
    last: join(state, "last.json"),
  }
}

/** The requests in `file` after `consumed`'s mark. */
export const pendingIn = (requests: string, consumed: string): ReadonlyArray<Request> => {
  const through = existsSync(consumed) ? Number(readFileSync(consumed, "utf8").trim()) || 0 : 0
  return existsSync(requests) ? requestsIn(readFileSync(requests, "utf8")).filter((request) => request.at > through) : []
}
