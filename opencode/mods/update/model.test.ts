import { describe, expect, test } from "bun:test"
import { Array as Arr, Clock, Config, Duration, Effect, Fiber, Layer, Option } from "effect"
import { constVoid } from "effect/Function"
import { TestClock } from "effect/testing"
import { buildName, prunable } from "./builds.ts"
import type { Reading } from "./health.ts"
import { EXIT_CODES, GATE_POLL, handoff, HEALTH_DEADLINE, HEALTH_POLL, intervalChecks, Updater, updaterLayer } from "./model.ts"
import { type Build, goodOf, proven, type Record, stagedRecord } from "./record.ts"
import { Builder, Builds, Configs, Handoff, HandoffMark, Heartbeat, Log, Notice, Records, Rejections, Resident, Service, Source, Trees, UpdateFailed } from "./service.ts"
import { treeOf } from "./trees.ts"
import type { Target } from "./target.ts"
import { HANDOFF_LIMIT, type Rejected, type Running } from "./update.ts"
import { RESIDENT_DELAY, watch } from "./watch.ts"

/** 2026-11-11T17:00:00Z, a Wednesday noon in Knowlton. */
const WEDNESDAY_NOON = 1_794_416_400_000
/** 2026-11-14T17:00:00Z, a Saturday noon in Knowlton: the Sabbath. */
const SATURDAY_NOON = 1_794_675_600_000

const TARGET: Target = { dotfiles: "d".repeat(40), fork: "f".repeat(40), batch: "batch-7" }
const PRIOR = "c".repeat(40)
/** The handoff's process, as its mark names it. */
const HANDOFF_PID = 4242
const SHORT = `dotfiles ${"d".repeat(10)}, fork ${"f".repeat(10)} (batch-7)`

const build = (version: string, dotfiles: string, fork = "f".repeat(40)): Build => ({ version, command: [`/s/opencode-${version}`], dotfiles, fork })
/** The last proven build, on the prior dotfiles commit and another fork commit. */
const GOOD = build("2.2.6-prime.aaaaaaaa.cccccccc.tree", PRIOR, "e".repeat(40))
/** The target's build, as daily's stage names it. */
const NEW = build("2.2.7-prime.ffffffff.dddddddd.tree", TARGET.dotfiles)
/** A host on the good build, proven. */
const onGood = (): Option.Option<Record> => Option.some(proven({ version: GOOD.version, command: GOOD.command, dotfiles: GOOD.dotfiles, fork: GOOD.fork }))
/** The same host once daily staged the target's build. */
const stagedTarget = (): Option.Option<Record> => Option.some(stagedRecord(onGood(), NEW, []))
/** A host on the target's build, proven. */
const onTarget = (): Option.Option<Record> => Option.some(proven({ version: NEW.version, command: NEW.command, dotfiles: NEW.dotfiles, fork: NEW.fork }))

/** The host as the fakes hold it: what each seam was asked, in order, and what it answers. */
interface World {
  readonly calls: Array<string>
  readonly lines: Array<string>
  record: Option.Option<Record>
  rejected: Option.Option<Rejected>
  /** The running handoff's mark, and the pids that live. */
  mark: Option.Option<Running>
  living: ReadonlyArray<number>
  readonly readings: Array<Reading>
  stageFails: boolean
  /** The builds with their tree beside them. */
  readonly trees: Set<string>
  /** The server config, as the handoff reads it: no entry of ours, entries of ours (R2), or not one JSON object. */
  serverConfig: "clean" | "ours" | "unreadable"
  /** How many restarts still fail before one goes through. */
  restartFailures: number
  /** Whether the prune of old builds cannot read what runs. */
  pruneFails: boolean
  /** The providers the service had a login for before the restart; none when that read fails. */
  before: Option.Option<ReadonlyArray<string>>
  /** How many reads of the verified target still die (a defect, not a failed step). */
  verifiedDeaths: number
  /** When each check was stamped (epoch ms). */
  readonly beats: Array<number>
}

const world = (at: Partial<Omit<World, "calls" | "lines" | "beats">> = {}): World => ({
  calls: [],
  lines: [],
  beats: [],
  verifiedDeaths: 0,
  record: Option.none(),
  rejected: Option.none(),
  mark: Option.none(),
  living: [HANDOFF_PID],
  readings: [],
  stageFails: false,
  trees: new Set([GOOD.version, NEW.version]),
  serverConfig: "clean",
  restartFailures: 0,
  pruneFails: false,
  before: Option.some([]),
  ...at,
})

const failure = (step: string) => Effect.fail(new UpdateFailed({ step, message: `${step} exited 1` }))

/** A record as one call line: the installed version, then the good and staged ones. */
const recordLine = (record: Record) =>
  [
    `record ${record.version}`,
    ...Option.toArray(Option.map(Option.fromNullishOr(record.good), (good) => `good ${good.version}`)),
    ...Option.toArray(Option.map(Option.fromNullishOr(record.staged), (staged) => `staged ${staged.version}`)),
  ].join(" ")

/** Fake git, build and exec: each seam records its call and answers from the world. */
const fakes = (host: World) =>
  Layer.mergeAll(
    Layer.succeed(
      Source,
      Source.of({
        verified: Effect.suspend(() => {
          if (host.verifiedDeaths === 0) return Effect.succeed(Option.some(TARGET))
          host.verifiedDeaths -= 1
          return Effect.die(new Error("git fetch: the origin's ref did not parse"))
        }),
        fetch: (commit) => Effect.sync(() => void host.calls.push(`fetch ${commit.slice(0, 1)}`)),
        commands: Effect.sync(() => void host.calls.push("commands")),
      }),
    ),
    Layer.succeed(
      Builder,
      Builder.of({
        version: () => Effect.succeed(NEW.version),
        stage: (target) =>
          Effect.suspend(() => {
            host.calls.push(`stage ${target.batch}`)
            if (host.stageFails) return failure("build")
            host.record = Option.some(stagedRecord(host.record, NEW, []))
            return Effect.void
          }),
      }),
    ),
    Layer.succeed(Handoff, Handoff.of({ start: (reason) => Effect.sync(() => void host.calls.push(`handoff ${reason}`)) })),
    Layer.succeed(
      HandoffMark,
      HandoffMark.of({
        hold: Clock.currentTimeMillis.pipe(Effect.map((at) => void (host.mark = Option.some({ pid: HANDOFF_PID, at })))),
        release: Effect.sync(() => {
          if (Option.exists(host.mark, (mark) => mark.pid === HANDOFF_PID)) host.mark = Option.none()
        }),
        read: Effect.sync(() => host.mark),
        alive: (pid) => Effect.sync(() => host.living.includes(pid)),
      }),
    ),
    Layer.succeed(
      Records,
      Records.of({
        read: Effect.sync(() => host.record),
        write: (record) =>
          Effect.sync(() => {
            host.record = Option.some(record)
            host.calls.push(recordLine(record))
          }),
      }),
    ),
    Layer.succeed(
      Rejections,
      Rejections.of({
        read: Effect.sync(() => host.rejected),
        write: (rejected) =>
          Effect.sync(() => {
            host.rejected = Option.some(rejected)
            host.calls.push(`reject ${rejected.step}`)
          }),
      }),
    ),
    Layer.succeed(
      Builds,
      Builds.of({
        // The call notes the record it reads itself (under its lock), and whether the handoff's mark is still held then.
        prune: (read) =>
          read.pipe(
            Effect.flatMap((record) => {
              host.calls.push([`prune ${Option.match(record, { onNone: () => "no record", onSome: (each) => each.version })}`, ...Option.toArray(Option.map(host.mark, () => "under the mark"))].join(" "))
              if (host.pruneFails) return failure("list the running processes")
              return Effect.succeed([{ name: "opencode-2.2.5-prime.old", bytes: 225_000_000 }])
            }),
          ),
      }),
    ),
    Layer.succeed(
      Configs,
      Configs.of({
        ours: Effect.suspend(() => {
          if (host.serverConfig === "unreadable") return failure("read the server config")
          return Effect.succeed(Option.filter(Option.some({ file: "/h/.config/opencode/opencode.json", under: "/h/dotfiles/opencode" }), () => host.serverConfig === "ours"))
        }),
      }),
    ),
    Layer.succeed(
      Trees,
      Trees.of({
        make: (version) => Effect.sync(() => void host.calls.push("make tree")).pipe(Effect.as(`/s/${treeOf(buildName(version))}`)),
        check: () => Effect.void,
        has: (version) => Effect.sync(() => host.trees.has(version)),
        remove: () => Effect.sync(() => void host.calls.push("remove tree")),
      }),
    ),
    Layer.succeed(Log, Log.of({ line: (text) => Effect.sync(() => void host.lines.push(text)) })),
    Layer.succeed(
      Heartbeat,
      Heartbeat.of({ beat: Clock.currentTimeMillis.pipe(Effect.map((at) => void host.beats.push(at))), last: Effect.sync(() => Option.fromNullishOr(host.beats.at(-1))) }),
    ),
    Layer.succeed(Notice, Notice.of({ show: (text) => Effect.sync(() => void host.calls.push(`notice ${text}`)), clear: Effect.sync(() => void host.calls.push("notice cleared")) })),
    Layer.succeed(
      Service,
      Service.of({
        restart: Effect.suspend(() => {
          host.calls.push("restart")
          if (host.restartFailures === 0) return Effect.void
          host.restartFailures -= 1
          return failure("restart the service")
        }),
        read: Effect.suspend(() => Option.match(Option.fromNullishOr(host.readings.shift()), { onNone: () => failure("read"), onSome: Effect.succeed })),
        logins: Effect.suspend(() => Option.match(host.before, { onNone: () => failure("list the integrations"), onSome: Effect.succeed })),
      }),
    ),
  )

