// The background-work panel (Down on an empty prompt) in the Prime look, with
// the wake plugin, against OpenCode with a scripted model: the root starts five
// background subagents (each runs one command, then works on), two background
// shells, an alarm and a monitor, and ends its turn. Then, at 160 columns and
// again at 80, Down opens the panel and → walks it: Subagents, Shell, then past
// Terminals to Wakes and Monitors.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out OPENCODE_DRIVE_MEDIA_DIR=<dir> bunx opencode-drive run scenarios/prime-panel.ts
//
// It writes, under SCENARIO_OUT, `panel-<cols>-<tab>.txt` and `.json` for each
// tab at each width (`subagents`, `shell`, `wakes`, `monitors`), and
// `panel-160-tick`: the Subagents tab again once its rows' times moved on.
// `BEFORE=1` runs it against a look without the panel slots: it keeps the same
// frames, but waits on no time moving. It waits on what the frame shows, never
// on a clock; a wait that runs out writes `panel-<name>.timeout.txt`.
import { Deferred, Effect, Option, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT || "out"
const before = process.env.BEFORE === "1"
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => span.text).join("").trimEnd()).join("\n")

const ASK = "Start the five lanes, two servers, an alarm and a monitor."
const DONE = "All set."
/** The subagents, by call id: `<role> <unit> rN`, so the rows read the role apart from the unit. */
const LANES = [
  { id: "call_lane_a", description: "implementor Corpus HP r1", prompt: "Lane brief A.", look: "call_look_a", unit: "Corpus HP" },
  { id: "call_lane_b", description: "implementor EX3 later clauses r1", prompt: "Lane brief B.", look: "call_look_b", unit: "EX3 later clauses" },
  { id: "call_lane_c", description: "verifier Corpus MD r2", prompt: "Lane brief C.", look: "call_look_c", unit: "Corpus MD" },
  { id: "call_lane_d", description: "planner port phase d r1", prompt: "Lane brief D.", look: "call_look_d", unit: "port phase d" },
  { id: "call_lane_e", description: "Fold the MONO1 IR-G pass", prompt: "Lane brief E.", look: "call_look_e", unit: "Fold the MONO1" },
]
const SHELLS = ["printf 'serving on :4000\\n'; sleep 600", "printf 'watching src\\n'; sleep 600"]
const ALARM = "Check the deploy"
const MONITOR = "echo still-waiting"

type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]
const call = (id: string, name: string, input: ToolInput) => Stream.make(Llm.toolCall({ index: 0, id, name, input }), Llm.finish("tool-calls"))
const say = (words: string) => Stream.make(Llm.text(words), Llm.finish())

/** The root's steps, in order, by the call id each is seen by in the next request. */
const STEPS: ReadonlyArray<{ readonly id: string; readonly name: string; readonly input: ToolInput }> = [
  ...LANES.map((lane) => ({ id: lane.id, name: "subagent", input: { agent: "general", description: lane.description, prompt: lane.prompt, background: true } })),
  ...SHELLS.map((command, at) => ({ id: `call_server_${at}`, name: "shell", input: { command, background: true } })),
  { id: "call_wake", name: "wake", input: { afterSeconds: 600, note: `${ALARM}: the canary` } },
  { id: "call_monitor", name: "monitor", input: { command: MONITOR, intervalSeconds: 1, until: "^READY$", note: "the service is up" } },
]

/** The time the Corpus HP row shows, as the Prime row ends: `working  12s`. */
const corpusTime = (frame: string) =>
  Option.fromNullishOr(/Corpus HP r1 .* working +(\S+)/.exec(frame)).pipe(Option.flatMap((match) => Option.fromNullishOr(match[1])), Option.getOrElse(() => ""))

