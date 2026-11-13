// The composer panel's Wakes and Monitors tabs, in the Prime look with the
// wakes plugin: the root sets a 10-minute alarm and a monitor and ends its
// turn; ↓ on the empty prompt opens the host's panel (Subagents first), → moves
// to Wakes, which lists the alarm, Enter shows it whole, ctrl+d cancels it and the tab says it has
// none; → moves to Monitors, which lists the monitor with its last output;
// Escape closes the panel, and the dock counts the monitor and no wake. Then
// ctrl+d cancels the monitor, and with nothing active the dock's count line is
// gone; a second turn sets one alarm alone, and the line is back counting it.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out bunx opencode-drive run scenarios/prime-composer.ts
//
// It writes, under SCENARIO_OUT, `composer-<name>.txt` and `.json` for each
// kept frame (`set`, `panel`, `wakes`, `detail`, `cancelled`, `monitors`, `closed`, `none`, `alarm`), and
// `composer-timeout.txt` when a wait times out. Each frame is kept only once
// it shows what tests/prime-composer.test.ts asserts on it
// (scenarios/prime-composer-frames.ts).
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"
import { alarmShows, CLOSED, closedDock, detailShows, noneShows, panelShows, type PanelFrame } from "./prime-composer-frames.ts"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"

type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]
const call = (id: string, name: string, input: ToolInput) => Stream.make(Llm.toolCall({ index: 0, id, name, input }), Llm.finish("tool-calls"))
const say = (text: string) => Stream.make(Llm.text(text), Llm.finish())

const reply = (s: string) => {
  // The second turn sets one alarm alone, so the dock counts a wake and nothing else.
  if (s.includes("Set one alarm.")) {
    if (!s.includes("call_wake_beta")) return call("call_wake_beta", "wake", { afterSeconds: 900, note: "BETA: look again" })
    return say("Alarm set.")
  }
  if (!s.includes("call_wake_alpha")) return call("call_wake_alpha", "wake", { afterSeconds: 600, note: "ALPHA: check the deploy" })
  if (!s.includes("call_monitor_gamma"))
    return call("call_monitor_gamma", "monitor", { command: "echo still-waiting", intervalSeconds: 1, until: "^READY$", note: "GAMMA: the service is up" })
  return say("Both set.")
}

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    config: { autoupdate: false, username: "Demo", plugins: [{ package: `${root}/cmd/wake`, options: { backstop: "off" } }] },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`],
    },
    tui: { viewport: { cols: 120, rows: 40 } },
    project: { git: true, files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") } },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        return s.includes("You name conversations") ? say("Composer fixture") : reply(s)
      })

      type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
      const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => span.text).join("").trimEnd()).join("\n")
      const until = (ready: (frame: string) => boolean, times = 300) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) && !text(frame).includes("Finishing startup") ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/composer-timeout.txt`, text(frame))))),
        )
      const lines = (frame: string) => frame.split("\n")
      /** Ready to keep `name`: the open panel shows all the test asserts of it. */
      const shows = (name: PanelFrame) => (frame: string) => panelShows(name, lines(frame))
      const keep = (name: string, screenshot = false) =>
        Effect.gen(function* () {
          const { images: _, ...frame } = yield* ui.capture()
          writeFileSync(`${out}/composer-${name}.txt`, text(frame))
          writeFileSync(`${out}/composer-${name}.json`, JSON.stringify(frame))
          if (screenshot) console.log("screenshot:", yield* ui.screenshot(`composer-${name}`))
        })

      yield* ui.submit("Set an alarm and a monitor.")
      yield* until((frame) => frame.includes("Both set.") && frame.includes("1 wake") && frame.includes("1 monitor"))
      yield* keep("set")
      // ↓ on the empty prompt opens the panel on its first tab.
      yield* ui.press("down")
      yield* until(shows("panel"), 50)
      yield* keep("panel", true)
      // → past Shell reaches Wakes. The note shows in the transcript too: the tab's row is what follows it.
      const alarmRow = "ALPHA: check the deploy  wake · once"
      for (let step = 0; step < 6; step++) {
        const frame = text(yield* ui.capture())
        if (frame.includes(alarmRow)) break
        yield* ui.press("right")
        yield* Effect.sleep("150 millis")
      }
      yield* until(shows("wakes"), 50)
      yield* keep("wakes", true)
      // Enter shows the alarm whole; Escape closes that and leaves the tab open.
      yield* ui.press("return")
      yield* until((frame) => detailShows(lines(frame)), 50)
      yield* keep("detail", true)
      yield* ui.press("escape")
      yield* until((frame) => !frame.includes("Repeat: once") && frame.includes(alarmRow), 50)
      yield* ui.press("d", { ctrl: true })
      yield* until(shows("cancelled"), 80)
      yield* keep("cancelled", true)
      yield* ui.press("right")
      yield* until(shows("monitors"), 80)
      yield* keep("monitors", true)
      // Escape closes the panel: the dock is back, counting the monitor and no wake.
      yield* ui.press("escape")
      yield* until((frame) => closedDock(lines(frame)) === CLOSED && !frame.includes("Monitors"), 50)
      yield* keep("closed")
      // Cancel the monitor too: with no subagent, shell, wake or monitor, the dock's count line is gone.
      yield* ui.press("down")
      yield* until((frame) => frame.includes("Wakes") && frame.includes("Monitors"), 50)
      for (let step = 0; step < 8; step++) {
        const frame = text(yield* ui.capture())
        if (frame.includes("echo still-waiting  still-waiting")) break
        yield* ui.press("right")
        yield* Effect.sleep("150 millis")
      }
      yield* until((frame) => frame.includes("echo still-waiting  still-waiting"), 50)
      yield* ui.press("d", { ctrl: true })
      yield* until((frame) => frame.includes("No monitors"), 80)
      yield* ui.press("escape")
      yield* until((frame) => !frame.includes("No monitors") && !frame.includes("Monitors") && noneShows(lines(frame)), 50)
      yield* keep("none")
      // A turn that sets one alarm alone: the line is back, counting the wake.
      yield* ui.submit("Set one alarm.")
      yield* until((frame) => frame.includes("Alarm set.") && alarmShows(lines(frame)))
      yield* keep("alarm")
    }),
)
