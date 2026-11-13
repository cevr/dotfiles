// The fixture boot: the fork's real TUI (`createAppFixture`, from the fork's own
// test folder) in this process, with our TUI plugins loaded by path through the
// host's own loader, on Bun's fake timers, in front of the server double
// (server.ts). This is the one file of sim-tui/ that touches real time.
//
// - One app per test file, booted once (`boot`), reported on its own line with
//   its wall time; a seed gets a fresh double and a fresh session the app
//   navigates to (`seed`), with ids drawn from the seed.
// - Time: Bun's fake timers hold the host's timers and its clock (`setTimeout`,
//   `setInterval`, `Date.now`, `performance.now`); our plugins read the TUI
//   clock (decider/tui-clock.ts), which the harness fills with the same virtual
//   clock and records. A seed starts at `EPOCH`; on its end the fake clock is
//   set back to where the seed runner left it plus the seed's real duration, so
//   the runner (sim/seed.ts, which reads `Date.now` through Effect's Clock)
//   measures wall time, not virtual time.
// - `settle()` waits on events, never on time: no request in flight, every
//   queued event sent and the client given turns to read it, and two renders
//   in a row equal. It counts passes, and fails naming what never came to rest.
import "@opentui/solid/preload"
import "@opencode-tui/test/preload.ts"
import { jest, mock } from "bun:test"
import * as perfHooks from "node:perf_hooks"
import { statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Data, Effect } from "effect"
import { createAppFixture } from "@opencode-tui/test/fixture/app.ts"
import { createFetch } from "@opencode-tui/test/fixture/tui-client.ts"
import * as TuiClock from "../decider/tui-clock.ts"
import { Identifier } from "@opencode/schema/identifier"
import { MockTreeSitterClient } from "@opentui/core/testing"
import * as Server from "./server.ts"
import * as Seed from "../sim/seed.ts"

/** Where every seed's virtual clock starts: 2026-11-04 15:00 UTC, a Wednesday afternoon. */
export const EPOCH = Date.UTC(2026, 10, 4, 15, 0, 0)
/**
 * The name of each TUI file's first test, which boots its app: the boot line and its limit are
 * that test's, so the seeds' budget holds only the seeds (a seeded test run alone boots lazily).
 */
export const BOOT_TEST = "sim-tui: the fork's TUI boots with the file's plugins"

/**
 * A simulated TUI file's runner: sim/seed.ts's, on the file's first `count` seeds. A file whose
 * 20 seeds do not fit the runner's 5 s budget on a loaded host takes the largest count that does
 * (each file's count is in its header); a seed past it passes without running.
 */
export const runner = (file: string, count: number) => {
  const { seeded } = Seed.runner(file)
  return {
    seeded: <E>(name: string, body: (run: Seed.Seeded) => Effect.Effect<void, E>) =>
      seeded(name, (run) => (run.seed > count ? Effect.void : body(run))),
  }
}
/** The first boot's limit on a quiet host. */
export const BOOT_LIMIT_MS = 4_000
/** The 1-minute load under which the boot limit holds. */
export const QUIET_LOAD = 12
/** Render passes `settle` may take before it says what never came to rest. */
const PASSES = 400
/** Real turns given to the client per pass: I/O over the loopback socket and the event stream. */
const TURNS = 1
/** The step `advance` moves time by between settles of I/O. */
const STEP_MS = 100
/** `until`'s step: the real scenarios poll their screen every 100 ms. */
const POLL_MS = 100
/** How long `until` waits by default: the real scenarios' 150 polls of 100 ms. */
const UNTIL_MS = 15_000
/** Time a seed spends back on the lobby before it starts: the timers the seed before left (a refetch, a retry, a 5 s toast) all fire. */
const LOBBY_MS = 6_000
/** The shortest timer the harness never sets, and the virtual time no seed reaches (see `hold`). */
const LONG_MS = 60_000

const ROOT = path.join(import.meta.dir, "..")

export class SimTuiError extends Data.TaggedError("SimTuiError")<{ readonly message: string }> {}

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

export interface BootOptions {
  /** The test file, as `bun test` names it from opencode/. */
  readonly file: string
  /** Our plugins, relative to opencode/, as `bun run daily` names them in the TUI config. */
  readonly plugins: ReadonlyArray<string>
  readonly width: number
  readonly height: number
  /** More of the TUI config (`session.verbosity`). */
  readonly config?: Record<string, unknown>
}

