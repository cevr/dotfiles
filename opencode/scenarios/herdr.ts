// One turn in which a scripted model runs a shell command, replayed against
// OpenCode with the herdr reporter (cmd/herdr) loaded and the TUI told it runs
// in a herdr pane whose socket is HERDR_FAKE_SOCKET, where the scenario itself
// listens as a fake herdr (mods/herdr/herdr/fake-server.ts).
// After the turn it stops the TUI with SIGTERM, as a supervisor would, and
// waits for herdr to hear the pane released: an event, bounded generously. It
// leaves the release unanswered, so the TUI (which tries a request twice, 500 ms
// each) is still running when the scenario ends and its exit is the driver's
// teardown, not an unexpected one; the driver's own SIGTERM then kills a TUI a
// second later, after the release has landed. Last it prints every request
// herdr heard, as JSON after `herdr heard: ` (tests/herdr.test.ts reads it).
// Run: OPENCODE_DEV=<opencode checkout> HERDR_FAKE_SOCKET=<socket> bunx opencode-drive run scenarios/herdr.ts
import { Console, Effect, Schedule, Schema, Stream } from "effect"
import { Llm, OpenCodeDriver } from "opencode-drive"
import { listen } from "../mods/herdr/herdr/fake-server.ts"

type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const PANE = "wtest:p1"
const ASK = "Run the slow check."
const COMMAND = "sleep 2 && echo checked"
const DONE = "The check passed."
/** How long herdr may take to hear the release after the TUI is told to stop, in 50 ms polls: 15 s. */
const RELEASE_POLLS = 300

const { env, pid: self, kill } = process
const { OPENCODE_DEV, HERDR_FAKE_SOCKET: socket = "herdr.sock" } = env
// Listening before the driver starts the TUI, which reports from its first frame.
const server = listen(socket)
const heard = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Unknown)))

/** A `ps` row: pid, parent pid, command. */
const ROW = /^\s*(\d+)\s+(\d+)\s+(.*)$/gm
/** The TUI the driver started for this run: this process's child that connects to the server (`--server <url>`). */
const tuiPids = Effect.sync(() =>
  [...Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="]).stdout.toString().matchAll(ROW)].flatMap((row) => {
    if (Number(row[2]) !== self || !/ --server /.test(String(row[3]))) return []
    return [Number(row[1])]
  }),
).pipe(Effect.filterOrFail((pids) => pids.length === 1, (pids) => `expected one TUI child of the run, found ${pids.length}`))

export default OpenCodeDriver.use(
  {
    opencode: {
      ...(OPENCODE_DEV ? { dev: OPENCODE_DEV } : {}),
      // The pane the TUI believes it runs in: never a real one.
      env: { HERDR_ENV: "1", HERDR_PANE_ID: PANE, HERDR_SOCKET_PATH: socket },
    },
    config: { autoupdate: false, username: "Demo" },
    tuiConfig: { animations: false, tabs: { mode: "off" }, plugins: [`${process.cwd()}/cmd/herdr`] },
    tui: { viewport: { cols: 100, rows: 30 } },
    project: { git: true },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      if ("failed" in server) return yield* Effect.fail(`the fake herdr could not listen at ${socket}: ${server.failed}`)
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
      const [tui = 0] = yield* tuiPids
      server.answer({ kind: "silent" })
      yield* Effect.sync(() => kill(tui, "SIGTERM"))
      yield* Effect.sync(() => server.received().some((request) => request.method === "pane.release_agent")).pipe(
        Effect.filterOrFail(Boolean, () => `herdr did not hear the pane released within ${RELEASE_POLLS / 20} s of the TUI's SIGTERM`),
        Effect.retry({ schedule: Schedule.spaced("50 millis"), times: RELEASE_POLLS }),
      )
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          if ("failed" in server) return Effect.void
          const received = server.received()
          // A listening socket would keep the scenario's process alive past its end.
          server.stop()
          return Console.log(`herdr heard: ${heard(received)}`)
        }),
      ),
    ),
)
