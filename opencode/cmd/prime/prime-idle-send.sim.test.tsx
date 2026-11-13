// tests/prime-idle-send.test.ts's names on the simulated TUI (sim-tui/), each
// at its first SEEDS seeds: the fork's real TUI in this process with Prime
// loaded by path, in front of the server double, on a virtual clock. Frame by
// frame (every frame drawn, as the real scenario captures them back to back):
// a prompt sent to an idle session never shows as a queued row; it enters the
// transcript as the reader's message, both for a new session's first prompt
// and for a prompt sent after a turn ended. While a turn runs, a steer and a
// prompt sent to the queue still show as rows, and when the runner takes them
// each moves from its row to the transcript without a frame that shows it in
// both. scenarios/prime-idle-send.ts step for step: the slow turn holds 5 s
// of virtual time (its `Llm.pause`) before it ends.
import { Effect, Option } from "effect"
import * as App from "../../sim-tui/app.ts"
import * as Golden from "../../sim-tui/golden.ts"
import { type Model, stall, text } from "../../sim-tui/server.ts"
import { hintRow } from "../../tests/composer.ts"

const FILE = "cmd/prime/prime-idle-send.sim.test.tsx"
/**
 * Seeds this file runs, by sim-tui's measured headroom rule (a file keeps half its 5 s of CPU): every
 * frame of three recordings is captured, about 450–550 ms a seed (10 seeds took 4512 ms at load 44, 5 took 2709 ms at load 31), so 4.
 */
const SEEDS = 4
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime"], width: 106, height: 40 }

App.bootTest(BOOT)

const FIRST = "Check the build."
const SECOND = "Now run the linter."
const SLOW = "Run the slow suite."
const STEER = "Also update the docs."
const LATER = "Afterwards tag the release."
const ANSWER_FIRST = "The build passes."
const ANSWER_SECOND = "The linter is clean."
const ANSWER_SLOW = "The suite passes."
const ANSWER_STEER = "Docs updated."
const ANSWER_LATER = "Release tagged."
/** How long the slow turn stalls: time to send a steer and a queued prompt behind it. */
const SLOW_MS = 5_000
const ROW = /◌ (queued|after the turn) · /

/**
 * The scenario's model, a step at a time: each prompt's answer; the slow turn says `Running` and holds
 * (released after SLOW_MS), and its next step, which takes the steer, answers it.
 */
const model: Model = ({ text: prompt, step }) => {
  if (prompt.includes(SLOW)) return [[text("Running"), stall], [text(ANSWER_STEER)]][step] ?? []
  if (step > 0) return []
  if (prompt.includes(LATER)) return [text(ANSWER_LATER)]
  if (prompt.includes(STEER)) return [text(ANSWER_STEER)]
  if (prompt.includes(SECOND)) return [text(ANSWER_SECOND)]
  return [text(ANSWER_FIRST)]
}

type Frames = Record<"first" | "second" | "busy", ReadonlyArray<ReadonlyArray<string>>>

const played = new Map<number, Frames>()
const scenario = (seed: number) =>
  Option.match(Option.fromUndefinedOr(played.get(seed)), {
    onSome: Effect.succeed,
    onNone: () => play(seed).pipe(Effect.tap((frames) => Effect.sync(() => played.set(seed, frames)))),
  })
