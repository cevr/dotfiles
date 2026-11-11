// The fleet install on fake hosts: a host's step, a pass over the fleet, the coordinator's
// coalescing and retries, the launch and remote commands, and host-sync.sh on a scratch repo.
// Nothing here reaches a real host, a real service or a real install.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  coordinate,
  type CoordinatorSteps,
  type Flags,
  fleetPass,
  type FleetSteps,
  forkTarget,
  HOSTS,
  hostInstall,
  type HostResult,
  type HostSteps,
  parseResult,
  pendingIn,
  readStamp,
  type Request,
  requestLine,
  resultLine,
  type Stamp,
  type Target,
  type Timing,
  writeStamp,
} from "./fleet.ts"
import { LABEL, plist, quote, remoteCommand } from "./fleet-install.ts"

const PLAIN: Flags = { force: false, upstream: false }
const TARGET: Target = { checkout: "/home/me/Developer/personal/dotfiles", dotfiles: "d".repeat(40), fork: "f".repeat(40) }
const STAMP: Stamp = { ...TARGET, version: "2.2.5-prime.ffffffff", at: "2026-11-11T00:00:00.000Z" }

/** A host whose step records what it did. */
const fakeHost = (over: Partial<HostSteps> & { stampAfter?: Stamp } = {}) => {
  const did: Array<string> = []
  let stamp: Stamp | undefined = over.stamp === undefined ? undefined : over.stamp()
  let clock = 0
  const steps: HostSteps = {
    name: "workbox",
    maxLoad: 64,
    load: () => {
      did.push("load")
      return 10
    },
    target: async () => {
      did.push("target")
      return TARGET
    },
    install: async () => {
      did.push("install")
      clock += 90_000
      stamp = over.stampAfter ?? { ...STAMP, version: "2.2.5-prime.new" }
      return { ok: true }
    },
    now: () => clock,
    log: (line) => void did.push(`log ${line}`),
    ...over,
    stamp: () => stamp,
  }
  return { steps, did }
}

describe("a host's step", () => {
  test("a host whose stamp names the target is skipped: no load read, no install", async () => {
    const { steps, did } = fakeHost({ stamp: () => STAMP })
    const result = await hostInstall(steps, PLAIN)
    expect(result).toEqual({ host: "workbox", outcome: "skipped", line: "workbox: already on 2.2.5-prime.ffffffff (dotfiles dddddddd, fork ffffffff)" })
    expect(did).toEqual(["target"])
  })

  test("a host behind its target installs, and its line names what daily stamped and how long it took", async () => {
    const { steps, did } = fakeHost({ stamp: () => ({ ...STAMP, dotfiles: "0".repeat(40) }), stampAfter: { ...STAMP, version: "2.2.5-prime.12345678" } })
    const result = await hostInstall(steps, PLAIN)
    expect(result).toEqual({ host: "workbox", outcome: "installed", line: "workbox: installed 2.2.5-prime.12345678 (dotfiles dddddddd) in 1m30s" })
    expect(did).toEqual(["target", "load", "install"])
  })

  test("another checkout, or another fork commit, is not the target", async () => {
    for (const stamp of [{ ...STAMP, checkout: "/home/me/Developer/personal/.rifts/dotfiles/x" }, { ...STAMP, fork: "e".repeat(40) }]) {
      const { steps } = fakeHost({ stamp: () => stamp })
      expect((await hostInstall(steps, PLAIN)).outcome).toBe("installed")
    }
  })

  test("--force installs a host already on its target", async () => {
    const { steps, did } = fakeHost({ stamp: () => STAMP })
    expect((await hostInstall(steps, { force: true, upstream: false })).outcome).toBe("installed")
    expect(did).toContain("install")
  })

  test("at or over its load gate the host defers and installs nothing", async () => {
    const { steps, did } = fakeHost({ load: () => 64 })
    expect(await hostInstall(steps, PLAIN)).toEqual({ host: "workbox", outcome: "deferred", line: "workbox: deferred, load 64.0 is not under 64" })
    expect(did).not.toContain("install")
  })

  test("a daily that fails, or ends with no stamp, fails the host", async () => {
    const failing = fakeHost({ install: async () => ({ ok: false, why: "daily exited 1; the log has its output" }) })
    expect(await hostInstall(failing.steps, PLAIN)).toEqual({ host: "workbox", outcome: "failed", line: "workbox: failed, daily exited 1; the log has its output" })
    const silent = fakeHost({ install: async () => ({ ok: true }) })
    expect((await hostInstall(silent.steps, PLAIN)).line).toBe("workbox: failed, daily ended without writing its stamp")
  })

  test("--upstream merges first on the fork's owner, under the load gate, before the target is read", async () => {
    const { steps, did } = fakeHost({ stamp: () => STAMP, upstream: async () => "upstream: up to date" })
    await hostInstall(steps, { force: false, upstream: true })
    expect(did).toEqual(["load", "log upstream: up to date", "target"])
    const busy = fakeHost({ load: () => 80, upstream: async () => "never" })
    expect((await hostInstall(busy.steps, { force: false, upstream: true })).outcome).toBe("deferred")
  })

  test("a host with no upstream step ignores --upstream", async () => {
    const { steps, did } = fakeHost({ stamp: () => STAMP })
    expect((await hostInstall(steps, { force: false, upstream: true })).outcome).toBe("skipped")
    expect(did).toEqual(["target"])
  })
})

