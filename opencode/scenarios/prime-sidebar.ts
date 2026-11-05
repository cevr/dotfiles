// The live subagent rows step aside while the session's sidebar shows. A
// background worker keeps thinking while the terminal is wide enough for the
// host's auto sidebar, then narrow, then wide again. Replayed against OpenCode
// with a scripted model; the fork's ui.sidebar.visible says which (a host
// without it keeps the rows everywhere).
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-sidebar.ts
//
// It writes, under SCENARIO_OUT:
// - `sidebar-wide`: 160 columns, the sidebar shows, the worker runs;
// - `sidebar-narrow`: 106 columns, no sidebar, the worker's row under the dock;
// - `sidebar-wide-again`: 160 columns again.
// Each frame is a `.txt` of its text and a `.json` of its styled lines.
import { Deferred, Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK = "Fix the money parser with one worker."
const STARTED = "A worker is on it."
const TITLE = "money worker"
const WORKER = { id: "call_fix", description: "Fix money parsing", prompt: "Worker brief.", thought: "Check the money parser first." }
const WIDE = { cols: 160, rows: 40 }
const NARROW = { cols: 106, rows: 40 }

export default OpenCodeDriver.use(
  {
    opencode: process.env.OPENCODE_DEV ? { dev: process.env.OPENCODE_DEV } : undefined,
    config: {
      autoupdate: false,
      username: "Demo",
      // Orchestrate runs the untyped call as its worker role. A Wednesday afternoon, so the Sabbath never stops it.
      plugins: [{ package: `${root}/cmd/orchestrate`, options: { now: "2026-11-04T15:00:00Z", log: `${out}/agents.jsonl` } }],
    },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/mods/prime`],
    },
    tui: { viewport: WIDE },
    project: {
      git: true,
      files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      const end = yield* Deferred.make<void>()
      const hold = Stream.fromEffect(Deferred.await(end)).pipe(Stream.drain)
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text(TITLE), Llm.finish())
        // The worker thinks, then holds until the end, so it runs throughout.
        if (s.includes(WORKER.prompt) && !s.includes(ASK))
          return Stream.make(Llm.reasoning(WORKER.thought)).pipe(
            Stream.concat(hold),
            Stream.concat(Stream.make(Llm.text("Fixed."), Llm.finish())),
          )
        if (s.includes(STARTED)) return Stream.make(Llm.text("Noted."), Llm.finish())
        if (!s.includes(WORKER.id))
          return Stream.make(
            Llm.toolCall({
              index: 0,
              id: WORKER.id,
              name: "subagent",
              input: { description: WORKER.description, prompt: WORKER.prompt, background: true },
            }),
            Llm.finish("tool-calls"),
          )
        return Stream.make(Llm.text(STARTED)).pipe(Stream.concat(hold), Stream.concat(Stream.make(Llm.finish())))
      })
      const until = (name: string, ready: (frame: string) => boolean, times = 300) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
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
      const running = (frame: string) => frame.includes("◆ 1 subagent ")
      const row = (frame: string) => frame.includes(`◆ worker  ${WORKER.description}`)
      // The sidebar titles the session in its own column, right of the transcript.
      const sidebar = (frame: string) => frame.split("\n").some((line) => line.indexOf(TITLE) >= WIDE.cols - 42)

      yield* ui.submit(ASK)
      // Wide: the dock counts the running worker; the sidebar shows, so no row does.
      yield* until("sidebar-wide", (frame) => frame.includes(STARTED) && running(frame) && sidebar(frame))
      // Give the rows' clock a beat to show a row it should not.
      yield* Effect.sleep("1 second")
      yield* save("sidebar-wide")

      yield* ui.resize(NARROW)
      yield* until("sidebar-narrow", (frame) => running(frame) && row(frame) && !sidebar(frame))
      yield* save("sidebar-narrow")

      yield* ui.resize(WIDE)
      yield* until("sidebar-wide-again", (frame) => running(frame) && sidebar(frame))
      yield* Effect.sleep("1 second")
      yield* save("sidebar-wide-again")

      yield* Deferred.succeed(end, undefined)
      yield* until("sidebar-end", (frame) => frame.includes("Noted."))
    }),
)
