// Ctrl+Enter on a turn stuck in a long shell call, with the escape TUI plugin
// (cmd/escape) loaded beside Prime, against OpenCode with a scripted model.
// The model calls a shell that never ends on its own (the drive holds it);
// the reader sends one prompt to the queue (leader+Enter, `◌ after the
// turn`), types a second in the composer, and presses Ctrl+Enter. The shell
// call is cut, the turn stops, and both prompts go out in the next turn, the
// queued one first, each once (the draft in the same model request, or at
// that turn's next step when its move landed after the turn took the first).
// A second Ctrl+Enter on the new turn, with nothing waiting, does nothing.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/escape-send.ts
//
// It writes, under SCENARIO_OUT:
// - `before.txt`: the frame just before Ctrl+Enter (the shell running, the queued row, the draft, the hint);
// - `checked.txt`: the frame 6.5 s after the first press, the next turn still answering (past the 5 s stop check);
// - `after.txt`: the frame once the next turn answered;
// - `tool.txt`: `interrupted` when the shell call was cut, else `running`;
// - `requests.json`: for each model request after the first, the user texts it carries, in order.
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK = "Run the slow suite."
const LATER = "Then tag the release."
const DRAFT = "Skip the suite, ship it."
const RUNNING = "Running it"
const ANSWER = "Shipped and tagged."
/**
 * How long the answer to the next turn stalls: time for a second Ctrl+Enter
 * while it runs, and for the stop check, STOP_MS (5 s) after the first press,
 * to find the session running that next turn.
 */
const ANSWER_MS = 8_000
/** When, after the first press, `checked.txt` is saved: past the stop check, within its toast's 5 s. */
const CHECKED_MS = 6_500

/** The user texts of a chat-completions request, in order. */
const userTexts = (req: unknown): ReadonlyArray<string> => {
  const messages = (req as { body?: { messages?: ReadonlyArray<{ role: string; content: unknown }> } }).body?.messages ?? []
  return messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content as ReadonlyArray<{ type: string; text?: string }>).map((part) => part.text ?? "").join(""),
    )
}

export default OpenCodeDriver.use(
  {
    opencode: process.env.OPENCODE_DEV ? { dev: process.env.OPENCODE_DEV } : undefined,
    config: { autoupdate: false, username: "Demo" },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`, `${root}/cmd/escape`],
      // The shell call its own row, as these frames read it; the default (low) folds a turn's calls into one.
      session: { verbosity: "medium" },
    },
    tui: { viewport: { cols: 106, rows: 40 } },
    tools: ["shell"],
    llm: { settlementTimeout: 120_000 },
    project: {
      git: true,
      files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") },
    },
  },
  ({ ui, llm, tools }) =>
    Effect.gen(function* () {
      const requests: Array<ReadonlyArray<string>> = []
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("slow suite"), Llm.finish())
        if (!s.includes("call_suite"))
          return Stream.make(
            Llm.text(RUNNING),
            Llm.toolCall({ index: 0, id: "call_suite", name: "shell", input: { command: "sleep 600", description: "Run the suite" } }),
            Llm.finish("tool-calls"),
          )
        requests.push(userTexts(req))
        return Stream.make(Llm.pause(ANSWER_MS), Llm.text(ANSWER), Llm.finish())
      })
      const until = (name: string, ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 200 }),
          Effect.tapError(() =>
            ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.timeout.txt`, text(frame)))),
          ),
        )
      const save = (name: string) => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.txt`, text(frame))))

      // CHORD=leader presses the fallback, leader (ctrl+x) then F, in place of Ctrl+Enter.
      const chord =
        process.env.CHORD === "leader"
          ? ui.press("x", { ctrl: true }).pipe(Effect.andThen(ui.press("f")))
          : ui.press("return", { ctrl: true })
      const shells = yield* tools.control("shell")
      yield* ui.submit(ASK)
      yield* until("running", (frame) => frame.includes(RUNNING))
      const shell = yield* shells.take("call_suite")
      // To the queue: leader (ctrl+x) then Enter.
      yield* ui.type(LATER)
      yield* ui.press("x", { ctrl: true })
      yield* ui.enter()
      yield* until("queued", (frame) => frame.includes(`◌ after the turn · ${LATER}`))
      yield* ui.type(DRAFT)
      yield* Effect.sleep("500 millis")
      yield* save("before")
      yield* chord
      const pressed = Date.now()
      const cut = yield* shell.awaitInterrupted().pipe(Effect.timeout("5 seconds"), Effect.option)
      writeFileSync(`${out}/tool.txt`, cut._tag === "Some" ? "interrupted" : "running")
      if (cut._tag === "None") yield* shell.succeed({ output: "done\n", exit: 0 })
      // The next turn runs: a second Ctrl+Enter with nothing waiting must not interrupt it.
      yield* until("next", (frame) => frame.includes(`┃ ${DRAFT}`) && !frame.includes("◌"))
      yield* chord
      // Past the stop check, the next turn still answering: a toast that the first press did not stop the turn would show.
      yield* Effect.sleep(`${Math.max(0, pressed + CHECKED_MS - Date.now())} millis`)
      yield* save("checked")
      // Settled: the last prompt answered and no turn running.
      yield* until("after", (frame) => frame.lastIndexOf(ANSWER) > frame.indexOf(`┃ ${DRAFT}`) && !frame.includes("Executing"))
      yield* Effect.sleep("500 millis")
      yield* save("after")
      writeFileSync(`${out}/requests.json`, JSON.stringify(requests, null, 2))
    }),
)
