// The live subagent rows beneath the composer in the Prime look, with the
// orchestrate plugin routing untyped calls to its worker role: two background
// workers think, then one works (a shell command it describes) while the
// other waits (a poll loop that sleeps), and one finishes while the other
// goes on. Replayed against OpenCode with a scripted model.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-rows.ts
//
// It writes, under SCENARIO_OUT:
// - `rows-thinking`: both workers are mid-thought;
// - `rows-shell`: one works on its described shell command, side by side with one waiting on its poll loop;
// - `rows-done`: the first has finished, the second waits;
// - `rows-dropped`: the finished one's row has gone, past its linger.
// Each frame is a `.txt` of its text and a `.json` of its styled lines.
import { Deferred, Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK = "Fix the two failing modules, one worker each."
const STARTED = "Two workers are on it."
// Each worker thinks, runs one shell command, then the first answers and the second waits.
// The first's command works and says what it does; the second's only polls for a file that never comes.
const WORKERS: ReadonlyArray<{
  id: string
  description: string
  thought: string
  prompt: string
  shell: string
  input: Record<string, string>
  finishes: boolean
}> = [
  {
    id: "call_fix_a",
    description: "Fix money parsing",
    thought: "Check the money parser first. Then run the tests.",
    prompt: "Worker brief A.",
    shell: "call_sleep_a",
    input: { command: "sleep 4 && ls", description: "Run the money tests" },
    finishes: true,
  },
  {
    id: "call_fix_b",
    description: "Fix CSV quoting",
    thought: "Check the CSV writer first. Then run the tests.",
    prompt: "Worker brief B.",
    shell: "call_sleep_b",
    input: { command: "for i in 1 2 3 4; do [ -f out/csv.done ] && break; sleep 1; done" },
    finishes: false,
  },
]

export default OpenCodeDriver.use(
  {
    opencode: process.env.OPENCODE_DEV ? { dev: process.env.OPENCODE_DEV } : undefined,
    config: {
      autoupdate: false,
      username: "Demo",
      // A Wednesday afternoon, so the Sabbath never stops the workers; the call log stays in the run's output.
      plugins: [{ package: `${root}/cmd/orchestrate`, options: { now: "2026-11-04T15:00:00Z", log: `${out}/agents.jsonl` } }],
    },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`],
    },
    tui: { viewport: { cols: 106, rows: 40 } },
    project: {
      git: true,
      files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      const think = yield* Deferred.make<void>()
      const end = yield* Deferred.make<void>()
      const hold = (gate: Deferred.Deferred<void>) => Stream.fromEffect(Deferred.await(gate)).pipe(Stream.drain)
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("two workers"), Llm.finish())
        const worker = WORKERS.find((item) => s.includes(item.prompt) && !s.includes(ASK))
        if (worker && !s.includes(worker.shell))
          return Stream.make(Llm.reasoning(worker.thought)).pipe(
            Stream.concat(hold(think)),
            Stream.concat(
              Stream.make(
                Llm.toolCall({ index: 0, id: worker.shell, name: "shell", input: worker.input }),
                Llm.finish("tool-calls"),
              ),
            ),
          )
        if (worker?.finishes) return Stream.make(Llm.text(`${worker.description}: done.`), Llm.finish())
        if (worker) return hold(end).pipe(Stream.concat(Stream.make(Llm.text(`${worker.description}: done.`), Llm.finish())))
        if (s.includes(STARTED)) return Stream.make(Llm.text("Noted."), Llm.finish())
        const next = WORKERS.find((item) => !s.includes(item.id))
        if (next)
          return Stream.make(
            Llm.toolCall({
              index: 0,
              id: next.id,
              name: "subagent",
              input: { description: next.description, prompt: next.prompt, background: true },
            }),
            Llm.finish("tool-calls"),
          )
        return Stream.make(Llm.text(STARTED)).pipe(Stream.concat(hold(end)), Stream.concat(Stream.make(Llm.finish())))
      })
      // Under load the host's startup panel can still sit beneath the rows; a
      // frame is ready only once it has gone.
      const until = (name: string, ready: (frame: string) => boolean, times = 300) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) && !text(frame).includes("Finishing startup") ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times }),
          Effect.tapError(() =>
            ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.timeout.txt`, text(frame)))),
          ),
        )
      const save = (name: string) =>
        Effect.gen(function* () {
          const { images: _, ...frame } = yield* ui.capture()
          writeFileSync(`${out}/${name}.txt`, text(frame))
          writeFileSync(`${out}/${name}.json`, JSON.stringify(frame))
          console.log("screenshot:", yield* ui.screenshot(name))
        })
      const rows = (frame: string, needle: string | RegExp) =>
        frame.split("\n").filter((line) => (typeof needle === "string" ? line.includes(needle) : needle.test(line))).length

      yield* ui.submit(ASK)
      yield* until("rows-thinking", (frame) => frame.includes(STARTED) && rows(frame, /[◇◈◆] worker .+  Check the .+ first\. · \d+s$/) === 2)
      yield* save("rows-thinking")

      yield* Deferred.succeed(think, undefined)
      yield* until(
        "rows-shell",
        (frame) => rows(frame, /[◇◈◆] worker .+  Run the money tests · \d+s$/) === 1 && rows(frame, /◈ worker .+  polling out\/csv\.done · \d+s$/) === 1,
      )
      yield* save("rows-shell")

      yield* until("rows-done", (frame) => rows(frame, /◆ worker .+  2 steps$/) === 1)
      yield* save("rows-done")

      // A finished row lingers for 30 seconds, then drops.
      yield* until("rows-dropped", (frame) => rows(frame, /  2 steps$/) === 0, 450)
      yield* save("rows-dropped")

      yield* Deferred.succeed(end, undefined)
      yield* until("rows-end", (frame) => frame.includes("Noted."))
    }),
)
