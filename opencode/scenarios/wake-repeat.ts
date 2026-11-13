// The schedule tools in real OpenCode, with OpenCode's schedules turned on
// (`experimental.schedules`), the built-in schedule plugin off as daily
// writes it (`-opencode.tool.schedule`) and the wake plugin, which also takes
// the schedule tools away, on a scripted model:
// - step-tools: the model is asked once, so its request (the tools it was
//   offered) is kept; the schedule tools must not be among them, nor the
//   `/schedule` command among the server's commands.
// The repeating monitor this scenario also drove (a status file changed
// twice, each change one short notice, then a cancel) runs on the simulated
// host: cmd/wake/wake-repeat.sim.test.ts.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out bunx opencode-drive run scenarios/wake-repeat.ts
//
// It writes, under SCENARIO_OUT, `wake-repeat-requests.json` (each model
// request, with its session), `wake-repeat-transcripts.json`,
// `wake-repeat-commands.json` (the server's command names: `schedule` must
// not be among them) and `wake-repeat-timeout.txt` when a wait times out. The
// backstop is `off`: a scenario must not register OS jobs.
import { Effect, Schedule, Stream } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { Llm, OpenCodeDriver } from "opencode-drive"
import { BUILTIN_SCHEDULE_OFF } from "../scripts/daily.ts"

const root = process.cwd()
const out = resolve(process.env.SCENARIO_OUT ?? "out")
mkdirSync(out, { recursive: true })

// ── The model ──
const say = (text: string) => Stream.make(Llm.text(text), Llm.finish())
const reply = (s: string) => (s.includes("step-tools") ? say("Tools noted.") : say("Nothing to do."))

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    config: {
      autoupdate: false,
      username: "Demo",
      experimental: { schedules: true },
      // As `bun run daily` writes the server config: the wake plugin, and the built-in schedule plugin off.
      plugins: [{ package: `${root}/cmd/wake`, options: { backstop: "off" } }, BUILTIN_SCHEDULE_OFF],
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

      yield* ui.submit("step-tools")
      yield* until((frame) => frame.includes("Tools noted."))
      yield* dump
    }),
)