describe("the target and the stamp", () => {
  test("the fork's target is origin's prime-look when the checkout is behind it or at it, else its own HEAD", () => {
    expect(forkTarget("a", "b", true)).toBe("b")
    expect(forkTarget("a", "b", false)).toBe("a")
    expect(forkTarget("a", undefined, false)).toBe("a")
  })

  test("a stamp reads back as written; a missing or malformed one reads as none", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-stamp-"))
    const file = join(dir, "state/installed.json")
    expect(readStamp(file)).toBeUndefined()
    writeStamp(file, STAMP)
    expect(readStamp(file)).toEqual(STAMP)
    writeFileSync(file, "{ not json")
    expect(readStamp(file)).toBeUndefined()
  })

  test("a host's result travels as its step's last result line", () => {
    const result: HostResult = { host: "macbook", outcome: "installed", line: "macbook: installed x" }
    expect(parseResult(`building\n${resultLine({ ...result, outcome: "failed" })}\nmore\n${resultLine(result)}\n`)).toEqual(result)
    expect(parseResult("no result here")).toBeUndefined()
    expect(parseResult("FLEET-RESULT {broken")).toBeUndefined()
  })
})

/** A fleet of fake hosts, each answering from `answers` in turn. */
const fakeFleet = (answers: Record<string, ReadonlyArray<HostResult["outcome"]>>) => {
  const order: Array<string> = []
  const notices: Array<string> = []
  const lines: Array<string> = []
  const tries: Record<string, number> = {}
  const steps: FleetSteps = {
    hosts: HOSTS.map((host) => host.name),
    install: async (host) => {
      order.push(host)
      const n = (tries[host] = (tries[host] ?? 0) + 1)
      const outcome = answers[host]?.[Math.min(n, answers[host]!.length) - 1] ?? "skipped"
      return { host, outcome, line: `${host}: ${outcome}` }
    },
    copyUpstream: async () => "upstream.json: copied to workbox",
    notify: (line) => void notices.push(line),
    log: (line) => void lines.push(line),
  }
  return { steps, order, notices, lines }
}