/** Runs `body` on the fakes (`seams`, by default the world's) under a test clock set to a Wednesday noon: the file's one runner. */
const run = <A>(host: World, body: Effect.Effect<A, UpdateFailed, Updater | Builder | Builds | HandoffMark | Service | Source | Records | Rejections | Configs | Trees | Notice | Log | Heartbeat>, seams: ReturnType<typeof fakes> = fakes(host)) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(WEDNESDAY_NOON)
      return yield* body
    }).pipe(Effect.provide(Layer.provideMerge(updaterLayer({ fetchEvery: GATE_POLL }), seams)), Effect.provide(TestClock.layer())),
  )

/** One check of the plugin's, run to its end with the clock moved past its gate polls. */
const check = (reason: string) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild((yield* Updater).check(reason))
    yield* settle
    yield* TestClock.adjust(GATE_POLL)
    yield* Fiber.join(fiber)
  })

/** A handoff run to its end, its health polls moved along by the clock. */
const handOff = Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(handoff("batch-7"))
  yield* settle
  yield* TestClock.adjust(HANDOFF_LIMIT)
  return yield* Fiber.join(fiber)
})

/** Lets every forked fiber run until it waits on the clock. */
const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true })

const POOL = "/d/opencode/cmd/pool"
const healthy: Reading = { configured: [POOL], listed: [{ path: Option.some(POOL), failed: Option.none() }], accounts: Option.some(7), providers: ["anthropic"], logins: ["anthropic", "openai"], placement: Option.none() }
const failedPool: Reading = { ...healthy, listed: [{ path: Option.some(POOL), failed: Option.some("Cannot find package '@dotfiles/opencode-status'") }], accounts: Option.none() }
/** The workbox after its 12:10Z restart on 2026-11-12: every plugin runs, the pool lists OpenAI only, the models are Anthropic's. */
const noAnthropic: Reading = { ...healthy, accounts: Option.some(1), logins: ["openai", "opencode-go"] }
const LOST = "login: no anthropic login after the restart, which had one before it: the pool lists no anthropic account and no credential is stored"
/** Readings enough to outlast the health deadline. */
const throughDeadline = (reading: Reading) => Array.from({ length: Duration.toMillis(HEALTH_DEADLINE) / Duration.toMillis(HEALTH_POLL) + 1 }, () => reading)
const POOL_FAILED = "pool: Cannot find package '@dotfiles/opencode-status'"

/** The handoff's record write that installs the staged build: its first write, and the step before the restart. */
const INSTALL = `record ${NEW.version} good ${GOOD.version}`
/** The rollback's record write: the good build installed again. */
const ROLL_BACK = `record ${GOOD.version} good ${GOOD.version}`
/** A proven handoff's last steps. */
const PROVEN = [`record ${NEW.version} good ${NEW.version}`, "notice cleared", `prune ${NEW.version} under the mark`, "commands"] as const

