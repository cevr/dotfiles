// The plugin seam: the composition root on a stand-in host, its systems as fakes under a test
// clock. It checks which copy does what: a copy outside the resident location asks the service for
// the resident location (the workbox's stall of 2026-11-12: a service a TUI started never loaded
// it, so no copy checked), and the resident copy runs its interval checks and answers `status`.
import { describe, expect, test } from "bun:test"
import { iso } from "@dotfiles/opencode-update/gate"
import { GATE_POLL } from "@dotfiles/opencode-update/model"
import { Placement } from "@dotfiles/opencode-update/placement"
import { UPDATE } from "@dotfiles/opencode-update/rpc"
import { Builder, Configs, Handoff, HandoffMark, Heartbeat, Log, Placer, Records, Rejections, Resident, Sessions, Source } from "@dotfiles/opencode-update/service"
import { RESIDENT_DELAY } from "@dotfiles/opencode-update/watch"
import { Clock, Duration, Effect, Layer, Option, type Scope } from "effect"
import { TestClock } from "effect/testing"
import { type Externals, type Host, plugin, type UpdateHandlers } from "./server.ts"

/** 2026-11-12T15:41:15Z, when a TUI's `service ensure` started the workbox's service. */
const STARTED = 1_794_498_075_000
const RESIDENT = "/home/x/.local/state/opencode-prime/resident"
/** The TUI's location, where a service a TUI started loads its plugins. */
const TUI = "/home/x/Developer/work/bite"
const EVERY = Duration.minutes(10)

const options = {
  host: "test",
  checkout: "/home/x/dotfiles",
  mode: "ff",
  fork: "/home/x/fork",
  bun: "/home/x/.bun/bin/bun",
  launcher: "/home/x/.local/bin/opencode",
  resident: RESIDENT,
  record: "/home/x/installed.json",
  config: ["/home/x/.config/opencode/opencode.json"],
  notice: "/home/x/upstream.json",
  state: "/home/x/.local/state/opencode-update",
  everyMinutes: 10,
}

/** The host as the fakes hold it: the asks for the resident location, the update log and the check stamps. */
interface World {
  asks: number
  /** Whether a check stamps the heartbeat; off, the checks look stalled. */
  stamping: boolean
  readonly beats: Array<number>
  readonly lines: Array<string>
}

const world = (at: Partial<Omit<World, "beats" | "lines">> = {}): World => ({ asks: 0, stamping: true, beats: [], lines: [], ...at })

const unused = (step: string) => Effect.die(new Error(`the seam test does not reach ${step}`))

/** Fakes for every system: no verified target on the origin, so a check only logs. */
const fakes = (host: World): Externals => {
  const log = Layer.succeed(Log, Log.of({ line: (text) => Effect.sync(() => void host.lines.push(text)) }))
  const heartbeat = Layer.succeed(
    Heartbeat,
    Heartbeat.of({
      beat: Effect.gen(function* () {
        if (host.stamping) host.beats.push(yield* Clock.currentTimeMillis)
      }),
      last: Effect.sync(() => Option.fromNullishOr(host.beats.at(-1))),
    }),
  )
  return {
    placement: () => Layer.succeed(Placer, Placer.of({ place: Effect.succeed(Placement.cases.Unmanaged.make({ reason: "a stand-in host" })), observe: Effect.succeed(Placement.cases.Unmanaged.make({ reason: "a stand-in host" })) })),
    watch: () =>
      Layer.mergeAll(
        Layer.succeed(Resident, Resident.of({ load: Effect.sync(() => void (host.asks += 1)) })),
        heartbeat,
        log,
      ),
    live: () =>
      Layer.mergeAll(
        Layer.succeed(Source, Source.of({ verified: Effect.succeed(Option.none()), head: unused("head"), advance: () => unused("advance"), reinstall: unused("reinstall") })),
        Layer.succeed(Builder, Builder.of({ stage: () => unused("stage") })),
        Layer.succeed(Sessions, Sessions.of({ all: unused("sessions") })),
        Layer.succeed(Handoff, Handoff.of({ start: () => unused("handoff") })),
        Layer.succeed(HandoffMark, HandoffMark.of({ hold: Effect.void, release: Effect.void, read: Effect.succeed(Option.none()), alive: () => Effect.succeed(false) })),
        Layer.succeed(Records, Records.of({ read: Effect.succeed(Option.none()), write: () => unused("record") })),
        Layer.succeed(Rejections, Rejections.of({ read: Effect.succeed(Option.none()), write: () => Effect.void })),
        Layer.succeed(Configs, Configs.of({ keep: Effect.void, restore: Effect.void })),
        log,
        heartbeat,
      ),
  }
}

