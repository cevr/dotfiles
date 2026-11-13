// The fixture boot: the fork's real TUI (`createAppFixture`, from the fork's own
// test folder) in this process, with our TUI plugins loaded by path through the
// host's own loader, on Bun's fake timers, in front of the server double
// (server.ts). This is the one file of sim-tui/ that touches real time.
//
// - One app per test file, booted once (`boot`) and reported on its own line
//   with its wall and CPU time; a seed gets a fresh double and a fresh session
//   the app navigates to (`seed`), with ids drawn from the seed. The file's last
//   test (`shutdown`) reports its seeds' wall and CPU time on a line of its own.
// - Time: Bun's fake timers hold the host's timers and its clock (`setTimeout`,
//   `setInterval`, `Date.now`, `performance.now`); our plugins read the TUI
//   clock (decider/tui-clock.ts), which the harness fills with the same virtual
//   clock and records. A seed starts at `EPOCH`; on its end the fake clock is
//   set back to where the seed runner left it plus the seed's real duration, so
//   the runner (sim/seed.ts, which reads the clock through Effect's Clock)
//   measures wall time, not virtual time. Wall time is read from a file's
//   modification time, which no fake timer reaches.
// - `settle` waits on events, never on time: no request in flight, every
//   queued event sent and the client given turns to read it, and two renders
//   in a row equal. It counts passes, and fails naming what never came to rest.
import "@opentui/solid/preload"
import "@opencode-tui/test/preload.ts"
import { jest } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Clock, Config, Console, Data, Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { createAppFixture } from "@opencode-tui/test/fixture/app.ts"
import { createFetch } from "@opencode-tui/test/fixture/tui-client.ts"
import * as TuiClock from "../decider/tui-clock.ts"
import { Identifier } from "@opencode/schema/identifier"
import { MockTreeSitterClient } from "@opentui/core/testing"
import { effectTest } from "./effect-test.ts"
import * as Server from "./server.ts"
import * as Seed from "../sim/seed.ts"
import { router } from "./route/registry.ts"

/** Where every seed's virtual clock starts: 2026-11-04 15:00 UTC, a Wednesday afternoon. */
export const EPOCH = 1_793_804_400_000
/**
 * The name of each TUI file's first test, which boots its app: the boot line and its limit are
 * that test's, so the seeds' budget holds only the seeds (a seeded test run alone boots lazily).
 */
export const BOOT_TEST = "sim-tui: the fork's TUI boots with the file's plugins"
/** The name of each TUI file's last test, which closes its app, reports its seeds and gives the process its real timers back. */
export const CLOSE_TEST = "sim-tui: the app closes and the process gets its real clock back"
/** The boot test's own timeout: a first boot on a loaded host outlasts bun's 5 s default; the boot line holds its limit. */
export const BOOT_TIMEOUT_MS = 120_000
/** The last test closes the app; its finalizers run in no virtual time. */
const CLOSE_TIMEOUT_MS = 30_000

/**
 * A simulated TUI file's runner: sim/seed.ts's, on the file's first `count` seeds. A file whose
 * 20 seeds do not fit the runner's 5 s budget on a loaded host takes the largest count that does
 * (each file's count is in its header); a seed past it passes without running.
 */
export const runner = (file: string, count: number) => {
  const { seeded } = Seed.runner(file)
  return {
    seeded: <E>(name: string, body: (run: Seed.Seeded) => Effect.Effect<void, E>) =>
      seeded(name, (run) => Effect.when(Effect.suspend(() => body(run)), Effect.sync(() => run.seed <= count)).pipe(Effect.asVoid)),
  }
}
/** The first boot's limit on a quiet host. */
export const BOOT_LIMIT_MS = 4_000
/** The 1-minute load under which the boot limit holds. */
export const QUIET_LOAD = 12
/** Render passes `settle` may take before it says what never came to rest. */
const PASSES = 400
/** The step `advance` moves time by between settles of I/O. */
const STEP_MS = 100
/** `until`'s step: the real scenarios poll their screen every 100 ms. */
const POLL_MS = 100
/** How long `until` waits by default: the real scenarios' 150 polls of 100 ms. */
const UNTIL_MS = 15_000
/** Time a seed spends back on the lobby before it starts: the timers the seed before left (a refetch, a retry, a 5 s toast) all fire. */
const LOBBY_MS = 6_000
/** The virtual time no seed reaches, and the shortest timer the harness never lets fire (`capped`). */
const LONG_MS = 60_000

