// A worker that waits on its own background shell command, in the Prime look
// with the orchestrate plugin: it moves a shell command to the background
// and ends its turn, so OpenCode reports its waiting line to the parent with
// the work still running; the shell's stop notice wakes it, and the answer it
// writes then reaches the parent as a second report. Replayed against
// OpenCode with a scripted model.
//
// The shell command waits for a release file the scenario writes once it has
// the waiting frame, so the waiting state lasts as long as the frame takes to
// come, however slow the host: a fixed `sleep 3` can end before the worker's
// waiting row draws, and then the frame never comes.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-wake.ts
//
// The parent's model says which report it got: `Root heard: …` for the
// answer written after the shell, `Root heard it waits.` for the line the
// worker wrote before it, while it still waited.
//
// It writes, under SCENARIO_OUT:
// - `wake-bg-waiting`: the worker has ended its turn and waits on its shell;
// - `wake-bg-done`: its answer has reached the parent.
// Each frame is a `.txt` of its text and a `.json` of its styled lines. A
// wait that times out writes `<frame>.timeout.txt` and keeps the run's server
// and TUI logs in `<frame>.logs`.
import { Effect, Schedule, Stream } from "effect"
import { cpSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = resolve(process.env.SCENARIO_OUT ?? "out")
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK = "Run the slow check in a background worker."
const STARTED = "Worker started."
const WAITING = "Waiting for the check."
const HEARD_WAITING = "Root heard it waits."
// The worker moves its shell command to the background, ends its turn, and answers once its shell's notice wakes it.
const WORKER = {
  id: "call_bg",
  description: "Run the slow check",
  prompt: "Worker brief B.",
  shell: "call_sleep_b",
  release: `${out}/release-bg`,
  answer: "Background check passed after its shell.",
  heard: "Root heard: the background check passed.",
}

const finish = (words: string) => Stream.make(Llm.text(words), Llm.finish())

/** The worker's slow check: it ends once the scenario writes its release file, or after two minutes. */
const check = `for i in $(seq 600); do [ -e '${WORKER.release}' ] && exit 0; sleep 0.2; done`

/** The worker's next step: start its shell, then wait, then answer once the shell's notice is in. */
const work = (request: string) => {
  if (!request.includes(WORKER.shell))
    return Stream.make(
      Llm.toolCall({ index: 0, id: WORKER.shell, name: "shell", input: { command: check, background: true } }),
      Llm.finish("tool-calls"),
    )
  // The shell's stop notice: `<shell id="…" state="completed" command="…">`.
  if (request.includes("<shell id=")) return finish(WORKER.answer)
  return finish(WAITING)
}

/** The parent's next step: start the worker, then say which report it got. */
const lead = (request: string) => {
  if (!request.includes(WORKER.id))
    return Stream.make(
      Llm.toolCall({ index: 0, id: WORKER.id, name: "subagent", input: { description: WORKER.description, prompt: WORKER.prompt } }),
      Llm.finish("tool-calls"),
    )
  if (request.includes(WORKER.answer)) return finish(WORKER.heard)
  if (request.includes(WAITING)) return finish(HEARD_WAITING)
  return finish(STARTED)
}

export default OpenCodeDriver.use(
  {
    opencode: process.env.OPENCODE_DEV ? { dev: process.env.OPENCODE_DEV } : undefined,
    config: {
      autoupdate: false,
      username: "Demo",
      // A Wednesday afternoon, so the Sabbath never stops the worker; the call log stays in the run's output.
      plugins: [{ package: `${root}/cmd/orchestrate`, options: { now: "2026-11-04T15:00:00Z", log: `${out}/agents.jsonl` } }],
    },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`],
      // Each call its own row, as these frames read them; the default (low) folds a turn's calls into one.
      session: { verbosity: "medium" },
    },
    tui: { viewport: { cols: 106, rows: 40 } },
    project: {
      git: true,
      files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") },
    },
  },
  ({ ui, llm, artifacts }) =>
    Effect.gen(function* () {
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return finish("slow check")
        // The worker's request carries its brief but never the parent's prompt.
        if (!s.includes(ASK) && s.includes(WORKER.prompt)) return work(s)
        return lead(s)
      })
      // Under load the host's startup panel can still sit beneath the rows; a
      // frame is ready only once it has gone.
      const until = (name: string, ready: (frame: string) => boolean, times = 300) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) && !text(frame).includes("Finishing startup") ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times }),
          Effect.tapError(() =>
            ui.capture().pipe(
              Effect.map((frame) => writeFileSync(`${out}/${name}.timeout.txt`, text(frame))),
              // The run's server and TUI logs go with the run; keep them beside the frame.
              Effect.andThen(Effect.sync(() => cpSync(`${artifacts}/logs`, `${out}/${name}.logs`, { recursive: true }))),
            ),
          ),
        )
      const save = (name: string) =>
        Effect.gen(function* () {
          const { images: _, ...frame } = yield* ui.capture()
          writeFileSync(`${out}/${name}.txt`, text(frame))
          writeFileSync(`${out}/${name}.json`, JSON.stringify(frame))
          console.log("screenshot:", yield* ui.screenshot(name))
        })
      const waiting = (frame: string) =>
        frame.split("\n").some((line) => line.includes(`◈ worker gpt  ${WORKER.description}  ${WAITING} · `))

      yield* ui.submit(ASK)
      // The worker has said it waits and ended its turn, and the parent has its waiting report; its shell still runs, until the release.
      yield* until("wake-bg-waiting", (frame) => frame.includes(HEARD_WAITING) && waiting(frame))
      yield* save("wake-bg-waiting")
      yield* Effect.sync(() => writeFileSync(WORKER.release, ""))
      yield* until("wake-bg-done", (frame) => frame.includes(WORKER.heard))
      yield* save("wake-bg-done")
    }),
)