/** A real clock under fake timers: a file's modification time, which no fake timer reaches. */
const scratch = path.join(os.tmpdir(), `sim-tui-clock-${process.pid}`)
const realNow = () => {
  writeFileSync(scratch, "")
  return statSync(scratch).mtimeMs
}

const sleepTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

type Fixture = Awaited<ReturnType<typeof createAppFixture>>

interface Booted {
  readonly fixture: Fixture
  readonly options: BootOptions
  current: Server.Double
  /** The session the app booted on, served by the lobby double: where every seed starts from. */
  readonly lobby: { readonly server: Server.Double; readonly sessionID: string }
  trace: Array<TraceEntry>
  started: number
}

const booted = new Map<string, Promise<Booted>>()

/** The virtual clock our plugins read (decider/tui-clock.ts), on the fake timers, each timer recorded. */
const simClock = (record: (entry: TraceEntry) => void, began: () => number): TuiClock.Clock => ({
  now: () => Date.now(),
  once: (ms, run) => {
    record({ at: Date.now() - began(), kind: "timer", value: `once ${ms}` })
    const timer = setTimeout(run, ms)
    return () => clearTimeout(timer)
  },
  every: (ms, run) => {
    record({ at: Date.now() - began(), kind: "timer", value: `every ${ms}` })
    const timer = setInterval(run, ms)
    return () => clearInterval(timer)
  },
})

const capture = (fixture: Fixture): Frame => ({
  lines: fixture.captureSpans().lines.map((line) => ({
    spans: line.spans.map((span) => ({ text: span.text, fg: String(span.fg), bg: String(span.bg), attributes: span.attributes })),
  })),
})
const styleKey = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => `${span.text}\u0000${span.fg}\u0000${span.bg}\u0000${span.attributes}`).join("\u0001")).join("\n")

const lobbyModel: Server.Model = () => undefined

/**
 * The TUI's client reaches the fixture's server in this process, not over a socket: a request to
 * a loopback host goes straight to the fixture's routes (`createFetch`, the same handler its
 * `Bun.serve` runs), so an answer and an event reach the client in turns of this process, never
 * after real I/O time. Any other host keeps the real fetch.
 */
const routes: { local?: Promise<(request: Request) => Promise<Response>> } = {}
/**
 * Held randomness: `crypto.getRandomValues`, which the fork's ids (client and double alike) draw
 * their random part from, fills from the seed's source, so a seed draws the same ids each run.
 */
const random: { draw: Server.Draw; run: number } = { draw: () => 0, run: 0 }
/** The client's requests to the fixture still open, and whether one ended since the last look. */
const flight = { open: 0, ended: false }
/**
 * The TUI's syntax highlighter is OpenTUI's tree-sitter client, a process-wide singleton that
 * answers from a worker thread in real time, so a frame would hang on the worker's speed. The
 * harness puts OpenTUI's own mock in its place before the boot: every highlight answers empty
 * (plain text, no syntax colors), on the held timers.
 */
const SINGLETONS = Symbol.for("@opentui/core/singleton")
const HIGHLIGHTER = "tree-sitter-client"
/**
 * The DevTools bar (on, as in the real drive's local build) shows the event loop's delay, which
 * Node measures in wall time: the harness's monitor reads none, so the bar's dot stays at rest.
 */
const holdLoopDelay = () =>
  mock.module("node:perf_hooks", () => ({
    ...perfHooks,
    monitorEventLoopDelay: () => ({ enable: () => true, disable: () => true, reset: () => {}, percentile: () => 0 }),
  }))

const holdHighlighter = () => {
  const bag = ((globalThis as { [SINGLETONS]?: Record<string, unknown> })[SINGLETONS] ??= {})
  if (bag[HIGHLIGHTER] instanceof MockTreeSitterClient) return
  const mock = new MockTreeSitterClient({ autoResolveTimeout: 0 })
  mock.setMockResult({ highlights: [] })
  bag[HIGHLIGHTER] = mock
}
/** Whether the client still waits on an answer the double will give without time moving. */
const waiting = (app: Booted) => {
  const ended = flight.ended
  flight.ended = false
  return ended || flight.open - app.current.parked() > 0 || app.current.busy()
}