export class SimTuiError extends Data.TaggedError("SimTuiError")<{ readonly message: string }> {}
const fail = (message: string) => Effect.fail(new SimTuiError({ message }))

export interface Span {
  readonly text: string
  readonly fg: string
  readonly bg: string
  readonly attributes: number
}
export interface Frame {
  readonly lines: ReadonlyArray<{ readonly spans: ReadonlyArray<Span> }>
}
/** A frame's text as the scenarios write it: each line's spans joined, trailing spaces cut. */
export const textOf = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => span.text).join("").trimEnd())

export interface TraceEntry {
  readonly at: number
  readonly kind: "frame" | "request" | "key" | "timer"
  readonly value: string
}

/** More of the TUI config: `session.verbosity`. */
export interface TuiConfig {
  readonly session?: { readonly verbosity: "low" | "medium" | "high" }
}

export interface BootOptions {
  /** The test file, as `bun test` names it from opencode/. */
  readonly file: string
  /** Our plugins, relative to opencode/, as `bun run daily` names them in the TUI config. */
  readonly plugins: ReadonlyArray<string>
  readonly width: number
  readonly height: number
  readonly config?: TuiConfig
}

type Fixture = Awaited<ReturnType<typeof createAppFixture>>

interface Booted {
  readonly fixture: Fixture
  readonly options: BootOptions
  current: Server.Double
  /** The session the app booted on, served by the lobby double: where every seed starts from. */
  readonly lobby: { readonly server: Server.Double; readonly sessionID: string }
  trace: Array<TraceEntry>
  /** The seeds' wall and CPU milliseconds, summed, and how many ran. */
  readonly spent: { wall: number; cpu: number; seeds: number }
}

/** What the harness holds for the process: the app, the fixture's routes, the held randomness, the client's open requests, the frame it rested on. */
interface Harness {
  booted: Option.Option<Booted>
  local: Option.Option<(request: Request) => Promise<Response>>
  draw: Server.Draw
  run: number
  open: number
  ended: boolean
  frame: Frame
  key: string
  scratch: Option.Option<string>
  release: () => void
}
const harness: Harness = {
  booted: Option.none(),
  local: Option.none(),
  draw: () => 0,
  run: 0,
  open: 0,
  ended: false,
  frame: { lines: [] },
  key: "",
  scratch: Option.none(),
  release: () => {},
}

/** The wall clock under fake timers: a scratch file's modification time. */
const realNow = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const scratch = yield* Option.match(harness.scratch, {
    onSome: Effect.succeed,
    onNone: () => fs.makeTempDirectory({ prefix: "sim-tui-clock-" }).pipe(Effect.map((dir) => path.join(dir, "now"))),
  })
  harness.scratch = Option.some(scratch)
  yield* fs.writeFileString(scratch, "")
  const info = yield* fs.stat(scratch)
  return Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() })
})

/** The process's CPU time so far, in milliseconds. */
const cpuNow = () => {
  const usage = process.cpuUsage()
  return (usage.user + usage.system) / 1_000
}

/** The 1-minute load average: `/proc/loadavg` on Linux, `sysctl vm.loadavg` on macOS. */
const loadNow = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const text = yield* fs.readFileString("/proc/loadavg").pipe(
    Effect.catch(() => Stream.mkString(spawner.streamString(ChildProcess.make("sysctl", ["-n", "vm.loadavg"], { stdin: "ignore", forceKillAfter: "3 seconds" })))),
  )
  return Number(text.replaceAll(/[{}]/g, " ").trim().split(/\s+/)[0] ?? "0") || 0
}).pipe(Effect.orElseSucceed(() => 0))