describe("a pass over the fleet", () => {
  test("the Mac goes first, then the workbox; each install that ends is one notice; upstream.json goes across after an install", async () => {
    const fleet = fakeFleet({ macbook: ["installed"], workbox: ["installed"] })
    const results = await fleetPass(fleet.steps, PLAIN)
    expect(results.map((result) => result.line)).toEqual(["macbook: installed", "workbox: installed"])
    expect(fleet.order).toEqual(["macbook", "workbox"])
    expect(fleet.notices).toEqual(["macbook: installed", "workbox: installed"])
    expect(fleet.lines).toEqual(["macbook: installed", "workbox: installed", "upstream.json: copied to workbox"])
  })

  test("hosts already on the target: no notice and nothing copied", async () => {
    const fleet = fakeFleet({})
    await fleetPass(fleet.steps, PLAIN)
    expect(fleet.notices).toEqual([])
    expect(fleet.lines).toEqual(["macbook: skipped", "workbox: skipped"])
  })

  test("a host whose step throws fails alone; the next host still goes", async () => {
    const fleet = fakeFleet({ workbox: ["installed"] })
    const steps: FleetSteps = { ...fleet.steps, install: async (host, flags) => (host === "macbook" ? Promise.reject(new Error("spawn failed")) : fleet.steps.install(host, flags)) }
    const results = await fleetPass(steps, PLAIN)
    expect(results.map((result) => result.outcome)).toEqual(["failed", "installed"])
    expect(fleet.notices[0]).toBe("macbook: failed, Error: spawn failed")
  })
})

const TIMING: Timing = { quietMs: 120_000, retryMs: 600_000, giveUpMs: 3_600_000 }

/** The coordinator on a fake clock: `arrivals` are requests that come at their time, while it sleeps. */
const fakeCoordinator = (answers: Record<string, ReadonlyArray<HostResult["outcome"]>>, arrivals: ReadonlyArray<Request>, during?: { readonly at: string; readonly request: Request }) => {
  const fleet = fakeFleet(answers)
  let clock = 0
  let through = -1
  const requests: Array<Request> = []
  const flagsSeen: Array<Flags> = []
  let came = false
  const arrive = () => {
    for (const request of arrivals) if (request.at <= clock && !requests.includes(request)) requests.push(request)
  }
  const steps: CoordinatorSteps = {
    ...fleet.steps,
    install: async (host, flags) => {
      flagsSeen.push(flags)
      if (during !== undefined && during.at === host && !came) {
        came = true
        requests.push({ ...during.request, at: clock })
      }
      clock += 60_000
      return fleet.steps.install(host, flags)
    },
    pending: () => {
      arrive()
      return requests.filter((request) => request.at > through)
    },
    consume: (at) => {
      through = at
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
  }
  return { steps, fleet, flagsSeen, clock: () => clock }
}

describe("the coordinator", () => {
  test("requests close together are one pass, once they went quiet; their flags are merged", async () => {
    const run = fakeCoordinator({ macbook: ["installed"], workbox: ["installed"] }, [
      { at: 0, reason: "batch-1 accepted" },
      { at: 60_000, reason: "batch-2 accepted", force: true },
      { at: 100_000, reason: "daily", upstream: true },
    ])
    await coordinate(run.steps, TIMING)
    expect(run.fleet.order).toEqual(["macbook", "workbox"])
    expect(run.flagsSeen[0]).toEqual({ force: true, upstream: true })
    expect(run.fleet.lines[0]).toBe("pass for 3 request(s): batch-1 accepted; batch-2 accepted; daily")
  })

  test("a request that comes during a pass starts one more pass after it; hosts already on the target skip it", async () => {
    const run = fakeCoordinator({ macbook: ["installed", "skipped"], workbox: ["installed", "skipped"] }, [{ at: 0, reason: "batch-1 accepted" }], {
      at: "workbox",
      request: { at: 0, reason: "batch-2 accepted" },
    })
    await coordinate(run.steps, TIMING)
    expect(run.fleet.order).toEqual(["macbook", "workbox", "macbook", "workbox"])
    expect(run.fleet.notices).toEqual(["macbook: installed", "workbox: installed"])
  })

  test("a host that defers on load is tried again alone every retry, until it installs", async () => {
    const run = fakeCoordinator({ macbook: ["installed"], workbox: ["deferred", "deferred", "installed"] }, [{ at: 0, reason: "batch-1 accepted" }])
    await coordinate(run.steps, TIMING)
    expect(run.fleet.order).toEqual(["macbook", "workbox", "workbox", "workbox"])
    expect(run.fleet.notices).toEqual(["macbook: installed", "workbox: installed"])
  })

  test("a host still deferred past the give-up time is given up on, said once, and the requests are done", async () => {
    const run = fakeCoordinator({ macbook: ["skipped"], workbox: ["unreachable"] }, [{ at: 0, reason: "batch-1 accepted" }])
    await coordinate(run.steps, TIMING)
    // Its first try ends at 4m; each retry is 10m asleep and 1m trying; at 6 retries (66m) it is past the hour.
    expect(run.fleet.order.filter((host) => host === "workbox").length).toBe(7)
    expect(run.fleet.order.filter((host) => host === "macbook").length).toBe(1)
    expect(run.fleet.notices).toEqual([expect.stringMatching(/^gave up on workbox after \d+m\d+s; the next request tries again$/)])
  })

  test("with no request waiting it does nothing", async () => {
    const run = fakeCoordinator({}, [])
    expect(await coordinate(run.steps, TIMING)).toEqual([])
    expect(run.fleet.order).toEqual([])
  })
})

describe("the request file", () => {
  test("only requests after the consumed mark wait; a line that does not read is skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-requests-"))
    const requests = join(dir, "requests.jsonl")
    const consumed = join(dir, "consumed")
    writeFileSync(requests, `${requestLine({ at: 1, reason: "a" })}not json\n${requestLine({ at: 5, reason: "b", force: true })}`)
    expect(pendingIn(requests, consumed).map((request) => request.reason)).toEqual(["a", "b"])
    writeFileSync(consumed, "1")
    expect(pendingIn(requests, consumed)).toEqual([{ at: 5, reason: "b", force: true }])
    expect(pendingIn(join(dir, "none"), consumed)).toEqual([])
  })
})

