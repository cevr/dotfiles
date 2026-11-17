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
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT || "out"
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

/** A closed pill as tree-sitter draws it unhooked, `[Done]`: not a pill still open (`[[Done]`). */
const shortcut = (pill: string) => new RegExp(`(?<!\\[)\\[${pill.replace(/[$/]/g, "\\$&")}\\](?!\\])`)
/** The known pills of REPLY, as typed: none may show so in a frame once it has closed. */
const PILLS = Array.from(REPLY.matchAll(/\[\[([^\]]+)\]\]/g), (match) => match[1] || "")

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV || "" },
    config: { autoupdate: false, username: "Demo" },
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
      yield* llm.serve((req) => {
        if (JSON.stringify(req).includes("You name conversations")) return Stream.make(Llm.text("disk cleanup"), Llm.finish())
        return Stream.make(Llm.text(REPLY, { delay: 15, chunkSize: 3 }), Llm.finish())
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
    }),
)
