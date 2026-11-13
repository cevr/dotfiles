// tests/escape-send.test.ts's names on the simulated TUI (sim-tui/), each at
// its first SEEDS seeds and for both chords the real file runs (Ctrl+Enter,
// and its fallback leader then F): the fork's real TUI in this process with
// Prime and the escape plugin loaded by path, in front of the server double,
// on a virtual clock. The chord interrupts a turn stuck in a shell call and
// sends what waits. scenarios/escape-send.ts step for step: the model calls a
// shell that never ends on its own (the double holds it, as the drive's
// tools.control does); the next turn's answer comes 8 s after it starts.
import { Effect, Option } from "effect"
import * as App from "../../sim-tui/app.ts"
import * as Golden from "../../sim-tui/golden.ts"
import { type Model, shell, stall, text } from "../../sim-tui/server.ts"

const FILE = "cmd/escape/escape-send.sim.test.tsx"
/** Seeds this file runs, per chord: sim-tui's measured headroom rule (a file keeps half its 5 s of CPU). */
const SEEDS = 3
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = {
  file: FILE,
  plugins: ["cmd/prime", "cmd/escape"],
  width: 106,
  height: 40,
  // The shell call its own row, as these frames read it; the default (low) folds a turn's calls into one.
  config: { session: { verbosity: "medium" } },
}

App.bootTest(BOOT)

const ASK = "Run the slow suite."
const LATER = "Then tag the release."
const DRAFT = "Skip the suite, ship it."
const RUNNING = "Running it"
const ANSWER = "Shipped and tagged."
/** How long the answer to the next turn stalls: time for a second chord while it runs, and for the 5 s stop check. */
const ANSWER_MS = 8_000
/** When, after the first press, `checked` is saved: past the stop check, within its toast's 5 s. */
const CHECKED_MS = 6_500
const CHORDS = ["ctrl", "leader"] as const
type Chord = (typeof CHORDS)[number]

/** How many times `needle` occurs in `text`. */
const count = (text: string, needle: string) => text.split(needle).length - 1

interface Played {
  readonly before: string
  readonly checked: string
  readonly after: string
  readonly tool: string
  /** For each model request after the first, the user texts it carries, in order. */
  readonly requests: ReadonlyArray<ReadonlyArray<string>>
  readonly golden: ReadonlyArray<string>
}

const play = (seed: number, chord: Chord) => {
  const requests: Array<ReadonlyArray<string>> = []
  const model: Model = ({ text: prompt, step, users }) => {
    if (prompt === ASK) return [[text(RUNNING), shell({ id: "call_suite", command: "sleep 600", description: "Run the suite" })]][step] ?? []
    if (step > 0) return []
    requests.push(users)
    return [stall]
  }
  return App.seed(BOOT, { key: chord, seed, model, title: () => "slow suite" }, (tui) =>
    Effect.gen(function* () {
      const has = (shown: string) => (frame: ReadonlyArray<string>) => frame.join("\n").includes(shown)
      const shown = () => tui.text().join("\n")
      const press = Effect.gen(function* () {
        if (chord === "leader") {
          yield* tui.press({ name: "x", ctrl: true })
          yield* tui.press({ name: "f" })
        }
        if (chord === "ctrl") yield* tui.press({ name: "enter", ctrl: true })
      })
      yield* tui.type(ASK)
      yield* tui.press({ name: "enter" })
      yield* tui.until("running", has(RUNNING))
      // To the queue: leader (ctrl+x) then Enter.
      yield* tui.type(LATER)
      yield* tui.press({ name: "x", ctrl: true })
      yield* tui.press({ name: "enter" })
      yield* tui.until("queued", has(`◌ after the turn · ${LATER}`))
      yield* tui.type(DRAFT)
      yield* tui.advance(500)
      const before = shown()
      yield* press
      const pressed = tui.elapsed()
      yield* tui.until("cut", () => tui.server.shellExits().includes("killed"), 5_000).pipe(Effect.ignore)
      const tool = ["running", "interrupted"][Number(tui.server.shellExits().includes("killed"))] ?? "running"
      // The next turn runs: a second chord with nothing waiting must not interrupt it.
      yield* tui.until("next", (frame) => has(`┃ ${DRAFT}`)(frame) && !has("◌")(frame))
      const next = tui.elapsed()
      yield* press
      // Past the stop check, the next turn still answering: a toast that the first press did not stop the turn would show.
      yield* tui.advance(Math.max(0, pressed + CHECKED_MS - tui.elapsed()))
      const checked = shown()
      yield* tui.advance(Math.max(0, next + ANSWER_MS - tui.elapsed()))
      tui.server.release(tui.sessionID, ANSWER)
      // Settled: the last prompt answered and no turn running.
      yield* tui.until("after", () => shown().lastIndexOf(ANSWER) > shown().indexOf(`┃ ${DRAFT}`) && !shown().includes("Executing"))
      yield* tui.advance(500)
      const after = shown()
      // Each frame held to the real run's (one run, Ctrl+Enter: the chord changes no frame).
      const golden = yield* Effect.forEach(
        [
          ["before", before],
          ["checked", checked],
          ["after", after],
        ] as const,
        ([name, frame]) => Effect.map(Golden.check("escape-send", name, frame.split("\n")), (lines) => lines.map((line) => `${name} ${line}`)),
      )
      return { before, checked, after, tool, requests, golden: golden.flat() } satisfies Played
    }),
  )
}