/** The virtual clock our plugins read (decider/tui-clock.ts), on the fake timers, each timer it sets recorded. */
const simClock = (record: (entry: TraceEntry) => void, began: () => number): TuiClock.Clock => ({
  now: TuiClock.system.now,
  once: (ms, run) => {
    record({ at: TuiClock.system.now() - began(), kind: "timer", value: `once ${ms}` })
    return TuiClock.system.once(ms, run)
  },
  every: (ms, run) => {
    record({ at: TuiClock.system.now() - began(), kind: "timer", value: `every ${ms}` })
    return TuiClock.system.every(ms, run)
  },
})

/** The DevTools bar's UI status glyph: it reads the host's real event-loop delay, so a frame carries it at rest. */
const STATUS = /^[○●⦿]$/
const UI_LABEL = " UI"
const JOINED = /^[○●⦿] UI$/
const held = (spans: ReadonlyArray<Span>): ReadonlyArray<Span> =>
  spans.map((span, index) => {
    const next = spans[index + 1]
    // One span when the glyph and the label share a style, two when they do not.
    if (JOINED.test(span.text)) return { ...span, text: `○${UI_LABEL}`, fg: "status" }
    if (STATUS.test(span.text) && next?.text === UI_LABEL) return { ...span, text: "○", fg: "status" }
    if (span.text === UI_LABEL && STATUS.test(spans[index - 1]?.text ?? "")) return { ...span, fg: "status" }
    return span
  })

const capture = (fixture: Fixture): Frame => ({
  lines: fixture.captureSpans().lines.map((line) => ({
    spans: held(line.spans.map((span) => ({ text: span.text, fg: String(span.fg), bg: String(span.bg), attributes: span.attributes }))),
  })),
})
const styleKey = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => `${span.text}\u0000${span.fg}\u0000${span.bg}\u0000${span.attributes}`).join("\u0001")).join("\n")

const lobbyModel: Server.Model = () => []

/** The TUI's syntax highlighter (see `hold`), the process-wide singleton OpenTUI keeps under this key. */
const SINGLETONS = Symbol.for("@opentui/core/singleton")
/** OpenTUI's singletons, as far as the harness reads them. */
interface Bag {
  "tree-sitter-client"?: MockTreeSitterClient
}

/** Whether the client still waits on an answer the double will give without time moving. */
const waiting = (app: Booted) => {
  const ended = harness.ended
  harness.ended = false
  return ended || harness.open - app.current.parked() > 0 || app.current.busy()
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * The TUI's client reaches the fixture's server in this process, not over a socket: a request to
 * a loopback host goes straight to the fixture's routes (`createFetch`, the same handler its
 * `Bun.serve` runs), so an answer and an event reach the client in turns of this process, never
 * after real I/O time. Any other host is refused: the TUI under test talks to its server alone.
 */
const routed = (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  const local = harness.local.pipe(Option.filter(() => LOOPBACK.has(url.hostname)))
  if (Option.isNone(local)) return Effect.runPromise(Effect.succeed(new Response(`sim-tui serves loopback only, not ${url.host}`, { status: 502 })))
  // The event stream stays open for the app's life; every other answer is read whole here, so a
  // settle waits on it from the call to the last byte, and one pass more for the client to take it.
  if (url.pathname === "/api/event") return local.value(request)
  harness.open += 1
  return Effect.runPromise(
    Effect.promise(() => local.value(request)).pipe(
      Effect.flatMap((response) => Effect.promise(() => response.arrayBuffer()).pipe(Effect.map((body) => new Response(body, response)))),
      Effect.ensuring(
        Effect.sync(() => {
          harness.open -= 1
          harness.ended = true
        }),
      ),
    ),
  )
}

/** Held randomness: the fork's ids (client and double alike) draw their random part from the seed. */
const fill = <T extends Parameters<Crypto["getRandomValues"]>[0]>(array: T): T => {
  if (!array) return array
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
  for (let index = 0; index < bytes.length; index++) bytes[index] = harness.draw(256)
  // A later run of the same seed in one app changes only the last character of each id: new ids, in the same order.
  const last = bytes.length - 1
  if (harness.run > 0 && last >= 0) bytes[last] = ((bytes[last] ?? 0) + harness.run) % 256
  return array
}

/**
 * Puts `next` in `owner[key]` and returns what puts the one before back: how the harness swaps the
 * two process globals the fork's TUI reads with no seam of its own (`fetch`, `crypto.getRandomValues`).
 */
