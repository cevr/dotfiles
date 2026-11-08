// A prompt sent while an automatic compaction runs, in the Prime look. The
// first step reports a prompt near the simulated model's 128k window and calls
// a tool, so the host compacts before the next step; the scripted summary
// takes a few seconds, and the reader sends two more prompts meanwhile. Until
// the runner takes them, the prompts are not in the transcript and take no
// row there: a queued row each above the composer shows them and the loader
// says `Compacting`. Once the runner takes them, they are in the transcript in
// the order sent, the queued rows are gone and the loader says `Executing`.
// Replayed against OpenCode with a scripted model.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-queued.ts
//
// It writes, under SCENARIO_OUT, a `.txt` of each frame's text, a `.json` of
// its styled lines and a screenshot:
// - `queued`: the compaction runs and the two later prompts wait;
// - `taken`: the runner took them and the model works on them.
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK = "Check the build."
const NEXT = "Also update the docs."
const LAST = "Then bump the version."
const DONE = "Docs updated."
/** A summary in OpenCode's template (a heading of its own), which the host checks before it keeps one. */
const SUMMARY = "## Objective\n\nResume from the build check."
/** How long the scripted summary takes: time to send the later prompts and frame them. */
const SUMMARY_MS = 6_000
/** How long the answer to the second prompt stalls before it ends: time to frame it running. */
const ANSWER_MS = 4_000

const usage = (prompt: number, output: number) =>
  Llm.raw({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output } })

export default OpenCodeDriver.use(
  {
    opencode: process.env.OPENCODE_DEV ? { dev: process.env.OPENCODE_DEV } : undefined,
    config: { autoupdate: false, username: "Demo" },
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
      let called = false
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("build check"), Llm.finish())
        if (s.includes("summarize the conversation above"))
          return Stream.make(Llm.pause(SUMMARY_MS), Llm.text(SUMMARY), usage(1_000, 40), Llm.finish())
        if (s.includes(NEXT)) return Stream.make(Llm.text("Updating"), Llm.pause(ANSWER_MS), Llm.text(` ${DONE}`), usage(2_000, 5), Llm.finish())
        // The first step: a tool call on a context near the window, so the host compacts before the next step.
        if (!called) {
          called = true
          return Stream.make(
            Llm.toolCall({ index: 0, id: "call_build", name: "shell", input: { command: "true", description: "Check the build" } }),
            usage(125_000, 20),
            Llm.finish("tool-calls"),
          )
        }
        return Stream.make(Llm.text("The build passes."), usage(2_000, 5), Llm.finish())
      })
      const until = (name: string, ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
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

      yield* ui.submit(ASK)
      yield* until("compacting", (frame) => frame.includes("Automatic compaction"))
      yield* ui.submit(NEXT)
      // The prompt reached the session's inbox (its queued row, not the composer's draft): the old look draws it at once, this one queues it.
      yield* until("queued-one", (frame) => frame.includes(`◌ queued · ${NEXT}`))
      yield* ui.submit(LAST)
      yield* until("queued", (frame) => frame.includes(`◌ queued · ${LAST}`))
      yield* Effect.sleep("1500 millis")
      yield* save("queued")
      yield* until("taken", (frame) => frame.includes("Updating"))
      yield* Effect.sleep("500 millis")
      yield* save("taken")
      // Let the stalled answer end before the driver checks every model response settled.
      yield* until("done", (frame) => frame.includes(DONE))
    }),
)
