// Opus first, Codex second, in real OpenCode with the Prime look: the
// orchestrate and wakes plugins, a stand-in pool whose pace holds every new
// agent on the first model's provider, and a second provider standing in for
// Codex, with two sol models. The parent starts a worker in the foreground;
// the pool holds its model, the Codex admission script admits the newest
// sol, so the worker starts at once on it instead of latching, runs, and its
// answer, led by the line saying where it ran and why, reaches the parent.
// Replayed against OpenCode with a scripted model.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out bunx opencode-drive run scenarios/prime-fallback.ts
//
// Under SCENARIO_OUT: the stand-in pool (`fake-pool/`, each answer a line of
// `pace.jsonl`), the admission script (`admit.ts`, each ask a line of
// `admit.jsonl`), the call log (`agents.jsonl`), and
// - `fallback-done`: the worker ran and its answer reached the parent;
// - `fallback-requests.json`: the worker's request and the parent's last one.
// Each frame is a `.txt` of its text and a `.json` of its styled lines.
import { Effect, Schedule, Stream } from "effect"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

/** The orchestrate plugin's fixed clock: a Wednesday afternoon, so only the pace holds. */
const PIN = "2026-11-04T15:00:00Z"

// ── The stand-in pool: it holds the first model's provider, and logs each answer and start ──
const pool = `${out}/fake-pool`
const paceLog = `${out}/pace.jsonl`
mkdirSync(pool, { recursive: true })
writeFileSync(`${pool}/package.json`, JSON.stringify({ name: "fallback-scenario-pool", type: "module", exports: { "./server": "./server.js" } }))
writeFileSync(
  `${pool}/server.js`,
  [
    `import { appendFileSync } from "node:fs"`,
    `const io = { input: { type: "object" }, output: { type: "object" } }`,
    `export default { id: "fixture.pool", async setup(ctx) {`,
    `  await ctx.rpc.register({ id: "dotfiles-opencode.pool", methods: { pace: io, started: io }, events: {} }, {`,
    `    pace: async ({ providerID }) => {`,
    `      const answer = { ok: false, measured: true, reason: "scripted 5h window is full", retryAt: Date.parse(${JSON.stringify(PIN)}) + 3_600_000 }`,
    `      appendFileSync(${JSON.stringify(paceLog)}, JSON.stringify({ at: Date.now(), providerID, ...answer }) + "\\n")`,
    `      return answer`,
    `    },`,
    `    started: async ({ providerID }) => { appendFileSync(${JSON.stringify(paceLog)}, JSON.stringify({ at: Date.now(), providerID, started: true }) + "\\n"); return {} },`,
    `  })`,
    `} }`,
    ``,
  ].join("\n"),
)
writeFileSync(paceLog, "")

// ── The stand-in Codex admission: it admits, and logs what it was asked ──
const admit = `${out}/admit.ts`
const admitLog = `${out}/admit.jsonl`
writeFileSync(
  admit,
  [
    `import { appendFileSync } from "node:fs"`,
    `appendFileSync(${JSON.stringify(admitLog)}, JSON.stringify(process.argv.slice(2)) + "\\n")`,
    `console.log("admit: scripted room")`,
    ``,
  ].join("\n"),
)
writeFileSync(admitLog, "")

// ── The model ──
const ASK = "Check the export in a worker."
const BRIEF = "Worker brief F: check the CSV export."
const ANSWER = "The export check passed."
const HEARD = "Root heard: the export check passed."

const finish = (words: string) => Stream.make(Llm.text(words), Llm.finish())
type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]
const call = (id: string, name: string, input: ToolInput) => Stream.make(Llm.toolCall({ index: 0, id, name, input }), Llm.finish("tool-calls"))

/** A stand-in Codex model: the sim's OpenAI chat endpoint answers it as it answers the first provider. */
const sol = (releaseDate: string) => ({
  family: "gpt-sol",
  releaseDate,
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  limit: { context: 128_000, output: 16_000 },
  variants: [{ id: "high" }],
})

export default OpenCodeDriver.use(
  {
    opencode: process.env.OPENCODE_DEV ? { dev: process.env.OPENCODE_DEV } : undefined,
    config: {
      autoupdate: false,
      username: "Demo",
      providers: {
        codex: {
          name: "Codex",
          package: "@opencode-ai/ai/providers/openai/chat",
          settings: { apiKey: "sim-key" },
          models: { "gpt-6-sol": sol("2026-06-01"), "gpt-6.1-sol": sol("2026-09-29") },
        },
      },
      plugins: [
        {
          package: `${root}/cmd/orchestrate`,
          options: { now: PIN, log: `${out}/agents.jsonl`, codex: { providers: ["codex"], script: admit } },
        },
        { package: `${root}/cmd/wake`, options: { backstop: "off" } },
        { package: pool },
      ],
    },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`],
    },
    tui: { viewport: { cols: 110, rows: 40 } },
    project: {
      git: true,
      files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      const requests: Array<string> = []
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        requests.push(s)
        if (s.includes("You name conversations")) return finish("export check")
        // The worker's request carries its brief, never the parent's prompt.
        if (!s.includes(ASK)) return s.includes(BRIEF) ? finish(ANSWER) : finish("?")
        if (s.includes(ANSWER)) return finish(HEARD)
        if (!s.includes("call_worker")) return call("call_worker", "subagent", { agent: "worker", description: "Check the export", prompt: BRIEF })
        return finish("?")
      })
      const until = (name: string, ready: (frame: string) => boolean, times = 400) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) && !text(frame).includes("Finishing startup") ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.timeout.txt`, text(frame))))),
        )
      const save = (name: string) =>
        Effect.gen(function* () {
          const { images: _, ...frame } = yield* ui.capture()
          writeFileSync(`${out}/${name}.txt`, text(frame))
          writeFileSync(`${out}/${name}.json`, JSON.stringify(frame))
          console.log("screenshot:", yield* ui.screenshot(name))
        })

      yield* ui.submit(ASK)
      yield* until("fallback-done", (frame) => frame.includes(HEARD), 600)
      yield* save("fallback-done")
      writeFileSync(
        `${out}/fallback-requests.json`,
        JSON.stringify({
          worker: requests.find((request) => request.includes(BRIEF) && !request.includes(ASK)) ?? "",
          parent: requests.findLast((request) => request.includes(ASK) && request.includes(ANSWER)) ?? "",
        }),
      )
    }),
)
