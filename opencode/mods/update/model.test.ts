import { describe, expect, test } from "bun:test"
import { Array as Arr, Clock, Config, Duration, Effect, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { buildName, prunable } from "./builds.ts"
import type { Reading } from "./health.ts"
import { EXIT_CODES, GATE_POLL, handoff, HEALTH_DEADLINE, HEALTH_POLL, intervalChecks, Updater, updaterLayer } from "./model.ts"
import { type Build, goodOf, proven, type Record, stagedRecord } from "./record.ts"
import { Builder, Builds, CheckoutStuck, Configs, Handoff, HandoffMark, Heartbeat, Log, Notice, Records, Rejections, Resident, Service, Source, Trees, UpdateFailed } from "./service.ts"
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
const GOOD = build("2.2.6-prime.aaaaaaaa", PRIOR, "e".repeat(40))
/** The target's build, as daily's stage names it. */
const NEW = build("2.2.7-prime.bbbbbbbb", TARGET.dotfiles)
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
  configureFails: boolean
  /** The commit the live checkout is on: where every running process loads its plugins from. */
  head: string
  /** How many restarts still fail before one goes through. */
  restartFailures: number
  reinstallFails: boolean
  /** Whether the prune of old builds cannot read what runs. */
  pruneFails: boolean
  /** The commits whose advance fails. */
  advanceFails: ReadonlyArray<string>
  /** Commits git refuses to move the checkout to (an untracked file in the way). */
  advanceStuck: ReadonlyArray<string>
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
  configureFails: false,
  head: PRIOR,
  restartFailures: 0,
  reinstallFails: false,
  pruneFails: false,
  advanceFails: [],
  advanceStuck: [],
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
        head: Effect.sync(() => host.head),
        advance: (commit) =>
          Effect.suspend((): Effect.Effect<void, UpdateFailed | CheckoutStuck> => {
            host.calls.push(`advance ${commit.slice(0, 1)}`)
            if (host.advanceStuck.includes(commit)) return Effect.fail(new CheckoutStuck({ step: "fast-forward the checkout", message: "untracked files the target tracks with other content: docs/x.md" }))
            // A failed install moves the checkout back to where it was (`git/source.ts`).
            if (host.advanceFails.includes(commit)) return failure("install the dependencies")
            host.head = commit
            return Effect.void
          }),
        reinstall: Effect.suspend(() => {
          host.calls.push("reinstall")
          if (host.reinstallFails) return failure("install the dependencies again")
          return Effect.void
        }),
        commands: Effect.die(new Error("the old scheme runs the host's commands in advance")),
      }),
    ),
    Layer.succeed(
      Builder,
      Builder.of({
        version: () => Effect.succeed(NEW.version),
        // These tests are the old scheme's: no fork binds a tree (the plugin trees section below has the tree scheme's).
        binds: () => Effect.succeed(false),
        stage: (target) =>
          Effect.suspend(() => {
            host.calls.push(`stage ${target.batch}`)
            if (host.stageFails) return failure("build")
            host.record = Option.some(stagedRecord(host.record, NEW, []))
            return Effect.void
          }),
        configure: Effect.suspend(() => {
          host.calls.push("configure")
          if (host.configureFails) return failure("write the configs")
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
        oldRunning: Effect.die(new Error("the old scheme strips no TUI config")),
      }),
    ),
    Layer.succeed(
      Configs,
      Configs.of({
        keep: Effect.sync(() => void host.calls.push("keep config")),
        restore: Effect.sync(() => void host.calls.push("restore config")),
        ours: Effect.succeed(true),
        strip: Effect.die(new Error("the old scheme strips nothing")),
        tuiOurs: Effect.die(new Error("the old scheme strips no TUI config")),
        stripTui: Effect.die(new Error("the old scheme strips no TUI config")),
      }),
    ),
    Layer.succeed(Trees, Trees.of({ make: () => Effect.die(new Error("the old scheme makes no tree")), check: () => Effect.void, has: () => Effect.succeed(false), remove: () => Effect.void })),
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

const notices = (host: World) => host.calls.filter((call) => call.startsWith("notice "))

/** The handoff's first steps onto the target's build: the running config kept, the live checkout moved, the configs written from it. */
const MOVE = ["keep config", "advance d", "configure"] as const

describe("the updater on its seams", () => {
  test("S1: the live checkout moves only in the handoff, right before the restart: never while the target builds or waits, and never by the updater", () => {
    const host = world({ record: onGood(), readings: [healthy] })
    return run(
      host,
      Effect.gen(function* () {
        yield* check("asked")
        // Built and handed off: every process still loads its plugins from the commit the running build came with.
        expect(host.calls).toEqual(["stage batch-7", `handoff ${SHORT}`])
        expect(host.head).toBe(PRIOR)
        expect(yield* handOff).toBe("proven")
        expect(host.calls).toEqual(["stage batch-7", `handoff ${SHORT}`, ...MOVE, `record ${NEW.version} good ${GOOD.version}`, "restart", `record ${NEW.version} good ${NEW.version}`, "notice cleared", `prune ${NEW.version} under the mark`])
        expect(host.head).toBe(TARGET.dotfiles)
        expect(host.lines.slice(0, 4)).toEqual([
          `update: the good build's fork ${GOOD.fork.slice(0, 10)} binds no plugin tree (no packages/cli/src/adjacent-config.ts); staying on the old scheme`,
          `update: ${SHORT}; building it ahead, the dotfiles stay at ${PRIOR.slice(0, 10)} until the restart`, `update: ${SHORT} is built; restarting onto it`, "update: the restart is handed off"])
        expect(host.lines).toContain(`handoff: moving the dotfiles from ${PRIOR.slice(0, 10)} to ${TARGET.dotfiles.slice(0, 10)}, right before the restart`)
      }),
    )
  })

  test("S2: the Sabbath rest holds the restart with the checkout unmoved, and it is handed off once the rest ends", () => {
    const host = world({ record: onGood() })
    return run(
      host,
      Effect.gen(function* () {
        yield* TestClock.setTime(SATURDAY_NOON)
        const fiber = yield* Effect.forkChild((yield* Updater).check("asked"))
        yield* settle
        yield* TestClock.adjust(GATE_POLL)
        yield* settle
        expect(host.calls).toEqual(["stage batch-7"])
        expect(host.head).toBe(PRIOR)
        expect(host.lines.some((line) => line.startsWith("restart held: the Sabbath rest, until "))).toBe(true)
        yield* TestClock.adjust(Duration.hours(12))
        yield* Fiber.join(fiber)
        expect(host.calls.at(-1)).toBe(`handoff ${SHORT}`)
        expect(host.head).toBe(PRIOR)
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

  test("P6, S3: a failed build moves nothing (the checkout and the config stay as they run) and rejects the target: later checks build nothing", () => {
    const host = world({ record: onGood(), stageFails: true })
    return run(
      host,
      Effect.gen(function* () {
        yield* check("interval")
        expect(host.calls).toEqual(["stage batch-7", "reject build"])
        expect(host.head).toBe(PRIOR)
        expect(host.lines.at(-1)).toBe("update failed at build: build exited 1")
        host.calls.length = 0
        yield* check("interval")
        yield* check("asked")
        expect(host.calls).toEqual([])
        expect(host.lines.at(-1)).toBe(`check (asked): ${SHORT} failed at build (build exited 1); waiting for another target`)
      }),
    )
  })

  test("a failed move in the handoff (its install; the checkout went back) gives up without a restart and rejects the target", () => {
    const host = world({ record: stagedTarget(), advanceFails: [TARGET.dotfiles] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("gave-up")
        expect(host.calls).toEqual(["keep config", "advance d", "notice advance: install the dependencies: install the dependencies exited 1; the service was not restarted", "reject advance"])
        expect(host.head).toBe(PRIOR)
        host.calls.length = 0
        yield* check("interval")
        expect(host.calls).toEqual([])
      }),
    )
  })

  test("a failed configure moves the checkout and the config back, gives up without a restart, and rejects the target", () => {
    const host = world({ record: stagedTarget(), configureFails: true })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("gave-up")
        expect(host.calls).toEqual([...MOVE, "advance c", "restore config", "notice configure: write the configs: write the configs exited 1; the service was not restarted", "reject configure"])
        expect(host.head).toBe(PRIOR)
        expect(Option.map(host.record, (record) => [record.version, record.staged?.version])).toEqual(Option.some([GOOD.version, NEW.version]))
      }),
    )
  })

  test("A1: a checkout git refuses to move holds the handoff: no rejection, no restart, the notice; a check after the handoff's limit hands off again, and a move that goes through proves the build and clears the notice", () => {
    const host = world({ record: stagedTarget(), advanceStuck: [TARGET.dotfiles], readings: [healthy] })
    const held = `notice update batch-7 is held: the dotfiles checkout could not move: untracked files the target tracks with other content: docs/x.md`
    return run(
      host,
      Effect.gen(function* () {
        yield* check("interval")
        yield* check("interval")
        expect(host.calls).toEqual([`handoff ${SHORT}`])
        // The handoff's run moves the clock past its limit.
        expect(yield* handOff).toBe("held")
        expect(host.calls.slice(1)).toEqual(["keep config", "advance d", held])
        expect(host.rejected).toEqual(Option.none())
        expect(host.head).toBe(PRIOR)
        expect(EXIT_CODES.held).not.toBe(0)
        host.calls.length = 0
        yield* check("interval")
        expect(host.calls).toEqual([`handoff ${SHORT}`])
        host.calls.length = 0
        host.advanceStuck = []
        expect(yield* handOff).toBe("proven")
        expect(host.calls).toContain("notice cleared")
        expect(host.head).toBe(TARGET.dotfiles)
      }),
    )
  })

  test("a build by hand, whose checkout is already on its commit, does not move the checkout, and writes the configs", () => {
    const host = world({ record: stagedTarget(), head: TARGET.dotfiles, readings: [healthy] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("proven")
        expect(host.calls.slice(0, 3)).toEqual(["keep config", "configure", `record ${NEW.version} good ${GOOD.version}`])
      }),
    )
  })

  test("a host on the target, proven, does nothing", () => {
    const host = world({ record: Option.some(proven({ version: NEW.version, command: NEW.command, dotfiles: NEW.dotfiles, fork: NEW.fork })) })
    return run(
      host,
      Effect.gen(function* () {
        yield* check("interval")
        expect(host.calls).toEqual([])
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

  test("a proven build prunes once, last, by the record it proved, while the handoff still holds its mark (no stage copies a build meanwhile), and logs each build with its size", () => {
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
    const host = world({ record: stagedTarget(), readings: [failedPool, failedPool, healthy] })
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
        expect(host.lines.at(-1)).toBe("prune: every build kept: list the running processes: list the running processes exited 1")
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
        expect(host.calls).toEqual([...MOVE, `record ${NEW.version} good ${GOOD.version}`, "restart", `record ${NEW.version} good ${NEW.version}`, "notice cleared", `prune ${NEW.version} under the mark`])
        expect(EXIT_CODES.proven).toBe(0)
      }),
    )
  })

  test("P1: a plugin that fails after the restart and the reinstall rolls back to the good build and dotfiles commit, and the target is never tried again", () => {
    const host = world({ record: stagedTarget(), readings: [failedPool, failedPool, healthy] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("rolled-back")
        expect(host.calls).toEqual([
          ...MOVE,
          `record ${NEW.version} good ${GOOD.version}`,
          "restart",
          "reinstall",
          "restart",
          "advance c",
          "restore config",
          `record ${GOOD.version} good ${GOOD.version}`,
          "restart",
          `notice ${POOL_FAILED}; rolled back`,
          "reject health",
        ])
        expect(Option.map(host.record, (record) => record.previous)).toEqual(Option.some([NEW.version]))
        host.calls.length = 0
        yield* check("interval")
        yield* check("interval")
        expect(host.calls).toEqual([])
        expect(EXIT_CODES["rolled-back"]).not.toBe(0)
      }),
    )
  })

  test("P2: a restart that fails once is a sick reading: it reinstalls, restarts and proves the build", () => {
    const host = world({ record: stagedTarget(), restartFailures: 1, readings: [healthy] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("proven")
        expect(host.calls.slice(MOVE.length + 1)).toEqual(["restart", "reinstall", "restart", `record ${NEW.version} good ${NEW.version}`, "notice cleared", `prune ${NEW.version} under the mark`])
      }),
    )
  })

  test("a restart that keeps failing rolls back, and a rollback that cannot restart gives up with the notice", () => {
    const host = world({ record: stagedTarget(), restartFailures: 3 })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("gave-up")
        expect(host.calls.slice(MOVE.length + 1)).toEqual([
          "restart",
          "reinstall",
          "restart",
          "advance c",
          "restore config",
          `record ${GOOD.version} good ${GOOD.version}`,
          "restart",
          "notice service restart: restart the service exited 1",
          "reject health",
        ])
        expect(EXIT_CODES["gave-up"]).not.toBe(0)
      }),
    )
  })

  test("a restart that fails twice, then a healthy rollback, ends rolled back with the notice", () => {
    const host = world({ record: stagedTarget(), restartFailures: 2, readings: [healthy] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("rolled-back")
        expect(notices(host)).toEqual(["notice service restart: restart the service exited 1; rolled back"])
      }),
    )
  })

  test("P3: a reinstall that fails goes on to the rollback, which ends healthy, with the notice", () => {
    const host = world({ record: stagedTarget(), reinstallFails: true, readings: [failedPool, healthy] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("rolled-back")
        expect(host.calls.slice(MOVE.length + 1)).toEqual([
          "restart",
          "reinstall",
          "advance c",
          "restore config",
          `record ${GOOD.version} good ${GOOD.version}`,
          "restart",
          "notice reinstall: install the dependencies again exited 1; rolled back",
          "reject health",
        ])
      }),
    )
  })

  test("P4: a rollback whose checkout move fails gives up with the notice and rejects the target", () => {
    const host = world({ record: stagedTarget(), advanceFails: [PRIOR], readings: [failedPool, failedPool] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("gave-up")
        expect(notices(host)).toEqual([`notice ${POOL_FAILED}; rollback at install the dependencies: install the dependencies exited 1`])
        expect(Option.map(host.rejected, (rejected) => [rejected.dotfiles, rejected.step])).toEqual(Option.some([TARGET.dotfiles, "health"]))
        // Nothing claims the rollback: the record still names the target's build installed, as the checkout (moved back by the failed advance) holds it.
        expect(Option.map(host.record, (record) => [record.version, record.dotfiles])).toEqual(Option.some([NEW.version, NEW.dotfiles]))
        expect(host.lines.some((line) => line.includes("rolled-back"))).toBe(false)
      }),
    )
  })

  test("a restart that loses the configured models' login reinstalls, then rolls back, naming the provider, though the pool answers with accounts", () => {
    const host = world({ record: stagedTarget(), before: Option.some(["anthropic", "openai"]), readings: [...throughDeadline(noAnthropic), ...throughDeadline(noAnthropic), healthy] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("rolled-back")
        expect(host.calls.slice(MOVE.length + 1)).toEqual([
          "restart",
          "reinstall",
          "restart",
          "advance c",
          "restore config",
          `record ${GOOD.version} good ${GOOD.version}`,
          "restart",
          `notice ${LOST}; rolled back`,
          "reject health",
        ])
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
        expect(host.calls.slice(MOVE.length + 1)).toEqual(["restart", `record ${NEW.version} good ${NEW.version}`, "notice healthy, but no anthropic login: sign in with opencode auth login", `prune ${NEW.version} under the mark`])
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

  test("with no good build to go back to, it gives up and the corner names the failed plugin", () => {
    const host = world({ record: Option.some(stagedRecord(Option.none(), NEW, [])), readings: [failedPool, failedPool] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("gave-up")
        expect(host.calls.slice(MOVE.length + 1)).toEqual(["restart", "reinstall", "restart", `notice ${POOL_FAILED}`, "reject health"])
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
    const host = world({ record: stagedTarget(), readings: [failedPool, ...Array.from({ length: 20 }, () => poolSilent), failedPool, ...Array.from({ length: 20 }, () => poolSilent), healthy] })
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
 * tree seams by U4 and folded into model.test.ts, which has the one runner).
 *
 * A model-based test at the updater's seam. The reference model is a host: a live dotfiles checkout,
 * the global config, the share directory's builds and trees, and running processes (the service and
 * open TUIs), each started on one build. The real `Updater` and `handoff` (model.ts) run over fakes of
 * the seams; each fake applies to the model what the real implementation does to the host (a checkout
 * move, a config write, a tree made, a restart, a prune by the real `prunable`). After every step the
 * invariant is read off the model:
 *
 *   I1  a running process holds plugin code of exactly its own build's dotfiles commit;
 *   I2  no step reloads plugins in a process that keeps running;
 *   I3  the live checkout never moves (no update step, and no rollback, moves git);
 *   I4  a prune deletes no binary or tree a model process runs, or the record keeps.
 *   (I5 to I7 below, with the starts and the trees; U5 adds I8: the TUI config loses our entries only
 *   once no process of an old-format build runs.)
 *
 * Red on main before U4: the handoff's `source.advance` moved the live checkout, which every open TUI
 * and the old service loaded from and watched, so I1, I2 and I3 all failed.
 *
 * Run (from a checkout's opencode/, OPENCODE_DEV set as for every check; `SIM_SEED` replays one run):
 *   bun test mods/update/model.test.ts -t 'plugin trees'
 */
describe("plugin trees", () => {
  const SHARE = "/s"
  const build = (version: string, dotfiles: string, fork: string): Build => ({ version, command: [`${SHARE}/${buildName(version)}`], dotfiles, fork })
  /** The old scheme's good build, before the host's first tree install: fork e (which binds a tree), dotfiles c, no tree. */
  const GOOD = build("2.2.6-prime.eeeeeeee.cccccccc", PRIOR, "e".repeat(40))
  /** The tree build of the good build's own commits: another version (`.tree`), at another path. A host on trees already runs it. */
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
    /** How often the live checkout moved. */
    moves: number
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
    /** Whether the server config lists plugin entries of ours (the old scheme wrote them), and whether the kept copy does. */
    globalOurs: boolean
    keptOurs: boolean
    /** Whether the TUI config (`cli.json`) lists plugin entries of ours: the old scheme wrote them, and only the late strip takes them out. */
    tuiOurs: boolean
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
   * tree (the fork's adjacent binding), and the server lists the global config's entries too, so a
   * service started while the global config still names ours holds both ("Duplicate plugin ID"); a
   * build with no tree loads from the live checkout, as the global configs name it, so a service
   * started once our entries left the server config holds none (a TUI reads its own config, which the
   * strip leaves).
   */
  const bind = (host: Host, name: string, version: string): Pick<Proc, "from" | "loaded"> => {
    if (!host.trees.has(version)) {
      if (name === "service" && !host.globalOurs) return { from: "live", loaded: "none" }
      if (name !== "service" && !host.tuiOurs) return { from: "live", loaded: "none" }
      return { from: "live", loaded: host.head }
    }
    if (name === "service" && host.globalOurs) return { from: "tree", loaded: `mixed ${host.head.slice(0, 8)}+tree` }
    return { from: "tree", loaded: dotfilesOf(version) }
  }

  const started = (host: Host, name: string, version: string): Proc => ({ name, version, ...bind(host, name, version), reloads: 0 })

  /** The live checkout moved: every process that loads from it reloads, onto the commit it moved to. */
  const checkoutMoved = (host: Host, commit: string) => {
    if (host.head === commit) return
    host.head = commit
    host.moves += 1
    for (const proc of host.procs.filter((each) => each.from === "live")) {
      proc.loaded = commit
      proc.reloads += 1
    }
  }

  /** The global configs' plugin entries were written: every process that reads its plugin list there reloads. */
  const globalPluginsWritten = (host: Host) => {
    for (const proc of host.procs.filter((each) => each.from === "live")) proc.reloads += 1
  }

  /** The server config alone was written (the strip, its restore): the service, when it reads it, reloads; a TUI reads only its own config. */
  const serverConfigWritten = (host: Host) => {
    for (const proc of host.procs.filter((each) => each.from === "live" && each.name === "service")) proc.reloads += 1
  }

  /** The TUI config's plugins were written (the late strip): every TUI that reads its plugin list there reloads, onto none of ours. */
  const tuiConfigWritten = (host: Host) => {
    for (const proc of host.procs.filter((each) => each.from === "live" && each.name !== "service")) {
      proc.reloads += 1
      proc.loaded = "none"
    }
  }

  /** The running processes of an old-format build: a build with no tree beside it, which reads its plugins from the global configs. */
  const oldFormat = (host: Host) => host.procs.filter((proc) => !host.trees.has(proc.version))

  /** The build the launcher starts (the record's installed one), and the one the service's unit starts again after a crash (the running service's). */
  const launched = (host: Host) => Option.getOrThrow(host.record).version
  const unitBuild = (host: Host) => Option.getOrElse(Option.map(Option.fromNullishOr(host.procs.find((proc) => proc.name === "service")), (proc) => proc.version), () => launched(host))

  /**
   * Whether the update stands between a config write (the strip, its restore) and the restart that
   * follows it: the one span where a service started by the launcher or its unit may hold no list of
   * ours or both, which that restart, the handoff's next step, ends. Outside it every start holds
   * exactly its build's plugins (I5).
   */
  const betweenWriteAndRestart = (host: Host) => Math.max(host.calls.lastIndexOf("strip"), host.calls.lastIndexOf("restore config")) > host.calls.lastIndexOf("restart")

  /** Every start a host can see at this instant, of the old build or the new: a service by the launcher or by its unit, and a TUI by the launcher. What each would hold that is not its build's own goes in `starts` (I5). */
  const tryStarts = (host: Host, before: string) => {
    const tries = [
      { name: "service", version: launched(host) },
      { name: "service", version: unitBuild(host) },
      { name: "tui", version: launched(host) },
    ]
    for (const each of tries) {
      const { loaded } = bind(host, each.name, each.version)
      const allowed = each.name === "service" && betweenWriteAndRestart(host)
      if (loaded !== dotfilesOf(each.version) && !allowed) host.starts.push(`I5: a ${each.name} started on ${each.version} before ${before} holds ${loaded.slice(0, 8)}`)
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
    ...[host.moves].values().filter((moves) => moves > 0).map((moves) => `I3: the live checkout moved ${moves} times`).toArray(),
    ...host.lost.map((what) => `I4: the prune deleted ${what}`),
    ...host.starts,
    // I7: a tree is only ever beside its build's binary: a stage that failed takes its tree with it.
    ...host.trees.values().filter((version) => !host.binaries.has(version)).map((version) => `I7: the tree of ${version} is left with no build`).toArray(),
  ]

  /** I6: an update the host did not reject ends on a build with its tree: a host never stays on the old scheme by itself. */
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

  const treeFakes = (host: Host) =>
    Layer.mergeAll(
      Layer.succeed(
        Source,
        Source.of({
          verified: Effect.sync(() => Option.some(host.target)),
          fetch: () => Effect.sync(() => call(host, "fetch")),
          head: Effect.sync(() => host.head),
          advance: (commit: string) =>
            Effect.sync(() => {
              call(host, `advance ${commit.slice(0, 1)}`)
              checkoutMoved(host, commit)
            }),
          reinstall: Effect.sync(() => call(host, "reinstall")),
          commands: Effect.sync(() => call(host, "commands")),
        }),
      ),
      Layer.succeed(
        Builder,
        Builder.of({
          version: (target) => Effect.sync(() => buildOfTarget(target).version),
          // Every fork here has the adjacent binding (U1): the tree scheme.
          binds: () => Effect.succeed(true),
          stage: (target) =>
            Effect.suspend(() => {
              call(host, "stage")
              if (Option.contains(host.fails, "stage")) return failure("stage the build")
              const built = buildOfTarget(target)
              host.binaries.add(built.version)
              host.record = Option.some(stagedRecord(host.record, built, listing(host)))
              return Effect.void
            }),
          configure: Effect.sync(() => {
            call(host, "configure")
            globalPluginsWritten(host)
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
          // By the processes' executables, as the real one reads them: a build with no tree beside it is old-format.
          oldRunning: Effect.sync(() => oldFormat(host).map((proc) => buildName(proc.version))),
        }),
      ),
      Layer.succeed(
        Configs,
        Configs.of({
          keep: Effect.sync(() => {
            call(host, "keep config")
            host.keptOurs = host.globalOurs
          }),
          restore: Effect.sync(() => {
            call(host, "restore config")
            if (host.globalOurs !== host.keptOurs) serverConfigWritten(host)
            host.globalOurs = host.keptOurs
          }),
          ours: Effect.sync(() => host.globalOurs),
          strip: Effect.sync(() => {
            call(host, "strip")
            if (host.globalOurs) serverConfigWritten(host)
            host.globalOurs = false
          }),
          tuiOurs: Effect.sync(() => host.tuiOurs),
          stripTui: Effect.sync(() => {
            call(host, "strip tui")
            // I8: the late strip runs only once no process of an old-format build runs, whatever it reads.
            for (const proc of oldFormat(host)) host.starts.push(`I8: the TUI config was stripped while ${proc.name} runs the old-format ${proc.version}`)
            if (host.tuiOurs) tuiConfigWritten(host)
            host.tuiOurs = false
          }),
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

  /** How a handoff ends: proven, rolled back after a sick restart, or given up after a sick rollback too. With no reinstall rung, one sick restart rolls back. */
  type Ending = "healthy" | "rolled back" | "gave up"
  const ENDINGS: ReadonlyArray<Ending> = ["healthy", "rolled back", "gave up"]
  const readingsOf = (ending: Ending): ReadonlyArray<Reading> => {
    if (ending === "healthy") return [healthy]
    if (ending === "rolled back") return [sick, healthy]
    return [sick, sick]
  }

  /** Where a host stands before its update: on trees already, before its first tree install (the old scheme's good build, our entries in the global config), or that and the target is its own build's commits. */
  type Start = "on trees" | "first install" | "same commits"
  const STARTS: ReadonlyArray<Start> = ["on trees", "first install", "same commits"]
  /** Per start: the build it targets first, whether the good build has its tree, and whether the global config still lists ours. */
  const START_OF = {
    "on trees": { first: NEW, good: GOOD_T },
    "first install": { first: NEW, good: GOOD },
    "same commits": { first: GOOD_T, good: GOOD },
  } as const

  /** A host on the good build, proven, with `tuis` TUIs open on it. */
  const hostOf = (start: Start, tuis: number): Host => {
    const { first, good } = START_OF[start]
    const treed = good === GOOD_T
    const host: Host = {
      head: PRIOR,
      moves: 0,
      procs: [],
      record: Option.some(proven({ version: good.version, command: good.command, dotfiles: good.dotfiles, fork: good.fork })),
      readings: [],
      restarts: 0,
      calls: [],
      target: targetOf(first, "batch-7"),
      binaries: new Set([good.version]),
      trees: new Set([good.version].filter(() => treed)),
      globalOurs: !treed,
      keptOurs: false,
      // Every host still has the old scheme's TUI entries: the migration leaves the TUI config alone.
      tuiOurs: true,
      lost: [],
      fails: Option.none(),
      crashAt: Option.none(),
      starts: [],
    }
    host.procs = [started(host, "service", good.version), ...Array.from({ length: tuis }, (_, index) => started(host, `tui-${index}`, good.version))]
    return host
  }

  /** Each open TUI that is not in `stay` moves, at its idle moment, onto the build the record installs, when that is not its own. */
  const idleMoves = (host: Host, stay: ReadonlyArray<string>) => {
    const installed = Option.getOrThrow(host.record).version
    for (const [index, proc] of host.procs.entries())
      if (proc.name.startsWith("tui-") && proc.version !== installed && !stay.includes(proc.name)) host.procs[index] = started(host, proc.name, installed)
  }

  /** One update onto `host.target`, ending as `ending`; the invariant read after the build, the handoff, and the TUIs' idle moves (all but those in `stay`). */
  const update = (host: Host, ending: Ending, found: Array<string>, stay: ReadonlyArray<string>, label: string) =>
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
        const crashed = [firstCalls, host.calls].some((calls) => Option.exists(host.crashAt, (at) => calls.indexOf("strip") >= 0 && calls.indexOf("strip") < at && at <= calls.indexOf("restart")))
        return { outcomes: [first, second], found, calls: [firstCalls, [...host.calls]], host, crashed }
      }),
    )
  }

  /** One pick of `choices` by the generator. */
  const pick = <A>(next: () => number, choices: ReadonlyArray<A>): A => Option.getOrThrow(Arr.get(choices, Math.floor(next() * choices.length)))

  /**
   * The 90 generated scenarios of one seed (`SIM_SEED`, else a fixed one): a start, its TUIs, the two
   * endings, which TUI stays on its build, before which call (if any) the service crashes and a TUI
   * opens, and which step of the first build fails, if any. Every call besides tries every start (I5).
   */
  const generated = (seed: number) => {
    const next = random(seed)
    return Array.from({ length: 90 }, () => ({
      tuis: Math.floor(next() * 4),
      ending: pick(next, ENDINGS),
      start: pick(next, STARTS),
      second: pick(next, ENDINGS),
      stay: ["tui-0"].filter(() => next() < 0.3),
      crashAt: Option.some(Math.floor(next() * 14)).pipe(Option.filter(() => next() < 0.7)),
      fails: Option.some(pick(next, ["make tree", "stage"] as const)).pipe(Option.filter(() => next() < 0.15)),
    }))
  }

  describe("a running process only ever holds its own build's plugins", () => {
    test("over generated hosts, endings, crashes and a second update, no step breaks I1 to I8, and a start at any step holds exactly its build's plugins", () =>
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
          // The generator reaches every way an update ends, on both updates.
          const seen = runs.map(({ ran }) => ran.outcomes)
          for (const outcome of ["proven", "rolled-back", "gave-up"]) expect([seen.some((each) => each[0] === outcome), seen.some((each) => each[1] === outcome)]).toEqual([true, true])
          // ... and every failed build, and a crash in the switch's span (between the strip and the restart).
          expect(["make tree", "stage"].map((step) => runs.some(({ each }) => Option.contains(each.fails, step)))).toEqual([true, true])
          expect(runs.some(({ ran }) => ran.crashed)).toBe(true)
          // ... and the late strip, and a host whose old TUI held it.
          expect([runs.some(({ ran }) => !ran.host.tuiOurs), runs.some(({ ran }) => ran.host.tuiOurs && ran.outcomes.includes("proven"))]).toEqual([true, true])
        },
      ))

    test("a rollback moves no git: it ends on the good build with the checkout where it was", () =>
      check(scenario("on trees", 1, ["rolled back", "healthy"], []), (ran) => {
        expect(ran.outcomes[0]).toBe("rolled-back")
        expect(ran.calls.flat().filter((call) => call.startsWith("advance"))).toEqual([])
        expect(ran.host.head).toBe(PRIOR)
      }))
  })

  /** One update of a host that starts as `start`, ending as `ending`, with `fails` failing; its calls and outcome. */
  const once = (start: Start, ending: Ending, fails: Option.Option<"make tree" | "stage"> = Option.none()) => {
    const host = hostOf(start, 1)
    host.fails = fails
    const found: Array<string> = []
    return onHost(host, update(host, ending, found, [], "the update")).pipe(Effect.map((outcome) => ({ outcome, calls: host.calls, found, host })))
  }

  describe("the order of an update's effects", () => {
    test("steady state: fetch, make the tree, stage, hand off; then the record, the restart, the good record, the prune; nothing moves the checkout or writes a config", () =>
      check(scenario("on trees", 1, ["healthy", "healthy"], []), (ran) => {
        expect(ran.outcomes).toEqual(["proven", "proven"])
        // The first proven handoff with no old-format build running takes the old scheme's entries out of the TUI config, once.
        // Then the host's commands, as a checkout move ran them.
        expect(ran.calls[0]).toEqual(["fetch", "make tree", "stage", "handoff", "record", "restart", "record (good)", "prune", "strip tui", "commands"])
        expect(ran.calls[1]).toEqual(["fetch", "make tree", "stage", "handoff", "record", "restart", "record (good)", "prune", "commands"])
        expect([ran.host.tuiOurs, ran.found]).toEqual([false, []])
      }))

    test("the late strip waits while a TUI of the old scheme runs, and comes with the first proven handoff after it moved", () =>
      check(scenario("first install", 1, ["healthy", "healthy"], []), (ran) => {
        expect(ran.outcomes).toEqual(["proven", "proven"])
        // tui-0 still runs the old build when the first handoff ends; it moves at its idle moment, before the second.
        expect(ran.calls[0].includes("strip tui")).toBe(false)
        expect(ran.calls[1].slice(-3)).toEqual(["prune", "strip tui", "commands"])
        expect([ran.host.tuiOurs, ran.found]).toEqual([false, []])
      }))

    test("a TUI of the old scheme that never moves holds the late strip for good", () =>
      check(scenario("first install", 1, ["healthy", "healthy"], ["tui-0"]), (ran) => {
        expect(ran.calls.flat().includes("strip tui")).toBe(false)
        expect([ran.host.tuiOurs, ran.found]).toEqual([true, []])
      }))

    test("a rollback never strips the TUI config", () =>
      check(scenario("on trees", 1, ["rolled back", "gave up"], []), (ran) => {
        expect(ran.calls.flat().includes("strip tui")).toBe(false)
        expect(ran.host.tuiOurs).toBe(true)
      }))

    test("the first tree install keeps the config and strips our entries right before the record; nothing else is new", () =>
      check(once("first install", "healthy"), (ran) => {
        expect(ran.outcome).toBe("proven")
        expect(ran.calls).toEqual(["fetch", "make tree", "stage", "handoff", "keep config", "strip", "record", "restart", "record (good)", "prune", "commands"])
        expect([ran.host.globalOurs, ran.found]).toEqual([false, []])
      }))

    test("the first tree install's rollback puts the kept config back before the record that installs the good build, which has no tree", () =>
      check(once("first install", "rolled back"), (ran) => {
        expect(ran.outcome).toBe("rolled-back")
        expect(ran.calls).toEqual(["fetch", "make tree", "stage", "handoff", "keep config", "strip", "record", "restart", "restore config", "record (good)", "restart", "reject health"])
        expect([ran.host.globalOurs, ran.found]).toEqual([true, []])
      }))

    test("a rollback on trees is a record write and a restart: no config is restored", () =>
      check(once("on trees", "rolled back"), (ran) => {
        expect(ran.calls).toEqual(["fetch", "make tree", "stage", "handoff", "record", "restart", "record (good)", "restart", "reject health"])
      }))

    test("a host on the old scheme's last build re-stages the same commits as a tree build, by itself, at another version, and strips once", () =>
      check(once("same commits", "healthy"), (ran) => {
        expect(ran.outcome).toBe("proven")
        expect(ran.calls).toEqual(["fetch", "make tree", "stage", "handoff", "keep config", "strip", "record", "restart", "record (good)", "prune", "commands"])
        expect(Option.map(ran.host.record, (record) => record.version)).toEqual(Option.some(GOOD_T.version))
        expect(ran.found).toEqual([])
      }))

    test("the same commits' first tree install rolls back like any other: the kept config back, then the good build, whose binary the tree build never overwrote", () =>
      check(once("same commits", "rolled back"), (ran) => {
        expect(ran.outcome).toBe("rolled-back")
        expect(ran.calls).toEqual(["fetch", "make tree", "stage", "handoff", "keep config", "strip", "record", "restart", "restore config", "record (good)", "restart", "reject health"])
        expect(Option.map(ran.host.record, (record) => record.version)).toEqual(Option.some(GOOD.version))
        expect([ran.host.binaries.has(GOOD.version), ran.host.globalOurs, ran.found]).toEqual([true, true, []])
      }))

    /** A failed step: the calls up to and including it; a failed stage then deletes the tree it was to bind. */
    const FAILED = [
      { fails: "make tree", what: "tree", calls: ["fetch", "make tree"] },
      { fails: "stage", what: "build", calls: ["fetch", "make tree", "stage", "remove tree"] },
    ] as const
    for (const start of ["first install", "same commits"] as const)
      for (const { fails, what, calls } of FAILED)
        test(`${start}: a failed ${what} rejects the target and leaves nothing: no record, no handoff, no config, no tree`, () =>
          check(once(start, "healthy", Option.some(fails)), (ran) => {
            expect(ran.outcome).toBe("not handed off")
            expect(ran.calls).toEqual([...calls, "reject build"])
            expect(Option.map(ran.host.record, (record) => [record.version, Option.isSome(Option.fromNullishOr(record.staged))])).toEqual(Option.some([GOOD.version, false]))
            expect([ran.host.globalOurs, [...ran.host.trees], ran.found]).toEqual([true, [], []])
          }))
  })
})