const replace = <O, K extends keyof O>(owner: O, key: K, next: O[K]) => {
  const before = owner[key]
  owner[key] = next
  return () => {
    owner[key] = before
  }
}
/** As `replace`, with `next` made from the one before it. */
const wrap = <O, K extends keyof O>(owner: O, key: K, make: (before: O[K]) => O[K]) => {
  const before = owner[key]
  owner[key] = make(before)
  return () => {
    owner[key] = before
  }
}

/** Past every seed and every lobby a process runs: where a timer the harness never lets fire is set. */
const NEVER_MS = 2 ** 31 - 1

/**
 * The fake `setTimeout`, with every timer of a minute or more set where it never fires: the client
 * store's backstop recheck of running sessions (once a minute) would land at another moment of
 * each seed, as one app lives through many, and no seed runs that long (`seed` fails one that does).
 */
const capped = (fake: typeof setTimeout): typeof setTimeout =>
  Object.assign((handler: TimerHandler, timeout = 0, ...rest: Array<unknown>) => {
    if (timeout >= LONG_MS) return fake(handler, NEVER_MS, ...rest)
    return fake(handler, timeout, ...rest)
  }, fake)

/**
 * What the harness holds while an app runs, taken once and given back by `release`: the fake
 * timers, the TUI clock, the in-process fetch, the held randomness and the highlighter.
 *
 * - OpenTUI's tree-sitter client answers from a worker thread in real time, so a frame would hang
 *   on the worker's speed: OpenTUI's own mock takes its place, every highlight answering empty.
 */
const hold = (clock: TuiClock.Clock) => {
  const singletons: { [key: symbol]: Bag } = globalThis
  const bag = singletons[SINGLETONS] ?? {}
  singletons[SINGLETONS] = bag
  if (!(bag["tree-sitter-client"] instanceof MockTreeSitterClient)) {
    const mock = new MockTreeSitterClient({ autoResolveTimeout: 0 })
    mock.setMockResult({ highlights: [] })
    bag["tree-sitter-client"] = mock
  }
  jest.useFakeTimers()
  const untimed = wrap(globalThis, "setTimeout", capped)
  const unclock = TuiClock.install(clock)
  const unfetch = replace(globalThis, "fetch", Object.assign(routed, { preconnect: () => {} }))
  const unrandom = replace(crypto, "getRandomValues", fill)
  harness.release = () => {
    unrandom()
    unfetch()
    harness.local = Option.none()
    untimed()
    unclock()
    jest.useRealTimers()
    harness.release = () => {}
  }
}

/** The theme document the real drive installs, read from themes/prime.json. */
const Theme = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))

/** One pass: the due timers (on a settle's first pass), the double's queued events, a real turn for I/O, one render. */
const pump = (app: Booted, render: boolean, timers: boolean) =>
  Effect.gen(function* () {
    // Bun runs a zero-delay timer 1 ms on, and its advance of 0 moves both clocks 1 ms: so a settle
    // runs the due timers on its first pass only, and the wall reading is put back, so neither
    // clock depends on how many passes a settle took.
    if (timers) {
      const at = yield* Clock.currentTimeMillis
      jest.advanceTimersByTime(0)
      jest.setSystemTime(at)
    }
    for (const event of app.current.take()) {
      app.fixture.events.emit(event)
      // The event crosses the stream to the client in turns of its own: the settle gives it a pass more.
      harness.ended = true
    }
    yield* Effect.yieldNow
    if (render) yield* Effect.promise(() => app.fixture.renderOnce())
  })

/** Comes to rest: the double owes nothing, the client waits on nothing, and two renders in a row are equal. */
const settleOn = (app: Booted) =>
  Effect.gen(function* () {
    const last = { key: "", same: 0 }
    for (let pass = 0; pass < PASSES; pass++) {
      yield* pump(app, true, pass === 0)
      const unserved = app.current.unserved()
      if (unserved.length > 0) return yield* fail(`the TUI asked the double for what it does not serve: ${unserved.join(", ")}`)
      const broken = app.current.broken()
      if (broken.length > 0) return yield* fail(`the double sent what the fork's schemas refuse: ${broken.join("; ")}`)
      harness.frame = capture(app.fixture)
      harness.key = styleKey(harness.frame)
      const busy = waiting(app)
      last.same = Number(!busy && harness.key === last.key) * (last.same + 1)
      last.key = harness.key
      if (last.same >= 1) return
    }
    return yield* fail(`never came to rest after ${PASSES} passes: ${app.current.owed()}`)
  })

