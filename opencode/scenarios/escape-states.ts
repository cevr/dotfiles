// One Escape on a busy session in each state the owner hit, with the escape
// TUI plugin (cmd/escape) loaded beside Prime, against OpenCode with a
// scripted model. CASE picks the state:
// - `steer`: the model streams; a second prompt sent while it works (a steer,
//   still pending) and then one Escape, then a second Escape;
// - `queue`: the same with the second prompt queued (leader+Enter);
// - `tool`: a shell call runs past the grace; one Escape;
// - `draft`: the model streams past the grace with a half-typed draft in the
//   composer; one Escape;
// - `offline`: the model streams past the grace and the link to the server
//   stalls (the drive's network blackhole); one Escape.
// Run: CASE=steer OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/escape-states.ts
//
// It writes, under SCENARIO_OUT, `<case>-before.txt` (the frame just before
// the Escape), `<case>-after.txt` (2.5 s after it, or 7 s for `offline`) and,
// for `steer` and `queue`, `<case>-again.txt` (2.5 s after a second Escape),
// plus `<case>-tool.txt` with `interrupted` when the shell call was cut.
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
const which = process.env.CASE ?? "steer"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK = "Rename the helper."
const NEXT = "Also update the docs."
const DRAFT = "half a thought"
const PARTIAL = "Working on it"
/** How long the scripted answer stalls after its first words: past every Escape here. */
const STALL = 20_000

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
    network: which === "offline",
    llm: { settlementTimeout: 120_000 },
    project: {
      git: true,
      files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") },
    },
  },
  ({ ui, llm, tools, network }) =>
    Effect.gen(function* () {
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("helper rename"), Llm.finish())
        if (which === "tool" && !s.includes("call_wait"))
          return Stream.make(
            Llm.text(PARTIAL),
            Llm.toolCall({ index: 0, id: "call_wait", name: "shell", input: { command: "sleep 60", description: "Wait" } }),
            Llm.finish("tool-calls"),
          )
        return Stream.make(Llm.text(PARTIAL), Llm.pause(STALL), Llm.text(" and done."), Llm.finish())
      })
      const until = (name: string, ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 150 }),
          Effect.tapError(() =>
            ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.timeout.txt`, text(frame)))),
          ),
        )
      const save = (name: string) =>
        ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${which}-${name}.txt`, text(frame))))
      const at = (start: number, ms: number) => Effect.sleep(Math.max(0, start + ms - Date.now()))

      const shells = which === "tool" ? yield* tools.control("shell") : undefined
      const sent = Date.now()
      yield* ui.submit(ASK)
      yield* until("streaming", (frame) => frame.includes(PARTIAL))
      // Past the 5 s grace, so the first prompt is never taken back.
      yield* at(sent, 6_000)
      const shell = shells === undefined ? undefined : yield* shells.take("call_wait")
      if (which === "steer") yield* ui.submit(NEXT)
      if (which === "queue") {
        yield* ui.type(NEXT)
        yield* ui.press("x", { ctrl: true })
        yield* ui.enter()
      }
      if (which === "draft") yield* ui.type(DRAFT)
      yield* Effect.sleep("1 second")
      if (which === "offline") yield* network.set({ blackhole: true })
      yield* save("before")
      yield* ui.press("escape")
      yield* Effect.sleep(which === "offline" ? "7 seconds" : "2500 millis")
      yield* save("after")
      if (which === "steer" || which === "queue") {
        yield* ui.press("escape")
        yield* Effect.sleep("2500 millis")
        yield* save("again")
      }
      if (shell !== undefined) {
        const cut = yield* shell.awaitInterrupted().pipe(Effect.timeout("3 seconds"), Effect.option)
        writeFileSync(`${out}/${which}-tool.txt`, cut._tag === "Some" ? "interrupted" : "running")
        if (cut._tag === "None") yield* shell.succeed({ output: "done\n", exit: 0 })
      }
      if (which === "offline") yield* network.clear()
      // Let the stalled answer end (if nothing cut it) before the driver checks every model response settled.
      yield* at(sent, STALL + 3_000)
    }),
)
