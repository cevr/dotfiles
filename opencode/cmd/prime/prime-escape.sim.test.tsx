// tests/prime-escape.test.ts's names on the simulated TUI (sim-tui/), each at
// 20 seeds: the fork's real TUI in this process with Prime and the escape
// plugin loaded by path, in front of the server double, on a virtual clock. One
// Escape on a busy session with an empty composer: at 1 s it cancels (the
// prompt leaves the transcript and is back in the composer), at 7 s it
// interrupts (the prompt and its partial answer stay); the Dock shows no Escape
// hint. The model streams its first words and stalls, as scenarios/prime-escape.ts's does.
import { Effect } from "effect"
import * as Seed from "../../sim/seed.ts"
import * as App from "../../sim-tui/app.ts"
import * as Golden from "../../sim-tui/golden.ts"
import type { Model } from "../../sim-tui/server.ts"
import { hintRow } from "../../tests/composer.ts"

const FILE = "cmd/prime/prime-escape.sim.test.tsx"
/** Seeds this file runs: 20 fit its 5 s budget (measured at load 26). */
const SEEDS = 20
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime", "cmd/escape"], width: 106, height: 40 }

Seed.effect(App.BOOT_TEST, App.boot(BOOT))

const ASK = "Rename the helper."
const PARTIAL = "Working on it"
const model: Model = () => [{ _tag: "Text", text: PARTIAL }, { _tag: "Stall" }]
const title = () => "helper rename"

/** The rows above the composer (the transcript, down to Prime's hint line) and the composer's first row. */
const split = (frame: ReadonlyArray<string>) => {
  const hint = hintRow(frame)
  return { transcript: frame.slice(0, hint).filter((line) => line.trim() !== ""), composer: frame[hint + 1] ?? "" }
}
/** The Dock's top row: the tray, right above its rule. */
const dock = (frame: ReadonlyArray<string>) => {
  const rule = frame.findLastIndex((line) => /^ ─{20,}$/.test(line))
  return rule >= 1 ? (frame[rule - 1] ?? "") : ""
}

/**
 * The scenario at `seed`, frame by frame (what the real scenario saves, by name), played once a
 * seed: the four tests read the same run, as the real tests read one replay.
 */
const played = new Map<number, Record<string, ReadonlyArray<string>>>()
const scenario = (seed: number) => {
  const done = played.get(seed)
  if (done !== undefined) return Effect.succeed(done)
  return play(seed).pipe(Effect.tap((frames) => Effect.sync(() => played.set(seed, frames))))
}
const play = (seed: number) =>
  App.seed(BOOT, { key: "prime-escape", seed, model, title }, (tui) =>
    Effect.gen(function* () {
      const frames: Record<string, ReadonlyArray<string>> = {}
      const has = (text: string) => (frame: ReadonlyArray<string>) => frame.join("\n").includes(text)
      /** Waits until `ms` after `start`, as the real scenario's `at`. */
      const at = (start: number, ms: number) => tui.advance(Math.max(0, start + ms - tui.elapsed()))
      const first = tui.elapsed()
      yield* tui.type(ASK)
      yield* tui.press({ name: "enter" })
      yield* tui.until("cancel-hint", has(PARTIAL))
      frames["cancel-hint"] = tui.text()
      yield* at(first, 1_000)
      yield* tui.press({ name: "escape" })
      yield* tui.until("cancelled", (frame) => !has(PARTIAL)(frame) && has(ASK)(frame))
      yield* tui.advance(500)
      frames.cancelled = tui.text()
      // Send the restored prompt again; this time wait out the grace.
      const second = tui.elapsed()
      yield* tui.press({ name: "enter" })
      yield* tui.until("resent", has(PARTIAL))
      yield* at(second, 7_000)
      yield* tui.until("interrupt-hint", has(PARTIAL))
      frames["interrupt-hint"] = tui.text()
      yield* tui.press({ name: "escape" })
      yield* tui.until("interrupted", has("Interrupted"))
      yield* tui.advance(500)
      frames.interrupted = tui.text()
      return frames
    }),
  )

seeded("just after sending, the Dock shows no Escape hint", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    expect(Golden.same(frames["cancel-hint"], Golden.frame("prime-escape", "cancel-hint"))).toEqual([])
    expect(dock(frames["cancel-hint"] ?? [])).toMatch(/\S/)
    expect(dock(frames["cancel-hint"] ?? [])).not.toContain("esc ")
  }),
)

seeded("Escape at 1 s: the prompt leaves the transcript and is back in the composer", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    expect(Golden.same(frames.cancelled, Golden.frame("prime-escape", "cancelled"))).toEqual([])
    const { transcript, composer } = split(frames.cancelled ?? [])
    expect(transcript.join("\n")).not.toContain(ASK)
    expect(transcript.join("\n")).not.toContain(PARTIAL)
    expect(composer).toBe(` ┃ ${ASK}`)
    expect(dock(frames.cancelled ?? [])).not.toContain("esc ")
  }),
)

seeded("7 s after sending, the Dock still shows no Escape hint", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    expect(Golden.same(frames["interrupt-hint"], Golden.frame("prime-escape", "interrupt-hint"))).toEqual([])
    expect(dock(frames["interrupt-hint"] ?? [])).not.toContain("esc ")
  }),
)

seeded("Escape at 7 s interrupts: the prompt and its partial answer stay", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    expect(Golden.same(frames.interrupted, Golden.frame("prime-escape", "interrupted"))).toEqual([])
    const { transcript, composer } = split(frames.interrupted ?? [])
    expect(transcript.slice(-3)).toEqual([` ┃ ${ASK}`, `  ${PARTIAL}`, "  ■ Interrupted"])
    expect(composer).toBe(" ┃")
  }),
)

Seed.effect(App.CLOSE_TEST, App.shutdown)
