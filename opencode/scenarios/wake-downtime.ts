// A wake that comes due while no OpenCode server runs: the root sets a 5 s
// alarm and ends its turn, the server stops, the alarm's time passes by more
// than a minute, and a server starts again. The plugin fires the alarm on start;
// its letter says it went late because no server was running, and the session
// wakes on it. The backstop is `off`, so no OS job fires it meanwhile: this is
// the in-process path on its own.
// Run: OPENCODE_DRIVE_DB=<out>/opencode.db bunx opencode-drive start --name wake-downtime --dev <opencode checkout> --script scenarios/wake-downtime.ts
// (manual launch: the script starts and stops the server itself; SCENARIO_OUT names the output directory).
// OPENCODE_DRIVE_DB must name a file: Drive's default database is in memory, so
// a restarted server would have no session and no wake to fire.
//
// It writes, under SCENARIO_OUT, `wake-downtime-<name>.txt` and `.json` for
// each kept frame (`pending`: the tray before the stop; `late`: the session
// woken after the start), a screenshot of each, `wake-downtime-timeout.txt`
// when a wait times out, `wake-downtime-requests.json` and
// `wake-downtime-transcripts.json`.
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { defineScript, Llm, type Ui } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
/** How long the server stays down: past the alarm, and past the minute after which a fire says it went late. */
const DOWN = "75 seconds"

const say = (text: string) => Stream.make(Llm.text(text), Llm.finish())

export default defineScript({
  launch: "manual",
  config: { autoupdate: false, username: "Demo", plugins: [{ package: `${root}/cmd/wake`, options: { backstop: "off" } }] },
  tuiConfig: {
    animations: false,
    tabs: { mode: "off" },
    theme: { name: "prime", mode: "dark" },
    plugins: [`${root}/mods/prime`, `${root}/cmd/wake`],
  },
  tui: { viewport: { cols: 150, rows: 50 } },
  project: { git: true, files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") } },
  run: ({ server, tuis, llm }) =>
    Effect.gen(function* () {
      const requests: Array<{ readonly at: number; readonly request: string }> = []
      yield* llm.title(() => Effect.succeed("Downtime fixture"))
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        requests.push({ at: Date.now(), request: s })
        if (s.includes("Note: ZETA")) return say(s.includes("no OpenCode server was running") ? "Woke late on zeta." : "Woke on zeta, not late.")
        if (s.includes("call_wake_zeta")) return say("Zeta alarm set.")
        return Stream.make(Llm.toolCall({ index: 0, id: "call_wake_zeta", name: "wake", input: { afterSeconds: 5, note: "ZETA: look again after the outage" } }), Llm.finish("tool-calls"))
      })

      type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
      const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => span.text).join("").trimEnd()).join("\n")
      const until = (ui: Ui, ready: (frame: string) => boolean, times = 300) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times }),
          Effect.tapError(() =>
            ui.capture().pipe(
              Effect.map((frame) => {
                writeFileSync(`${out}/wake-downtime-timeout.txt`, text(frame))
                writeFileSync(`${out}/wake-downtime-requests.json`, JSON.stringify(requests, null, 2))
              }),
            ),
          ),
        )
      const keep = (ui: Ui, name: string) =>
        Effect.gen(function* () {
          const { images: _, ...frame } = yield* ui.capture()
          writeFileSync(`${out}/wake-downtime-${name}.txt`, text(frame))
          writeFileSync(`${out}/wake-downtime-${name}.json`, JSON.stringify(frame))
          console.log("screenshot:", yield* ui.screenshot(`wake-downtime-${name}`))
        })
      const tray = (frame: string) => frame.split("\n").find((line) => line.includes("⏰")) ?? ""

      yield* server.launch()
      const tui = yield* tuis.launch("before")
      yield* tui.ui.submit("downtime-fixture")
      yield* until(tui.ui, (frame) => frame.includes("Zeta alarm set.") && tray(frame).includes("1 wake"))
      yield* keep(tui.ui, "pending")
      yield* tui.close()
      yield* server.kill()
      writeFileSync(`${out}/wake-downtime-stopped.txt`, String(Date.now()))

      yield* Effect.sleep(DOWN)

      const opencode = yield* server.launch()
      writeFileSync(`${out}/wake-downtime-started.txt`, String(Date.now()))
      const after = yield* tuis.launch("after")
      // The new TUI opens on the home screen: open the one session there is
      // (listed under its title, or under the default name if titling lost the race).
      yield* after.ui.submit("/sessions")
      yield* until(after.ui, (frame) => frame.includes("Sessions for") && (frame.includes("Downtime fixture") || frame.includes("New session -")))
      yield* after.ui.press("return")
      yield* until(after.ui, (frame) => frame.includes("Woke late on zeta.") || frame.includes("Woke on zeta, not late."), 600)
      yield* keep(after.ui, "late")

      writeFileSync(`${out}/wake-downtime-requests.json`, JSON.stringify(requests, null, 2))
      const page = yield* opencode.session.list()
      const transcripts = yield* Effect.forEach(page.data, (session) =>
        opencode.session.context({ sessionID: session.id }).pipe(Effect.map((messages) => ({ id: session.id, parentID: session.parentID, title: session.title, messages }))),
      )
      writeFileSync(`${out}/wake-downtime-transcripts.json`, JSON.stringify(transcripts, null, 2))
    }),
})