/** The plugin loaded in `directory` on the fakes over `host`; answers the update's RPC handlers, if it registered them. */
const load = (host: World, directory: string) =>
  Effect.gen(function* () {
    const registered: Array<UpdateHandlers> = []
    const stand: Host = {
      options,
      location: { directory },
      rpc: {
        register: (definition, handlers) =>
          Effect.sync(() => {
            expect(definition.id).toBe(UPDATE.id)
            registered.push(handlers)
          }),
      },
    }
    yield* plugin(stand, fakes(host))
    return Option.fromNullishOr(registered.at(0))
  })

/** Lets every forked fiber run until it waits on the clock. */
const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true })

/** `body` in a scope, under a test clock at the service's start. */
const scenario = <A>(body: Effect.Effect<A, never, Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(STARTED)
        return yield* body
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  )

/** The `status` RPC's answer. */
const statusOf = (handlers: Option.Option<UpdateHandlers>) =>
  Option.match(handlers, {
    onNone: () => Effect.die(new Error(`not registered: ${UPDATE.id}`)),
    onSome: (each) => each.status(),
  })

describe("the plugin outside the resident location (a service a TUI started)", () => {
  test("asks the service for the resident location once it loaded, and registers no update RPC", () =>
    scenario(
      Effect.gen(function* () {
        const host = world()
        const handlers = yield* load(host, TUI)
        yield* settle
        expect(host.asks).toBe(0)
        yield* TestClock.adjust(RESIDENT_DELAY)
        yield* settle
        expect(host.asks).toBe(1)
        expect(Option.isNone(handlers)).toBe(true)
      }),
    ))

  test("runs the watchdog: checks that stopped for more than two intervals are logged and the resident location asked for again", () =>
    scenario(
      Effect.gen(function* () {
        const host = world()
        yield* load(host, `${TUI}/`)
        yield* TestClock.adjust(RESIDENT_DELAY)
        yield* settle
        for (const _ of [1, 2]) {
          yield* TestClock.adjust(EVERY)
          yield* settle
        }
        expect(host.asks).toBe(2)
        expect(host.lines).toEqual(["watchdog: no update check for 20m 10s (more than 2 intervals); asking the service for its resident location"])
      }),
    ))
})

describe("the plugin in the resident location", () => {
  test("runs the interval checks: one a poll after it loads, then one every interval, and asks for nothing", () =>
    scenario(
      Effect.gen(function* () {
        const host = world()
        yield* load(host, `${RESIDENT}/`)
        yield* settle
        expect(host.lines).toEqual([])
        yield* TestClock.adjust(GATE_POLL)
        yield* settle
        expect(host.lines).toEqual(["check (interval): the origin names no verified target"])
        yield* TestClock.adjust(EVERY)
        yield* TestClock.adjust(GATE_POLL)
        yield* settle
        expect(host.lines).toHaveLength(2)
        expect(host.asks).toBe(0)
      }),
    ))

  test("status answers the last check, not stalled", () =>
    scenario(
      Effect.gen(function* () {
        const host = world()
        const handlers = yield* load(host, RESIDENT)
        expect(yield* statusOf(handlers)).toEqual({ stalled: false })
        yield* TestClock.adjust(GATE_POLL)
        yield* settle
        expect(yield* statusOf(handlers)).toEqual({ lastCheck: iso(STARTED + Duration.toMillis(GATE_POLL)), stalled: false })
      }),
    ))

  test("status answers stalled once no check was stamped for more than two intervals", () =>
    scenario(
      Effect.gen(function* () {
        const host = world({ stamping: false })
        const handlers = yield* load(host, RESIDENT)
        yield* TestClock.adjust(Duration.minutes(21))
        yield* settle
        expect(yield* statusOf(handlers)).toEqual({ stalled: true })
      }),
    ))
})
