// The restart leg (scripts/restart-leg.ts), the parts that run on any host: its flags, its refusals (the owner's
// port, the live port, a name clash, a run dir outside its root), its ownership check before a signal or a stop
// (with fake pids), its judgement of a stop, and its dry run, which prints every command the Linux run takes. The
// Linux run itself (user systemd, the installed build) is the workbox's.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Option, Result, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ROOT } from "./reach.ts"
import {
  answerOf,
  behaviourOf,
  commands,
  expected,
  type Flags,
  inputOf,
  isNotice,
  isRunDir,
  liveDifferences,
  type LiveSnapshot,
  launcherSteps,
  launcherUnit,
  nameClash,
  NEVER_PORT,
  ownsPid,
  ownsUnit,
  pathsOf,
  planOf,
  portRefusal,
  serverConfig,
  serviceEnv,
  unitsOf,
  updateOptions,
} from "./restart-leg.ts"

const FLAGS: Flags = {
  root: "/dev/shm",
  expect: "no-wake",
  cases: "a,c,d",
  port: Option.none(),
  tree: Option.none(),
  binary: Option.none(),
  waitMs: 300_000,
  settleMs: 20_000,
  dryRun: false,
  noSystemd: false,
}
const input = (flags: Partial<Flags> = {}) => inputOf({ ...FLAGS, ...flags }, "/home/exedev", "run1")
const RUN = "/dev/shm/restart-leg-run1"

describe("flags", () => {
  it.effect("default to every case, upstream's no-wake, the installed tree, and a run dir right under the root", () =>
    Effect.sync(() => {
      const made = input({ root: "/dev/shm/" })
      expect(Result.isSuccess(made)).toBe(true)
      if (Result.isFailure(made)) return
      expect(made.success).toMatchObject({ root: "/dev/shm", run: RUN, expect: "no-wake", cases: ["a", "c", "d"], tree: "/home/exedev/.local/share/opencode-prime/current.plugins" })
      expect(Result.isSuccess(input({ expect: "wake", cases: "d, a" }))).toBe(true)
      expect(Result.map(input({ cases: "d,a" }), (each) => each.cases)).toEqual(Result.succeed(["a", "d"]))
    }),
  )

  it.effect("refuse a relative or the system root, an unknown expectation or case, a short wait, the owner's port, and d without systemd", () =>
    Effect.sync(() => {
      const why = (flags: Partial<Flags>) => Result.match(input(flags), { onFailure: (reason) => reason, onSuccess: () => "accepted" })
      expect(why({ root: "shm" })).toContain("absolute")
      expect(why({ root: "/" })).toContain("not a scratch directory")
      expect(why({ root: "/dev/shm/../home" })).toContain("not a scratch directory")
      expect(why({ expect: "maybe" })).toContain("--expect")
      expect(why({ cases: "a,b" })).toContain("--cases")
      expect(why({ cases: "" })).toContain("--cases")
      expect(why({ waitMs: 10 })).toContain("--wait-ms")
      expect(why({ port: Option.some(NEVER_PORT) })).toContain("8240")
      expect(why({ noSystemd: true })).toContain("--no-systemd")
      expect(why({ noSystemd: true, cases: "a,c" })).toBe("accepted")
    }),
  )
})

