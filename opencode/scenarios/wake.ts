// Wakes in real OpenCode, with a scripted model, in the Prime look:
// - step-wake: the root sets a 3 s alarm and ends its turn; the alarm wakes the idle
//   session with its note, and the model answers it.
// - step-notify: a 2 s notice; its fire starts no turn, the tray counts it, and the
//   next turn (step-after-notice) reads it.
// - step-monitor: a monitor checks a command every second until its stdout says READY
//   (about 3 s on), then wakes the session with the note and the last output.
// - step-cancel: a 4 s alarm, cancelled with wake_cancel; it never fires.
// - step-reload: an 8 s alarm, then the plugin reloads (its entry is rewritten, so
//   the module watcher loads it again) before the alarm is due; it fires once.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out bunx opencode-drive run scenarios/wake.ts
//
// The server plugin loads through a wrapper package under SCENARIO_OUT
// (`wake-plugin/`), which re-exports cmd/wake/server.ts and appends `rev N <epoch ms>`
// to `wake-plugin.log` each time it activates; rewriting it to rev 2 is the reload.
// The backstop is `off` (jobs in memory): a scenario must not register OS jobs.
//
// It writes, under SCENARIO_OUT, `wake-<name>.txt` and `.json` for each kept
// frame (`pending`, `alpha`, `notice`, `after-notice`, `monitor-pending`,
// `gamma`, `cancelled`, `reload-pending`, `epsilon`), a screenshot of some,
// `wake-timeout.txt` when a wait times out, `wake-requests.json` (each model
// request, with when it came and from which session) and `wake-transcripts.json`.
import { Effect, Schedule, Stream } from "effect"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"

// ── The reloadable plugin entry ──
const wrapper = `${out}/wake-plugin`
const revisions = `${out}/wake-plugin.log`
const entry = (rev: number) =>
  [
    `import { appendFileSync } from "node:fs"`,
    `import plugin from ${JSON.stringify(`${root}/cmd/wake/server.ts`)}`,
    `// rev ${rev}`,
    `export default {`,
    `  id: plugin.id,`,
    `  effect: (ctx) => {`,
    `    appendFileSync(${JSON.stringify(revisions)}, \`rev ${rev} \${Date.now()}\\n\`)`,
    `    return plugin.effect(ctx)`,
    `  },`,
    `}`,
    ``,
  ].join("\n")
mkdirSync(wrapper, { recursive: true })
writeFileSync(`${wrapper}/package.json`, JSON.stringify({ name: "wake-scenario-plugin", type: "module", exports: { "./server": "./server.js" } }, null, 2))
writeFileSync(`${wrapper}/server.js`, entry(1))
writeFileSync(revisions, "")

// ── The model ──
type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]
const call = (id: string, name: string, input: ToolInput) => Stream.make(Llm.toolCall({ index: 0, id, name, input }), Llm.finish("tool-calls"))
const say = (text: string) => Stream.make(Llm.text(text), Llm.finish())

const READY_AT = { value: 0 }
const MONITOR_COMMAND = () => `if [ "$(date +%s)" -ge ${READY_AT.value} ]; then echo READY; else echo waiting; fi`