const play = (seed: number) =>
  App.seed(BOOT, { key: "prime-idle-send", seed, model, title: () => "checks" }, (tui) =>
    Effect.gen(function* () {
      const has = (shown: string) => (frame: ReadonlyArray<string>) => frame.join("\n").includes(shown)
      const enter = tui.press({ name: "enter" })
      /** Types `prompt`, then records from just before its Enter until `done`. */
      const sent = (prompt: string, done: (frame: ReadonlyArray<string>) => boolean) =>
        tui.type(prompt).pipe(
          Effect.andThen(tui.record(tui.advance(30).pipe(Effect.andThen(enter), Effect.andThen(tui.until(prompt, done, 30_000))))),
          Effect.map(([, frames]) => frames),
        )
      const first = yield* sent(FIRST, has(ANSWER_FIRST))
      yield* tui.advance(1_000)
      const second = yield* sent(SECOND, has(ANSWER_SECOND))
      yield* tui.advance(1_000)
      // A slow turn, then a steer and a prompt to the queue (leader, Ctrl+X, then Enter) behind it.
      yield* tui.type(SLOW)
      yield* enter
      yield* tui.until("running", has("Running"))
      const stalled = tui.elapsed()
      yield* tui.type(STEER)
      const [, busy] = yield* tui.record(
        Effect.gen(function* () {
          yield* tui.advance(30)
          yield* enter
          yield* tui.advance(500)
          yield* tui.type(LATER)
          yield* tui.press({ name: "x", ctrl: true })
          yield* enter
          yield* tui.advance(Math.max(0, stalled + SLOW_MS - tui.elapsed()))
          tui.server.release(tui.sessionID, ` ${ANSWER_SLOW}`)
          yield* tui.until("busy", (frame) => has(ANSWER_LATER)(frame) && !has("◌")(frame), 30_000)
        }),
      )
      return { first, second, busy } satisfies Frames
    }),
  )

/** The rows above Prime's hint line (tests/composer.ts): the transcript, then the queued rows. */
const above = (lines: ReadonlyArray<string>) => {
  return Option.match(Option.liftPredicate(hintRow(lines), (row) => row >= 0), { onNone: () => lines, onSome: (row) => lines.slice(0, row) })
}

/** Whether the frame shows the prompt as a queued row, and as the reader's message in the transcript. */
const where = (frame: ReadonlyArray<string>, prompt: string) => {
  const lines = above(frame)
  return { row: lines.some((line) => ROW.test(line) && line.includes(prompt)), transcript: lines.some((line) => line === ` ┃ ${prompt}`) }
}

/** The queued rows a frame shows, for a readable failure. */
const rows = (frame: ReadonlyArray<string>) => frame.filter((line) => ROW.test(line))

/**
 * The last frame of a recording, held to the real run's (`golden/prime-idle-send/<name>-last.txt`), its
 * status row blank on both sides: the real run stops recording on the first frame that holds the last
 * answer, while the turn's `Executing` row may still show for a frame; the simulated one settles past it.
 */
const golden = (frames: Frames, name: keyof Frames) =>
  Effect.map(Golden.frame("prime-idle-send", `${name}-last`), (expected) => {
    const kept = (lines: ReadonlyArray<string>) => lines.map((line) => line.replace(/^.* Executing · .*$/, ""))
    return Golden.same(kept(frames[name].at(-1) ?? []), kept(expected))
  })

for (const [name, prompt] of [
  ["first", FIRST],
  ["second", SECOND],
] as const)
  seeded(`the ${name} prompt: no queued row in any frame, and in the transcript from its first frame on`, ({ seed, expect }) =>
    Effect.gen(function* () {
      const shown = (yield* scenario(seed))[name]
      expect(yield* golden(yield* scenario(seed), name)).toEqual([])
      expect(shown.length).toBeGreaterThan(1)
      expect(shown.flatMap(rows)).toEqual([])
      const at = shown.findIndex((frame) => where(frame, prompt).transcript)
      expect(at).toBeGreaterThanOrEqual(0)
      // Once it shows, it stays: no frame after drops it.
      expect(shown.slice(at).every((frame) => where(frame, prompt).transcript)).toBe(true)
    }),
  )

seeded("while a turn runs a steer and a queued prompt show as rows, and each moves to the transcript without a frame in both", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    const shown = frames.busy
    expect(yield* golden(frames, "busy")).toEqual([])
    for (const prompt of [STEER, LATER]) {
      const states = shown.map((frame) => where(frame, prompt))
      expect(states.some((state) => state.row)).toBe(true)
      expect(states.filter((state) => state.row && state.transcript)).toEqual([])
      const first = states.findIndex((state) => state.row)
      const entered = states.findIndex((state) => state.transcript)
      expect(entered).toBeGreaterThan(first)
      expect(states.slice(entered).every((state) => state.transcript && !state.row)).toBe(true)
    }
    expect((shown.at(-1) ?? []).join("\n")).not.toMatch(ROW)
  }),
)

App.closeTest()
