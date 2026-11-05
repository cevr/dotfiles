// Kernel cells in the Prime look, with the kernel as the agent's runtime (as
// daily loads it): a cell that describes itself draws its description as the
// group's header over the rows of the tools.* calls it made; a cell without
// one draws as before, its header counting what it ran (or its one row
// alone). Replayed against OpenCode with a scripted model.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-kernel.ts
//
// It writes, under SCENARIO_OUT, `kernel` (the finished turn, in Details
// mode; a `.txt` of its text and a `.json` of its styled lines), and
// `kernel.timeout.txt` when a wait times out.
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK = "Merge the worker and check the notes."
/** The described cell: two commands and a read. */
const MERGE = [
  "await tools.shell({ command: \"printf 'merged\\\\n'\", description: \"Merge\" })",
  "await tools.shell({ command: \"printf 'tests ok\\\\n'\", description: \"Test\" })",
  "await tools.read({ path: \"notes.md\" })",
].join("\n")
/** The cells without a description: two commands, then one. */
const CHECK = [
  "await tools.shell({ command: \"printf 'lint ok\\\\n'\", description: \"Lint\" })",
  "await tools.shell({ command: \"printf 'types ok\\\\n'\", description: \"Types\" })",
].join("\n")
const STATUS = "await tools.shell({ command: \"printf 'clean\\\\n'\", description: \"Status\" })"

export default OpenCodeDriver.use(
  {
    opencode: process.env.OPENCODE_DEV ? { dev: process.env.OPENCODE_DEV } : undefined,
    config: { autoupdate: false, username: "Demo", plugins: [`${root}/cmd/kernel`] },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`],
    },
    tui: { viewport: { cols: 106, rows: 40 } },
    project: {
      git: true,
      files: {
        ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8"),
        "notes.md": "ship it\n",
      },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("merge worker"), Llm.finish())
        const cell = (id: string, input: { code: string; description?: string }) =>
          Stream.make(Llm.toolCall({ index: 0, id, name: "kernel", input }), Llm.finish("tool-calls"))
        if (!s.includes("call_merge")) return cell("call_merge", { code: MERGE, description: "Merge the skill-dollar worker" })
        if (!s.includes("call_check")) return cell("call_check", { code: CHECK })
        if (!s.includes("call_status")) return cell("call_status", { code: STATUS })
        return Stream.make(Llm.text("Merged; the notes say ship it."), Llm.finish())
      })
      const until = (name: string, ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
          Effect.tapError(() =>
            ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.timeout.txt`, text(frame)))),
          ),
        )
      yield* ui.submit(ASK)
      yield* until("kernel", (frame) => frame.includes("the notes say ship it") && !frame.includes("Executing"))
      yield* Effect.sleep("500 millis")
      const { images: _, ...frame } = yield* ui.capture()
      writeFileSync(`${out}/kernel.txt`, text(frame))
      writeFileSync(`${out}/kernel.json`, JSON.stringify(frame))
      console.log("screenshot:", yield* ui.screenshot("kernel"))
    }),
)
