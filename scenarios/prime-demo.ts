// Prime Agent's demo conversation, replayed against OpenCode with a scripted model.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-demo.ts
import { Effect, Stream } from "effect"
import { writeFileSync } from "node:fs"
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
    tuiConfig: { animations: false, tabs: { mode: "off" }, theme: { name: process.env.SCENARIO_THEME ?? "opencode", mode: "dark" } },
    tui: { viewport: { cols: 106, rows: 38 } },
    project: {
      git: true,
      files: {
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
            Llm.reasoning("Look at the test first, then patch the loop."),
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
        return Stream.make(Llm.text("The fix is in. **1 file changed**; the retry loop now makes every attempt."), Llm.finish())
      })
      yield* ui.submit("Fix the flaky retry test in src/net.py.")
      yield* ui.waitFor("The fix is in.", { timeout: 20_000 })
      yield* Effect.sleep("500 millis")
      writeFileSync(`${out}/${label}.txt`, text(yield* ui.capture()))
      console.log("screenshot:", yield* ui.screenshot(label))
    }),
)