describe("refusals", () => {
  it.effect("the port: 8240, a live one (registered or configured), a system port; another is free to take", () =>
    Effect.sync(() => {
      expect(Option.isSome(portRefusal(8240, []))).toBe(true)
      expect(portRefusal(49_374, [49_374, 8240])).toEqual(Option.some("port 49374 is the live service's (registered or configured); a scratch service never takes it"))
      expect(Option.isSome(portRefusal(80, []))).toBe(true)
      expect(portRefusal(47_123, [49_374])).toEqual(Option.none())
    }),
  )

  it.effect("a name clash: a launcher scope the user manager lists already, or the live service's scope", () =>
    Effect.sync(() => {
      const names = launcherSteps(["a", "c", "d"]).map((step) => launcherUnit("run1", step))
      expect(names).toEqual(["restart-leg-run1-start.scope", "restart-leg-run1-restart-a.scope", "restart-leg-run1-start-c.scope", "restart-leg-run1-start-d.scope"])
      const listed = unitsOf("● opencode-service-812.scope loaded active running OpenCode service\nrestart-leg-run1-start-c.scope loaded inactive dead x\nsession-4.scope loaded active running Session\n")
      expect(listed).toEqual(["opencode-service-812.scope", "restart-leg-run1-start-c.scope", "session-4.scope"])
      expect(nameClash(names, listed, ["opencode-service-812.scope"])).toEqual(
        Option.some("the user manager already lists restart-leg-run1-start-c.scope: another run's, or a name clash; refusing to start"),
      )
      expect(nameClash(["opencode-service-812.scope"], [], ["opencode-service-812.scope"])).toEqual(Option.some("opencode-service-812.scope is the live service's scope"))
      expect(nameClash(names, ["session-4.scope"], ["opencode-service-812.scope"])).toEqual(Option.none())
    }),
  )

  it.effect("the run dir: only a restart-leg-* dir right under the root is the run's to remove", () =>
    Effect.sync(() => {
      expect(isRunDir("/dev/shm", RUN)).toBe(true)
      expect(isRunDir("/dev/shm/", RUN)).toBe(true)
      expect(isRunDir("/dev/shm", "/dev/shm")).toBe(false)
      expect(isRunDir("/dev/shm", "/dev/shm/restart-leg-")).toBe(false)
      expect(isRunDir("/dev/shm", "/dev/shm/other")).toBe(false)
      expect(isRunDir("/dev/shm", "/dev/shm/restart-leg-run1/home")).toBe(false)
      expect(isRunDir("/dev/shm", "/dev/shmx/restart-leg-run1")).toBe(false)
      expect(isRunDir("/dev/shm", "/home/exedev/restart-leg-run1")).toBe(false)
      expect(isRunDir("/dev/shm", "/dev/shm/restart-leg-a/../../home")).toBe(false)
    }),
  )
})

describe("ownership before a signal or a stop", () => {
  const ours = Option.some({ cmdline: `${RUN}/bin/opencode-clone\0serve\0--service`, environ: `HOME=${RUN}/home\0PATH=/usr/bin` })
  const theirs = Option.some({ cmdline: "/home/exedev/.local/share/opencode-prime/opencode-2.3.0\0serve\0--service", environ: "HOME=/home/exedev" })

  it.effect("a pid is the run's only when recorded and still carrying the run dir", () =>
    Effect.sync(() => {
      expect(ownsPid(RUN, [101, 102], 101, ours)).toEqual(Result.succeed(true))
      expect(ownsPid(RUN, [101], 101, Option.some({ cmdline: "bash\0-c\0x", environ: `RESTART_LEG_RUN=${RUN}` }))).toEqual(Result.succeed(true))
      expect(Result.isFailure(ownsPid(RUN, [101], 999, ours))).toBe(true)
      // A recorded pid the kernel gave to another process since: the live service, say.
      expect(ownsPid(RUN, [101], 101, theirs)).toEqual(Result.fail(`pid 101 does not carry ${RUN} in its command line or environment (reused by another process?)`))
      expect(ownsPid(RUN, [101], 101, Option.none())).toEqual(Result.fail("pid 101 is gone"))
      // Another run under the same root is not this one.
      expect(Result.isFailure(ownsPid(RUN, [101], 101, Option.some({ cmdline: "/dev/shm/restart-leg-run2/bin/x", environ: "" })))).toBe(true)
    }),
  )

  it.effect("a unit is the run's only when recorded and every process in it is the run's", () =>
    Effect.sync(() => {
      const unit = "opencode-service-101.scope"
      expect(ownsUnit(RUN, [unit], unit, [{ pid: 101, view: ours }, { pid: 102, view: ours }])).toEqual(Result.succeed(true))
      expect(ownsUnit(RUN, [unit], unit, [])).toEqual(Result.succeed(true))
      expect(ownsUnit(RUN, [], "opencode-service-812.scope", [{ pid: 812, view: theirs }])).toEqual(Result.fail("opencode-service-812.scope is not a unit the run recorded"))
      expect(ownsUnit(RUN, [unit], unit, [{ pid: 101, view: ours }, { pid: 812, view: theirs }])).toEqual(Result.fail(`${unit} holds processes that are not the run's: 812`))
    }),
  )
})

