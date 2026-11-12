import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import type { SessionView } from "./gate.ts"
import type { Reading } from "./health.ts"
import { GATE_POLL, handoff, Updater, updaterLayer } from "./model.ts"
import type { Record } from "./record.ts"
import { Builder, Configs, Handoff, Log, Notice, Records, Service, Sessions, Source, UpdateFailed } from "./service.ts"
import type { Target } from "./target.ts"

/** 2026-11-11T17:00:00Z, a Wednesday noon in Knowlton. */
const WEDNESDAY_NOON = 1_794_416_400_000

const TARGET: Target = { dotfiles: "d".repeat(40), fork: "f".repeat(40), batch: "batch-7" }
const PRIOR = "c".repeat(40)

/** The host as the fakes hold it: what each seam was asked, in order, and what it answers. */
interface World {
  readonly calls: Array<string>
  readonly lines: Array<string>
  views: ReadonlyArray<SessionView>
  record: Option.Option<Record>
  readonly readings: Array<Reading>
  readonly stageFails: boolean
}

const world = (at: Partial<Pick<World, "views" | "record" | "readings" | "stageFails">> = {}): World => ({
  calls: [],
  lines: [],
  views: [],
  record: Option.none(),
  readings: [],
  stageFails: false,
  ...at,
})

const session = (id: string, at: Partial<Omit<SessionView, "id">> = {}): SessionView => ({ id, parentID: Option.none(), busy: false, compacting: false, ...at })

/** Fake git, build and exec: each seam records its call and answers from the world. */
const fakes = (host: World) =>
  Layer.mergeAll(
    Layer.succeed(
      Source,
      Source.of({
        verified: Effect.succeed(Option.some(TARGET)),
        head: Effect.succeed(PRIOR),
        advance: (commit) => Effect.sync(() => void host.calls.push(`advance ${commit.slice(0, 1)}`)),
        reinstall: Effect.sync(() => void host.calls.push("reinstall")),
      }),
    ),
    Layer.succeed(
      Builder,
      Builder.of({
        stage: (target) =>
          Effect.sync(() => host.calls.push(`stage ${target.batch}`)).pipe(
            Effect.andThen(Effect.suspend(() => Effect.when(Effect.fail(new UpdateFailed({ step: "build", message: "bun build exited 1" })), Effect.sync(() => host.stageFails)))),
            Effect.asVoid,
          ),
      }),
    ),
    Layer.succeed(Sessions, Sessions.of({ all: Effect.sync(() => host.views) })),
    Layer.succeed(Handoff, Handoff.of({ start: (reason) => Effect.sync(() => void host.calls.push(`handoff ${reason}`)) })),
    Layer.succeed(
      Records,
      Records.of({
        read: Effect.sync(() => host.record),
        write: (record) =>
          Effect.sync(() => {
            host.record = Option.some(record)
            host.calls.push(`record ${record.version}${Option.match(Option.fromNullishOr(record.good), { onNone: () => "", onSome: (good) => ` good ${good.version}` })}`)
          }),
      }),
    ),
    Layer.succeed(Configs, Configs.of({ keep: Effect.sync(() => void host.calls.push("keep config")), restore: Effect.sync(() => void host.calls.push("restore config")) })),
    Layer.succeed(Log, Log.of({ line: (text) => Effect.sync(() => void host.lines.push(text)) })),
    Layer.succeed(Notice, Notice.of({ show: (text) => Effect.sync(() => void host.calls.push(`notice ${text}`)), clear: Effect.sync(() => void host.calls.push("notice cleared")) })),
    Layer.succeed(
      Service,
      Service.of({
        restart: Effect.sync(() => void host.calls.push("restart")),
        read: Effect.suspend(() => Option.match(Option.fromNullishOr(host.readings.shift()), { onNone: () => Effect.fail(new UpdateFailed({ step: "read", message: "no reading" })), onSome: Effect.succeed })),
      }),
    ),
  )

/** Runs `body` on the fakes under a test clock set to a Wednesday noon. */
const run = <A>(host: World, body: Effect.Effect<A, UpdateFailed, Updater | Service | Source | Records | Configs | Notice | Log>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(WEDNESDAY_NOON)
      return yield* body
    }).pipe(Effect.provide(Layer.provideMerge(updaterLayer({ fetchEvery: GATE_POLL }), fakes(host))), Effect.provide(TestClock.layer())),
  )

/** Lets every forked fiber run until it waits on the clock. */
const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true })