/** Moves virtual time by `ms`, letting I/O finish between steps, then settles. */
const advanceOn = (app: Booted, ms: number) =>
  Effect.gen(function* () {
    for (let left = ms; left > 0; left -= STEP_MS) {
      jest.advanceTimersByTime(Math.min(STEP_MS, left))
      for (let pass = 0; pass < PASSES && (waiting(app) || pass < 1); pass++) yield* pump(app, false, false)
    }
    yield* settleOn(app)
  })

/**
 * Stops an app for good: its double answers what it held, and the fake clock goes with every
 * timer the app set (Bun drops pending fake timers when real ones come back), so nothing of it
 * runs again. It is not shut down: the TUI's shutdown prints its epilogue to the test's output
 * and waits on timers of its own; the process ends with the test run.
 */
const close = (app: Booted) => {
  app.current.close()
  harness.release()
  harness.booted = Option.none()
  router().navigate = Option.none()
}

/** The router's navigate the route plugin lent (route/registry.ts). */
const navigateTo = (sessionID: string) =>
  Option.match(router().navigate, {
    onNone: () => fail("the route plugin (sim-tui/route) did not load"),
    onSome: (navigate) => Effect.sync(() => navigate(sessionID)),
  })

const start = Effect.fn("SimTui.start")(function* (options: BootOptions) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url))
  // The TUI's plugin runtime refuses, for the rest of the process, any module of an Effect that is not
  // the host's (the root's own, which effect-bun-test runs on): a test file after this one in the
  // process would fail to load it. It is loaded first, while it still can be.
  yield* Effect.promise(() => import("effect-bun-test"))
  // The wall time when the fake clock takes over, given back once the boot is done (the seed runner reads it).
  const wall = yield* Clock.currentTimeMillis
  const began = yield* realNow
  const cpu = cpuNow()
  const theme = yield* fs.readFileString(path.join(root, "themes/prime.json")).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Theme)))
  const traced = { trace: new Array<TraceEntry>(), started: EPOCH }
  // A file before this one in the process gave its holds back when it closed; a seeded test run alone holds them for good.
  harness.release()
  hold(simClock((entry) => traced.trace.push(entry), () => traced.started))
  jest.setSystemTime(EPOCH)
  const lobby = Server.make({ draw: () => 0, now: TuiClock.system.now, model: lobbyModel })
  const lobbyID = lobby.session({ title: "lobby" })
  const current = { server: lobby }
  const handler = (url: URL, request: Request) => current.server.fetch(url, request).then(Option.getOrUndefined)
  const fixture = yield* Effect.tryPromise({
    try: () =>
      createAppFixture({
        width: options.width,
        height: options.height,
        // The real drive runs a local build: its header says `vlocal` and its DevTools bar shows.
        version: "local",
        config: {
          animations: false,
          debug: { devtools: true },
          tabs: { mode: "off" },
          theme: { name: "prime", mode: "dark" },
          plugins: [...options.plugins.map((plugin) => path.join(root, plugin)), path.join(root, "sim-tui/route")],
          ...options.config,
        },
        themes: { prime: theme },
        args: { sessionID: lobbyID },
        fetch: handler,
      }),
    catch: (cause) => new SimTuiError({ message: `the fixture did not start: ${String(cause)}` }),
  })
  const calls = createFetch(handler, fixture.events)
  harness.local = Option.some((request: Request) => calls.fetch(request))
  const ready = { done: false }
  void fixture.ready.then(() => {
    ready.done = true
  })
  const app: Booted = {
    fixture,
    options,
    lobby: { server: lobby, sessionID: lobbyID },
    spent: { wall: 0, cpu: 0, seeds: 0 },
    get trace() {
      return traced.trace
    },
    set trace(entries) {
      traced.trace = entries
    },
    get current() {
      return current.server
    },
    set current(server) {
      current.server = server
    },
  }
  // Ready, then every plugin loaded: the route plugin, loaded last, has lent its navigate.
  for (let pass = 0; pass < PASSES * 25 && !(ready.done && Option.isSome(router().navigate)); pass++) yield* pump(app, true, true)
  if (!ready.done) return yield* fail("the TUI never said it was ready")
  if (Option.isNone(router().navigate)) return yield* fail("the route plugin (sim-tui/route) never loaded")
  yield* settleOn(app)
  const took = (yield* realNow) - began
  const used = cpuNow() - cpu
  const load = yield* loadNow
  yield* Console.log(`sim-tui boot ${options.file}: wall ${Math.round(took)} ms, cpu ${Math.round(used)} ms (load ${load.toFixed(1)}, ${navigator.hardwareConcurrency} cores)`)
  jest.setSystemTime(wall + took)
  if (load < QUIET_LOAD && took > BOOT_LIMIT_MS) return yield* fail(`${options.file}: the first boot took ${Math.round(took)} ms, past the ${BOOT_LIMIT_MS} ms it has on a quiet host`)
  harness.booted = Option.some(app)
  return app
})

