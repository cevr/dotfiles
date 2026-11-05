// Prime Agent's demo conversation, replayed against OpenCode with a scripted model.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-demo.ts
//
// It writes, under SCENARIO_OUT and named by SCENARIO_LABEL:
// - `<label>-running`: while the reviewer subagent works;
// - `<label>`: the finished turn, in Details mode;
// - with SCENARIO_CYCLE=1, `<label>-all` and `<label>-overview` after each Ctrl+O.
// Each frame is a `.txt` of its text and a `.json` of its styled lines.
import { Deferred, Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const out = process.env.SCENARIO_OUT ?? "out"
const label = process.env.SCENARIO_LABEL ?? "baseline"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

// The parent's prompt and the reviewer's task; a request without the first is the subagent's own.
// Long enough to wrap at the 106-column viewport, so the user rail shows on a wrapped row too.
const ASK =
  "Fix the flaky retry test in src/net.py and have a reviewer check it. It fails about one run in five on CI, always on the last attempt."
const REVIEW = "Review the diff in src/net.py."
// The last turn's usage: 64k of the 262k window below, as in Prime's tray.
const USAGE = { prompt_tokens: 63_000, completion_tokens: 1_000, total_tokens: 64_000 }

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
    config: {
      autoupdate: false,
      username: "Demo",
      providers: { simulation: { models: { "gpt-sim-model": { limit: { context: 262_144, output: 16_000 } } } } },
    },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: process.env.SCENARIO_THEME ?? "opencode", mode: "dark" },
      // SCENARIO_PRIME=1 loads the Prime look plugin from mods/prime.
      ...(process.env.SCENARIO_PRIME ? { plugins: [`${process.cwd()}/mods/prime`] } : {}),
    },
    // Tall enough that the splash stays on screen in every Ctrl+O mode.
    tui: { viewport: { cols: 106, rows: 56 } },
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
      // The reviewer holds its answer until the running frame is captured.
      const review = yield* Deferred.make<void>()
      yield* llm.serve((req, index) => {
        const s = JSON.stringify(req)
        if (process.env.SCENARIO_DUMP) writeFileSync(`${out}/request-${index}.json`, JSON.stringify(req, null, 1))
        // OpenCode 2.2's title prompt; opencode-drive's llm.title does not recognise it yet.
        if (s.includes("You name conversations")) return Stream.make(Llm.text("fix flaky retry test"), Llm.finish())
        if (!s.includes(ASK))
          return Stream.fromEffect(Deferred.await(review)).pipe(
            Stream.drain,
            Stream.concat(Stream.make(Llm.text("Approved: the loop now makes every attempt."), Llm.finish())),
          )
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
        if (!s.includes("call_review"))
          return Stream.make(
            Llm.toolCall({
              index: 0,
              id: "call_review",
              name: "subagent",
              input: { agent: "general", description: "code-reviewer", prompt: REVIEW },
            }),
            Llm.finish("tool-calls"),
          )
        if (!s.includes("call_read"))
          return Stream.make(
            Llm.toolCall({ index: 0, id: "call_grep", name: "grep", input: { pattern: "retries", path: "src" } }),
            Llm.toolCall({ index: 1, id: "call_read", name: "read", input: { path: "out/traces.jsonl" } }),
            Llm.finish("tool-calls"),
          )
        return Stream.make(
          Llm.text("The fix is in. **1 file changed**, reviewer approved."),
          Llm.raw({ choices: [], usage: USAGE }),
          Llm.finish(),
        )
      })
      // ui.waitFor reads the last render buffer without rendering and can time
      // out on text already on screen (anomalyco/opencode#61681, fixed on our
      // fork); capture() renders first, so this works on any OpenCode.
      const until = (name: string, ready: (frame: Frame) => boolean) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(frame) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 200 }),
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
      // Prime's dock counts running subagents; hold the reviewer until it shows.
      yield* until(`${label}-running`, (frame) =>
        process.env.SCENARIO_PRIME ? text(frame).includes("◆ 1 subagent") : text(frame).includes("code-reviewer"),
      )
      yield* save(`${label}-running`)
      yield* Deferred.succeed(review, undefined)
      yield* until(label, (frame) => text(frame).includes("reviewer approved") && !text(frame).includes("Executing"))
      // Each run fetches the Python grammar afresh from GitHub, and the diff is
      // highlighted only once it lands, which can be after the turn settles. Wait
      // for the diff's `def` to be its own syntax span; on a timeout, save anyway
      // so the colour assertions report it.
      yield* until(`${label}-highlight`, (frame) =>
        frame.lines.every(
          (line) =>
            !/^\s+1\s+def fetch\(/.test(line.spans.map((span) => span.text).join("")) ||
            line.spans.some((span) => span.text === "def"),
        ),
      ).pipe(Effect.ignore)
      yield* Effect.sleep("500 millis")
      yield* save(label)
      // SCENARIO_CYCLE=1 presses Ctrl+O twice: Details -> All -> Overview.
      if (process.env.SCENARIO_CYCLE)
        for (const mode of ["all", "overview"]) {
          yield* ui.press("o", { ctrl: true })
          yield* Effect.sleep("300 millis")
          yield* save(`${label}-${mode}`)
        }
    }),
)