/**
 * What the harness holds while an app runs, taken once and given back by `shutdown`: the fake
 * timers, the TUI clock, the in-process fetch and the held randomness.
 */
const held: { restore: () => void } = { restore: () => {} }
const hold = (clock: TuiClock.Clock) => {
  jest.useFakeTimers()
  // A timer of a minute or more (the client store's backstop recheck of running sessions) is
  // never set: one app lives through many seeds, so its phase would differ from seed to seed,
  // and no seed runs that long (`seed` fails one that does).
  const fakeTimeout = globalThis.setTimeout
  const fakeClear = globalThis.clearTimeout
  const longs = new WeakSet<object>()
  const timeout = (run: () => void, ms?: number, ...rest: Array<unknown>) => {
    if ((ms ?? 0) < LONG_MS) return fakeTimeout(run, ms, ...rest)
    const never = {}
    longs.add(never)
    return never
  }
  globalThis.setTimeout = Object.assign(timeout, fakeTimeout) as typeof setTimeout
  globalThis.clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => {
    if (typeof id === "object" && id !== null && longs.has(id)) return
    return fakeClear(id)
  }) as typeof clearTimeout
  const unclock = TuiClock.install(clock)
  const real = globalThis.fetch
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"])
  const routed = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init)
    if (!loopback.has(new URL(request.url).hostname) || routes.local === undefined) return real(input, init)
    // The event stream stays open for the app's life; every other answer is read whole here, so a
    // settle waits on it from the call to the last byte, and one pass more for the client to take it.
    if (new URL(request.url).pathname === "/api/event") return routes.local.then((handle) => handle(request))
    flight.open += 1
    return routes.local
      .then((handle) => handle(request))
      .then(async (response) => new Response(await response.arrayBuffer(), response))
      .finally(() => {
        flight.open -= 1
        flight.ended = true
      })
  }
  globalThis.fetch = Object.assign(routed, { preconnect: real.preconnect })
  const fill = <T extends ArrayBufferView | null>(array: T): T => {
    if (array === null) return array
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
    for (let index = 0; index < bytes.length; index++) bytes[index] = random.draw(256)
    // A later run of the same seed in one app changes only the last character of each id: new ids, in the same order.
    if (random.run > 0 && bytes.length > 0) bytes[bytes.length - 1] = ((bytes[bytes.length - 1] ?? 0) + random.run) % 256
    return array
  }
  const realRandom = crypto.getRandomValues.bind(crypto)
  crypto.getRandomValues = fill as typeof crypto.getRandomValues
  held.restore = () => {
    crypto.getRandomValues = realRandom
    globalThis.fetch = real
    routes.local = undefined
    unclock()
    globalThis.setTimeout = fakeTimeout
    globalThis.clearTimeout = fakeClear
    jest.useRealTimers()
    held.restore = () => {}
  }
}

const start = async (options: BootOptions): Promise<Booted> => {
  // The wall time when the fake clock takes over, given back once the boot is done (the seed runner reads it).
  const wall = Date.now()
  const began = realNow()
  const traced: { trace: Array<TraceEntry>; started: number } = { trace: [], started: EPOCH }
  // A file before this one in the process gave its holds back when it closed; a seeded test run alone holds them for good.
  held.restore()
  holdHighlighter()
  holdLoopDelay()
  hold(simClock((entry) => traced.trace.push(entry), () => traced.started))
  jest.setSystemTime(EPOCH)
  const lobby = Server.make({ draw: () => 0, now: () => Date.now(), model: lobbyModel })
  const lobbyID = lobby.session({ title: "lobby" })
  const state = Object.assign(traced, { current: lobby, lobby: { server: lobby, sessionID: lobbyID } })
  const theme = JSON.parse(await Bun.file(path.join(ROOT, "themes/prime.json")).text()) as Record<string, unknown>
  const handler: Server.Handler = (url, request) => state.current.fetch(url, request)
  const local = Promise.withResolvers<(request: Request) => Promise<Response>>()
  routes.local = local.promise
  const fixture = await createAppFixture({
    width: options.width,
    height: options.height,
    // The real drive runs a local build: its header says `vlocal` and its DevTools bar shows.
    version: "local",
    config: {
      animations: false,
      debug: { devtools: true },
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [...options.plugins.map((plugin) => path.join(ROOT, plugin)), path.join(import.meta.dir, "route")],
      ...options.config,
    },
    themes: { prime: theme },
    args: { sessionID: lobbyID },
    fetch: handler,
  })
  const calls = createFetch(handler, fixture.events)
  local.resolve((request) => calls.fetch(request))
  let ready = false
  void fixture.ready.then(() => {
    ready = true
  })
  const app: Booted = Object.assign(state, { fixture, options })
  // Ready, then every plugin loaded: the route plugin, loaded last, has lent its navigate.
  const loaded = () => ready && (globalThis as { [ROUTE]?: unknown })[ROUTE] !== undefined
  for (let pass = 0; pass < PASSES * 25 && !loaded(); pass++) await pump(app)
  if (!loaded()) throw new Error(ready ? "the route plugin (sim-tui/route) never loaded" : "the TUI never said it was ready")
  await settleOn(app)
  const took = realNow() - began
  const load = os.loadavg()[0] ?? 0
  console.log(`sim-tui boot ${options.file}: ${Math.round(took)} ms (load ${load.toFixed(1)}, ${os.cpus().length} cores)`)
  jest.setSystemTime(wall + took)
  if (load < QUIET_LOAD && took > BOOT_LIMIT_MS)
    throw new Error(`${options.file}: the first boot took ${Math.round(took)} ms, past the ${BOOT_LIMIT_MS} ms it has on a quiet host`)
  return app
}