/** Closes the booted app, reports its seeds' wall and CPU time, and puts back what the harness held: timers, clock, fetch, randomness. */
export const shutdown = Effect.gen(function* () {
  if (Option.isSome(harness.booted)) {
    const app = harness.booted.value
    const load = yield* loadNow
    const { wall, cpu, seeds } = app.spent
    yield* Console.log(`sim-tui seeds ${app.options.file}: ${seeds} seed runs, wall ${Math.round(wall)} ms, cpu ${Math.round(cpu)} ms (load ${load.toFixed(1)})`)
    close(app)
  }
  harness.release()
}).pipe(Effect.provide(NodeServices.layer))

/** The app for `options.file`, booted once per process: the app of another file closes first, so its timers and requests stop. */
export const boot = (options: BootOptions) =>
  Effect.gen(function* () {
    const found = harness.booted.pipe(Option.filter((app) => app.options.file === options.file))
    if (Option.isSome(found)) return found.value
    Option.map(harness.booted, close)
    return yield* start(options)
  }).pipe(Effect.provide(NodeServices.layer))

export { effectTest } from "./effect-test.ts"
/** A TUI file's first test: it boots the file's app, with the time a first boot takes on a loaded host. */
export const bootTest = (options: BootOptions) => effectTest(BOOT_TEST, boot(options), BOOT_TIMEOUT_MS)
/** A TUI file's last test: it closes the app and reports the seeds. */
export const closeTest = () => effectTest(CLOSE_TEST, shutdown, CLOSE_TIMEOUT_MS)

export interface Key {
  readonly name: string
  readonly ctrl?: boolean
  readonly shift?: boolean
}

/** One seed's view of the app: its double, its session, its keys and its clock. */
export interface Tui {
  readonly server: Server.Double
  /** The root session the seed opened. */
  readonly sessionID: string
  readonly frame: () => Frame
  readonly text: () => ReadonlyArray<string>
  readonly settle: Effect.Effect<void, SimTuiError>
  readonly advance: (ms: number) => Effect.Effect<void, SimTuiError>
  /**
   * Moves virtual time 100 ms at a time until the frame's text satisfies `ready`, as a
   * real scenario polls its screen; fails naming `what` past `limitMs`.
   */
  readonly until: (what: string, ready: (text: ReadonlyArray<string>) => boolean, limitMs?: number) => Effect.Effect<void, SimTuiError>
  readonly press: (key: Key) => Effect.Effect<void, SimTuiError>
  readonly type: (text: string) => Effect.Effect<void, SimTuiError>
  readonly resize: (cols: number, rows: number) => Effect.Effect<void, SimTuiError>
  readonly navigate: (sessionID: string) => Effect.Effect<void, SimTuiError>
  /** Virtual milliseconds since the seed began. */
  readonly elapsed: () => number
  readonly trace: () => ReadonlyArray<TraceEntry>
}

