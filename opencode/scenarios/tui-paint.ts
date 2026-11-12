// How often an idle orchestrator's TUI paints. The root sets an alarm an hour
// out, starts SUBAGENTS background workers and ends its turn: it sits idle
// while they work (each worker's model holds its answer until the scenario
// ends), which is the owner's orchestrator TUI on a quiet afternoon. A probe
// TUI plugin counts the renderer's frames, and the scenario reads them over
// WINDOW_MS twice: once before anything was asked (`quiet`), once with the
// root idle and its workers running (`orchestrator`). Replayed against
// OpenCode with a scripted model, in the owner's TUI: the Prime look and his
// other TUI plugins, animations and tabs as the host defaults them, the
// sidebar hidden.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out bunx opencode-drive run scenarios/tui-paint.ts
//
// PAINT_TRACE=1 keeps a stack per render and live request (its first lines,
// counted over the whole run) in `paint-trace.json`, to find what asks for frames.
//
// The probe (`paint-probe/`, written under SCENARIO_OUT) logs, each second, to
// `paint-probe.jsonl`: the renderer's loop count (`renderStats.frameCount`,
// every frame the loop ran), the frames it put on screen (its `frame` event),
// the render requests and the live-request count (a live request keeps the
// loop at its target rate). It writes `paint.json` under SCENARIO_OUT:
// `{ quiet, orchestrator }`, each `{ seconds, loops, rendered, requests, live }`
// with loops, rendered and requests per second over its window.
import { Array as Arr, Deferred, Effect, Option, Schedule, Schema, Stream } from "effect"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT || "out"
const TRACE = process.env.PAINT_TRACE === "1"
const SUBAGENTS = 3
const WINDOW_MS = 10_000
/** The owner's TUI plugins (his cli.json), less herdr (it needs a herdr pane) and btw (he turns it off). */
const PLUGINS = ["prime", "status", "git", "cache", "questions", "skills", "recover", "orchestrate", "escape"]

type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

// ── The probe TUI plugin ──
const probe = `${out}/paint-probe`
const log = `${out}/paint-probe.jsonl`
const entry = [
  `import { appendFileSync, writeFileSync } from "node:fs"`,
  `const LOG = ${JSON.stringify(log)}`,
  `const TRACING = ${JSON.stringify(TRACE)}`,
  `const TRACE = ${JSON.stringify(`${out}/paint-trace.json`)}`,
  `export default {`,
  `  id: "tui-paint-probe",`,
  `  setup(ctx) {`,
  `    const renderer = ctx.renderer`,
  `    let rendered = 0`,
  `    let requests = 0`,
  `    const stacks = new Map()`,
  `    const keep = (label) => {`,
  `      const stack = label + (new Error().stack ?? "").split("\\n").slice(3, 15).map((line) => line.trim()).join(" | ")`,
  `      stacks.set(stack, (stacks.get(stack) ?? 0) + 1)`,
  `    }`,
  `    renderer.on("frame", () => { rendered++ })`,
  `    const request = renderer.requestRender.bind(renderer)`,
  `    renderer.requestRender = (...args) => {`,
  `      requests++`,
  `      if (TRACING) keep("")`,
  `      return request(...args)`,
  `    }`,
  `    const live = renderer.requestLive.bind(renderer)`,
  `    renderer.requestLive = (...args) => {`,
  `      if (TRACING) keep("LIVE ")`,
  `      return live(...args)`,
  `    }`,
  `    setInterval(() => {`,
  `      appendFileSync(LOG, JSON.stringify({ at: Date.now(), loops: renderer.renderStats.frameCount, rendered, requests, live: renderer.liveRequestCount }) + "\\n")`,
  `      if (TRACING) writeFileSync(TRACE, JSON.stringify([...stacks].sort((a, b) => b[1] - a[1]), null, 1))`,
  `    }, 1000)`,
  `  },`,
  `}`,
  ``,
].join("\n")
mkdirSync(probe, { recursive: true })
writeFileSync(`${probe}/package.json`, JSON.stringify({ name: "tui-paint-probe", type: "module", exports: { "./tui": "./tui.js" } }))
writeFileSync(`${probe}/tui.js`, entry)
writeFileSync(log, "")

const Sample = Schema.Struct({ at: Schema.Number, loops: Schema.Number, rendered: Schema.Number, requests: Schema.Number, live: Schema.Number })
type Sample = typeof Sample.Type
const decodeSample = Schema.decodeUnknownSync(Sample)
const samples = (): ReadonlyArray<Sample> =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => decodeSample(JSON.parse(line)))

const EMPTY = { seconds: 0, loops: 0, rendered: 0, requests: 0, live: 0 }

