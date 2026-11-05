// One turn in which a scripted model runs a shell command, replayed against
// OpenCode with the herdr reporter (cmd/herdr) loaded and the TUI told it runs
// in a herdr pane whose socket is HERDR_FAKE_SOCKET: a fake herdr the caller
// listens on (tests/herdr.test.ts). The scenario only drives the turn; the
// caller reads what herdr received.
// Run: OPENCODE_DEV=<opencode checkout> HERDR_FAKE_SOCKET=<socket> bunx opencode-drive run scenarios/herdr.ts
import { Effect, Schedule, Stream } from "effect"
import { Llm, OpenCodeDriver } from "opencode-drive"

type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const PANE = "wtest:p1"
const ASK = "Run the slow check."
const COMMAND = "sleep 2 && echo checked"
const DONE = "The check passed."

export default OpenCodeDriver.use(
  {
    opencode: {
      ...(process.env.OPENCODE_DEV ? { dev: process.env.OPENCODE_DEV } : {}),
      // The pane the TUI believes it runs in: never a real one.
      env: { HERDR_ENV: "1", HERDR_PANE_ID: PANE, HERDR_SOCKET_PATH: process.env.HERDR_FAKE_SOCKET ?? "" },
    },
    config: { autoupdate: false, username: "Demo" },
    tuiConfig: { animations: false, tabs: { mode: "off" }, plugins: [`${process.cwd()}/cmd/herdr`] },
    tui: { viewport: { cols: 100, rows: 30 } },
    project: { git: true },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("herdr check"), Llm.finish())
        if (s.includes("call_check")) return Stream.make(Llm.text(DONE), Llm.finish())
        return Stream.make(Llm.toolCall({ index: 0, id: "call_check", name: "shell", input: { command: COMMAND } }), Llm.finish("tool-calls"))
      })
      yield* ui.submit(ASK)
      yield* ui.capture().pipe(
        Effect.flatMap((frame) => (text(frame).includes(DONE) ? Effect.void : Effect.fail("pending"))),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
      )
      // Long enough for the idle report and the title.
      yield* Effect.sleep("2 seconds")
    }),
)