describe("the commands it runs", () => {
  test("the workbox's step runs in a transient user unit of its own, waited on and piped back", () => {
    const workbox = HOSTS.find((host) => host.name === "workbox")!
    const command = remoteCommand(workbox, { force: true, upstream: false })
    expect(command).toStartWith("systemd-run --user --pipe --wait --quiet --collect --unit opencode-fleet-install ")
    expect(command).toContain(`bash "$HOME/.local/state/opencode-fleet/host-sync.sh" reset "$HOME/Developer/personal/dotfiles" --force`)
    expect(command).toContain("--setenv=FLEET_HOST=workbox")
  })

  test("the coordinator's launchd job runs once: RunAtLoad, no KeepAlive, its own process group abandoned", () => {
    const text = plist({ bun: "/b/bun", script: "/d/fleet-install.ts", log: "/s/coordinator.log", env: { PATH: "/x&y", HOME: "/h" } })
    expect(text).toContain(`<key>Label</key><string>${LABEL}</string>`)
    expect(text).toContain("<key>ProgramArguments</key><array><string>/b/bun</string><string>/d/fleet-install.ts</string><string>run</string></array>")
    expect(text).toContain("<key>RunAtLoad</key><true/>")
    expect(text).toContain("<key>KeepAlive</key><false/>")
    expect(text).toContain("<key>AbandonProcessGroup</key><true/>")
    expect(text).toContain("<string>/x&amp;y</string>")
  })

  test("a reason goes to the other host as one shell word", () => {
    expect(quote("batch-1 accepted; it's done")).toBe(`'batch-1 accepted; it'\\''s done'`)
  })

  test("the Mac installs first and gates at 40; the workbox resets over Syncthing", () => {
    expect(HOSTS.map((host) => [host.name, host.sync, host.maxLoad])).toEqual([
      ["macbook", "ff", 40],
      ["workbox", "reset", 64],
    ])
  })
})

