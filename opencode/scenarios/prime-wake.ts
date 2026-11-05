// A worker that waits on its own background shell command, in the Prime look
// with the orchestrate plugin: it moves a three-second `sleep 3` to the
// background and ends its turn, the shell's stop notice wakes it, and only
// the answer it writes then reaches the parent. Once as a background worker
// (its answer comes back as the parent's stop notice), once in the
// foreground (as the subagent call's result). Replayed against OpenCode with
// a scripted model.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-wake.ts
//
// The parent's model says which answer it got: `Root heard: …` for the one
// written after the shell, `Root heard too early.` for the one the worker
// wrote before it, while it still waited.
//
// It writes, under SCENARIO_OUT:
// - `wake-bg-waiting`: the background worker has ended its turn and waits on its shell;
// - `wake-bg-done`: its answer has reached the parent;
// - `wake-fg-waiting`, `wake-fg-done`: the same for the foreground worker.
// Each frame is a `.txt` of its text and a `.json` of its styled lines.
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK = "Run the slow check in a background worker."
const AGAIN = "Now run it once more in the foreground."
const STARTED = "Worker started."
const WAITING = "Waiting for the check."
const TOO_EARLY = "Root heard too early."
// Each worker moves `sleep 3` to the background, ends its turn, and answers once its shell's notice wakes it.
const WORKERS = {
  background: {
    id: "call_bg",
    description: "Run the slow check",
    prompt: "Worker brief B.",
    shell: "call_sleep_b",
    answer: "Background check passed after its shell.",
    heard: "Root heard: the background check passed.",
  },
  foreground: {
    id: "call_fg",
    description: "Check it in the foreground",
    prompt: "Worker brief F.",
    shell: "call_sleep_f",
    answer: "Foreground check passed after its shell.",
    heard: "Root heard: the foreground check passed.",
  },
}
type Worker = (typeof WORKERS)[keyof typeof WORKERS]

const finish = (words: string) => Stream.make(Llm.text(words), Llm.finish())

/** A worker's next step: start its shell, then wait, then answer once the shell's notice is in. */
const work = (worker: Worker, request: string) => {
  if (!request.includes(worker.shell))
    return Stream.make(
      Llm.toolCall({ index: 0, id: worker.shell, name: "shell", input: { command: "sleep 3", background: true } }),
      Llm.finish("tool-calls"),
    )
  // The shell's stop notice: `<shell id="…" state="completed" command="sleep 3">`.
  if (request.includes("<shell id=")) return finish(worker.answer)
  return finish(WAITING)
}

/** The parent's next step for one worker: start it, then say which answer it got. */
const lead = (worker: Worker, request: string, input: Record<string, unknown>, started: string) => {
  if (!request.includes(worker.id))
    return Stream.make(
      Llm.toolCall({ index: 0, id: worker.id, name: "subagent", input: { description: worker.description, prompt: worker.prompt, ...input } }),
      Llm.finish("tool-calls"),
    )
  if (request.includes(worker.answer)) return finish(worker.heard)
  if (request.includes(WAITING)) return finish(TOO_EARLY)
  return finish(started)
}

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
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return finish("slow check")
        // A worker's request carries its brief but never the parent's prompt.
        if (!s.includes(ASK)) {
          if (s.includes(WORKERS.background.prompt)) return work(WORKERS.background, s)
          if (s.includes(WORKERS.foreground.prompt)) return work(WORKERS.foreground, s)
        }
        if (s.includes(AGAIN)) return lead(WORKERS.foreground, s, {}, "Running it.")
        return lead(WORKERS.background, s, { background: true }, STARTED)
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
      const waiting = (frame: string, worker: Worker) =>
        frame.split("\n").some((line) => line.includes(`◈ worker gpt  ${worker.description}  ${WAITING} · `))
      const heard = (frame: string, worker: Worker) => frame.includes(worker.heard) || frame.includes(TOO_EARLY)

      yield* ui.submit(ASK)
      // The worker has said it waits and ended its turn; its shell still sleeps.
      yield* until("wake-bg-waiting", (frame) => frame.includes(STARTED) && waiting(frame, WORKERS.background))
      yield* save("wake-bg-waiting")
      yield* until("wake-bg-done", (frame) => heard(frame, WORKERS.background))
      yield* save("wake-bg-done")

      yield* ui.submit(AGAIN)
      yield* until("wake-fg-waiting", (frame) => waiting(frame, WORKERS.foreground))
      yield* save("wake-fg-waiting")
      yield* until("wake-fg-done", (frame) => heard(frame, WORKERS.foreground))
      yield* save("wake-fg-done")
    }),
)