const POOL = "/d/opencode/cmd/pool"
const healthy: Reading = { configured: [POOL], listed: [{ path: Option.some(POOL), failed: Option.none() }], accounts: Option.some(7) }
const failedPool: Reading = { configured: [POOL], listed: [{ path: Option.some(POOL), failed: Option.some("Cannot find package '@dotfiles/opencode-status'") }], accounts: Option.none() }

const build = (version: string, dotfiles: string) => ({ version, command: [`/s/opencode-${version}`] as const, dotfiles, fork: "f".repeat(40) })

describe("the update on its seams", () => {
  test("a busy root holds the restart; once the roots are idle, running subagents do not, and the build is handed off", () => {
    const host = world({ views: [session("ses_root", { busy: true }), session("ses_sub", { parentID: Option.some("ses_root"), busy: true })] })
    return run(
      host,
      Effect.gen(function* () {
        const updater = yield* Updater
        const fiber = yield* Effect.forkChild(updater.check("asked"))
        yield* settle
        yield* TestClock.adjust(GATE_POLL)
        yield* settle
        expect(host.calls).toEqual([`advance d`, "keep config", "stage batch-7"])
        expect(host.lines).toContain("restart held: root sessions at work: ses_root")
        host.views = [session("ses_root"), session("ses_sub", { parentID: Option.some("ses_root"), busy: true })]
        yield* TestClock.adjust(GATE_POLL)
        yield* Fiber.join(fiber)
        expect(host.calls).toEqual([`advance d`, "keep config", "stage batch-7", `handoff dotfiles ${"d".repeat(10)}, fork ${"f".repeat(10)} (batch-7)`])
        expect(host.lines.some((line) => /^restart: .* after 1m of waiting$/.test(line))).toBe(true)
      }),
    )
  })

  test("a failed build moves the dotfiles back and restarts nothing", () => {
    const host = world({ stageFails: true })
    return run(
      host,
      Effect.gen(function* () {
        yield* (yield* Updater).check("interval")
        expect(host.calls).toEqual([`advance d`, "keep config", "stage batch-7", `advance c`])
        expect(host.lines.at(-1)).toBe("update failed at build: bun build exited 1")
      }),
    )
  })

  test("a host on the target does nothing", () => {
    const host = world({ record: Option.some({ ...build("2.2.7-prime.bbbbbbbb", TARGET.dotfiles), fork: TARGET.fork }) })
    return run(
      host,
      Effect.gen(function* () {
        yield* (yield* Updater).check("interval")
        expect(host.calls).toEqual([])
      }),
    )
  })

  test("a healthy restart proves the build and clears the corner", () => {
    const host = world({ record: Option.some(build("2.2.7-prime.bbbbbbbb", "d".repeat(40))), readings: [healthy] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handoff("batch-7")).toBe("proven")
        expect(host.calls).toEqual(["restart", "record 2.2.7-prime.bbbbbbbb good 2.2.7-prime.bbbbbbbb", "notice cleared"])
      }),
    )
  })

  test("a plugin that fails after the restart and the reinstall rolls back to the last good build and dotfiles commit", () => {
    const good = build("2.2.6-prime.aaaaaaaa", PRIOR)
    const host = world({ record: Option.some({ ...build("2.2.7-prime.bbbbbbbb", "d".repeat(40)), good }), readings: [failedPool, failedPool, healthy] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handoff("batch-7")).toBe("rolled-back")
        expect(host.calls).toEqual([
          "restart",
          "reinstall",
          "restart",
          "advance c",
          "restore config",
          "record 2.2.6-prime.aaaaaaaa good 2.2.6-prime.aaaaaaaa",
          "restart",
          "notice pool: Cannot find package '@dotfiles/opencode-status'; rolled back",
        ])
        expect(Option.map(host.record, (record) => record.previous)).toEqual(Option.some(["2.2.7-prime.bbbbbbbb"]))
      }),
    )
  })

  test("with no good build to go back to, it gives up and the corner names the failed plugin", () => {
    const host = world({ record: Option.some(build("2.2.7-prime.bbbbbbbb", "d".repeat(40))), readings: [failedPool, failedPool] })
    return run(
      host,
      Effect.gen(function* () {
        expect(yield* handoff("batch-7")).toBe("gave-up")
        expect(host.calls).toEqual(["restart", "reinstall", "restart", "notice pool: Cannot find package '@dotfiles/opencode-status'"])
      }),
    )
  })
})
