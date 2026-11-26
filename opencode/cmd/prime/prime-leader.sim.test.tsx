// @reads all
// @reads-reason native TUI plugin loader reads at sim-tui/app.ts: createAppFixture({
// The pending leader on Prime's hint line (owner, 2026-11-18: "an indicator … that the leader's active"), on the
// simulated TUI (sim-tui/): the fork's real TUI with Prime loaded by path, on a virtual clock. Ctrl+X shows
// `Ctrl+X …` on the line above the composer, in place of its hint, and no row moves; the line is clear again once
// the chord completes (Ctrl+X T), once Escape cancels it, and once the leader times out.
import { Effect, Option } from "effect"
import * as App from "../../sim-tui/app.ts"
import { type Model, text } from "../../sim-tui/server.ts"
import { composerRow, hintRow } from "../../tests/composer.ts"

const FILE = "cmd/prime/prime-leader.sim.test.tsx"
/** Seeds this file runs: sim-tui's measured headroom rule (a file keeps half its 5 s of CPU). */
const SEEDS = 4
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime"], width: 106, height: 40 }

App.bootTest(BOOT)

const HINT = "Ctrl+X …"
/** The fork's default leader timeout (config `leader.timeout`), and a little past it for the expiry's settle. */
const PAST_TIMEOUT_MS = 2_000 + 200
const model: Model = () => [text("ok")]

type Shot = { readonly hint: string; readonly composer: number; readonly text: string }
const shot = (frame: ReadonlyArray<string>): Shot => ({
  hint: frame[hintRow(frame)] ?? "",
  composer: composerRow(frame),
  text: frame.join("\n"),
})

const play = (seed: number) =>
  App.seed(BOOT, { key: "prime-leader", seed, model, title: () => "leader" }, (tui) =>
    Effect.gen(function* () {
      const shows = (frame: ReadonlyArray<string>) => frame.join("\n").includes(HINT)
      const leader = tui.press({ name: "x", ctrl: true }).pipe(Effect.andThen(tui.until("the pending leader", shows)))
      yield* tui.settle
      const before = shot(tui.text())
      yield* leader
      const pending = shot(tui.text())
      yield* tui.press({ name: "t" })
      yield* tui.until("the chord completed", (frame) => !shows(frame))
      const completed = shot(tui.text())
      yield* tui.press({ name: "escape" })
      yield* tui.settle
      yield* leader
      yield* tui.press({ name: "escape" })
      yield* tui.until("the leader cancelled", (frame) => !shows(frame))
      const cancelled = shot(tui.text())
      yield* leader
      yield* tui.advance(PAST_TIMEOUT_MS)
      yield* tui.settle
      const expired = shot(tui.text())
      return { before, pending, completed, cancelled, expired }
    }),
  )

type Run = Effect.Success<ReturnType<typeof play>>
const played = new Map<number, Run>()
const scenario = (seed: number) =>
  Option.match(Option.fromUndefinedOr(played.get(seed)), {
    onSome: Effect.succeed,
    onNone: () => play(seed).pipe(Effect.tap((run) => Effect.sync(() => played.set(seed, run)))),
  })

seeded("Ctrl+X shows the pending leader on the hint line, and the composer stays where it was", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* scenario(seed)
    expect(run.before.text).not.toContain(HINT)
    expect(run.pending.hint).toContain(HINT)
    expect(run.pending.composer).toBe(run.before.composer)
  }),
)

seeded("the hint clears when the chord completes, when Escape cancels it and when the leader times out", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* scenario(seed)
    expect(run.completed.text).not.toContain(HINT)
    expect(run.cancelled.text).not.toContain(HINT)
    expect(run.expired.text).not.toContain(HINT)
  }),
)

App.closeTest()
