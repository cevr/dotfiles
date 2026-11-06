// A repeating monitor in real OpenCode, with OpenCode's schedules turned on
// (`experimental.schedules`) and the wake plugin, which takes the schedule
// tools away, on a scripted model:
// - step-tools: the model is asked once, so its request (the tools it was
//   offered) is kept; the schedule tools must not be among them.
// - step-watch: a `repeat: "change"` monitor reads a status file every second.
//   Its first check is the baseline; the scenario rewrites the file twice, and
//   each change wakes the idle session with a short synthetic notice.
// - step-stop: the model cancels the monitor with wake_cancel.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out bunx opencode-drive run scenarios/wake-repeat.ts
//
// It writes, under SCENARIO_OUT, `wake-repeat-requests.json` (each model
// request, with its session), `wake-repeat-transcripts.json`,
// `wake-repeat-commands.json` (the server's command names: `schedule` among
// them shows the schedules flag is on), `wake-repeat-<name>.txt` for the kept
// frames (`set`, `first`, `second`, `stopped`) and `wake-repeat-timeout.txt`
// when a wait times out. The backstop is `off`: a scenario must not register
// OS jobs.
import { Effect, Schedule, Stream } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = resolve(process.env.SCENARIO_OUT ?? "out")
mkdirSync(out, { recursive: true })
const status = `${out}/wake-repeat-status.txt`
writeFileSync(status, "status one\n")

// ── The model ──
type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]
const call = (id: string, name: string, input: ToolInput) => Stream.make(Llm.toolCall({ index: 0, id, name, input }), Llm.finish("tool-calls"))
const say = (text: string) => Stream.make(Llm.text(text), Llm.finish())

const rules: ReadonlyArray<readonly [string, (request: string) => Stream.Stream<Llm.Output>]> = [
  ["step-tools", () => say("Tools noted.")],
  [
    "step-watch",
    () => call("call_monitor_watch", "monitor", { command: `cat ${status}`, intervalSeconds: 1, repeat: "change", timeoutSeconds: 300, note: "WATCH: the status changed" }),
  ],
  ["call_monitor_watch", () => say("Watch set.")],
  ["Note: WATCH", (s) => say(`Saw fire ${/\(fire (\d+)\)/.exec(s.slice(s.lastIndexOf("Note: WATCH") - 400))?.[1] ?? "?"}.`)],
  [
    "step-stop",
    (s) => call("call_stop_watch", "wake_cancel", { id: /Monitor (w[0-9a-z]+) set/.exec(s.slice(s.lastIndexOf("call_monitor_watch")))?.[1] ?? "missing" }),
  ],
  ["call_stop_watch", (s) => say(s.includes("Cancelled w") ? "Watch stopped." : "Watch not stopped.")],
]
const reply = (s: string) => {
  const last = rules.map(([marker, respond]) => ({ at: s.lastIndexOf(marker), respond })).toSorted((left, right) => right.at - left.at)[0]
  return last === undefined || last.at < 0 ? say("Nothing to do.") : last.respond(s)
}

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    config: {
      autoupdate: false,
      username: "Demo",
      experimental: { schedules: true },
      plugins: [{ package: `${root}/cmd/wake`, options: { backstop: "off" } }],
    },
    tuiConfig: { animations: false, tabs: { mode: "off" } },
    tui: { viewport: { cols: 150, rows: 50 } },
    project: { git: true },
  },
  ({ ui, llm, opencode }) =>
    Effect.gen(function* () {
      const requests: Array<{ readonly session: "root" | "title"; readonly at: number; readonly request: string }> = []
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        const title = s.includes("You name conversations")
        requests.push({ session: title ? "title" : "root", at: Date.now(), request: s })
        return title ? say("Repeat fixture") : reply(s)
      })

      type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
      const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => span.text).join("").trimEnd()).join("\n")
      const dump = Effect.gen(function* () {
        writeFileSync(`${out}/wake-repeat-requests.json`, JSON.stringify(requests, null, 2))
        const page = yield* opencode.session.list()
        const transcripts = yield* Effect.forEach(page.data, (session) =>
          opencode.session.context({ sessionID: session.id }).pipe(Effect.map((messages) => ({ id: session.id, parentID: session.parentID, messages }))),
        )
        writeFileSync(`${out}/wake-repeat-transcripts.json`, JSON.stringify(transcripts, null, 2))
        const commands = yield* opencode.command.list()
        writeFileSync(`${out}/wake-repeat-commands.json`, JSON.stringify(commands.data.map((command) => command.name)))
      })
      const until = (ready: (frame: string) => boolean, times = 300) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/wake-repeat-timeout.txt`, text(frame))), Effect.andThen(dump))),
        )
      const keep = (name: string) => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/wake-repeat-${name}.txt`, text(frame))))

      yield* ui.submit("step-tools")
      yield* until((frame) => frame.includes("Tools noted."))

      yield* ui.submit("step-watch")
      yield* until((frame) => frame.includes("Watch set."))
      // Room for the baseline and a few unchanged checks: nothing fires.
      yield* Effect.sleep("3 seconds")
      yield* keep("set")

      writeFileSync(status, "status two\n")
      yield* until((frame) => frame.includes("Saw fire 1."))
      yield* keep("first")

      writeFileSync(status, "status three\n")
      yield* until((frame) => frame.includes("Saw fire 2."))
      // Room for a third fire, were the unchanged output to fire again.
      yield* Effect.sleep("3 seconds")
      yield* keep("second")

      yield* ui.submit("step-stop")
      yield* until((frame) => frame.includes("Watch stopped.") || frame.includes("Watch not stopped."))
      yield* keep("stopped")
      yield* dump
    }),
)