/** One pass: zero-delay timers, the double's queued events, real turns for I/O, one render. */
const pump = async (app: Booted, render = true, timers = true) => {
  // Bun runs a zero-delay timer 1 ms on, and its advance of 0 moves both clocks 1 ms: so a settle
  // runs the due timers on its first pass only, and the wall reading is put back, so neither
  // clock depends on how many passes a settle took.
  if (timers) {
    const at = Date.now()
    jest.advanceTimersByTime(0)
    jest.setSystemTime(at)
  }
  for (const event of app.current.take()) {
    app.fixture.events.emit(event as Parameters<Fixture["events"]["emit"]>[0])
    // The event crosses the stream to the client in turns of its own: the settle gives it a pass more.
    flight.ended = true
  }
  for (let turn = 0; turn < TURNS; turn++) await sleepTurn()
  if (render) await app.fixture.renderOnce()
}

/** The frame the last settle came to rest on: what `text()` and the trace read. */
const rested: { frame: Frame; key: string } = { frame: { lines: [] }, key: "" }

const settleOn = async (app: Booted) => {
  let last = ""
  let same = 0
  for (let pass = 0; pass < PASSES; pass++) {
    await pump(app, true, pass === 0)
    const unserved = app.current.unserved()
    if (unserved.length > 0) throw new Error(`the TUI asked the double for what it does not serve: ${unserved.join(", ")}`)
    const broken = app.current.broken()
    if (broken.length > 0) throw new Error(`the double sent what the fork's schemas refuse: ${broken.join("; ")}`)
    const frame = capture(app.fixture)
    const key = styleKey(frame)
    rested.frame = frame
    rested.key = key
    const busy = waiting(app)
    same = !busy && key === last ? same + 1 : 0
    last = key
    if (same >= 1) return
  }
  throw new Error(
    `never came to rest after ${PASSES} passes: ${app.current.owed()}, the frame ${same > 0 ? "steady" : "still changing"}`,
  )
}

/** Moves virtual time by `ms`, letting I/O finish between steps, then settles. */
const advanceOn = async (app: Booted, ms: number) => {
  let left = ms
  while (left > 0) {
    const step = Math.min(STEP_MS, left)
    jest.advanceTimersByTime(step)
    left -= step
    for (let pass = 0; pass < PASSES && (waiting(app) || pass < 1); pass++) await pump(app, false, false)
  }
  await settleOn(app)
}

/**
 * Stops an app for good: its double answers what it held, and the fake clock goes with every
 * timer the app set (Bun drops pending fake timers when real ones come back), so nothing of it
 * runs again. It is not shut down: the TUI's shutdown prints its epilogue to the test's output
 * and waits on timers of its own; the process ends with the test run.
 */
const close = (app: Booted) => {
  app.current.close()
  held.restore()
  delete (globalThis as { [ROUTE]?: unknown })[ROUTE]
}

/** The name of each TUI file's last test, which closes its app and gives the process its real timers back. */
export const CLOSE_TEST = "sim-tui: the app closes and the process gets its real clock back"

