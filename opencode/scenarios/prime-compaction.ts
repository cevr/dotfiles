// A compaction in the Prime look: one line below All
// (`◇ Compacted · 171k → 6k tokens · 1.2s`), and at All (Ctrl+O) the host's
// whole block, its rule and the summary. The reader runs /compact after one
// turn; the scripted model answers the summary request with a 171k prompt
// and a 6k summary. Replayed against OpenCode with a scripted model.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-compaction.ts
//
// It writes, under SCENARIO_OUT:
// - `compaction`: the compacted session, in Details mode;
// - `compaction-all` and `compaction-overview` after each Ctrl+O.
// Each frame is a `.txt` of its text and a `.json` of its styled lines.
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK = "Check the build."
const ANSWER = "The build passes."
/** The summary's last line, the one the All frame shows. */
const SUMMARY_LINE = "Resume from the passing build."
/** A summary in OpenCode's template (a heading of its own), which the host checks before it keeps one. */
const SUMMARY = `## Objective\n\n${SUMMARY_LINE}`

const usage = (prompt: number, output: number) =>
  Llm.raw({
    choices: [],
    usage: { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output },
  })

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
    tui: { viewport: { cols: 106, rows: 48 } },
    project: {
      git: true,
      files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("build check"), Llm.finish())
        if (s.includes("summarize the conversation above"))
          return Stream.make(Llm.pause(1000), Llm.text(SUMMARY), usage(171_000, 6_000), Llm.finish())
        return Stream.make(Llm.text(ANSWER), usage(12_000, 20), Llm.finish())
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
      yield* until("answered", (frame) => frame.includes(ANSWER))
      yield* ui.submit("/compact")
      yield* until("compaction", (frame) => /◇ Compacted · .* · \d/.test(frame))
      yield* Effect.sleep("500 millis")
      yield* save("compaction")
      yield* ui.press("o", { ctrl: true })
      yield* until("compaction-all", (frame) => frame.includes(SUMMARY_LINE))
      yield* save("compaction-all")
      yield* ui.press("o", { ctrl: true })
      yield* Effect.sleep("300 millis")
      yield* save("compaction-overview")
    }),
)