describe("the updater on its seams", () => {
  test("builds the target with its tree and hands the restart off; the handoff installs it and proves it", () => {
    const host = world({ record: onGood(), readings: [healthy] })
    return run(
      host,
      Effect.gen(function* () {
        yield* check("asked")
        expect(host.calls).toEqual(["fetch d", "make tree", "stage batch-7", `handoff ${SHORT}`])
        expect(yield* handOff).toBe("proven")
        expect(host.calls.slice(4)).toEqual([INSTALL, "restart", ...PROVEN])
        expect(host.lines.slice(0, 3)).toEqual([`update: ${SHORT}; building it ahead with its own plugin tree; nothing running loads from it`, `update: ${SHORT} is built; restarting onto it`, "update: the restart is handed off"])
      }),
    )
  })

  test("the Sabbath rest holds the restart, and it is handed off once the rest ends", () => {
    const host = world({ record: onGood() })
    return run(
      host,
      Effect.gen(function* () {
        yield* TestClock.setTime(SATURDAY_NOON)
        const fiber = yield* Effect.forkChild((yield* Updater).check("asked"))
        yield* settle
        yield* TestClock.adjust(GATE_POLL)
        yield* settle
        expect(host.calls).toEqual(["fetch d", "make tree", "stage batch-7"])
        expect(host.lines.some((line) => line.startsWith("restart held: the Sabbath rest, until "))).toBe(true)
        yield* TestClock.adjust(Duration.hours(12))
        yield* Fiber.join(fiber)
        expect(host.calls.at(-1)).toBe(`handoff ${SHORT}`)
        expect(host.lines.some((line) => /^restart: the Sabbath rest ended after .* of waiting$/.test(line))).toBe(true)
      }),
    )
  })

  test("the staged build is not the installed one: the record keeps the running build until the handoff installs it", () => {
    const host = world({ record: onGood(), stageFails: false })
    return run(
      host,
      Effect.gen(function* () {
        yield* check("interval")
        expect(Option.map(host.record, (record) => [record.version, record.dotfiles, record.staged?.version, record.staged?.dotfiles])).toEqual(Option.some([GOOD.version, PRIOR, NEW.version, TARGET.dotfiles]))
      }),
    )
  })

  test("P6: a failed build takes its tree with it and rejects the target: later checks build nothing", () => {
    const host = world({ record: onGood(), stageFails: true })
    return run(
      host,
      Effect.gen(function* () {
        yield* check("interval")
        expect(host.calls).toEqual(["fetch d", "make tree", "stage batch-7", "remove tree", "reject build"])
        expect(host.lines.at(-1)).toBe("update failed at build: build exited 1")
        host.calls.length = 0
        yield* check("interval")
        yield* check("asked")
        expect(host.calls).toEqual([])
        expect(host.lines.at(-1)).toBe(`check (asked): ${SHORT} failed at build (build exited 1); waiting for another target`)
      }),
    )
  })

  test("a host on the target, proven, does nothing", () => {
    const host = world({ record: onTarget() })
    return run(
      host,
      Effect.gen(function* () {
        yield* check("interval")
        expect(host.calls).toEqual([])
      }),
    )
  })

  test("a host on the target, proven, with no tree beside it builds the target again as a tree build", () => {
    const host = world({ record: onTarget(), trees: new Set([GOOD.version]) })
    return run(
      host,
      Effect.gen(function* () {
        yield* check("interval")
        expect(host.calls).toEqual(["fetch d", "make tree", "stage batch-7", `handoff ${SHORT}`])
      }),
    )
  })

  test("M1: a build an earlier run staged is restarted onto without building it again", () => {
    const host = world({ record: stagedTarget() })
    return run(
      host,
      Effect.gen(function* () {
        yield* check("interval")
        expect(host.calls).toEqual([`handoff ${SHORT}`])
      }),
    )
  })

  test("a build installed by a restart outside the handoff (a crash, a reboot) is not proven: the next check restarts onto it through the handoff", () => {
    const host = world({ record: Option.some({ version: NEW.version, command: NEW.command, dotfiles: NEW.dotfiles, fork: NEW.fork, good: GOOD }) })
    return run(
      host,
      Effect.gen(function* () {
        yield* check("interval")
        expect(host.calls).toEqual([`handoff ${SHORT}`])
      }),
    )
  })

  test("a check that dies is logged and ends its run: the next check runs, and every check is stamped", () => {
    const host = world({ record: onTarget(), verifiedDeaths: 1 })
    return run(
      host,
      Effect.gen(function* () {
        yield* check("interval")
        yield* check("interval")
        expect(host.lines).toEqual(["check (interval) died: Error: git fetch: the origin's ref did not parse", `check (interval): installed is ${SHORT}`])
        expect(host.beats).toHaveLength(2)
      }),
    )
  })

  test("the interval checks go on after a check that dies: one a poll after the start, then one every interval", () => {
    const host = world({ record: onTarget(), verifiedDeaths: 1 })
    const every = Duration.minutes(10)
    return run(
      host,
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(intervalChecks((yield* Updater).check, every))
        yield* settle
        yield* TestClock.adjust(GATE_POLL)
        yield* settle
        expect(host.lines).toEqual(["check (interval) died: Error: git fetch: the origin's ref did not parse"])
        for (const _ of [1, 2]) {
          yield* TestClock.adjust(every)
          yield* TestClock.adjust(GATE_POLL)
          yield* settle
        }
        expect(host.lines.slice(1)).toEqual([`check (interval): installed is ${SHORT}`, `check (interval): installed is ${SHORT}`])
        yield* Fiber.interrupt(fiber)
      }),
    )
  })

  test("once the restart is handed off, later checks wait for it", () => {
    const host = world({ record: stagedTarget() })
    return run(
      host,
      Effect.gen(function* () {
        yield* check("interval")
        yield* check("asked")
        expect(host.calls).toEqual([`handoff ${SHORT}`])
      }),
    )
  })
})

describe("old builds, pruned after a proven install", () => {
  const prunes = (host: World) => host.calls.filter((call) => call.startsWith("prune "))

  test("a proven build prunes once, by the record it proved, while the handoff still holds its mark (no stage copies a build meanwhile), and logs each build with its size", () => {
    const host = world({ record: stagedTarget(), readings: [healthy] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("proven")
        expect(prunes(host)).toEqual([`prune ${NEW.version} under the mark`])
        expect(host.lines.slice(-2)).toEqual(["prune: deleted the old build opencode-2.2.5-prime.old (225.0 MB)", "prune: 1 old builds deleted, 225.0 MB freed"])
      }),
    )
  })

  test("a rollback prunes nothing", () => {
    const host = world({ record: stagedTarget(), readings: [failedPool, healthy] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("rolled-back")
        expect(prunes(host)).toEqual([])
      }),
    )
  })

  test("a give-up prunes nothing", () => {
    const host = world({ record: stagedTarget(), restartFailures: 3 })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("gave-up")
        expect(prunes(host)).toEqual([])
      }),
    )
  })

  test("a prune that cannot read what runs keeps every build, says why, and the build stays proven", () => {
    const host = world({ record: stagedTarget(), readings: [healthy], pruneFails: true })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("proven")
        expect(host.lines).toContain("prune: every build kept: list the running processes: list the running processes exited 1")
      }),
    )
  })
})

describe("the handoff on its seams", () => {
  test("installs the staged build, restarts, and a healthy restart proves it and clears the corner", () => {
    const host = world({ record: stagedTarget(), readings: [healthy] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("proven")
        expect(host.calls).toEqual([INSTALL, "restart", ...PROVEN])
        expect(EXIT_CODES.proven).toBe(0)
      }),
    )
  })

  test("P1: a plugin that fails after the restart rolls back to the good build by a record write, and the target is never tried again", () => {
    const host = world({ record: stagedTarget(), readings: [failedPool, healthy] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("rolled-back")
        expect(host.calls).toEqual([INSTALL, "restart", ROLL_BACK, "restart", `notice ${POOL_FAILED}; rolled back`, "reject health"])
        expect(Option.map(host.record, (record) => record.previous)).toEqual(Option.some([NEW.version]))
        host.calls.length = 0
        yield* check("interval")
        yield* check("interval")
        expect(host.calls).toEqual([])
        expect(EXIT_CODES["rolled-back"]).not.toBe(0)
      }),
    )
  })

  test("P2: a restart that fails once is a sick reading: it rolls back, and the healthy rollback ends there with the notice", () => {
    const host = world({ record: stagedTarget(), restartFailures: 1, readings: [healthy] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("rolled-back")
        expect(host.calls).toEqual([INSTALL, "restart", ROLL_BACK, "restart", "notice service restart: restart the service exited 1; rolled back", "reject health"])
      }),
    )
  })

  test("a restart that keeps failing rolls back, and a rollback that cannot restart gives up with the notice", () => {
    const host = world({ record: stagedTarget(), restartFailures: 2 })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("gave-up")
        expect(host.calls).toEqual([INSTALL, "restart", ROLL_BACK, "restart", "notice service restart: restart the service exited 1", "reject health"])
        expect(EXIT_CODES["gave-up"]).not.toBe(0)
      }),
    )
  })

  test("a restart that loses the configured models' login rolls back, naming the provider, though the pool answers with accounts", () => {
    const host = world({ record: stagedTarget(), before: Option.some(["anthropic", "openai"]), readings: [...throughDeadline(noAnthropic), healthy] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("rolled-back")
        expect(host.calls).toEqual([INSTALL, "restart", ROLL_BACK, "restart", `notice ${LOST}; rolled back`, "reject health"])
        expect(host.lines).toContain("handoff: logins before the restart: anthropic, openai")
        expect(host.lines).toContain(`handoff (first): ${LOST}`)
      }),
    )
  })

  test("a login the host had not before the restart either is reported in the log and the corner, and the build is proven, not rolled back", () => {
    const host = world({ record: stagedTarget(), before: Option.some(["openai"]), readings: [noAnthropic] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("proven")
        expect(host.calls).toEqual([INSTALL, "restart", `record ${NEW.version} good ${NEW.version}`, "notice healthy, but no anthropic login: sign in with opencode auth login", `prune ${NEW.version} under the mark`, "commands"])
        expect(host.lines).toContain("handoff (first): healthy, but no anthropic login: sign in with opencode auth login")
      }),
    )
  })

  test("logins before the restart that do not read count as none: a missing login is reported, not rolled back", () => {
    const host = world({ record: stagedTarget(), before: Option.none(), readings: [noAnthropic] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("proven")
        expect(host.lines).toContain("handoff: the logins before the restart do not read (list the integrations exited 1); a missing login is reported, not rolled back")
      }),
    )
  })

  test("R1: a staged build with no tree beside it is refused before any write: given up, rejected at tree, the corner says why, and no restart", () => {
    const host = world({ record: stagedTarget(), trees: new Set([GOOD.version]), readings: [healthy] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("gave-up")
        const said = `tree: ${NEW.version} has no plugin tree beside it; this update installs only tree builds; nothing changed and the service was not restarted`
        expect(host.calls).toEqual([`notice ${said}`, "reject tree"])
        expect(host.lines.at(-1)).toBe(`handoff: gave-up; ${said}`)
        expect(Option.map(host.record, (record) => [record.version, record.staged?.version])).toEqual(Option.some([GOOD.version, NEW.version]))
        // The record names the target's build staged, but the rejection holds the next checks.
        host.calls.length = 0
        yield* check("interval")
        expect(host.calls).toEqual([])
      }),
    )
  })

  for (const [serverConfig, what, said] of [
    [
      "ours",
      "lists our entries",
      `config: the server config /h/.config/opencode/opencode.json lists our plugin entries: remove the entries under /h/dotfiles/opencode from "plugins" in /h/.config/opencode/opencode.json, or install commit 51fc7c9f first, which strips them; nothing changed and the service was not restarted`,
    ],
    ["unreadable", "does not read", "config: the server config does not read: read the server config exited 1; nothing changed and the service was not restarted"],
  ] as const)
    test(`R2: a server config that ${what} is refused before any write: given up, rejected at config, the line names the file and the repair`, () => {
      const host = world({ record: stagedTarget(), serverConfig, readings: [healthy] })
      return run(
        host,
        Effect.gen(function* () {
          expect(yield* handOff).toBe("gave-up")
          expect(host.calls).toEqual([`notice ${said}`, "reject config"])
        }),
      )
    })

  test("R3: a sick restart whose good build has no tree gives up on the new build, saying so: no rollback onto a build that would start with no plugins", () => {
    const host = world({ record: stagedTarget(), trees: new Set([NEW.version]), readings: [failedPool] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("gave-up")
        expect(host.calls).toEqual([INSTALL, "restart", `notice ${POOL_FAILED}; the good build ${GOOD.version} has no plugin tree; not rolled back`, "reject health"])
      }),
    )
  })

  test("with no good build to go back to, it gives up and the corner names the failed plugin", () => {
    const host = world({ record: Option.some(stagedRecord(Option.none(), NEW, [])), readings: [failedPool] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("gave-up")
        expect(host.calls).toEqual([`record ${NEW.version}`, "restart", `notice ${POOL_FAILED}`, "reject health"])
      }),
    )
  })
})

