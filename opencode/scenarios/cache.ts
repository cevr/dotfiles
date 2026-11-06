// One turn whose prompt cache expires while a shell call runs, replayed against
// OpenCode with the Prime look and the cache mod (cmd/cache, its TUI and server
// halves) loaded. The model
// costs $3 per million input tokens, $3.75 to write the cache and $0.30 to read
// it, and its cache lives 2s; the shell call takes 4s, so the second request
// writes back the 48k prefix the first one cached.
// With CACHE_ROLE_TTL set the model's cache lives an hour and a fixture server
// plugin gives the build agent its own CACHE_ROLE_TTL
// (`request.settings.cacheTTL`, as cmd/orchestrate does for its roles; the
// config's `agents` merges only a request's headers and body): the miss is an
// expiry only by the agent's lifetime.
// Run: OPENCODE_DEV=<opencode checkout> bunx opencode-drive run scenarios/cache.ts
//
// It writes, under SCENARIO_OUT: the finished turn with its miss row and the
// sidebar line, as `cache.txt` (its text) and `cache.json` (its styled lines);
// `cache.timeout.txt` if they never drew; the server half's `ledger.jsonl`, and
// `ledger.timeout.txt` if it never held a line for each request.
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const out = process.env.SCENARIO_OUT ?? "out"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

const ASK = "Run the slow check."
const COMMAND = "sleep 4 && echo checked"
const DONE = "The check passed."
const ROLE_TTL = process.env.CACHE_ROLE_TTL
const roleFixture = `export default {id: "fixture.role-ttl", async setup(ctx) {
  await ctx.agent.transform((editor) => editor.update("build", (agent) => { agent.request.settings.cacheTTL = ${JSON.stringify(ROLE_TTL ?? "")} }));
}}`

// The first request writes its 48k prompt to the cache; the second, after the
// cache expired, reads none of it and writes all 50k again.
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
      // The server half: its ledger goes to SCENARIO_OUT.
      plugins: [{ package: `${process.cwd()}/cmd/cache`, options: { dir: out, host: "scenario" } }],
      providers: {
        simulation: {
          models: {
            "gpt-sim-model": {
              limit: { context: 262_144, output: 16_000 },
              cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
              settings: { cache: { ttl: ROLE_TTL === undefined ? "2s" : "1h" } },
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
    // Wide enough for the sidebar to show beside the transcript.
    tui: { viewport: { cols: 144, rows: 40 } },
    project: {
      git: true,
      files: {
        ".opencode/themes/prime.json": readFileSync(`${process.cwd()}/themes/prime.json`, "utf8"),
        ...(ROLE_TTL === undefined
          ? {}
          : {
              ".opencode/plugins/fixture/package.json": JSON.stringify({ name: "fixture-role-ttl", type: "module", exports: { "./server": "./server.ts" } }),
              ".opencode/plugins/fixture/server.ts": roleFixture,
            }),
      },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("slow check"), Llm.finish())
        if (s.includes("call_check")) return Stream.make(Llm.text(DONE), usage(50_000, 50_000), Llm.finish())
        return Stream.make(
          Llm.toolCall({ index: 0, id: "call_check", name: "shell", input: { command: COMMAND } }),
          usage(48_000, 48_000),
          Llm.finish("tool-calls"),
        )
      })
      yield* ui.submit(ASK)
      const frame = yield* ui.capture().pipe(
        Effect.flatMap((frame) => {
          const shown = text(frame)
          return shown.includes(DONE) && shown.includes("cache miss") && shown.includes("Cache ") ? Effect.succeed(frame) : Effect.fail("pending")
        }),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
        Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/cache.timeout.txt`, text(frame))))),
      )
      writeFileSync(`${out}/cache.txt`, text(frame))
      writeFileSync(`${out}/cache.json`, JSON.stringify(frame))
      // The server half judged both requests: a line each in the ledger.
      yield* Effect.try(() => readFileSync(`${out}/ledger.jsonl`, "utf8").trim().split("\n")).pipe(
        Effect.flatMap((lines) => (lines.length >= 2 ? Effect.void : Effect.fail("pending"))),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }),
        Effect.orElseSucceed(() => writeFileSync(`${out}/ledger.timeout.txt`, "the ledger never held two lines")),
      )
    }),
)