/** The root's next step: the reply to whatever came last in its conversation. */
const rules: ReadonlyArray<readonly [string, (request: string) => Stream.Stream<Llm.Output>]> = [
  ["step-wake", () => call("call_wake_alpha", "wake", { afterSeconds: 3, note: "ALPHA: check that the build finished" })],
  ["call_wake_alpha", () => say("Alpha alarm set.")],
  ["Note: ALPHA", () => say("Woke on alpha.")],
  ["step-notify", () => call("call_notify_beta", "wake", { afterSeconds: 2, mode: "notify", note: "BETA: glance at the deploy" })],
  ["call_notify_beta", () => say("Beta notice set.")],
  ["step-after-notice", (s) => say(s.includes("Note: BETA") ? "Saw the beta notice." : "Missed the beta notice.")],
  [
    "step-monitor",
    () => call("call_monitor_gamma", "monitor", { command: MONITOR_COMMAND(), intervalSeconds: 1, until: "^READY$", note: "GAMMA: the service is up" }),
  ],
  ["call_monitor_gamma", () => say("Gamma monitor set.")],
  ["Note: GAMMA", () => say("Woke on gamma.")],
  ["step-cancel", () => call("call_wake_delta", "wake", { afterSeconds: 4, note: "DELTA: should never fire" })],
  [
    "call_wake_delta",
    (s) => {
      const id = /Alarm (w[0-9a-z]+) set/.exec(s.slice(s.lastIndexOf("call_wake_delta")))?.[1] ?? "missing"
      return call("call_cancel_delta", "wake_cancel", { id })
    },
  ],
  ["call_cancel_delta", (s) => say(s.includes("Cancelled w") ? "Delta cancelled." : "Delta not cancelled.")],
  ["Note: DELTA", () => say("Delta fired after all.")],
  ["step-reload", () => call("call_wake_epsilon", "wake", { afterSeconds: 8, note: "EPSILON: survive the reload" })],
  ["call_wake_epsilon", () => say("Epsilon alarm set.")],
  ["Note: EPSILON", () => say("Woke on epsilon.")],
]
const reply = (s: string) => {
  const last = rules.map(([marker, respond]) => ({ at: s.lastIndexOf(marker), respond })).toSorted((left, right) => right.at - left.at)[0]
  return last === undefined || last.at < 0 ? say("Nothing to do.") : last.respond(s)
}

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    config: { autoupdate: false, username: "Demo", plugins: [{ package: wrapper, options: { backstop: "off" } }] },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/mods/prime`, `${root}/cmd/wake`],
    },
    tui: { viewport: { cols: 150, rows: 50 } },
    project: { git: true, files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") } },
  },
  ({ ui, llm, opencode }) =>
    Effect.gen(function* () {
      const requests: Array<{ readonly session: "root" | "title"; readonly at: number; readonly request: string }> = []
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        const title = s.includes("You name conversations")
        requests.push({ session: title ? "title" : "root", at: Date.now(), request: s })
        return title ? say("Wake fixture") : reply(s)
      })

      type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
      const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => span.text).join("").trimEnd()).join("\n")
      const dump = Effect.gen(function* () {
        writeFileSync(`${out}/wake-requests.json`, JSON.stringify(requests, null, 2))
        const page = yield* opencode.session.list()
        const transcripts = yield* Effect.forEach(page.data, (session) =>
          opencode.session.context({ sessionID: session.id }).pipe(Effect.map((messages) => ({ id: session.id, parentID: session.parentID, title: session.title, messages }))),
        )
        writeFileSync(`${out}/wake-transcripts.json`, JSON.stringify(transcripts, null, 2))
      })
      const until = (ready: (frame: string) => boolean, times = 300) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/wake-timeout.txt`, text(frame))), Effect.andThen(dump))),
        )
      const keep = (name: string, screenshot = false) =>
        Effect.gen(function* () {
          const { images: _, ...frame } = yield* ui.capture()
          writeFileSync(`${out}/wake-${name}.txt`, text(frame))
          writeFileSync(`${out}/wake-${name}.json`, JSON.stringify(frame))
          if (screenshot) console.log("screenshot:", yield* ui.screenshot(`wake-${name}`))
        })
      const tray = (frame: string) => frame.split("\n").find((line) => line.includes("⏰")) ?? ""

      // A 3 s alarm wakes the idle session with its note.
      yield* ui.submit("step-wake")
      yield* until((frame) => frame.includes("Alpha alarm set.") && tray(frame).includes("1 wake"))
      yield* keep("pending", true)
      yield* until((frame) => frame.includes("Woke on alpha.") && tray(frame) === "")
      yield* keep("alpha", true)

      // A notice starts no turn: the tray counts it until the next turn reads it.
      yield* ui.submit("step-notify")
      yield* until((frame) => frame.includes("Beta notice set.") && tray(frame).includes("1 notice"))
      yield* keep("notice", true)
      // Past its time and some: still no turn.
      yield* Effect.sleep("3 seconds")
      yield* ui.submit("step-after-notice")
      yield* until((frame) => frame.includes("Saw the beta notice.") || frame.includes("Missed the beta notice."))
      yield* until((frame) => !tray(frame).includes("notice"))
      yield* keep("after-notice")

      // A monitor wakes the session once its command prints READY.
      READY_AT.value = Math.floor(Date.now() / 1000) + 4
      yield* ui.submit("step-monitor")
      yield* until((frame) => frame.includes("Gamma monitor set.") && tray(frame).includes("1 monitor"))
      yield* keep("monitor-pending", true)
      yield* until((frame) => frame.includes("Woke on gamma."))
      yield* keep("gamma")

      // A cancelled alarm never fires.
      yield* ui.submit("step-cancel")
      yield* until((frame) => frame.includes("Delta cancelled.") || frame.includes("Delta not cancelled."))
      yield* Effect.sleep("6 seconds")
      yield* keep("cancelled")

      // A reload before the alarm is due: it fires once.
      yield* ui.submit("step-reload")
      yield* until((frame) => frame.includes("Epsilon alarm set.") && tray(frame).includes("1 wake"))
      yield* keep("reload-pending", true)
      writeFileSync(`${wrapper}/server.js`, entry(2))
      yield* Effect.sync(() => readFileSync(revisions, "utf8")).pipe(
        Effect.flatMap((log) => (log.includes("rev 2") ? Effect.void : Effect.fail("not reloaded"))),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
      )
      yield* until((frame) => frame.includes("Woke on epsilon."), 200)
      // Room for a second fire, were there one.
      yield* Effect.sleep("4 seconds")
      yield* keep("epsilon", true)
      yield* dump
    }),
)