/** The pool's status not answering yet: a reading that is not final, so the handoff reads again. */
const poolSilent: Reading = { ...healthy, accounts: Option.none() }

/**
 * A handoff on the fakes with the restarted service's own check at `after` into it: the plugin of
 * the new service checks while the handoff still reads health.
 */
const checkDuring = (after: Duration.Input) =>
  Effect.gen(function* () {
    const handing = yield* Effect.forkChild(handoff("batch-7"))
    yield* settle
    yield* TestClock.adjust(after)
    yield* settle
    yield* check("interval")
    yield* TestClock.adjust("10 minutes")
    return yield* Fiber.join(handing)
  })

describe("one handoff at a time", () => {
  for (const after of ["0 seconds", "30 seconds", "60 seconds", "90 seconds"] as const)
    test(`B1, P7: the restarted service's check ${after} into a handoff whose pool answers after 100 s starts no second handoff; once proven, a check does nothing`, () => {
      const host = world({ record: stagedTarget(), readings: [...Array.from({ length: 50 }, () => poolSilent), healthy] })
      return run(
        host,
        Effect.gen(function* () {
          expect(yield* checkDuring(after)).toBe("proven")
          expect(host.calls.filter((call) => call === "restart" || call.startsWith("handoff "))).toEqual(["restart"])
          expect(host.lines).toContain("check (interval): a handoff runs (pid 4242); nothing builds or restarts until it ends")
          expect(host.mark).toEqual(Option.none())
          host.calls.length = 0
          yield* check("interval")
          expect(host.calls).toEqual([])
        }),
      )
    })

  test("B1: a check while the handoff rolls back neither builds the failed target nor restarts; after it, the rejection holds", () => {
    const host = world({ record: stagedTarget(), readings: [failedPool, ...Array.from({ length: 20 }, () => poolSilent), healthy] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* checkDuring("60 seconds")).toBe("rolled-back")
        expect(host.calls.filter((call) => call.startsWith("stage") || call.startsWith("handoff "))).toEqual([])
        host.calls.length = 0
        yield* check("interval")
        expect(host.calls).toEqual([])
      }),
    )
  })

  test("B1: a mark whose handoff died (its pid gone) holds nothing: the check restarts onto the staged build", () => {
    const host = world({ record: stagedTarget(), mark: Option.some({ pid: 999, at: WEDNESDAY_NOON }) })
    return run(
      host,
      Effect.gen(function* () {
        yield* check("interval")
        expect(host.calls).toEqual([`handoff ${SHORT}`])
      }),
    )
  })

  test("B1: a mark older than the handoff's limit holds nothing, even when its pid lives (a reused pid)", () => {
    const host = world({ record: stagedTarget(), mark: Option.some({ pid: HANDOFF_PID, at: WEDNESDAY_NOON - 21 * 60_000 }) })
    return run(
      host,
      Effect.gen(function* () {
        yield* check("interval")
        expect(host.calls).toEqual([`handoff ${SHORT}`])
      }),
    )
  })
})

/** 2026-11-12T15:41:15Z, when a TUI's `service ensure` started the workbox's service. */
const STARTED = 1_794_498_075_000
const EVERY = Duration.minutes(10)

/**
 * The service as a watchdog sees it: whether the resident location runs, and the update's stamps
 * and log. While the resident location runs, its copy checks once an interval; a service a TUI
 * started does not run it until asked.
 */
interface ServiceWorld {
  residentLoaded: boolean
  asks: number
  /** How many asks still fail. */
  askFailures: number
  readonly beats: Array<number>
  readonly lines: Array<string>
}

const serviceWorld = (at: Partial<Omit<ServiceWorld, "beats" | "lines">> = {}): ServiceWorld => ({ residentLoaded: false, asks: 0, askFailures: 0, beats: [], lines: [], ...at })

const watchFakes = (host: ServiceWorld) =>
  Layer.mergeAll(
    Layer.succeed(
      Resident,
      Resident.of({
        load: Effect.suspend(() => {
          host.asks += 1
          if (host.askFailures === 0) return Effect.sync(() => void (host.residentLoaded = true))
          host.askFailures -= 1
          return failure("load the resident location")
        }),
      }),
    ),
    Layer.succeed(Heartbeat, Heartbeat.of({ beat: Effect.void, last: Effect.sync(() => Option.fromNullishOr(host.beats.at(-1))) })),
    Layer.succeed(Log, Log.of({ line: (text) => Effect.sync(() => void host.lines.push(text)) })),
  )

/** `body` with the watchdog of a copy outside the resident location running, under a test clock at the service's start. */
const watching = (host: ServiceWorld, body: Effect.Effect<void>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(STARTED)
      const fiber = yield* Effect.forkChild(watch(EVERY))
      yield* settle
      yield* body
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.provide(watchFakes(host)), Effect.provide(TestClock.layer())),
  )