/** The probe's counts between two moments, per second; the most live requests held at any sample. */
const between = (from: number, to: number) => {
  const inside = samples().filter((sample) => sample.at >= from && sample.at <= to)
  const first = inside[0]
  const last = inside.at(-1)
  if (!first || !last || last.at === first.at) return EMPTY
  const seconds = (last.at - first.at) / 1000
  const rate = (key: "loops" | "rendered" | "requests") => Number(((last[key] - first[key]) / seconds).toFixed(2))
  return { seconds, loops: rate("loops"), rendered: rate("rendered"), requests: rate("requests"), live: Math.max(...inside.map((sample) => sample.live)) }
}

/** Until the probe has logged a sample at or after `at`: the probe's own clock, read from its log, never a capture (a capture renders). */
const sampledFrom = (at: number) =>
  Effect.sync(() => samples().some((sample) => sample.at >= at)).pipe(
    Effect.repeat({ schedule: Schedule.spaced("250 millis"), until: (done) => done, times: 400 }),
  )

const ASK = "Fan the work out to workers."
const STARTED = "Workers started; waiting on them."
const WORKER = (i: number) => `Worker brief ${i}.`
const WORKERS = Array.from({ length: SUBAGENTS }, (_, i) => i)

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV || "" },
    // The backstop is `off` (jobs in memory): a scenario must not register OS jobs.
    config: { autoupdate: false, username: "Demo", plugins: [{ package: `${root}/cmd/wake`, options: { backstop: "off" } }] },
    tuiConfig: {
      theme: { name: "prime", mode: "dark" },
      session: { sidebar: "hide" },
      plugins: [...PLUGINS.map((name) => `${root}/cmd/${name}`), probe],
    },
    tui: { viewport: { cols: 160, rows: 45 } },
    project: { git: true, files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") } },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      const finished = yield* Deferred.make<boolean>()
      const step = (id: string, name: string, input: Parameters<typeof Llm.toolCall>[0]["input"]) =>
        Stream.make(Llm.toolCall({ index: 0, id, name, input }), Llm.finish("tool-calls"))
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("fan out"), Llm.finish())
        // A worker reads its brief, then works until the scenario ends.
        const worker = Arr.findFirst(WORKERS, (i) => s.includes(WORKER(i)) && !s.includes(ASK))
        if (Option.isSome(worker))
          return Stream.make(Llm.reasoning(`Worker ${worker.value} reads the brief.`)).pipe(
            Stream.concat(Stream.fromEffect(Deferred.await(finished)).pipe(Stream.drain)),
            Stream.concat(Stream.make(Llm.text(`Worker ${worker.value} done.`), Llm.finish())),
          )
        // An orchestrator keeps an alarm for its next look: the dock counts it, read again every 2 seconds.
        if (!s.includes("call_wake")) return step("call_wake", "wake", { afterSeconds: 3600, note: "Look at the workers." })
        return Option.match(
          Arr.findFirst(WORKERS, (i) => !s.includes(`call_worker_${i}`)),
          {
            onSome: (next) =>
              step(`call_worker_${next}`, "subagent", { agent: "general", description: `Fix module ${next}`, prompt: WORKER(next), background: true }),
            onNone: () => Stream.make(Llm.text(STARTED), Llm.finish()),
          },
        )
      })
      const until = (name: string, ready: (frame: string) => boolean, times = 300) =>
        ui.capture().pipe(
          Effect.map(text),
          Effect.filterOrFail(ready, () => "pending"),
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.timeout.txt`, text(frame))))),
        )
      const save = (name: string) => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${name}.txt`, text(frame))))
      /** The probe's counts over the window, from a moment after the last capture settled. */
      const measure = Effect.gen(function* () {
        // What the last capture drew settles first: two probe samples on.
        yield* sampledFrom(Date.now() + 2_000)
        const from = Date.now()
        // One sample past the window's end, so the window holds WINDOW_MS of samples.
        yield* sampledFrom(from + WINDOW_MS + 1_000)
        return between(from, Date.now())
      })

      yield* until("ready", (frame) => frame.length > 0 && samples().length > 0)
      const quiet = yield* measure
      yield* save("quiet")

      yield* ui.submit(ASK)
      yield* until("started", (frame) => frame.includes(STARTED) && frame.includes("1 wake") && WORKERS.every((i) => frame.includes(`Fix module ${i}`)))
      const orchestrator = yield* measure
      yield* save("orchestrator")

      const result = { subagents: SUBAGENTS, windowMs: WINDOW_MS, quiet, orchestrator }
      writeFileSync(`${out}/paint.json`, JSON.stringify(result))
      console.log("paint:", JSON.stringify(result))
      // Every worker's answer ends before the driver checks each model response settled: the dock
      // counts no working subagent. (A worker's last words show on its row only between their chunk
      // and its finish, a moment a capture every 200 ms can miss; once done, the row reads `1 step`.)
      yield* Deferred.succeed(finished, true)
      yield* until("finished", (frame) => frame.includes("◆ 0 subagents"), 300)
    }),
)
