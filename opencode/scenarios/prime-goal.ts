// The Prime dock with a background shell and a wake, then a session goal
// through its life: set, paused, resumed and cancelled. A scripted model starts
// `sleep 3600` in the background and sets a wake an hour out; the dock counts
// both and shows no goal. `/goal` sets one: each round the model runs a shell
// command and answers, and the goal's reviewer (the same scripted model) says
// continue twice, then wait (the background shell is running, so waiting is
// allowed and the session goes idle with the goal active). `/goal pause`,
// `/goal resume` (one more round, then wait) and `/goal cancel` follow.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out bunx opencode-drive run scenarios/prime-goal.ts
//
// It writes, under SCENARIO_OUT, `prime-goal-<name>.txt` and `.json` for the frames
// `dock` (shell and wake, no goal), `active` (two rounds sent), `paused`,
// `resumed` (one round since the resume) and `cancelled`, a screenshot of
// each, `prime-goal-timeout.txt` (and the run's server and TUI logs in
// `prime-goal-timeout.logs`) when a wait times out and
// `prime-goal-requests.json` (each model request, tagged root, reviewer or
// title).
import { Effect, Schedule, Stream } from "effect"
import { cpSync, readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
const label = "prime-goal"

type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]
const call = (id: string, name: string, input: ToolInput) => Stream.make(Llm.toolCall({ index: 0, id, name, input }), Llm.finish("tool-calls"))
const say = (text: string) => Stream.make(Llm.text(text), Llm.finish())

/** The fork's goal reviewer prompt (packages/core/src/plugin/goal/judge.txt). */
const REVIEWER = "You are now the reviewer for the session's goal"
/** The reviewer's answers in order: two rounds, then wait on the shell; after the resume, wait again. */
const VERDICTS = [
  { verdict: "continue", reason: "Round one ran; the dock still needs its goal state", next_step: "Run round two" },
  { verdict: "continue", reason: "Round two ran; the colours are not checked yet", next_step: "Run round three" },
  { verdict: "wait", reason: "sleep 3600 is still running" },
  { verdict: "wait", reason: "sleep 3600 is still running after the resume" },
]

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    config: { autoupdate: false, username: "Demo", plugins: [{ package: `${root}/cmd/wake`, options: { backstop: "off" } }] },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`],
      // Each call its own row, as these frames read them; the default (low) folds a turn's calls into one.
      session: { verbosity: "medium" },
    },
    tui: { viewport: { cols: 150, rows: 50 } },
    project: { git: true, files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") } },
  },
  ({ ui, llm, artifacts }) =>
    Effect.gen(function* () {
      const requests: Array<{ readonly session: "root" | "reviewer" | "title"; readonly request: string }> = []
      let goal = false
      let judged = 0
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        if (s.includes("You name conversations")) {
          requests.push({ session: "title", request: s })
          return say("Goal dock fixture")
        }
        if (s.includes(REVIEWER)) {
          requests.push({ session: "reviewer", request: s })
          const verdict = VERDICTS[judged] ?? VERDICTS.at(-1)!
          judged += 1
          return say(JSON.stringify(verdict))
        }
        requests.push({ session: "root", request: s })
        if (!goal) {
          if (!s.includes("call_shell")) return call("call_shell", "shell", { command: "sleep 3600", background: true })
          if (!s.includes("call_wake")) return call("call_wake", "wake", { afterSeconds: 3600, note: "Check the dock again" })
          return say("Shell and wake set.")
        }
        // A round: one command (so the reviewer sees progress), then a line saying it ran.
        const id = `call_round_${judged}`
        if (!s.includes(id)) return call(id, "shell", { command: `echo round ${judged}` })
        return say(`Round ${judged} ran.`)
      })

      type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
      const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => span.text).join("").trimEnd()).join("\n")
      const dump = Effect.sync(() => writeFileSync(`${out}/${label}-requests.json`, JSON.stringify(requests, null, 2)))
      const until = (ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
          Effect.tapError(() =>
            ui.capture().pipe(
              Effect.map((frame) => writeFileSync(`${out}/${label}-timeout.txt`, text(frame))),
              Effect.andThen(dump),
              // The run's server and TUI logs go with the run; keep them beside the frame.
              Effect.andThen(Effect.sync(() => cpSync(`${artifacts}/logs`, `${out}/${label}-timeout.logs`, { recursive: true }))),
            ),
          ),
        )
      const keep = (name: string) =>
        Effect.gen(function* () {
          const { images: _, ...frame } = yield* ui.capture()
          writeFileSync(`${out}/${label}-${name}.txt`, text(frame))
          writeFileSync(`${out}/${label}-${name}.json`, JSON.stringify(frame))
          console.log("screenshot:", yield* ui.screenshot(`${label}-${name}`))
        })
      const idle = (frame: string) => !frame.includes("Executing")

      // A background shell and a wake: the dock counts both, and shows no goal.
      yield* ui.submit("prime-goal-fixture")
      yield* until((frame) => frame.includes("Shell and wake set.") && frame.includes("1 shell  ·  1 wake") && idle(frame))
      yield* keep("dock")

      // The goal: two continued rounds, then the reviewer waits on the shell and the session idles, the goal active.
      goal = true
      yield* ui.submit("/goal ship the goal dock")
      yield* until((frame) => judged >= 3 && frame.includes("Round 2 ran.") && frame.includes("2↻") && idle(frame))
      yield* Effect.sleep("500 millis")
      yield* keep("active")

      yield* ui.submit("/goal pause")
      yield* until((frame) => frame.includes("‖ goal paused"))
      yield* keep("paused")

      // The resume sends one continuation (round 1 of the new budget); the model runs it, and the reviewer waits again.
      yield* ui.submit("/goal resume")
      yield* until((frame) => judged >= 4 && frame.includes("Round 3 ran.") && frame.includes("1↻") && idle(frame))
      yield* Effect.sleep("500 millis")
      yield* keep("resumed")

      yield* ui.submit("/goal cancel")
      yield* until((frame) => !frame.includes("● goal") && !frame.includes("goal paused"))
      yield* keep("cancelled")
      yield* dump
    }),
)