describe("the live check after the run", () => {
  const before: LiveSnapshot = {
    pids: [812],
    ports: [8240],
    scopes: ["opencode-service-812.scope"],
    tree: Option.some("opencode-2.3.0-prime.a.tree.plugins"),
    launcher: Option.some("#!/bin/sh\nexec a"),
    updateLog: "/home/exedev/.local/state/opencode-update/update.log",
    updateLogSize: 300,
  }

  it.effect("passes the live updater's own log lines and a log that moved in size; fails a new pid, scope, pointer, launcher or a line of this run", () =>
    Effect.sync(() => {
      expect(liveDifferences(before, { ...before, updateLogSize: 299 }, "host-a check (interval): installed is a", "run1")).toEqual([])
      expect(liveDifferences(before, { ...before, pids: [900], scopes: ["opencode-service-900.scope"] }, "", "run1")).toHaveLength(2)
      expect(liveDifferences(before, { ...before, tree: Option.some("opencode-2.3.0-prime.b.tree.plugins") }, "", "run1")).toEqual(["the installed tree's pointer (current.plugins) changed"])
      expect(liveDifferences(before, { ...before, launcher: Option.none() }, "", "run1")).toEqual(["the launcher ~/.local/bin/opencode changed"])
      expect(liveDifferences(before, before, "restart-leg-run1 update failed at fetch the verified target", "run1")).toHaveLength(1)
    }),
  )
})

describe("judging a stop", () => {
  it.effect("names what the shell and its session did, and --expect picks the one that passes", () =>
    Effect.sync(() => {
      expect(behaviourOf({ survived: true, wakes: 0, queued: false })).toBe("survived")
      expect(behaviourOf({ survived: false, wakes: 1, queued: false })).toBe("woken-once")
      expect(behaviourOf({ survived: false, wakes: 2, queued: false })).toBe("woken-more")
      expect(behaviourOf({ survived: false, wakes: 0, queued: true })).toBe("queued")
      expect(behaviourOf({ survived: false, wakes: 0, queued: false })).toBe("lost")
      expect(expected("no-wake")).toBe("queued")
      expect(expected("wake")).toBe("woken-once")
    }),
  )

  it.effect("reads the notice of a tag in its state, and the model starts a tag's background shell", () =>
    Effect.sync(() => {
      const cancelled = '<background-result kind="shell" id="sh_1" state="cancelled" command="… echo bg-finished-C">\nCommand cancelled because the server restarted\n</background-result>'
      expect(isNotice(cancelled, "C", "cancelled")).toBe(true)
      expect(isNotice(cancelled, "C", "completed")).toBe(false)
      expect(isNotice(cancelled, "D", "any")).toBe(false)
      const call = answerOf({ last: "run-shell C", history: ["run-shell C"] }, `${RUN}/work`, 3)
      expect(call).toContain('"name":"shell"')
      expect(call).toContain("bg-C.gate")
      expect(call).toContain('"finish_reason":"tool_calls"')
      expect(answerOf({ last: cancelled, history: [] }, `${RUN}/work`, 4)).toContain('"content":"Done."')
    }),
  )
})