/** Closes the booted app and puts back what the harness held: timers, clock, fetch, randomness. */
export const shutdown = Effect.tryPromise({
  try: async () => {
    for (const [file, before] of booted) {
      booted.delete(file)
      close(await before)
    }
    held.restore()
  },
  catch: (cause) => new SimTuiError({ message: `the app did not close: ${String(cause)}` }),
})

/** The app for `options.file`, booted once per process. */
export const boot = (options: BootOptions) =>
  Effect.tryPromise({
    try: async () => {
      const found = booted.get(options.file)
      if (found !== undefined) return found
      // One app at a time in a process: the app of the file before closes first, so its timers and requests stop.
      for (const [file, before] of booted) {
        booted.delete(file)
        close(await before)
      }
      const next = start(options)
      booted.set(options.file, next)
      return next
    },
    catch: (cause) => new SimTuiError({ message: `${options.file}: the app did not boot: ${String(cause)}` }),
  })

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

const lift = (what: string, run: () => Promise<void>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new SimTuiError({ message: `${what}: ${cause instanceof Error ? cause.message : String(cause)}` }) })

/**
 * A trace with its ids named by first appearance (`ses#0`, `msg#1`, …): two runs of one seed in
 * one app draw different ids (the TUI keeps state by id), so they are compared up to that renaming.
 */
export const canonical = (trace: ReadonlyArray<TraceEntry>) => {
  const names = new Map<string, string>()
  const rename = (text: string) =>
    text.replace(/\b(ses|msg|evt|prt|call|sh|inb)_[0-9A-Za-z]{26}\b/g, (found, prefix: string) => {
      const known = names.get(found)
      if (known !== undefined) return known
      const named = `${prefix}#${names.size}`
      names.set(found, named)
      return named
    })
  return trace.map((entry) => `${entry.at} ${entry.kind} ${rename(entry.value)}`)
}

/** With this variable naming a folder, each seed writes its canonical trace there, under `traceName`. */
export const TRACE_ENV = "SIM_TUI_TRACES"
/** The file a seed's trace is written to: its test file, key and seed, and the run within the seed if not the first. */
export const traceName = (file: string, seed: { readonly key: string; readonly seed: number; readonly run?: number }) =>
  `${file.replaceAll("/", "_")}--${seed.key.replaceAll(/[^A-Za-z0-9]+/g, "-")}--${seed.seed}${seed.run ? `--${seed.run}` : ""}.txt`

/** The wall clock, for a test that proves no trace holds it (the one wall read sim-tui/ lends out). */
export const wallNow = () => realNow()

/** A random source from a seed (mulberry32): the same seed, the same draws. */
export const drawFrom = (seed: number): Server.Draw => {
  let state = seed >>> 0
  return (n) => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
  }
}

/** FNV-1a of `text`, a 32-bit seed. */
const hash = (text: string) => {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193) >>> 0
  return value
}

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

/**
 * Runs `body` on a fresh double and a fresh session in `app`'s TUI, at the
 * virtual epoch; the runner's clock gets back the seed's real duration.
 */