const ID = /\b(ses|msg|evt|prt|call|sh|inb)_[0-9A-Za-z]{26}\b/g

/**
 * A trace with its ids named by first appearance (`ses#0`, `msg#1`, …): two runs of one seed in
 * one app draw different ids (the TUI keeps state by id), so they are compared up to that renaming.
 */
export const canonical = (trace: ReadonlyArray<TraceEntry>) => {
  const names = new Map<string, string>()
  const rename = (text: string) =>
    text.replace(ID, (found, prefix: string) => {
      const named = names.get(found) ?? `${prefix}#${names.size}`
      names.set(found, named)
      return named
    })
  return trace.map((entry) => `${entry.at} ${entry.kind} ${rename(entry.value)}`)
}

/** With this variable naming a folder, each seed writes its canonical trace there, under `traceName`. */
export const TRACE_ENV = "SIM_TUI_TRACES"
/** The file a seed's trace is written to: its test file, key and seed, and the run within the seed if not the first. */
export const traceName = (file: string, seed: { readonly key: string; readonly seed: number; readonly run?: number }) =>
  [file.replaceAll("/", "_"), seed.key.replaceAll(/[^A-Za-z0-9]+/g, "-"), String(seed.seed), ...[`${seed.run ?? 0}`].filter((run) => run !== "0")].join("--") + ".txt"

/** The wall clock, for a test that proves no trace holds it (the one wall read sim-tui/ lends out). */
export const wallNow = realNow.pipe(Effect.provide(NodeServices.layer))

/** A random source from a seed (mulberry32): the same seed, the same draws. */
export const drawFrom = (seed: number): Server.Draw => {
  const state = { value: seed >>> 0 }
  return (n) => {
    state.value = (state.value + 0x6d2b79f5) >>> 0
    const t = Math.imul(state.value ^ (state.value >>> 15), state.value | 1)
    const u = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))
    return Math.floor((((u ^ (u >>> 14)) >>> 0) / 4294967296) * n)
  }
}