/** The scenario at `seed`, for both chords, played once a seed (the four tests read the same runs, as the real file's describe does). */
const played = new Map<number, ReadonlyArray<readonly [Chord, Played]>>()
const scenario = (seed: number) =>
  Option.match(Option.fromUndefinedOr(played.get(seed)), {
    onSome: Effect.succeed,
    onNone: () =>
      Effect.forEach(CHORDS, (chord) => Effect.map(play(seed, chord), (run) => [chord, run] as const)).pipe(Effect.tap((runs) => Effect.sync(() => played.set(seed, runs)))),
  })

seeded("before the press: the shell runs, one prompt is queued, the draft is in the composer and the hint names the key", ({ seed, expect }) =>
  Effect.gen(function* () {
    for (const [chord, { before, golden }] of yield* scenario(seed)) {
      expect({ chord, golden }).toEqual({ chord, golden: [] })
      // The running call's dot pulses.
      expect(before).toMatch(/[●○] Running sleep 600/)
      expect(before).toContain(`◌ after the turn · ${LATER}`)
      expect(before).toContain(` ┃ ${DRAFT}`)
      // The hint stands alone on its line: no standing Ctrl+O hint, and no update notice in the scenario's scratch state.
      expect(before).toMatch(/^ Ctrl\+Enter interrupt and send$/m)
      expect(before).not.toContain("Ctrl+O to")
    }
  }),
)

seeded("the press cuts the shell call, as Escape does, and the turn reads interrupted once", ({ seed, expect }) =>
  Effect.gen(function* () {
    for (const [, { tool, after }] of yield* scenario(seed)) {
      expect(tool).toBe("interrupted")
      expect(after).toContain("● Ran sleep 600 · cancelled")
      expect(count(after, "■ Interrupted")).toBe(1)
    }
  }),
)

seeded("both prompts go out after the interrupt, the queued one first, each once, and the answer comes", ({ seed, expect }) =>
  Effect.gen(function* () {
    for (const [, { after, checked }] of yield* scenario(seed)) {
      const order = [ASK, "■ Interrupted", LATER, DRAFT].map((line) => after.indexOf(line))
      expect(order.every((index) => index >= 0)).toBe(true)
      expect(order).toEqual(order.toSorted((a, b) => a - b))
      for (const prompt of [ASK, LATER, DRAFT]) expect(count(after, `┃ ${prompt}`)).toBe(1)
      // 6.5 s after the press, the next turn still running: the interrupted turn stopped, so no "Still running" toast.
      expect(checked).toContain(`┃ ${DRAFT}`)
      expect(checked).toMatch(/Executing · \d+s/)
      expect(checked).not.toContain("Still running")
      expect(after.lastIndexOf(ANSWER)).toBeGreaterThan(after.indexOf(`┃ ${DRAFT}`))
      // Nothing waits, the composer is empty (the second press typed nothing) and no hint is left.
      expect(after).not.toContain("◌")
      expect(after).toMatch(/^ ┃$/m)
      expect(after).not.toContain("interrupt and send")
    }
  }),
)

seeded("the model is sent each prompt once, the queued one first; the draft in the same request or the turn's next step", ({ seed, expect }) =>
  Effect.gen(function* () {
    for (const [, { requests }] of yield* scenario(seed)) {
      expect(requests.length).toBeGreaterThanOrEqual(1)
      expect(requests.length).toBeLessThanOrEqual(2)
      expect(requests[0]?.slice(0, 2)).toEqual([ASK, LATER])
      expect(requests.at(-1)).toEqual([ASK, LATER, DRAFT])
    }
  }),
)

App.closeTest()
