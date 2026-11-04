// Prime Agent's demo conversation, replayed against OpenCode with a scripted model.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-demo.ts
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const out = process.env.SCENARIO_OUT ?? "out"
const label = process.env.SCENARIO_LABEL ?? "baseline"
const text = (frame: { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }) =>
  frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const NET_PY = [
  "def fetch(url, retries=3):",
  "    for i in range(retries - 1):",
  "        try:",
  "            return get(url)",
  "        except TimeoutError:",
  "            backoff(i)",
  "    raise TimeoutError(url)",
  "",
].join("\n")

export default OpenCodeDriver.use(
  {
    opencode: process.env.OPENCODE_DEV ? { dev: process.env.OPENCODE_DEV } : undefined,
    config: { autoupdate: false, username: "Demo" },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: process.env.SCENARIO_THEME ?? "opencode", mode: "dark" },
      // SCENARIO_PRIME=1 turns on the fork's opt-in Prime look plugin.
      // Prime shows every tool call and thought on its own row, so grouping is off.
      ...(process.env.SCENARIO_PRIME ? { plugins: ["opencode.prime"], session: { grouping: "none", thinking: "show" } } : {}),
    },
    tui: { viewport: { cols: 106, rows: 38 } },
    project: {
      git: true,
      files: {
        ".opencode/themes/prime.json": readFileSync(`${process.cwd()}/themes/prime.json`, "utf8"),
        "src/net.py": NET_PY,
        "tests/test_net.py": "from src.net import fetch\n\ndef test_retries():\n    assert fetch('x', retries=3)\n",
      },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (process.env.SCENARIO_DUMP) writeFileSync(`${out}/request.json`, JSON.stringify(req, null, 1))
        if (!s.includes("call_shell"))
          return Stream.make(
            Llm.reasoning("Look at the test first, then spawn a reviewer."),
            Llm.text("Reading the retry test and its helper."),
            Llm.toolCall({ index: 0, id: "call_shell", name: "shell", input: { command: "printf 'test_net.py F\\n1 failed\\n'" } }),
            Llm.finish("tool-calls"),
          )
        if (!s.includes("call_edit"))
          return Stream.make(
            Llm.text("The backoff loop exits one attempt early. Patching it."),
            Llm.toolCall({
              index: 0,
              id: "call_edit",
              name: "patch",
              input: {
                patchText: [
                  "*** Begin Patch",
                  "*** Update File: src/net.py",
                  "@@ def fetch(url, retries=3):",
                  "-    for i in range(retries - 1):",
                  "+    for i in range(retries):",
                  "*** End Patch",
                ].join("\n"),
              },
            }),
            Llm.finish("tool-calls"),
          )
        if (!s.includes("call_read"))
          return Stream.make(
            Llm.toolCall({ index: 0, id: "call_grep", name: "grep", input: { pattern: "retries", path: "src" } }),
            Llm.toolCall({ index: 1, id: "call_read", name: "read", input: { path: "out/traces.jsonl" } }),
            Llm.finish("tool-calls"),
          )
        return Stream.make(Llm.text("The fix is in. **1 file changed**; the retry loop now makes every attempt."), Llm.finish())
      })
      yield* ui.submit("Fix the flaky retry test in src/net.py and have a reviewer check it.")
      // ui.waitFor reads the last render buffer without rendering, so an idle
      // screen never shows the final text; capture() renders first.
      const done = ui.capture().pipe(
        Effect.flatMap((frame) => (text(frame).includes("The fix is in.") ? Effect.void : Effect.fail("pending"))),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 200 }),
      )
      yield* done.pipe(
        Effect.tapError(() =>
          ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${label}.timeout.txt`, text(frame)))),
        ),
      )
      yield* Effect.sleep("500 millis")
      writeFileSync(`${out}/${label}.txt`, text(yield* ui.capture()))
      console.log("screenshot:", yield* ui.screenshot(label))
      // SCENARIO_CYCLE=1 presses Ctrl+O twice: Details -> All -> Overview.
      if (process.env.SCENARIO_CYCLE)
        for (const mode of ["all", "overview"]) {
          yield* ui.press("o", { ctrl: true })
          yield* Effect.sleep("300 millis")
          writeFileSync(`${out}/${label}-${mode}.txt`, text(yield* ui.capture()))
          console.log("screenshot:", yield* ui.screenshot(`${label}-${mode}`))
        }
    }),
)