/** Runs git in `dir`, failing the test on an error. */
const git = (dir: string, ...args: ReadonlyArray<string>) => {
  const ran = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`)
  return ran.stdout.toString().trim()
}

/**
 * A scratch origin and a host's checkout one commit behind it, whose host step is a stub that
 * prints the commit it runs at; the checkout then gets what Syncthing does to it.
 */
const scratchHost = () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-sync-"))
  const origin = join(root, "origin.git")
  const seed = join(root, "seed")
  const host = join(root, "host")
  mkdirSync(seed)
  git(root, "init", "-q", "--bare", "-b", "main", origin)
  git(seed, "init", "-q", "-b", "main")
  mkdirSync(join(seed, "opencode/scripts"), { recursive: true })
  mkdirSync(join(seed, "codex"), { recursive: true })
  writeFileSync(join(seed, "opencode/scripts/fleet-install.ts"), `console.log("FLEET-RESULT " + JSON.stringify({ host: "stub", outcome: "skipped", line: "ran " + process.argv.slice(2).join(" ") }))\n`)
  writeFileSync(join(seed, "notes.md"), "one\n")
  writeFileSync(join(seed, "codex/config.toml"), "mine = 1\n")
  git(seed, "add", ".")
  git(seed, "commit", "-q", "-m", "one")
  git(seed, "remote", "add", "origin", origin)
  git(seed, "push", "-q", "origin", "main")
  git(root, "clone", "-q", origin, host)
  writeFileSync(join(seed, "notes.md"), "two\n")
  writeFileSync(join(seed, "added.md"), "new\n")
  git(seed, "add", ".")
  git(seed, "commit", "-q", "-m", "two")
  git(seed, "push", "-q", "origin", "main")
  return { root, host, head: git(seed, "rev-parse", "HEAD") }
}

const hostSync = (mode: string, checkout: string) => {
  const ran = Bun.spawnSync(["bash", join(import.meta.dir, "fleet/host-sync.sh"), mode, checkout, "--force"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, FLEET_HOST: "testhost" } })
  return { code: ran.exitCode, out: ran.stdout.toString() }
}

describe("host-sync.sh", () => {
  test("ff: a checkout behind origin/main fast-forwards and runs the host step from it, with the flags", () => {
    const { host, head } = scratchHost()
    const ran = hostSync("ff", host)
    expect(ran.code).toBe(0)
    expect(git(host, "rev-parse", "HEAD")).toBe(head)
    expect(parseResult(ran.out)?.line).toBe("ran host --force")
  })

  test("reset: Syncthing's files already there, a stale tracked file and its conflict copy; HEAD moves, the stale file is put back, the copy deleted, the host's own config kept", () => {
    const { host, head } = scratchHost()
    // Syncthing brought the new files before git: the merge would refuse `added.md`.
    writeFileSync(join(host, "added.md"), "new\n")
    writeFileSync(join(host, "notes.md"), "half-synced\n")
    writeFileSync(join(host, "notes.sync-conflict-20261111-ABCDEFG.md"), "x\n")
    writeFileSync(join(host, "codex/config.toml"), "mine = 2\n")
    expect(hostSync("ff", host).code).toBe(1)
    const ran = hostSync("reset", host)
    expect(ran.code).toBe(0)
    expect(git(host, "rev-parse", "HEAD")).toBe(head)
    expect(readFileSync(join(host, "notes.md"), "utf8")).toBe("two\n")
    expect(existsSync(join(host, "notes.sync-conflict-20261111-ABCDEFG.md"))).toBe(false)
    expect(readFileSync(join(host, "codex/config.toml"), "utf8")).toBe("mine = 2\n")
    expect(parseResult(ran.out)?.line).toBe("ran host --force")
  })

  test("ff: a checkout that does not fast-forward fails the host with a result line, and runs nothing", () => {
    const { host } = scratchHost()
    writeFileSync(join(host, "local.md"), "x\n")
    git(host, "add", ".")
    git(host, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "local")
    const ran = hostSync("ff", host)
    expect(ran.code).toBe(1)
    expect(parseResult(ran.out)).toEqual({ host: "testhost", outcome: "failed", line: "testhost: failed, the dotfiles checkout does not fast-forward to origin/main" })
  })
})
