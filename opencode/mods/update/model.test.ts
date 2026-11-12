import { describe, expect, test } from "bun:test"
import { Clock, Duration, Effect, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import type { SessionView } from "./gate.ts"
import type { Reading } from "./health.ts"
import { EXIT_CODES, GATE_POLL, handoff, HEALTH_DEADLINE, HEALTH_POLL, intervalChecks, Updater, updaterLayer } from "./model.ts"
import { type Build, proven, type Record, stagedRecord } from "./record.ts"
import { Builder, Configs, Handoff, HandoffMark, Heartbeat, Log, Notice, Records, Rejections, Resident, Service, Sessions, Source, UpdateFailed } from "./service.ts"
import type { Target } from "./target.ts"
import { HANDOFF_LIMIT, type Rejected, type Running } from "./update.ts"
import { RESIDENT_DELAY, watch } from "./watch.ts"

/** 2026-11-11T17:00:00Z, a Wednesday noon in Knowlton. */
const WEDNESDAY_NOON = 1_794_416_400_000

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
  views: ReadonlyArray<SessionView>
  record: Option.Option<Record>
  rejected: Option.Option<Rejected>
  /** The running handoff's mark, and the pids that live. */
  mark: Option.Option<Running>
  living: ReadonlyArray<number>
  readonly readings: Array<Reading>
  stageFails: boolean
  sessionsFail: boolean
  /** How many restarts still fail before one goes through. */
  restartFailures: number
  reinstallFails: boolean
  /** The commits whose advance fails. */
  advanceFails: ReadonlyArray<string>
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
  views: [],
  record: Option.none(),
  rejected: Option.none(),
  mark: Option.none(),
  living: [HANDOFF_PID],
  readings: [],
  stageFails: false,
  sessionsFail: false,
  restartFailures: 0,
  reinstallFails: false,
  advanceFails: [],
  before: Option.some([]),
  ...at,
})