export const seed = <A, E>(options: BootOptions, seedOptions: SeedOptions, body: (tui: Tui) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const app = yield* boot(options)
    const left = Date.now()
    const began = realNow()
    return yield* Effect.gen(function* () {
      // Every seed starts from the same screen: the boot's lobby session on the file's terminal size,
      // whatever the seed before left open; only then do the clock and the trace start.
      yield* lift("back to the lobby", async () => {
        app.current = app.lobby.server
        if (app.fixture.renderer.width !== options.width || app.fixture.renderer.height !== options.height) app.fixture.resize(options.width, options.height)
        navigateTo(app.lobby.sessionID)
        // The timers the seed before left fire here, in one move, on the lobby double.
        jest.advanceTimersByTime(LOBBY_MS)
        await settleOn(app)
      })
      jest.setSystemTime(EPOCH)
      app.started = EPOCH
      app.trace = []
      // Two sources: the ids' random part, and the double's own draws (its scripted choices).
      random.draw = drawFrom(hash(`${options.file} ${seedOptions.key}`) ^ seedOptions.seed)
      random.run = seedOptions.run ?? 0
      const draw = drawFrom(hash(`${seedOptions.key}`) ^ seedOptions.seed)
      // The fork's Identifier keeps the last time it drew at; a seed's first id must not depend on the seed before.
      Identifier.create(false, 0)
      const server = Server.make({ draw, now: () => Date.now(), model: seedOptions.model })
      if (seedOptions.title) server.retitle(seedOptions.title)
      const sessionID = server.session()
      app.current = server
      const record = (entry: TraceEntry) => app.trace.push(entry)
      const frames = () => record({ at: Date.now() - EPOCH, kind: "frame", value: rested.key })
      let seen = 0
      const requests = () => {
        for (const request of server.requests().slice(seen)) record({ at: request.at - EPOCH, kind: "request", value: `${request.method} ${request.path} ${JSON.stringify(request.body ?? "")}` })
        seen = server.requests().length
      }
      const settled = (what: string, run: () => Promise<void>) =>
        lift(what, async () => {
          await run()
          await settleOn(app)
          requests()
          frames()
        })
      const tui: Tui = {
        server,
        sessionID,
        frame: () => rested.frame,
        text: () => textOf(rested.frame),
        settle: settled("settle", async () => {}),
        until: (what, ready, limitMs = UNTIL_MS) =>
          lift(`until ${what}`, async () => {
            await settleOn(app)
            for (let waited = 0; !ready(textOf(rested.frame)); waited += POLL_MS) {
              if (waited >= limitMs) throw new Error(`not within ${limitMs} ms:\n${textOf(rested.frame).join("\n")}`)
              await advanceOn(app, POLL_MS)
            }
            requests()
            frames()
          }),
        advance: (ms) =>
          lift(`advance ${ms}`, async () => {
            await advanceOn(app, ms)
            requests()
            frames()
          }),
        press: (key) => {
          record({ at: Date.now() - EPOCH, kind: "key", value: `${key.ctrl ? "ctrl+" : ""}${key.shift ? "shift+" : ""}${key.name}` })
          return settled(`press ${key.name}`, async () => {
            pressOn(app.fixture, key)
          })
        },
        type: (text) => {
          record({ at: Date.now() - EPOCH, kind: "key", value: `type ${text}` })
          return settled(`type ${text}`, async () => {
            for (const char of text) app.fixture.mockInput.pressKey(char)
          })
        },
        resize: (cols, rows) => settled(`resize ${cols}x${rows}`, async () => app.fixture.resize(cols, rows)),
        navigate: (target) => settled(`navigate ${target}`, async () => navigateTo(target)),
        elapsed: () => Date.now() - EPOCH,
        trace: () => app.trace,
      }
      yield* tui.navigate(sessionID)
      const result = yield* body(tui)
      // The seed ends with nothing of it left open: its parked requests answered, and the client at rest on them.
      yield* lift("the seed's end", async () => {
        if (Date.now() - EPOCH >= LONG_MS) throw new Error(`the seed ran ${Date.now() - EPOCH} ms of virtual time, past the ${LONG_MS} ms a seed has`)
        server.close()
        await settleOn(app)
      })
      return result
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          app.current.close()
          // The isolation check (isolation.test.ts) reads each seed's trace from here.
          const traces = process.env[TRACE_ENV]
          if (traces) writeFileSync(path.join(traces, traceName(options.file, seedOptions)), canonical(app.trace).join("\n"))
          jest.setSystemTime(left + (realNow() - began))
        }),
      ),
    )
  })

const pressOn = (fixture: Fixture, key: Key) => {
  const modifiers = { ctrl: key.ctrl, shift: key.shift }
  if (key.name === "escape") return fixture.mockInput.pressEscape(modifiers)
  if (key.name === "enter") return fixture.mockInput.pressEnter(modifiers)
  if (key.name === "up" || key.name === "down" || key.name === "left" || key.name === "right") return fixture.mockInput.pressArrow(key.name, modifiers)
  return fixture.mockInput.pressKey(key.name, modifiers)
}

/** The route plugin (route/tui.ts) puts its navigate here when the host loads it. */
const navigateTo = (sessionID: string) => {
  const navigate = (globalThis as { [ROUTE]?: (sessionID: string) => void })[ROUTE]
  if (navigate === undefined) throw new Error("the route plugin (sim-tui/route) did not load")
  navigate(sessionID)
}
export const ROUTE = Symbol.for("dotfiles.sim-tui.navigate")