/** Moves the clock on by `count` intervals; while the resident location runs, it checks once in each, half way. */
const intervals = (host: ServiceWorld, count: number) =>
  Effect.forEach(
    Array.from({ length: count }),
    () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(Duration.divideUnsafe(EVERY, 2))
        yield* settle
        if (host.residentLoaded) host.beats.push(yield* Clock.currentTimeMillis)
        yield* TestClock.adjust(Duration.divideUnsafe(EVERY, 2))
        yield* settle
      }),
    { discard: true },
  )

describe("the watchdog outside the resident location", () => {
  test("a service a TUI started never loads the resident location: the TUI location's copy asks for it once it loaded, and the checks start", () => {
    const host = serviceWorld()
    return watching(
      host,
      Effect.gen(function* () {
        expect(host.asks).toBe(0)
        yield* TestClock.adjust(RESIDENT_DELAY)
        yield* settle
        expect([host.asks, host.residentLoaded]).toEqual([1, true])
        yield* intervals(host, 4)
        expect(host.asks).toBe(1)
        expect(host.lines).toEqual([])
      }),
    )
  })

  test("checks that stop for more than two intervals are logged, and the service is asked for the resident location again", () => {
    const host = serviceWorld({ askFailures: 1 })
    return watching(
      host,
      Effect.gen(function* () {
        yield* TestClock.adjust(RESIDENT_DELAY)
        yield* settle
        expect(host.lines).toEqual(["watchdog: asking the service for its resident location failed at load the resident location: load the resident location exited 1"])
        yield* intervals(host, 1)
        expect(host.asks).toBe(1)
        yield* intervals(host, 1)
        expect([host.asks, host.residentLoaded]).toEqual([2, true])
        expect(host.lines.at(-1)).toBe("watchdog: no update check for 20m 10s (more than 2 intervals); asking the service for its resident location")
        yield* intervals(host, 3)
        expect(host.asks).toBe(2)
        expect(host.lines).toHaveLength(2)
      }),
    )
  })
})

/**
 * plugin-trees acceptance check (written by the planner before any product change, ported to the
 * tree seams by U4, folded into model.test.ts, which has the one runner, and cut to trees alone by U6).
 *
 * A model-based test at the updater's seam. The reference model is a host: a live dotfiles checkout,
 * the global config, the share directory's builds and trees, and running processes (the service and
 * open TUIs), each started on one build. The real `Updater` and `handoff` (model.ts) run over fakes of
 * the seams; each fake applies to the model what the real implementation does to the host (a tree
 * made, a record written, a restart, a prune by the real `prunable`). After every step the invariant
 * is read off the model:
 *
 *   I1  a running process holds plugin code of exactly its own build's dotfiles commit;
 *   I2  no step reloads plugins in a process that keeps running;
 *   I3  the live checkout never moves: `Source` has no step that moves it, so this model has none;
 *   I4  a prune deletes no binary or tree a model process runs, or the record keeps.
 *   (I5 to I7 below, with the starts and the trees.)
 *
 * A host the update refuses is part of the model too: one whose server config still lists our entries
 * (R2: no write and no restart) and one whose good build has no tree (R3: no rollback onto it).
 *
 * Run (from a checkout's opencode/, OPENCODE_DEV set as for every check; `SIM_SEED` replays one run):
 *   bun test mods/update/model.test.ts -t 'plugin trees'
 */