/** The lines under the panel's tab bar: the tab's rows and its footer. */
const panel = (frame: string) => {
  const lines = frame.split("\n")
  const bar = lines.findIndex((line) => line.includes("Subagents") && line.includes("Monitors"))
  return lines.slice(Math.max(0, bar)).join("\n")
}

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV || "" },
    config: { autoupdate: false, username: "Demo", plugins: [{ package: `${root}/cmd/wake`, options: { backstop: "off" } }] },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`],
    },
    tui: { viewport: { cols: 160, rows: 40 } },
    project: { git: true, files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") } },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      // The lanes work on until the scenario is done, so every row stays live.
      const release = yield* Deferred.make<boolean>()
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        if (s.includes("You name conversations")) return say("panel fixture")
        const lane = Option.fromUndefinedOr(LANES.find((each) => s.includes(each.prompt) && !s.includes(ASK)))
        if (Option.isSome(lane) && !s.includes(lane.value.look))
          return Stream.make(
            Llm.text(`Reading the ${lane.value.unit} sources.`),
            Llm.toolCall({ index: 0, id: lane.value.look, name: "shell", input: { command: `printf '${lane.value.prompt}\\n'` } }),
            Llm.finish("tool-calls"),
          )
        if (Option.isSome(lane))
          return Stream.make(Llm.text(`Porting ${lane.value.unit}`)).pipe(
            Stream.concat(Stream.fromEffect(Deferred.await(release)).pipe(Stream.drain)),
            Stream.concat(Stream.make(Llm.text(" done."), Llm.finish())),
          )
        const next = STEPS.find((step) => !s.includes(step.id))
        if (next) return call(next.id, next.name, next.input)
        return say(DONE)
      })

      const until = (name: string, ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.map(text),
          Effect.filterOrFail(ready, () => "pending"),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/panel-${name}.timeout.txt`, text(frame))))),
        )
      const keep = (name: string) =>
        Effect.gen(function* () {
          const { images: _, ...frame } = yield* ui.capture()
          writeFileSync(`${out}/panel-${name}.txt`, text(frame))
          writeFileSync(`${out}/panel-${name}.json`, JSON.stringify(frame))
          console.log("screenshot:", yield* ui.screenshot(`panel-${name}`))
          return text(frame)
        })
      const shows = (needles: ReadonlyArray<string>) => (frame: string) => needles.every((needle) => panel(frame).includes(needle))

      /** Opens the panel at `cols` columns and keeps each tab. */
      const walk = (cols: number) =>
        Effect.gen(function* () {
          yield* ui.resize({ cols, rows: 40 })
          yield* until(`${cols}-resized`, (frame) => frame.split("\n").every((line) => Array.from(line).length <= cols) && !frame.includes("Subagents"))
          yield* ui.press("down")
          yield* until(`${cols}-subagents`, shows(["Monitors", ...LANES.map((lane) => lane.unit.slice(0, 6))]))
          const first = yield* keep(`${cols}-subagents`)
          // The rows' times move on with the clock, the rows redrawn in place.
          if (cols === 160 && !before) {
            const was = corpusTime(panel(first))
            yield* until("160-tick", (frame) => corpusTime(panel(frame)) !== "" && corpusTime(panel(frame)) !== was)
            yield* keep("160-tick")
          }
          yield* ui.press("right")
          yield* until(`${cols}-shell`, shows(["serving on :4000", "watching src"].map((line) => line.slice(0, 7))))
          yield* keep(`${cols}-shell`)
          yield* ui.press("right")
          yield* ui.press("right")
          yield* until(`${cols}-wakes`, shows([ALARM]))
          yield* keep(`${cols}-wakes`)
          yield* ui.press("right")
          yield* until(`${cols}-monitors`, (frame) => shows([MONITOR])(frame) && !panel(frame).includes("not checked yet"))
          yield* keep(`${cols}-monitors`)
          yield* ui.press("escape")
          yield* until(`${cols}-closed`, (frame) => !frame.includes("Monitors"))
        })

      yield* ui.submit(ASK)
      yield* until("set", (frame) => frame.includes(DONE) && frame.includes("5 subagents") && frame.includes("2 shells") && frame.includes("1 monitor"))
      yield* walk(160)
      yield* walk(80)
      yield* Deferred.succeed(release, true)
    }),
)
