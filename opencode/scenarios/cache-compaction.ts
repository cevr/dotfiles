// A compaction between two turns whose summary request misses the cache,
// replayed against OpenCode with the Prime look and the cache mod (cmd/cache,
// its TUI and server halves) loaded. The model costs $3 per million input
// tokens, $3.75 to write the cache and $0.30 to read it, and its cache lives an
// hour. The first turn writes its 48k prompt; /compact's summary request reads
// none of it and writes 50k; the next turn's request writes the 6k summary,
// under the row's threshold. The miss row belongs to the compaction: it sits
// under the compaction's own row, not under the turn after it.
// Run: OPENCODE_DEV=<opencode checkout> bunx opencode-drive run scenarios/cache-compaction.ts
//
// It writes, under SCENARIO_OUT, the second turn's end as `cache-compaction.txt`
// (its text) and `cache-compaction.json` (its styled lines), and
// `cache-compaction.timeout.txt` if they never drew.
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const out = process.env.SCENARIO_OUT ?? "out"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK = "Check the build."
const ANSWER = "The build passes."
const AGAIN = "Check it again."
const STILL = "Still passing."
/** A summary in OpenCode's template (a heading of its own), which the host checks before it keeps one. */
const SUMMARY = "## Objective\n\nResume from the passing build."

const usage = (prompt: number, write: number) =>
  Llm.raw({
    choices: [],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: 10,
      total_tokens: prompt + 10,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: write },
    },
  })

export default OpenCodeDriver.use(
  {
    opencode: process.env.OPENCODE_DEV ? { dev: process.env.OPENCODE_DEV } : undefined,
    config: {
      autoupdate: false,
      username: "Demo",
      plugins: [{ package: `${process.cwd()}/cmd/cache`, options: { dir: out, host: "scenario" } }],
      providers: {
        simulation: {
          models: {
            "gpt-sim-model": {
              limit: { context: 262_144, output: 16_000 },
              cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
              settings: { cache: { ttl: "1h" } },
            },
          },
        },
      },
    },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${process.cwd()}/cmd/prime`, `${process.cwd()}/cmd/cache`],
    },
    tui: { viewport: { cols: 144, rows: 40 } },
    project: {
      git: true,
      files: { ".opencode/themes/prime.json": readFileSync(`${process.cwd()}/themes/prime.json`, "utf8") },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("build check"), Llm.finish())
        if (s.includes("summarize the conversation above")) return Stream.make(Llm.text(SUMMARY), usage(50_000, 50_000), Llm.finish())
        if (s.includes(AGAIN)) return Stream.make(Llm.text(STILL), usage(6_000, 6_000), Llm.finish())
        return Stream.make(Llm.text(ANSWER), usage(48_000, 48_000), Llm.finish())
      })
      const until = (name: string, ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.succeed(frame) : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.timeout.txt`, text(frame))))),
        )
      yield* ui.submit(ASK)
      yield* until("answered", (frame) => frame.includes(ANSWER))
      yield* ui.submit("/compact")
      yield* until("compacted", (frame) => /◇ Compacted · .* · \d/.test(frame))
      yield* ui.submit(AGAIN)
      // The second turn closed and the sidebar counted both misses ($0.17 + $0.02).
      const { images: _, ...frame } = yield* until("cache-compaction", (frame) => frame.includes(STILL) && frame.includes("cache miss") && frame.includes("missed $0.19"))
      writeFileSync(`${out}/cache-compaction.txt`, text(frame))
      writeFileSync(`${out}/cache-compaction.json`, JSON.stringify(frame))
    }),
)