describe("plugin trees", () => {
  const SHARE = "/s"
  const build = (version: string, dotfiles: string, fork: string): Build => ({ version, command: [`${SHARE}/${buildName(version)}`], dotfiles, fork })
  /** A good build with no tree (a pre-tree build): fork e, dotfiles c. */
  const GOOD = build("2.2.6-prime.eeeeeeee.cccccccc", PRIOR, "e".repeat(40))
  /** The tree build of the same commits: another version (`.tree`), at another path. A host on trees runs it. */
  const GOOD_T = build("2.2.6-prime.eeeeeeee.cccccccc.tree", PRIOR, "e".repeat(40))
  const NEW = build("2.2.7-prime.ffffffff.dddddddd.tree", "d".repeat(40), "f".repeat(40))
  /** The second update's build, on top of the first: the same fork, another dotfiles commit. */
  const NEWER = build("2.2.7-prime.ffffffff.bbbbbbbb.tree", "b".repeat(40), "f".repeat(40))
  /** The builds an update makes: each a tree build. */
  const TREE_BUILDS = [GOOD_T, NEW, NEWER]
  const BUILDS = [GOOD, ...TREE_BUILDS]
  const targetOf = (each: Build, batch: string): Target => ({ dotfiles: each.dotfiles, fork: each.fork, batch })
  const dotfilesOf = (version: string) => Option.getOrElse(Option.map(Option.fromNullishOr(BUILDS.find((each) => each.version === version)), (each) => each.dotfiles), () => "unknown")
  const buildOfTarget = (target: Target) => Option.getOrThrow(Option.fromNullishOr(TREE_BUILDS.find((each) => each.dotfiles === target.dotfiles && each.fork === target.fork)))

  /** One running process: the build it started on, the dotfiles commit its loaded plugins are of, and how often they were reloaded under it. */
  interface Proc {
    readonly name: string
    readonly version: string
    /** Where it loads plugins from: the live checkout (by the global config), or its build's own tree. */
    readonly from: "live" | "tree"
    loaded: string
    reloads: number
  }

  interface Host {
    /** The live checkout's commit. */
    head: string
    procs: Array<Proc>
    record: Option.Option<Record>
    /** What the service reads as after each restart, in order. */
    readonly readings: Array<Reading>
    restarts: number
    readonly calls: Array<string>
    target: Target
    /** The share directory: the builds whose binary is there, and the builds with a tree beside it. */
    readonly binaries: Set<string>
    readonly trees: Set<string>
    /** Whether the server config lists plugin entries of ours (a pre-tree writer's): no update writes it. */
    readonly globalOurs: boolean
    /** What a prune deleted that a process ran or the record kept. */
    readonly lost: Array<string>
    /** The step that fails, if any: the tree's make or the stage. */
    fails: Option.Option<"make tree" | "stage">
    /** Before which of an update's calls (by its index) the service crashes, its unit starts it again and a TUI opens, if any. */
    crashAt: Option.Option<number>
    /** What the starts the model tries before every call found wrong (I5). */
    readonly starts: Array<string>
  }

  /**
   * How a process started on `version` binds its plugins: a build with its tree beside it binds the
   * tree, and the server lists the global config's entries too, so a service started while the global
   * config names ours holds both ("Duplicate plugin ID"); a build with no tree loads from the live
   * checkout, as the global configs name it, or nothing when they name none of ours.
   */
  const bind = (host: Host, name: string, version: string): Pick<Proc, "from" | "loaded"> => {
    if (!host.trees.has(version)) return { from: "live", loaded: Option.getOrElse(Option.liftPredicate(host.head, () => host.globalOurs), () => "none") }
    if (name === "service" && host.globalOurs) return { from: "tree", loaded: `mixed ${host.head.slice(0, 8)}+tree` }
    return { from: "tree", loaded: dotfilesOf(version) }
  }

  const started = (host: Host, name: string, version: string): Proc => ({ name, version, ...bind(host, name, version), reloads: 0 })

  /** The build the launcher starts (the record's installed one), and the one the service's unit starts again after a crash (the running service's). */
  const launched = (host: Host) => Option.getOrThrow(host.record).version
  const unitBuild = (host: Host) => Option.getOrElse(Option.map(Option.fromNullishOr(host.procs.find((proc) => proc.name === "service")), (proc) => proc.version), () => launched(host))

  /** Every start a host can see at this instant, of the old build or the new: a service by the launcher or by its unit, and a TUI by the launcher. What each would hold that is not its build's own goes in `starts` (I5). */
  const tryStarts = (host: Host, before: string) => {
    const tries = [
      { name: "service", version: launched(host) },
      { name: "service", version: unitBuild(host) },
      { name: "tui", version: launched(host) },
    ]
    for (const each of tries) {
      const { loaded } = bind(host, each.name, each.version)
      if (loaded !== dotfilesOf(each.version)) host.starts.push(`I5: a ${each.name} started on ${each.version} before ${before} holds ${loaded.slice(0, 8)}`)
    }
  }

  /** The update's next call: first every start this instant allows is tried, and at `crashAt` the service crashes (its unit starts it again) and a TUI opens. */
  const call = (host: Host, name: string) => {
    tryStarts(host, name)
    if (Option.contains(host.crashAt, host.calls.length))
      host.procs = [...host.procs.filter((proc) => proc.name !== "service"), started(host, "service", unitBuild(host)), started(host, `tui-opened-${host.calls.length}`, launched(host))]
    host.calls.push(name)
  }

  /** What the invariant finds wrong on the host, as lines; none when it holds. */
  const broken = (host: Host): ReadonlyArray<string> => [
    // I1: exactly its build's plugins: none, both lists or another commit's all break it.
    ...host.procs.filter((proc) => proc.loaded !== dotfilesOf(proc.version)).map((proc) => `I1: ${proc.name} runs ${proc.version} with plugins of ${proc.loaded.slice(0, 8)}`),
    ...host.procs.filter((proc) => proc.reloads > 0).map((proc) => `I2: ${proc.name} reloaded its plugins ${proc.reloads} times while running`),
    ...host.lost.map((what) => `I4: the prune deleted ${what}`),
    ...host.starts,
    // I7: a tree is only ever beside its build's binary: a stage that failed takes its tree with it.
    ...host.trees.values().filter((version) => !host.binaries.has(version)).map((version) => `I7: the tree of ${version} is left with no build`).toArray(),
  ]

  /** I6: an update the host did not reject ends on a build with its tree. */
  const stuck = (host: Host): ReadonlyArray<string> =>
    [launched(host)].values().filter((version) => !host.calls.some((each) => each.startsWith("reject")) && !host.trees.has(version)).map((version) => `I6: the update ended on ${version}, which has no tree, and rejected nothing`).toArray()

  const POOL = "/t/opencode/cmd/pool"
  const healthy: Reading = { configured: [POOL], listed: [{ path: Option.some(POOL), failed: Option.none() }], accounts: Option.some(7), providers: ["anthropic"], logins: ["anthropic"], placement: Option.none() }
  const sick: Reading = { ...healthy, listed: [{ path: Option.some(POOL), failed: Option.some("Cannot find package") }], accounts: Option.none() }

  const failure = (step: string) => Effect.fail(new UpdateFailed({ step, message: `${step} exited 1` }))

  /** A record write as one call: `record (good)` once it names its installed build good (a proof, or a rollback to the good build). */
  const recordCall = (next: Record) =>
    Option.match(Option.filter(goodOf(next), (good) => good.version === next.version && good.dotfiles === next.dotfiles), { onNone: () => "record", onSome: () => "record (good)" })

  /** The share directory's names, as a prune lists them. */
  const listing = (host: Host) => [...[...host.binaries].map(buildName), ...[...host.trees].map((version) => treeOf(buildName(version))), "pool-auth", "current.plugins"]

  /** What a prune must keep: every build a process runs, with its tree, and the record's installed, staged and good builds. */
  const needed = (host: Host, record: Record) => [
    ...host.procs.map((proc) => proc.version),
    ...[record.version, record.staged?.version, record.good?.version].flatMap((each) => Option.toArray(Option.fromNullishOr(each))),
  ]

  /** The prune, by the real rule (`builds.ts` `prunable`) over the model's share directory and running executables. */
  const prune = (host: Host, record: Record) => {
    const doomed = prunable(listing(host), record, Option.some({ executables: host.procs.map((proc) => `${SHARE}/${buildName(proc.version)}`), commands: [] }))
    for (const version of host.binaries) if (doomed.includes(buildName(version))) host.binaries.delete(version)
    for (const version of host.trees) if (doomed.includes(treeOf(buildName(version)))) host.trees.delete(version)
    for (const version of needed(host, record)) {
      if (!host.binaries.has(version)) host.lost.push(`the binary of ${version}`)
      if (TREE_BUILDS.some((each) => each.version === version) && !host.trees.has(version)) host.lost.push(`the tree of ${version}`)
    }
    if (doomed.includes("pool-auth")) host.lost.push("pool-auth")
  }

  /** Every effect an update may have: anything else (a checkout move, a config write) is a step of no update. */
  const EFFECTS = ["fetch", "make tree", "stage", "remove tree", "handoff", "record", "record (good)", "restart", "prune", "commands", "reject build", "reject tree", "reject config", "reject health"]

  const treeFakes = (host: Host) =>
    Layer.mergeAll(
      Layer.succeed(
        Source,
        Source.of({
          verified: Effect.sync(() => Option.some(host.target)),
          fetch: () => Effect.sync(() => call(host, "fetch")),
          commands: Effect.sync(() => call(host, "commands")),
        }),
      ),
      Layer.succeed(
        Builder,
        Builder.of({
          version: (target) => Effect.sync(() => buildOfTarget(target).version),
          stage: (target) =>
            Effect.suspend(() => {
              call(host, "stage")
              if (Option.contains(host.fails, "stage")) return failure("stage the build")
              const built = buildOfTarget(target)
              host.binaries.add(built.version)
              host.record = Option.some(stagedRecord(host.record, built, listing(host)))
              return Effect.void
            }),
        }),
      ),
      Layer.succeed(
        Trees,
        Trees.of({
          make: (version) =>
            Effect.suspend(() => {
              call(host, "make tree")
              if (Option.contains(host.fails, "make tree")) return failure("install the tree")
              host.trees.add(version)
              return Effect.succeed(`${SHARE}/${treeOf(buildName(version))}`)
            }),
          check: () => Effect.void,
          has: (version) => Effect.sync(() => host.trees.has(version)),
          remove: (version) =>
            Effect.sync(() => {
              call(host, "remove tree")
              host.trees.delete(version)
            }),
        }),
      ),
      Layer.succeed(Handoff, Handoff.of({ start: () => Effect.sync(() => call(host, "handoff")) })),
      Layer.succeed(HandoffMark, HandoffMark.of({ hold: Effect.void, release: Effect.void, read: Effect.succeed(Option.none()), alive: () => Effect.succeed(false) })),
      Layer.succeed(
        Records,
        Records.of({
          read: Effect.sync(() => host.record),
          write: (next) =>
            Effect.sync(() => {
              call(host, recordCall(next))
              host.record = Option.some(next)
            }),
        }),
      ),
      Layer.succeed(Rejections, Rejections.of({ read: Effect.succeed(Option.none()), write: (rejected) => Effect.sync(() => call(host, `reject ${rejected.step}`)) })),
      Layer.succeed(
        Builds,
        Builds.of({
          prune: (read) =>
            read.pipe(
              Effect.map((record) => {
                call(host, "prune")
                for (const each of Option.toArray(record)) prune(host, each)
                return []
              }),
            ),
        }),
      ),
      Layer.succeed(
        Configs,
        Configs.of({
          ours: Effect.sync(() => Option.filter(Option.some({ file: "/h/.config/opencode/opencode.json", under: "/h/dotfiles/opencode" }), () => host.globalOurs)),
        }),
      ),
      Layer.succeed(Log, Log.of({ line: () => Effect.void })),
      Layer.succeed(Heartbeat, Heartbeat.of({ beat: Effect.void, last: Effect.succeed(Option.none()) })),
      Layer.succeed(Notice, Notice.of({ show: () => Effect.void, clear: Effect.void })),
      Layer.succeed(
        Service,
        Service.of({
          // The service process ends and another starts on the build the record installs.
          restart: Effect.sync(() => {
            call(host, "restart")
            host.restarts += 1
            const installed = Option.getOrThrow(host.record).version
            host.procs = [...host.procs.filter((proc) => proc.name !== "service"), started(host, "service", installed)]
          }),
          read: Effect.suspend(() => Option.match(Option.fromNullishOr(host.readings.shift()), { onNone: () => failure("read"), onSome: Effect.succeed })),
          logins: Effect.succeed(["anthropic"]),
        }),
      ),
    )

  const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true })

  /** A small seeded generator (mulberry32), so a failing scenario replays by its seed. */
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** How a handoff ends: proven, rolled back after a sick restart, or given up after a sick rollback too. */
  type Ending = "healthy" | "rolled back" | "gave up"
  const ENDINGS: ReadonlyArray<Ending> = ["healthy", "rolled back", "gave up"]
  const readingsOf = (ending: Ending): ReadonlyArray<Reading> => {
    if (ending === "healthy") return [healthy]
    if (ending === "rolled back") return [sick, healthy]
    return [sick, sick]
  }

  /**
   * Where a host stands before its update: on trees; on a pre-tree good build whose writer left our
   * entries in the server config (R2), targeting another build or that build's own commits; or on an
   * unproven tree build whose good build has no tree (R3).
   */
  type Start = "on trees" | "lists ours" | "same commits" | "untreed good"
  const STARTS: ReadonlyArray<Start> = ["on trees", "lists ours", "same commits", "untreed good"]
  /** Per start: the build it targets first, the build its processes run, the record's good build, and whether the server config lists ours. */
  const START_OF = {
    "on trees": { first: NEW, running: GOOD_T, good: GOOD_T, ours: false },
    "lists ours": { first: NEW, running: GOOD, good: GOOD, ours: true },
    "same commits": { first: GOOD_T, running: GOOD, good: GOOD, ours: true },
    "untreed good": { first: NEW, running: GOOD_T, good: GOOD, ours: false },
  } as const

  /** A host on its running build with `tuis` TUIs open on it; the record names it installed, and good once proven. */
  const hostOf = (start: Start, tuis: number): Host => {
    const { first, running, good, ours } = START_OF[start]
    const host: Host = {
      head: PRIOR,
      procs: [],
      record: Option.some({ ...proven({ version: running.version, command: running.command, dotfiles: running.dotfiles, fork: running.fork }), good }),
      readings: [],
      restarts: 0,
      calls: [],
      target: targetOf(first, "batch-7"),
      binaries: new Set([running.version, good.version]),
      trees: new Set([running.version].filter((version) => TREE_BUILDS.some((each) => each.version === version))),
      globalOurs: ours,
      lost: [],
      fails: Option.none(),
      crashAt: Option.none(),
      starts: [],
    }
    host.procs = [started(host, "service", running.version), ...Array.from({ length: tuis }, (_, index) => started(host, `tui-${index}`, running.version))]
    return host
  }

  /** Each open TUI that is not in `stay` moves, at its idle moment, onto the build the record installs, when that is not its own. */
  const idleMoves = (host: Host, stay: ReadonlyArray<string>) => {
    const installed = Option.getOrThrow(host.record).version
    for (const [index, proc] of host.procs.entries())
      if (proc.name.startsWith("tui-") && proc.version !== installed && !stay.includes(proc.name)) host.procs[index] = started(host, proc.name, installed)
  }

  /**
   * One update onto `host.target`, ending as `ending`; the invariant read after the build, the handoff,
   * and the TUIs' idle moves (all but those in `stay`). `meanwhile` runs between the build and the handoff.
   */
  const update = (host: Host, ending: Ending, found: Array<string>, stay: ReadonlyArray<string>, label: string, meanwhile: (host: Host) => void = constVoid) =>
    Effect.gen(function* () {
      const read = (after: string) => found.push(...broken(host).map((line) => `${label}, after ${after}: ${line}`))
      host.readings.push(...readingsOf(ending))
      const checking = yield* Effect.forkChild((yield* Updater).check("asked"))
      yield* settle
      yield* TestClock.adjust(GATE_POLL)
      yield* Fiber.join(checking)
      read("the build")
      if (!host.calls.includes("handoff")) {
        found.push(...stuck(host).map((line) => `${label}: ${line}`))
        return "not handed off"
      }
      meanwhile(host)
      const handing = yield* Effect.forkChild(handoff("batch"))
      yield* settle
      yield* TestClock.adjust(HANDOFF_LIMIT)
      const outcome = yield* Fiber.join(handing)
      read(`the handoff (${outcome})`)
      idleMoves(host, stay)
      tryStarts(host, "the next update")
      read("the TUIs' idle moves")
      found.push(...stuck(host).map((line) => `${label}: ${line}`))
      host.readings.length = 0
      return outcome
    })

  /** `body` on the tree fakes over `host`, under a test clock of its own at a Wednesday noon. */
  const onHost = <A>(host: Host, body: Effect.Effect<A, UpdateFailed, Updater | Builder | Builds | HandoffMark | Service | Source | Records | Rejections | Configs | Trees | Notice | Log | Heartbeat>) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(WEDNESDAY_NOON)
      return yield* body
    }).pipe(Effect.provide(Layer.provideMerge(updaterLayer({ fetchEvery: GATE_POLL }), treeFakes(host))), Effect.provide(TestClock.layer()))

  /** Runs `scenarios` (each on its own host), then `assert` on what they answer, through the file's one runner (`run`). */
  const check = <A>(scenarios: Effect.Effect<A, UpdateFailed>, assert: (ran: A) => void) => run(world(), Effect.map(scenarios, assert))

  /** One generated host and its update, and a second update on top of it; what the invariant found, and each update's calls. */
  const scenario = (start: Start, tuis: number, endings: readonly [Ending, Ending], stay: ReadonlyArray<string>, crashAt: Option.Option<number> = Option.none(), fails: Option.Option<"make tree" | "stage"> = Option.none()) => {
    const host = hostOf(start, tuis)
    host.crashAt = crashAt
    host.fails = fails
    const found: Array<string> = []
    return onHost(
      host,
      Effect.gen(function* () {
        const first = yield* update(host, endings[0], found, stay, "first update")
        const firstCalls = [...host.calls]
        host.calls.length = 0
        host.fails = Option.none()
        host.target = targetOf(NEWER, "batch-8")
        const second = yield* update(host, endings[1], found, stay, "second update")
        const crashed = [firstCalls, host.calls].some((calls) => Option.exists(host.crashAt, (at) => calls.indexOf("record") >= 0 && calls.indexOf("record") < at && at <= calls.indexOf("restart")))
        return { outcomes: [first, second], found, calls: [firstCalls, [...host.calls]], host, crashed }
      }),
    )
  }

  /** One pick of `choices` by the generator. */
  const pick = <A>(next: () => number, choices: ReadonlyArray<A>): A => Option.getOrThrow(Arr.get(choices, Math.floor(next() * choices.length)))

  /**
   * The 120 generated scenarios of one seed (`SIM_SEED`, else a fixed one): a start, its TUIs, the two
   * endings, which TUI stays on its build, before which call (if any) the service crashes and a TUI
   * opens, and which step of the first build fails, if any. Every call besides tries every start (I5).
   */
  const generated = (seed: number) => {
    const next = random(seed)
    return Array.from({ length: 120 }, () => ({
      tuis: Math.floor(next() * 4),
      ending: pick(next, ENDINGS),
      start: pick(next, STARTS),
      second: pick(next, ENDINGS),
      stay: ["tui-0"].filter(() => next() < 0.3),
      crashAt: Option.some(Math.floor(next() * 10)).pipe(Option.filter(() => next() < 0.7)),
      fails: Option.some(pick(next, ["make tree", "stage"] as const)).pipe(Option.filter(() => next() < 0.15)),
    }))
  }

  /** The handoff's part of an update's calls: what follows `handoff`. */
  const afterHandoff = (calls: ReadonlyArray<string>) => calls.slice(calls.indexOf("handoff") + 1)

  describe("a running process only ever holds its own build's plugins", () => {
    test("A4: over generated hosts, endings, crashes and a second update, no step breaks I1 to I7, no step of the old scheme runs, a server config listing ours ends with no write and no restart, and a good build with no tree is never rolled back onto", () =>
      check(
        // `SIM_SEED` replays one run.
        Effect.flatMap(Effect.orDie(Config.Int("SIM_SEED").pipe(Config.withDefault(20261119))), (seed) =>
          Effect.forEach(generated(seed), (each) => scenario(each.start, each.tuis, [each.ending, each.second], each.stay, each.crashAt, each.fails).pipe(Effect.map((ran) => ({ each, ran })))),
        ),
        (runs) => {
          const failures = runs.flatMap(({ each, ran }) =>
            ran.found.slice(0, 1).map((first) => `${each.start}, ${each.tuis} TUIs, ${each.ending} then ${each.second} (${ran.outcomes.join(", ")}): ${first} [${ran.calls.map((calls) => calls.join(", ")).join(" | ")}]`),
          )
          expect(failures.slice(0, 5)).toEqual([])
          // No effect but an update's own, in any scenario: no checkout move, no config write, no reinstall.
          expect([...new Set(runs.flatMap(({ ran }) => ran.calls.flat()).filter((call) => !EFFECTS.includes(call)))]).toEqual([])
          // R2: a host whose server config lists ours refuses every handed-off update before any write or restart.
          const listing = runs.filter(({ ran }) => ran.host.globalOurs).flatMap(({ ran }) => ran.calls.filter((calls) => calls.includes("handoff")).map(afterHandoff))
          expect([listing.length > 0, [...new Set(listing.map((calls) => calls.join(", ")))]]).toEqual([true, ["reject config"]])
          // R3: a sick first restart over a good build with no tree gives up on the new build: no rollback.
          const untreed = runs.filter(({ each }) => each.start === "untreed good" && each.ending !== "healthy").filter(({ ran }) => ran.calls[0].includes("handoff"))
          expect([untreed.length > 0, [...new Set(untreed.map(({ ran }) => `${ran.outcomes[0]}: ${afterHandoff(ran.calls[0]).join(", ")}`))]]).toEqual([true, ["gave-up: record, restart, reject health"]])
          // The generator reaches every way an update ends, on both updates.
          const seen = runs.map(({ ran }) => ran.outcomes)
          for (const outcome of ["proven", "rolled-back", "gave-up"]) expect([seen.some((each) => each[0] === outcome), seen.some((each) => each[1] === outcome)]).toEqual([true, true])
          // ... and every failed build, and a crash between the record that installs the build and the restart.
          expect(["make tree", "stage"].map((step) => runs.some(({ each }) => Option.contains(each.fails, step)))).toEqual([true, true])
          expect(runs.some(({ ran }) => ran.crashed)).toBe(true)
        },
      ))

    test("a rollback ends on the good build by a record write, the invariant whole", () =>
      check(scenario("on trees", 1, ["rolled back", "healthy"], []), (ran) => {
        expect(ran.outcomes[0]).toBe("rolled-back")
        expect(ran.found).toEqual([])
      }))
  })

  /** One update of a host that starts as `start`, ending as `ending`, with `fails` failing; its calls and outcome. */
  const once = (start: Start, ending: Ending, fails: Option.Option<"make tree" | "stage"> = Option.none(), meanwhile: (host: Host) => void = constVoid) => {
    const host = hostOf(start, 1)
    host.fails = fails
    const found: Array<string> = []
    return onHost(host, update(host, ending, found, [], "the update", meanwhile)).pipe(Effect.map((outcome) => ({ outcome, calls: host.calls, found, host })))
  }

  describe("A3: the order of an update's effects", () => {
    test("steady state: fetch, make the tree, stage, hand off; then the record, the restart, the good record, the prune, the host's commands; nothing else", () =>
      check(scenario("on trees", 1, ["healthy", "healthy"], []), (ran) => {
        expect(ran.outcomes).toEqual(["proven", "proven"])
        expect(ran.calls[0]).toEqual(["fetch", "make tree", "stage", "handoff", "record", "restart", "record (good)", "prune", "commands"])
        expect(ran.calls[1]).toEqual(["fetch", "make tree", "stage", "handoff", "record", "restart", "record (good)", "prune", "commands"])
        expect(ran.found).toEqual([])
      }))

    test("a rollback is a record write and a restart", () =>
      check(once("on trees", "rolled back"), (ran) => {
        expect(ran.outcome).toBe("rolled-back")
        expect(ran.calls).toEqual(["fetch", "make tree", "stage", "handoff", "record", "restart", "record (good)", "restart", "reject health"])
      }))

    /** A failed step: the calls up to and including it; a failed stage then deletes the tree it was to bind. */
    const FAILED = [
      { fails: "make tree", what: "tree", calls: ["fetch", "make tree"] },
      { fails: "stage", what: "build", calls: ["fetch", "make tree", "stage", "remove tree"] },
    ] as const
    for (const { fails, what, calls } of FAILED)
      test(`a failed ${what} rejects the target and leaves nothing: no record, no handoff, no tree`, () =>
        check(once("on trees", "healthy", Option.some(fails)), (ran) => {
          expect(ran.outcome).toBe("not handed off")
          expect(ran.calls).toEqual([...calls, "reject build"])
          expect(Option.map(ran.host.record, (record) => [record.version, Option.isSome(Option.fromNullishOr(record.staged))])).toEqual(Option.some([GOOD_T.version, false]))
          expect([[...ran.host.trees], ran.found]).toEqual([[GOOD_T.version], []])
        }))

    test("R1: a staged build whose tree is gone by the handoff is refused: no record, no restart", () =>
      check(
        once("on trees", "healthy", Option.none(), (host) => void host.trees.delete(NEW.version)),
        (ran) => {
          expect(ran.outcome).toBe("gave-up")
          expect(ran.calls).toEqual(["fetch", "make tree", "stage", "handoff", "reject tree"])
          expect([launched(ran.host), ran.host.restarts]).toEqual([GOOD_T.version, 0])
        },
      ))

    for (const start of ["lists ours", "same commits"] as const)
      test(`R2 (${start}): a server config that lists our entries is refused: no record, no restart, the config as it was`, () =>
        check(once(start, "healthy"), (ran) => {
          expect(ran.outcome).toBe("gave-up")
          expect(ran.calls).toEqual(["fetch", "make tree", "stage", "handoff", "reject config"])
          expect([launched(ran.host), ran.host.restarts, ran.host.globalOurs, ran.found]).toEqual([GOOD.version, 0, true, []])
        }))

    test("R3: a sick restart over a good build with no tree gives up on the new build: no rollback onto a build that would start with no plugins", () =>
      check(once("untreed good", "rolled back"), (ran) => {
        expect(ran.outcome).toBe("gave-up")
        expect(ran.calls).toEqual(["fetch", "make tree", "stage", "handoff", "record", "restart", "reject health"])
        expect(launched(ran.host)).toBe(NEW.version)
      }))
  })
})