const session = (id: string, at: Partial<Omit<SessionView, "id">> = {}): SessionView => ({ id, parentID: Option.none(), busy: false, compacting: false, ...at })

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
        head: Effect.succeed(PRIOR),
        advance: (commit) =>
          Effect.suspend(() => {
            host.calls.push(`advance ${commit.slice(0, 1)}`)
            if (host.advanceFails.includes(commit)) return failure("install the dependencies")
            return Effect.void
          }),
        reinstall: Effect.suspend(() => {
          host.calls.push("reinstall")
          if (host.reinstallFails) return failure("install the dependencies again")
          return Effect.void
        }),
      }),
    ),
    Layer.succeed(
      Builder,
      Builder.of({
        stage: (target) =>
          Effect.suspend(() => {
            host.calls.push(`stage ${target.batch}`)
            if (host.stageFails) return failure("build")
            host.record = Option.some(stagedRecord(host.record, NEW, []))
            return Effect.void
          }),
      }),
    ),
    Layer.succeed(
      Sessions,
      Sessions.of({
        all: Effect.suspend(() => {
          if (host.sessionsFail) return failure("list the sessions")
          return Effect.succeed(host.views)
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
    Layer.succeed(Configs, Configs.of({ keep: Effect.sync(() => void host.calls.push("keep config")), restore: Effect.sync(() => void host.calls.push("restore config")) })),
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

/** Runs `body` on the fakes under a test clock set to a Wednesday noon. */
const run = <A>(host: World, body: Effect.Effect<A, UpdateFailed, Updater | HandoffMark | Service | Source | Records | Rejections | Configs | Notice | Log | Heartbeat>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(WEDNESDAY_NOON)
      return yield* body
    }).pipe(Effect.provide(Layer.provideMerge(updaterLayer({ fetchEvery: GATE_POLL }), fakes(host))), Effect.provide(TestClock.layer())),
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

describe("the updater on its seams", () => {
  test("a busy root holds the restart; once the roots are idle, running subagents do not, and the build is handed off", () => {
    const host = world({ record: onGood(), views: [session("ses_root", { busy: true }), session("ses_sub", { parentID: Option.some("ses_root"), busy: true })] })
    return run(
      host,
      Effect.gen(function* () {
        const updater = yield* Updater
        const fiber = yield* Effect.forkChild(updater.check("asked"))
        yield* settle
        yield* TestClock.adjust(GATE_POLL)
        yield* settle
        expect(host.calls).toEqual(["advance d", "keep config", "stage batch-7"])
        expect(host.lines).toContain("restart held: root sessions at work: ses_root")
        host.views = [session("ses_root"), session("ses_sub", { parentID: Option.some("ses_root"), busy: true })]
        yield* TestClock.adjust(GATE_POLL)
        yield* Fiber.join(fiber)
        expect(host.calls).toEqual(["advance d", "keep config", "stage batch-7", `handoff ${SHORT}`])
        expect(host.lines.some((line) => /^restart: .* after 1m of waiting$/.test(line))).toBe(true)
      }),
    )
  })

  test("the staged build is not the installed one: the record keeps the running build until the handoff installs it", () => {
    const host = world({ record: onGood(), stageFails: false })
    return run(
      host,
      Effect.gen(function* () {
        yield* check("interval")
        expect(Option.map(host.record, (record) => [record.version, record.dotfiles, record.staged?.version])).toEqual(Option.some([GOOD.version, PRIOR, NEW.version]))
      }),
    )
  })

  test("P6: a failed build moves the dotfiles and the config back and rejects the target: later checks build nothing", () => {
    const host = world({ record: onGood(), stageFails: true })
    return run(
      host,
      Effect.gen(function* () {
        yield* check("interval")
        expect(host.calls).toEqual(["advance d", "keep config", "stage batch-7", "advance c", "restore config", "reject build"])
        expect(host.lines.at(-1)).toBe("update failed at build: build exited 1")
        host.calls.length = 0
        yield* check("interval")
        yield* check("asked")
        expect(host.calls).toEqual([])
        expect(host.lines.at(-1)).toBe(`check (asked): ${SHORT} failed at build (build exited 1); waiting for another target`)
      }),
    )
  })

  test("a failed advance (its install) rejects the target too", () => {
    const host = world({ record: onGood(), advanceFails: [TARGET.dotfiles] })
    return run(
      host,
      Effect.gen(function* () {
        yield* check("interval")
        host.calls.length = 0
        yield* check("interval")
        expect(host.calls).toEqual([])
        expect(Option.map(host.rejected, (rejected) => rejected.step)).toEqual(Option.some("advance"))
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

  test("P5, M1: a failed session read while the build waits ends the run; the next check restarts onto the staged build without building it again", () => {
    const host = world({ record: onGood(), sessionsFail: true })
    return run(
      host,
      Effect.gen(function* () {
        yield* check("interval")
        expect(host.calls).toEqual(["advance d", "keep config", "stage batch-7"])
        expect(host.lines.at(-1)).toBe("update failed at list the sessions: list the sessions exited 1")
        host.sessionsFail = false
        host.calls.length = 0
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

describe("the handoff on its seams", () => {
  test("installs the staged build, restarts, and a healthy restart proves it and clears the corner", () => {
    const host = world({ record: stagedTarget(), readings: [healthy] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("proven")
        expect(host.calls).toEqual([`record ${NEW.version} good ${GOOD.version}`, "restart", `record ${NEW.version} good ${NEW.version}`, "notice cleared"])
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
        expect(host.calls.slice(1)).toEqual(["restart", "reinstall", "restart", `record ${NEW.version} good ${NEW.version}`, "notice cleared"])
      }),
    )
  })

  test("a restart that keeps failing rolls back, and a rollback that cannot restart gives up with the notice", () => {
    const host = world({ record: stagedTarget(), restartFailures: 3 })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handOff).toBe("gave-up")
        expect(host.calls.slice(1)).toEqual([
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
        expect(host.calls.slice(1)).toEqual([
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
        expect(host.calls.slice(1)).toEqual([
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
        expect(host.calls.slice(1)).toEqual(["restart", `record ${NEW.version} good ${NEW.version}`, "notice healthy, but no anthropic login: sign in with opencode auth login"])
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
        expect(host.calls.slice(1)).toEqual(["restart", "reinstall", "restart", `notice ${POOL_FAILED}`, "reject health"])
      }),
    )
  })
})

/** The pool's status not answering yet: a reading that is not final, so the handoff reads again. */
const poolSilent: Reading = { ...healthy, accounts: Option.none() }

/**
 * A handoff on the fakes with the restarted service's own check at `after` into it: the plugin of
 * the new service, its roots idle, checks while the handoff still reads health.
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
        expect(host.calls.filter((call) => call.startsWith("stage") || call.startsWith("handoff ") || call === "advance d")).toEqual([])
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
