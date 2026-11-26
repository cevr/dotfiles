// A reply's emphasis in the Prime look: `[[Word]]` chips and the queue's lead
// labels (mods/prime/emphasis.ts), drawn into the host's Markdown with no fork
// change (mods/prime/tui/emphasis.ts). One ask, answered by a streamed reply
// holding each chip, a table cell and an "In the queue" section, replayed
// against OpenCode with a scripted model and its real tree-sitter.
// Run: OPENCODE_DEV=<opencode checkout> OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-emphasis.ts
//
// It writes, under SCENARIO_OUT:
// - `emphasis`: the finished reply, with a screenshot (`emphasis.png`);
// - with SCENARIO_EMPHASIS=off, `emphasis-plain` instead: the same reply with
//   Prime's option `emphasis` false, every pill as typed (the proof pair);
// - `emphasis-stream.json`: each distinct frame captured back to back while the
//   reply streamed, and the closed pills any of them showed as typed (none).
// Each frame is a `.txt` of its text and a `.json` of its styled lines.
//
// Both halves of Prime are loaded, the server half (cmd/prime/server.ts, the
// reply style) before memory (cmd/memory, on a scratch file holding one global
// note, so its digest is in the system prompt), as daily lists them. After the
// screenshot the owner asks for a worker, so a subagent's request is made too.
// With SCENARIO_DUMP=1 it writes `requests.json`: each model request's kind
// (`title`, `root`, `child`), how many times it holds the section's opening tag,
// and where the section and memory's digest start in it.
import { Effect, Schedule, Stream } from "effect"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { Llm, OpenCodeDriver } from "./test-driver.ts"
import { main as memory } from "../cmd/memory/cli.ts"
import { stamp } from "../tests/hang-guard.ts"

const root = process.cwd()
const out = resolve(process.env.SCENARIO_OUT || "out")
mkdirSync(out, { recursive: true })
const plain = process.env.SCENARIO_EMPHASIS === "off"
const name = ["emphasis", "emphasis-plain"][Number(plain)] || "emphasis"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK = "How did the disk cleanup go?"
/** The reply: every taught chip, an accepted one, a table cell, and the queue's labels. */
const REPLY = [
  "Disk is at 61% after the cleanup [[Measured]], down from 89%.",
  "",
  "- Build caches deleted in 104 workspaces [[Done 104/104]].",
  "- The deep accept run was not started [[Skipped]]: the host was loaded.",
  "- The upload check broke [[Failed: 3 tests]] on the token step.",
  "- The bucket move waits on the owner's login [[Blocked]].",
  "- The leak is the stale lock [[Inferred]] from the log tail.",
  "- The workbox may need a reboot [[Guess]].",
  "- The gate ran green [[Passed]].",
  "- Deleting the old bucket [[Irreversible]] loses the 2024 logs.",
  "- Moving it to cold storage [[Costs money]] about $4 a month.",
  "",
  "| unit | state |",
  "|---|---|",
  "| emphasis-draw | [[Done]] |",
  "| emphasis-rules | [[Blocked]] |",
  "",
  "In the queue:",
  "",
  "- **Running (mine):** the 95% disk watch.",
  "- **Waiting on you:** the bucket login.",
  "- **Dated (mine):** the cache review on 2026-11-20.",
  "- **Next:** emphasis-rules, after this lands.",
].join("\n")

/** The owner's second ask, for a worker; the worker's brief, which only its own requests carry; its report. */
const DELEGATE = "Have a worker check the disk again."
const BRIEF = "Report the disk use of / in one line."
const REPORT = "Disk at 61%."
const DONE = "The worker says the disk is at 61%."
const OPEN = "<reply_style>"
const DIGEST = "# Memory"

/** Memory's file: the scenario adds one global note before the first ask, so its digest is in every system prompt. */
const MEMORY_DB = `${out}/memory.db`

