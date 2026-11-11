// Every transcript row kind in the Prime look, for the column its glyph
// starts in: a turn of one shell call (`● Ran 1 command`), a step of two
// calls at once (a grouped run), an inline tool (a glob) and prose, then a
// program's notice (`◈ rift land · accept passed`, a synthetic message the
// host draws). Replayed against OpenCode with a scripted model, once per
// transcript verbosity: `low` (the host default) folds a turn's calls into
// one `+ N …` summary row, `medium` gives each call its own row.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out INDENT_VERBOSITY=low bunx opencode-drive run scenarios/prime-indent.ts
//
// It writes, under SCENARIO_OUT, `indent-<verbosity>-folded.txt` (low only:
// the turn's summary row, folded), `indent-<verbosity>.txt` (the turn shown
// in full, low's summary unfolded by a click), a `.json` of each frame's
// styled lines, a screenshot of each, and `indent-timeout.txt` when a wait
// times out.
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
const verbosity = process.env.INDENT_VERBOSITY === "medium" ? "medium" : "low"
const label = `indent-${verbosity}`

const ASK = "prime-indent-fixture"
const DONE = "All rows drawn."
const NOTICE = "rift land · accept passed"

type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]
const call = (id: string, name: string, input: ToolInput) => Stream.make(Llm.toolCall({ index: 0, id, name, input }), Llm.finish("tool-calls"))
const say = (text: string) => Stream.make(Llm.text(text), Llm.finish())

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    config: { autoupdate: false, username: "Demo" },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`],
      session: { verbosity },
    },
    tui: { viewport: { cols: 110, rows: 50 } },
    project: {
      git: true,
      files: {
        ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8"),
        "notes.md": "# Notes\n",
      },
    },
  },
  ({ ui, llm, opencode }) =>
    Effect.gen(function* () {
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        if (s.includes("You name conversations")) return say("Indent fixture")
        if (!s.includes("call_one")) return call("call_one", "shell", { command: "echo one", description: "Echo one" })
        // Two calls in one step: a grouped run.
        if (!s.includes("call_two"))
          return Stream.make(
            Llm.toolCall({ index: 0, id: "call_two", name: "shell", input: { command: "echo two", description: "Echo two" } }),
            Llm.toolCall({ index: 1, id: "call_three", name: "shell", input: { command: "echo three", description: "Echo three" } }),
            Llm.finish("tool-calls"),
          )
        if (!s.includes("call_glob")) return call("call_glob", "glob", { pattern: "*.md" })
        return say(DONE)
      })

      type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
      const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => span.text).join("").trimEnd()).join("\n")
      const until = (ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) && !text(frame).includes("Finishing startup") ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/indent-timeout.txt`, text(frame))))),
        )
      const keep = (name: string) =>
        Effect.gen(function* () {
          const { images: _, ...frame } = yield* ui.capture()
          writeFileSync(`${out}/${name}.txt`, text(frame))
          writeFileSync(`${out}/${name}.json`, JSON.stringify(frame))
          console.log("screenshot:", yield* ui.screenshot(name))
        })
      const idle = (frame: string) => !frame.includes("Executing")

      yield* ui.submit(ASK)
      yield* until((frame) => frame.includes(DONE) && idle(frame))

      // A program's notice into the idle session, as a job's end or a land's result arrives: a synthetic message the host draws.
      const page = yield* opencode.session.list()
      const session = page.data.find((item) => !item.parentID)
      if (!session) return yield* Effect.fail("no root session")
      yield* opencode.session.synthetic({
        sessionID: session.id,
        text: `<notice>${NOTICE}</notice>`,
        description: NOTICE,
        metadata: { source: "rift" },
        resume: false,
      })
      yield* until((frame) => frame.includes(NOTICE))
      yield* Effect.sleep("500 millis")

      if (verbosity === "low") {
        // The turn's calls fold into one summary row; a click unfolds it.
        yield* keep(`${label}-folded`)
        const lines = text(yield* ui.capture()).split("\n")
        const y = lines.findIndex((line) => /^\s*\+ /.test(line))
        if (y < 0) return yield* Effect.fail("no folded summary row")
        const x = lines[y]!.indexOf("+")
        yield* ui.mouse({ action: "move", x, y })
        yield* ui.mouse({ action: "down", x, y, button: "left" })
        yield* ui.mouse({ action: "up", x, y, button: "left" })
        yield* until((frame) => frame.includes("Ran") && frame.includes(NOTICE))
        yield* Effect.sleep("500 millis")
      }
      yield* keep(label)
    }),
)