/** FNV-1a of `text`, a 32-bit seed. */
const hash = (text: string) => Array.from(text).reduce((value, char) => Math.imul(value ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0, 0x811c9dc5)

export interface SeedOptions {
  /**
   * What the seed plays (a scenario, a case): with the seed, it picks the random source, so two
   * runs in one app draw different ids (the TUI keeps drafts and messages by id across sessions)
   * while a run alone draws the same ones it draws in the full file.
   */
  readonly key: string
  readonly seed: number
  /** Which run of the same key and seed in one app (0 by default): it changes the ids only. */
  readonly run?: number
  readonly model: Server.Model
  /** The seed's root session: its title, if the scenario's model named it before the TUI showed it. */
  readonly title?: (text: string) => string
}

const pressOn = (fixture: Fixture, key: Key) => {
  const modifiers = { ctrl: key.ctrl, shift: key.shift }
  if (key.name === "escape") return fixture.mockInput.pressEscape(modifiers)
  if (key.name === "enter") return fixture.mockInput.pressEnter(modifiers)
  if (key.name === "up" || key.name === "down" || key.name === "left" || key.name === "right") return fixture.mockInput.pressArrow(key.name, modifiers)
  return fixture.mockInput.pressKey(key.name, modifiers)
}

/** A key as the trace names it. */
const keyName = (key: Key) => [...[key.ctrl && "ctrl", key.shift && "shift"].filter(Boolean), key.name].join("+")

/** A seed's start: back on the lobby session at the file's size, whatever the seed before left open, the timers it left fired there. */
const lobbyOn = (app: Booted) =>
  Effect.gen(function* () {
    app.current = app.lobby.server
    const { width, height } = app.options
    if (app.fixture.renderer.width !== width || app.fixture.renderer.height !== height) app.fixture.resize(width, height)
    yield* navigateTo(app.lobby.sessionID)
    jest.advanceTimersByTime(LOBBY_MS)
    yield* settleOn(app)
  })

/**
 * Runs `body` on a fresh double and a fresh session in `app`'s TUI, at the
 * virtual epoch; the runner's clock gets back the seed's real duration.
 */
export const seed = <A, E>(options: BootOptions, seedOptions: SeedOptions, body: (tui: Tui) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const app = yield* boot(options)
    const left = yield* Clock.currentTimeMillis
    const began = yield* realNow
    const cpu = cpuNow()
    const traces = yield* Config.option(Config.String(TRACE_ENV))
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const ended = Effect.gen(function* () {
      app.current.close()
      // The isolation check (isolation.test.ts) reads each seed's trace from here.
      if (Option.isSome(traces)) yield* fs.writeFileString(path.join(traces.value, traceName(options.file, seedOptions)), canonical(app.trace).join("\n"))
      const took = (yield* realNow) - began
      app.spent.wall += took
      app.spent.cpu += cpuNow() - cpu
      app.spent.seeds += 1
      jest.setSystemTime(left + took)
    }).pipe(Effect.orDie)
    return yield* Effect.gen(function* () {
      yield* lobbyOn(app)
      // Only now do the clock and the trace start.
      jest.setSystemTime(EPOCH)
      app.trace = []
      // Two sources: the ids' random part, and the double's own draws (its scripted choices).
      harness.draw = drawFrom(hash(`${options.file} ${seedOptions.key}`) ^ seedOptions.seed)
      harness.run = seedOptions.run ?? 0
      const draw = drawFrom(hash(`${seedOptions.key}`) ^ seedOptions.seed)
      // The fork's Identifier keeps the last time it drew at; a seed's first id must not depend on the seed before.
      Identifier.create(false, 0)
      const server = Server.make({ draw, now: TuiClock.system.now, model: seedOptions.model })
      Option.map(Option.fromUndefinedOr(seedOptions.title), server.retitle)
      const sessionID = server.session()
      app.current = server
      const record = (entry: TraceEntry) => app.trace.push(entry)
      const since = () => TuiClock.system.now() - EPOCH
      const seen = { requests: 0 }
      const observe = Effect.sync(() => {
        for (const request of server.requests().slice(seen.requests)) record({ at: request.at - EPOCH, kind: "request", value: `${request.method} ${request.path} ${request.body}` })
        seen.requests = server.requests().length
        record({ at: since(), kind: "frame", value: harness.key })
      })
      const settled = <R>(run: Effect.Effect<void, SimTuiError, R>) => run.pipe(Effect.andThen(settleOn(app)), Effect.andThen(observe))
      const tui: Tui = {
        server,
        sessionID,
        frame: () => harness.frame,
        text: () => textOf(harness.frame),
        settle: settled(Effect.void),
        until: (what, ready, limitMs = UNTIL_MS) =>
          Effect.gen(function* () {
            yield* settleOn(app)
            for (let waited = 0; !ready(textOf(harness.frame)); waited += POLL_MS) {
              if (waited >= limitMs) return yield* fail(`until ${what}: not within ${limitMs} ms:\n${textOf(harness.frame).join("\n")}`)
              yield* advanceOn(app, POLL_MS)
            }
            yield* observe
          }),
        advance: (ms) => advanceOn(app, ms).pipe(Effect.andThen(observe)),
        press: (key) =>
          Effect.sync(() => record({ at: since(), kind: "key", value: keyName(key) })).pipe(
            Effect.andThen(settled(Effect.sync(() => pressOn(app.fixture, key)))),
          ),
        type: (text) =>
          Effect.sync(() => record({ at: since(), kind: "key", value: `type ${text}` })).pipe(
            Effect.andThen(settled(Effect.sync(() => Array.from(text, (char) => app.fixture.mockInput.pressKey(char))))),
          ),
        resize: (cols, rows) => settled(Effect.sync(() => app.fixture.resize(cols, rows))),
        navigate: (target) => settled(navigateTo(target)),
        elapsed: since,
        trace: () => app.trace,
      }
      yield* tui.navigate(sessionID)
      const result = yield* body(tui)
      // The seed ends with nothing of it left open: its parked requests answered, and the client at rest on them.
      if (since() >= LONG_MS) return yield* fail(`the seed ran ${since()} ms of virtual time, past the ${LONG_MS} ms a seed has`)
      server.close()
      yield* settleOn(app)
      return result
    }).pipe(Effect.ensuring(ended))
  }).pipe(Effect.provide(NodeServices.layer))