/** A closed pill as tree-sitter draws it unhooked, `[Done]`: not a pill still open (`[[Done]`). */
const shortcut = (pill: string) => new RegExp(`(?<!\\[)\\[${pill.replace(/[$/]/g, "\\$&")}\\](?!\\])`)
/** The known pills of REPLY, as typed: none may show so in a frame once it has closed. */
const PILLS = Array.from(REPLY.matchAll(/\[\[([^\]]+)\]\]/g), (match) => match[1] || "")

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV || "" },
    config: { autoupdate: false, username: "Demo", plugins: [`${root}/cmd/prime`, { package: `${root}/cmd/memory`, options: { path: MEMORY_DB } }] },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [{ package: `${root}/cmd/prime`, options: { emphasis: !plain } }],
    },
    tui: { viewport: { cols: 100, rows: 40 } },
    project: {
      git: true,
      files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      const requests: Array<{ kind: string; opens: number; section: number; digest: number }> = []
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        // The worker's conversation is its brief alone; the root's holds the owner's first ask.
        const kind = ["root", "child", "title"][Number(s.includes(BRIEF) && !s.includes(ASK)) + 2 * Number(s.includes("You name conversations"))] || "title"
        requests.push({ kind, opens: s.split(OPEN).length - 1, section: s.indexOf(OPEN), digest: s.indexOf(DIGEST) })
        if (kind === "title") return Stream.make(Llm.text("disk cleanup"), Llm.finish())
        if (kind === "child") return Stream.make(Llm.text(REPORT), Llm.finish())
        if (!s.includes(DELEGATE)) return Stream.make(Llm.text(REPLY, { delay: 15, chunkSize: 3 }), Llm.finish())
        if (!s.includes("call_worker"))
          return Stream.make(
            Llm.toolCall({ index: 0, id: "call_worker", name: "subagent", input: { agent: "general", description: "disk check", prompt: BRIEF } }),
            Llm.finish("tool-calls"),
          )
        // OpenCode runs every subagent in the background: the root waits for the worker's report, then answers.
        if (!s.includes(REPORT)) return Stream.make(Llm.finish())
        return Stream.make(Llm.text(DONE), Llm.finish())
      })
      const done = (frame: string) => frame.includes("Next: emphasis-rules") && !frame.includes("Executing")
      // The turn's end time, the row Prime draws under a finished turn.
      const ended = (frame: string) => done(frame) && /\d (AM|PM)\b/.test(frame)
      const until = (label: string, ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.filterOrFail((frame) => ready(text(frame)), () => "pending"),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${label}.timeout.txt`, text(frame))))),
        )
      yield* Effect.promise(() => memory(["add", "The owner reads replies in the Prime look.", "--scope", "global"], { db: MEMORY_DB, now: stamp() })).pipe(
        Effect.filterOrFail((added) => added.code === 0, (added) => `memory add failed: ${added.out}`),
      )
      yield* ui.submit(ASK)
      // Frames back to back while the reply streams, until it is done.
      const frames: Array<string> = []
      for (let look = 0; look < 2000; look++) {
        const shown = text(yield* ui.capture())
        if (frames.at(-1) !== shown) frames.push(shown)
        if (done(shown)) break
      }
      // With the option off every pill shows as typed: only the drawn reply is held to none.
      const raw = frames.flatMap((frame) =>
        PILLS.filter((pill) => !plain && (frame.includes(`[[${pill}]]`) || shortcut(pill).test(frame))).map((pill) => ({ pill, frame })),
      )
      writeFileSync(`${out}/emphasis-stream.json`, JSON.stringify({ frames: frames.length, raw }))
      yield* until(name, ended)
      const { images: _, ...frame } = yield* ui.capture()
      writeFileSync(`${out}/${name}.txt`, text(frame))
      writeFileSync(`${out}/${name}.json`, JSON.stringify(frame))
      console.log("screenshot:", yield* ui.screenshot(name))

      // A worker's request, for the dump: its system prompt holds no section.
      yield* ui.submit(DELEGATE)
      yield* until(`${name}-worker`, (frame) => frame.includes(DONE))
      if (process.env.SCENARIO_DUMP) writeFileSync(`${out}/requests.json`, JSON.stringify(requests))
    }),
)