describe("the scratch service", () => {
  it.effect("keeps every update option, path and variable in the run dir, the user bus and PATH aside", () =>
    Effect.sync(() => {
      const paths = pathsOf(RUN)
      const options = updateOptions(paths, "run1")
      const values = [options.checkout, options.fork, options.bun, options.launcher, options.resident, options.record, options.notice, options.state, ...options.config]
      expect(values.filter((value) => !value.startsWith(`${RUN}/`))).toEqual([])
      const config = serverConfig(paths, "run1", "/home/exedev/.local/share/opencode-prime/current.plugins", 40_001)
      expect(config.plugins.map((entry) => entry.package)).toEqual(["/home/exedev/.local/share/opencode-prime/current.plugins/entries/server/update"])
      const env = serviceEnv(paths, { PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1000", HOME: "/home/exedev", XDG_STATE_HOME: "/home/exedev/.local/state", ANTHROPIC_API_KEY: "k" })
      expect(Object.keys(env)).not.toContain("ANTHROPIC_API_KEY")
      const outside = Object.entries(env).filter(([key, value]) => !["PATH", "XDG_RUNTIME_DIR", "OPENCODE_DISABLE_MODELS_FETCH", "OPENCODE_DISABLE_FILEWATCHER"].includes(key) && !value.startsWith(RUN))
      expect(outside).toEqual([])
    }),
  )
})

describe("the dry run", () => {
  it.effect("prints every host command in run order: the scope list, the launcher scopes, the signal, the scope stop, the cleanup", () =>
    Effect.sync(() => {
      const made = input()
      if (Result.isFailure(made)) return expect(made.failure).toBe("accepted")
      const plan = planOf(made.success).join("\n")
      const run = commands(pathsOf(RUN))
      const order = [
        run.listScopes.join(" "),
        `systemd-run --user --scope --quiet --collect --unit=restart-leg-run1-start.scope ${RUN}/bin/opencode-clone service start`,
        `--unit=restart-leg-run1-restart-a.scope ${RUN}/bin/opencode-clone service restart`,
        "kill -TERM <S>",
        `--unit=restart-leg-run1-start-c.scope ${RUN}/bin/opencode-clone service start`,
        "systemctl --user stop '<the shell D'\\''s scope>'",
        `${RUN}/bin/opencode-clone service stop`,
        "kill -KILL <pid>",
        `then remove ${RUN}`,
      ]
      const at = order.map((each) => plan.indexOf(each))
      expect(at.filter((index) => index < 0)).toEqual([])
      expect(at).toEqual(at.toSorted((one, two) => one - two))
    }),
  )

  it.live.layer(BunServices.layer)("the CLI's --dry-run prints the plan and exits 0; a refused port exits 2; a run without systemd here is refused", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const cli = (...args: ReadonlyArray<string>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(ChildProcess.make("bun", [`${ROOT}/scripts/restart-leg.ts`, ...args], { stdin: "ignore", forceKillAfter: "1 second" }))
            return yield* Effect.all({ said: handle.all.pipe(Stream.decodeText(), Stream.mkString), code: handle.exitCode }, { concurrency: 2 })
          }),
        )
      const dry = yield* cli("--root", "/nonexistent/loop-probe-x", "--dry-run")
      expect(Number(dry.code)).toBe(0)
      expect(dry.said).toContain("# restart-leg dry run: /nonexistent/loop-probe-x/restart-leg-")
      expect(dry.said).toContain("## cleanup (always)")
      const port = yield* cli("--root", "/nonexistent/loop-probe-x", "--port", "8240", "--dry-run")
      expect(Number(port.code)).toBe(2)
      expect(port.said).toContain("8240 is the owner's service port")
      const uname = yield* spawner.string(ChildProcess.make("uname", ["-s"], { stdin: "ignore", forceKillAfter: "1 second" }))
      if (uname.trim() === "Linux") return
      const refused = yield* cli("--root", "/nonexistent/loop-probe-x")
      expect(Number(refused.code)).toBe(2)
      expect(refused.said).toContain("REFUSED")
    }),
  )
})
