// Background compaction (the fork's `background_compaction` flag, which
// `bun run daily` turns on) in the Prime look. The first turn ends near the
// simulated model's ceiling (128k window, 108.8k ceiling): a tool step on a
// 20k prompt, then an answer on a 90k one, past the background trigger (the
// ceiling less half the room the cycle started with, 64.4k). As the turn
// ends the host writes the summary in the background and holds it. The next
// prompt's tool step reports 115k, so the step after it is due to compact:
// the automatic compaction swaps the held summary in, with no second summary
// request and no wait, and its row reads as a finished compaction at once.
// Replayed against OpenCode with a scripted model.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-precompute.ts
//
// It writes, under SCENARIO_OUT:
// - `held`: the first turn's end, its summary already written in the background;
// - `swapped`: the second turn's end, after the automatic compaction;
// - `requests.json`: each model request's kind and when it came, and when the second prompt was sent.
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
const NEXT = "Now update the docs."
const DONE = "Docs updated."
/** A summary in OpenCode's template (a heading of its own), which the host checks before it keeps one. */
const SUMMARY = "## Objective\n\nResume from the passing build."

const usage = (prompt: number, output: number) =>
  Llm.raw({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output } })
const shell = (id: string, prompt: number) =>
  Stream.make(
    Llm.toolCall({ index: 0, id, name: "shell", input: { command: "true", description: "Check the build" } }),
    usage(prompt, 20),
    Llm.finish("tool-calls"),
  )

export type Request = { readonly kind: "title" | "summary" | "step"; readonly at: number }
export type Requests = { readonly requests: ReadonlyArray<Request>; readonly next: number }

export default OpenCodeDriver.use(
  {
    opencode: process.env.OPENCODE_DEV ? { dev: process.env.OPENCODE_DEV } : undefined,
    config: { autoupdate: false, username: "Demo", experimental: { background_compaction: true } },
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
      const requests: Request[] = []
      let steps = 0
      let next = 0
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) {
          requests.push({ kind: "title", at: Date.now() })
          return Stream.make(Llm.text("build check"), Llm.finish())
        }
        if (s.includes("summarize the conversation above")) {
          requests.push({ kind: "summary", at: Date.now() })
          return Stream.make(Llm.text(SUMMARY), usage(88_000, 500), Llm.finish())
        }
        requests.push({ kind: "step", at: Date.now() })
        steps += 1
        // A tool step on a small prompt, the answer near the ceiling; then a tool step past it, and the answer on the summary.
        if (steps === 1) return shell("call_build", 20_000)
        if (steps === 2) return Stream.make(Llm.text(ANSWER), usage(90_000, 5), Llm.finish())
        if (steps === 3) return shell("call_docs", 115_000)
        return Stream.make(Llm.text(DONE), usage(3_000, 5), Llm.finish())
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
      const summarized = Effect.suspend(() =>
        requests.some((request) => request.kind === "summary") ? Effect.void : Effect.fail("pending"),
      ).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }))

      yield* ui.submit(ASK)
      yield* until("answered", (frame) => frame.includes(ANSWER))
      yield* summarized
      yield* Effect.sleep("500 millis")
      yield* save("held")
      next = Date.now()
      yield* ui.submit(NEXT)
      yield* until("swapped", (frame) => frame.includes(DONE) && frame.includes("◇ Compacted automatically"))
      yield* Effect.sleep("500 millis")
      yield* save("swapped")
      writeFileSync(`${out}/requests.json`, JSON.stringify({ requests, next } satisfies Requests))
    }),
)
