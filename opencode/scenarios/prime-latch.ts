// A latched subagent in real OpenCode, in the Prime look, with the
// orchestrate and wakes plugins and a stand-in pool whose pace holds every
// new agent for the first twelve seconds, six at a time, then admits. The parent starts a
// worker in the foreground; the pace holds it, so the call latches: it
// answers at once that the worker waits and when it opens, the parent goes
// on, and the worker's row beneath the composer reads latched. The wakes
// decide the latch again at its time (still held, it latches again), then
// the pace admits, the worker starts in the background on the child made
// when it latched, and its answer wakes the parent. Replayed against
// OpenCode with a scripted model.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out bunx opencode-drive run scenarios/prime-latch.ts
//
// The stand-in pool is a plugin package under SCENARIO_OUT (`fake-pool/`)
// serving the pool's `pace` and `started`; each answer it gives is a line of
// `pace.jsonl`. A hold's `retryAt` is on the orchestrate plugin's fixed
// clock, which stands still at PIN: PIN plus the time left. The wakes keep
// the system's time, and the plugin moves a latch's times onto it. The
// wakes' backstop is `off` (jobs in memory).
//
// It writes, under SCENARIO_OUT:
// - `latch-latched`: the call has answered latched and the parent went on;
// - `latch-done`: the worker ran and its answer reached the parent;
// - `latch-wakes.json`: wake_list's answer while it was latched.
// Each frame is a `.txt` of its text and a `.json` of its styled lines.
import { Effect, Schedule, Stream } from "effect"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

/** How long the stand-in pool holds, from the first agent it is asked about. */
export const HOLD_MS = 12_000
/** How far ahead each hold says it opens: half the hold, so the first opening finds it still held. */
export const RETRY_MS = 6_000
/** The orchestrate plugin's fixed clock: a Wednesday afternoon, so only the pace holds. */
const PIN = "2026-11-04T15:00:00Z"

// ── The stand-in pool ──
const pool = `${out}/fake-pool`
const paceLog = `${out}/pace.jsonl`
mkdirSync(pool, { recursive: true })
writeFileSync(`${pool}/package.json`, JSON.stringify({ name: "latch-scenario-pool", type: "module", exports: { "./server": "./server.js" } }))
writeFileSync(
  `${pool}/server.js`,
  [
    `import { appendFileSync } from "node:fs"`,
    `let first`,
    `const io = { input: { type: "object" }, output: { type: "object" } }`,
    `export default { id: "fixture.pool", async setup(ctx) {`,
    `  await ctx.rpc.register({ id: "dotfiles-opencode.pool", methods: { pace: io, started: io }, events: {} }, {`,
    `    pace: async ({ providerID }) => {`,
    `      const now = Date.now()`,
    `      first ??= now`,
    `      const left = Math.min(first + ${HOLD_MS} - now, ${RETRY_MS})`,
    `      const answer = left > 0 ? { ok: false, measured: true, reason: "scripted 5h window is full", retryAt: Date.parse(${JSON.stringify(PIN)}) + left } : { ok: true, measured: true, reason: "scripted room" }`,
    `      appendFileSync(${JSON.stringify(paceLog)}, JSON.stringify({ at: now, providerID, ...answer }) + "\\n")`,
    `      return answer`,
    `    },`,
    `    started: async ({ providerID }) => { appendFileSync(${JSON.stringify(paceLog)}, JSON.stringify({ at: Date.now(), providerID, started: true }) + "\\n"); return {} },`,
    `  })`,
    `} }`,
    ``,
  ].join("\n"),
)
writeFileSync(paceLog, "")

// ── The model ──
const ASK = "Check the export in a worker."
const BRIEF = "Worker brief L: check the CSV export."
const ANSWER = "The export check passed."
const LATCHED = "Latched; I will hear back."
const HEARD = "Root heard: the export check passed."
const LIST = "List the wakes."

const finish = (words: string) => Stream.make(Llm.text(words), Llm.finish())
type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]
const call = (id: string, name: string, input: ToolInput) => Stream.make(Llm.toolCall({ index: 0, id, name, input }), Llm.finish("tool-calls"))

export default OpenCodeDriver.use(
  {
    opencode: process.env.OPENCODE_DEV ? { dev: process.env.OPENCODE_DEV } : undefined,
    config: {
      autoupdate: false,
      username: "Demo",
      // The call log stays in the run's output.
      plugins: [
        { package: `${root}/cmd/orchestrate`, options: { now: PIN, log: `${out}/agents.jsonl` } },
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
        if (s.includes(LIST)) return s.includes("call_list") ? finish("Listed.") : call("call_list", "wake_list", {})
        if (!s.includes("call_worker"))
          return call("call_worker", "subagent", { agent: "worker", description: "Check the export", prompt: BRIEF })
        return finish(s.includes("The subagent is latched") ? LATCHED : "Not latched.")
      })
      // Under load the host's startup panel can still sit beneath the rows; a
      // frame is ready only once it has gone.
      const until = (name: string, ready: (frame: string) => boolean, times = 400) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) && !text(frame).includes("Finishing startup") ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times }),
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
      const latchedRow = (frame: string) => frame.split("\n").some((line) => /◇ worker \S+ +Check the export +pace · opens \d\d:\d\d · /.test(line))

      yield* ui.submit(ASK)
      // The call answered latched, the parent's turn went on, and the row reads latched.
      yield* until("latch-latched", (frame) => frame.includes(LATCHED) && latchedRow(frame))
      yield* save("latch-latched")
      yield* ui.submit(LIST)
      yield* until("latch-listed", (frame) => frame.includes("Listed."))
      const listing = requests.findLast((request) => request.includes("call_list")) ?? ""
      writeFileSync(`${out}/latch-wakes.json`, JSON.stringify({ request: listing }))
      // The pace admits; the worker runs and its answer wakes the parent.
      yield* until("latch-done", (frame) => frame.includes(HEARD), 600)
      yield* save("latch-done")
    }),
)
