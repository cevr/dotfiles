// A worker whose wait ends with no stop notice, in the Prime look with the
// orchestrate plugin: it moves a long `sleep 600` (the proof wait) and a short
// `sleep 6` to the background and ends its turn. While both run its row waits
// and the host's Subagents panel (↓ on an empty prompt) lists it as active,
// waiting. The short shell's notice wakes it; it kills the long one with
// shell({ action: "kill", id }), which sends no notice, and ends its turn. Its row then leaves
// the live rows and the panel lists it no more: the host's shell registry no
// longer runs the shell, notice or not. Replayed against OpenCode with a
// scripted model.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-waiting.ts
//
// It writes, under SCENARIO_OUT:
// - `waiting-rows`: the worker has ended its turn and waits on both shells;
// - `waiting-panel`: the same, with the Subagents panel open;
// - `ended-rows`: it killed the proof wait and ended its turn;
// - `ended-panel`: the same, with the Subagents panel open;
// - `prime-waiting-requests.json`: each model request.
// Each frame is a `.txt` of its text and a `.json` of its styled lines.
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]
const call = (id: string, name: string, input: ToolInput) => Stream.make(Llm.toolCall({ index: 0, id, name, input }), Llm.finish("tool-calls"))
const say = (words: string) => Stream.make(Llm.text(words), Llm.finish())
/** The shell IDs the tool results named, in order. */
const shellIDs = (request: string) => [...new Set([...request.matchAll(/(sh_[A-Za-z0-9]+) · /g)].map((match) => match[1]!))]

const ASK = "Prove it in a background worker."
const BRIEF = "Worker brief P."
const STARTED = "Worker started."
const WAITING = "Waiting for the proof."
const STOPPED = "Stopped the proof wait."
const HEARD = "Root heard the worker stopped."

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    config: {
      autoupdate: false,
      username: "Demo",
      // A Wednesday afternoon, so the Sabbath never stops the worker.
      plugins: [{ package: `${root}/cmd/orchestrate`, options: { now: "2026-11-04T15:00:00Z", log: `${out}/agents.jsonl` } }],
    },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`],
    },
    tui: { viewport: { cols: 120, rows: 40 } },
    project: { git: true, files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") } },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      const requests: Array<string> = []
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        if (s.includes("You name conversations")) return say("proof")
        requests.push(s)
        // A worker's request carries its brief but never the parent's prompt.
        if (s.includes(BRIEF) && !s.includes(ASK)) {
          if (!s.includes("call_long"))
            return call("call_long", "shell", { command: "sleep 600", background: true, description: "Wait for proof DONE" })
          if (!s.includes("call_short")) return call("call_short", "shell", { command: "sleep 6", background: true, description: "Short check" })
          // The short shell's stop notice wakes it: it stops the proof wait, which sends no notice.
          if (!s.includes("<shell id=")) return say(WAITING)
          if (!s.includes("call_kill")) return call("call_kill", "shell", { action: "kill", id: shellIDs(s)[0] ?? "missing" })
          return say(STOPPED)
        }
        if (!s.includes("call_worker"))
          return call("call_worker", "subagent", { description: "Run the proof", prompt: BRIEF, background: true })
        if (s.includes(STOPPED)) return say(HEARD)
        return say(STARTED)
      })
      const dump = Effect.sync(() => writeFileSync(`${out}/prime-waiting-requests.json`, JSON.stringify(requests, null, 2)))
      const until = (name: string, ready: (frame: string) => boolean, times = 400) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) && !text(frame).includes("Finishing startup") ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.timeout.txt`, text(frame))))),
          Effect.tapError(() => dump),
        )
      const save = (name: string) =>
        Effect.gen(function* () {
          const { images: _, ...frame } = yield* ui.capture()
          writeFileSync(`${out}/${name}.txt`, text(frame))
          writeFileSync(`${out}/${name}.json`, JSON.stringify(frame))
          console.log("screenshot:", yield* ui.screenshot(name))
        })
      const row = (frame: string, symbol: string, update: string) =>
        frame.split("\n").some((line) => line.includes(`${symbol} worker gpt  Run the proof  ${update}`))

      yield* ui.submit(ASK)
      // It has said it waits and ended its turn; both shells still run.
      yield* until("waiting-rows", (frame) => frame.includes(STARTED) && row(frame, "◈", WAITING))
      yield* save("waiting-rows")
      yield* ui.press("down")
      yield* until("waiting-panel", (frame) => frame.includes("Waiting") && frame.includes("Run the proof"), 50)
      yield* save("waiting-panel")
      yield* ui.press("escape")
      // The short shell woke it, it killed the proof wait and stopped; the parent heard.
      yield* until("ended-rows", (frame) => frame.includes(HEARD))
      yield* save("ended-rows")
      yield* ui.press("down")
      yield* until("ended-panel", (frame) => frame.includes("No active subagents"), 50)
      yield* save("ended-panel")
      yield* dump
    }),
)
