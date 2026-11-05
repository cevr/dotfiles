// Moving between a session and its running subagents in the Prime look: three
// background workers, each of which runs a command and then waits, while the
// parent waits too. Replayed against OpenCode with a scripted model.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-subagents.ts
//
// It writes, under SCENARIO_OUT and named by SCENARIO_LABEL (default `subagents`):
// - `<label>-started`: the three workers run, the parent waits;
// - `<label>-clicked`: after a click on the `├ Started Fix money parsing` row;
// - `<label>-returned`: after Up from there;
// - `<label>-picker`: after Down on the empty prompt;
// - `<label>-child`: after Enter in the picker;
// - `<label>-sibling`: after Right in that subagent;
// - `<label>-parent`: after Up from there;
// - `<label>-dock`: after a click on the dock's `◆ 3 subagents`.
// Each frame is a `.txt` of its text and a `.json` of its styled lines.
import { Deferred, Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const out = process.env.SCENARIO_OUT ?? "out"
const label = process.env.SCENARIO_LABEL ?? "subagents"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK = "Fix the three failing modules, one worker each."
const STARTED = "Three workers are on it."
// The workers, by call id: each step starts one; each worker runs one command, then waits.
const WORKERS = [
  { id: "call_fix_a", description: "Fix money parsing", prompt: "Worker brief A.", look: "call_look_a" },
  { id: "call_fix_b", description: "Fix CSV quoting", prompt: "Worker brief B.", look: "call_look_b" },
  { id: "call_fix_c", description: "Fix month padding", prompt: "Worker brief C.", look: "call_look_c" },
]

export default OpenCodeDriver.use(
  {
    opencode: process.env.OPENCODE_DEV ? { dev: process.env.OPENCODE_DEV } : undefined,
    config: { autoupdate: false, username: "Demo" },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${process.cwd()}/mods/prime`],
    },
    tui: { viewport: { cols: 106, rows: 40 } },
    project: {
      git: true,
      files: { ".opencode/themes/prime.json": readFileSync(`${process.cwd()}/themes/prime.json`, "utf8") },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      // Everyone stays busy until the navigation is done, so every session shows its loader.
      const release = yield* Deferred.make<void>()
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("three workers"), Llm.finish())
        const worker = WORKERS.find((item) => s.includes(item.prompt) && !s.includes(ASK))
        if (worker && !s.includes(worker.look))
          return Stream.make(
            Llm.reasoning(`Check ${worker.description.toLowerCase()} first.`),
            Llm.text(`Looking at ${worker.description.toLowerCase()}.`),
            Llm.toolCall({
              index: 0,
              id: worker.look,
              name: "shell",
              input: { command: `printf '${worker.prompt}\\n'` },
            }),
            Llm.finish("tool-calls"),
          )
        if (worker)
          return Stream.fromEffect(Deferred.await(release)).pipe(
            Stream.drain,
            Stream.concat(Stream.make(Llm.text(`${worker.description}: done.`), Llm.finish())),
          )
        if (s.includes(STARTED)) return Stream.make(Llm.text("Noted."), Llm.finish())
        const next = WORKERS.find((item) => !s.includes(item.id))
        if (next)
          return Stream.make(
            Llm.toolCall({
              index: 0,
              id: next.id,
              name: "subagent",
              input: { agent: "general", description: next.description, prompt: next.prompt, background: true },
            }),
            Llm.finish("tool-calls"),
          )
        return Stream.make(Llm.text(STARTED)).pipe(
          Stream.concat(Stream.fromEffect(Deferred.await(release)).pipe(Stream.drain)),
          Stream.concat(Stream.make(Llm.finish())),
        )
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
      // A left click on the first cell of `needle` in the current frame.
      const click = (needle: string) =>
        Effect.gen(function* () {
          const lines = text(yield* ui.capture()).split("\n")
          const y = lines.findIndex((line) => line.includes(needle))
          if (y < 0) return yield* Effect.fail(`no line contains ${needle}`)
          const x = lines[y]!.indexOf(needle)
          yield* ui.mouse({ action: "move", x, y })
          yield* ui.mouse({ action: "down", x, y, button: "left" })
          yield* ui.mouse({ action: "up", x, y, button: "left" })
        })
      const top = (frame: string) => frame.split("\n")[0] ?? ""
      // A subagent's frame once its own transcript has drawn.
      const inside = (frame: string) =>
        top(frame).includes(" › ") && frame.includes("Executing") && frame.includes("● Ran printf")

      yield* ui.submit(ASK)
      yield* until(`${label}-started`, (frame) => frame.includes(STARTED) && frame.includes("◆ 3 subagents"))
      yield* Effect.sleep("500 millis")
      yield* save(`${label}-started`)

      yield* click("Started Fix money parsing")
      yield* until(`${label}-clicked`, (frame) => inside(frame) && top(frame).includes("Fix money parsing"))
      yield* save(`${label}-clicked`)

      yield* ui.arrow("up")
      yield* until(`${label}-returned`, (frame) => !top(frame).includes(" › ") && frame.includes("◆ 3 subagents"))
      yield* save(`${label}-returned`)

      yield* ui.arrow("down")
      yield* until(`${label}-picker`, (frame) => frame.includes("Subagents") && frame.includes("Running"))
      yield* save(`${label}-picker`)

      yield* ui.enter()
      yield* until(`${label}-child`, inside)
      yield* save(`${label}-child`)
      const first = top(text(yield* ui.capture()))

      yield* ui.arrow("right")
      yield* until(`${label}-sibling`, (frame) => inside(frame) && top(frame) !== first)
      yield* save(`${label}-sibling`)

      yield* ui.arrow("up")
      yield* until(`${label}-parent`, (frame) => !top(frame).includes(" › ") && frame.includes("◆ 3 subagents"))
      yield* save(`${label}-parent`)

      yield* click("◆ 3 subagents")
      yield* until(`${label}-dock`, (frame) => frame.includes("Subagents") && frame.includes("Running"))
      yield* save(`${label}-dock`)

      yield* ui.press("escape")
      yield* Deferred.succeed(release, undefined)
      yield* until(`${label}-done`, (frame) => frame.includes("Noted."))
    }),
)
