// Background shells in the Prime look. The fork moves a foreground shell call
// to the background once it outlives its limit (here 2 s, through
// `experimental.shell_background_after`) and returns its handle; the agent
// then lists the session's shells, checks the handle, waits on it a moment,
// starts a second command in the background, and kills both through their
// handles (`shell({ id, kill: true })`). The reader moves a
// blocking call (`timeout: 0`, no limit) to the background with ctrl+b, opens
// the dock's shell list with a click and kills it there with ctrl+k.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out bunx opencode-drive run scenarios/prime-shells.ts
//
// It writes, under SCENARIO_OUT, `prime-shells-<name>.txt` and `.json` for
// the frames
// - `moved`: the long call moved to the background, listed, checked and
//   waited on, and a second started in the background; `2 shells`;
// - `list`: the dock's shell list, opened by a click on `2 shells`;
// - `killed`: the agent killed both; `0 shells`;
// - `blocking`: the blocking call runs, the host offering ctrl+b;
// - `user`: the reader's ctrl+b moved the blocking call; `1 shell`;
// - `user-list`: the list after ctrl+k killed it there;
// - `user-killed`: the agent heard the kill; `0 shells`;
// a screenshot of each, `prime-shells-timeout.txt` when a wait times out and
// `prime-shells-requests.json` (each root model request).
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
const label = "prime-shells"

type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]
const call = (id: string, name: string, input: ToolInput) => Stream.make(Llm.toolCall({ index: 0, id, name, input }), Llm.finish("tool-calls"))
const say = (text: string) => Stream.make(Llm.text(text), Llm.finish())

/** The shell IDs the tool results' handle headers named (`sh_… · running · …`), in order. */
const shellIDs = (request: string) => [...new Set([...request.matchAll(/(sh_[A-Za-z0-9]+) · /g)].map((match) => match[1]!))]

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    config: { autoupdate: false, username: "Demo", experimental: { shell_background_after: 2000 } },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`],
    },
    tui: { viewport: { cols: 150, rows: 50 } },
    project: { git: true, files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") } },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      const requests: Array<string> = []
      let phase: "agent" | "kill" | "block" | "heard" = "agent"
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        if (s.includes("You name conversations")) return say("Shells fixture")
        requests.push(s)
        const [first, second, third] = shellIDs(s)
        if (phase === "agent") {
          if (!s.includes("call_long"))
            return call("call_long", "shell", { command: "printf 'tick 1\\n'; sleep 600", description: "Long sleeper" })
          if (!s.includes("call_list")) return call("call_list", "shell", { list: true })
          if (!s.includes("call_check")) return call("call_check", "shell", { id: first ?? "missing", lines: 5 })
          if (!s.includes("call_wait")) return call("call_wait", "shell", { id: first ?? "missing", wait: 500 })
          if (!s.includes("call_bg"))
            return call("call_bg", "shell", { command: "printf 'bg\\n'; sleep 600", background: true, description: "Background sleeper" })
          return say("The sleepers are still running.")
        }
        if (phase === "kill") {
          if (!s.includes("call_kill_long")) return call("call_kill_long", "shell", { id: first ?? "missing", kill: true })
          if (!s.includes("call_kill_bg")) return call("call_kill_bg", "shell", { id: second ?? "missing", kill: true })
          return say("Killed the sleepers.")
        }
        if (phase === "block") {
          // The host tells the agent of the reader's move too (its session.background notice).
          if (s.includes("Backgrounded work:")) return say("Noted the move.")
          if (!s.includes("call_block"))
            return call("call_block", "shell", { command: "sleep 300", timeout: 0, description: "Blocking sleeper" })
          return say(`Moved: ${third ?? "?"}.`)
        }
        return say("Heard the blocking sleeper was killed.")
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
      // A left click on the first cell of `needle` in the current frame.
      const click = (needle: string) =>
        Effect.gen(function* () {
          const lines = text(yield* ui.capture()).split("\n")
          const y = lines.findIndex((line) => line.includes(needle))
          if (y < 0) return yield* Effect.fail(`no line contains ${needle}`)
          const x = lines[y]!.indexOf(needle)
          yield* ui.mouse({ action: "move", x, y })
          yield* ui.mouse({ action: "down", x, y, button: "left" })
          yield* ui.mouse({ action: "up", x, y, button: "left" })
        })
      const idle = (frame: string) => !frame.includes("Executing")
      const dock = (count: string) => (frame: string) => frame.includes(`◆ 0 subagents  ·  ${count}`)

      // The limit moves the long call to the background; the agent lists, checks and waits on it, and starts another.
      yield* ui.submit("prime-shells-fixture")
      yield* until((frame) => frame.includes("The sleepers are still running.") && dock("2 shells")(frame) && idle(frame))
      yield* Effect.sleep("500 millis")
      yield* keep("moved")

      // The dock's count opens the session's shell list.
      yield* click("2 shells")
      yield* until((frame) => frame.includes("Long sleeper") && frame.includes("Background sleeper") && frame.includes("running · "))
      yield* keep("list")
      yield* ui.press("escape")
      yield* until((frame) => !frame.includes("kill ctrl+k"))

      // The agent kills both through their handles: no stop notice comes back, and the dock counts none.
      phase = "kill"
      yield* ui.submit("Kill the sleepers.")
      yield* until((frame) => frame.includes("Killed the sleepers.") && dock("0 shells")(frame) && idle(frame))
      yield* Effect.sleep("500 millis")
      yield* keep("killed")

      // A blocking call has no limit; the reader's ctrl+b moves it.
      phase = "block"
      yield* ui.submit("Run the blocking sleeper.")
      // The host offers the key once the call has run a moment.
      yield* until((frame) => frame.includes("Press ctrl+b to move running work to the background") && dock("1 shell")(frame))
      yield* keep("blocking")
      yield* ui.press("b", { ctrl: true })
      yield* until((frame) => frame.includes("Moved: sh_") && frame.includes("Noted the move.") && dock("1 shell")(frame) && idle(frame))
      yield* Effect.sleep("500 millis")
      yield* keep("user")

      // The reader kills it from the list; the agent hears of it.
      phase = "heard"
      yield* click("1 shell")
      yield* until((frame) => frame.includes("Blocking sleeper") && frame.includes("running · "))
      yield* ui.press("k", { ctrl: true })
      yield* until((frame) => frame.includes("Blocking sleeper killed · "))
      yield* keep("user-list")
      yield* ui.press("escape")
      yield* until((frame) => frame.includes("Heard the blocking sleeper was killed.") && dock("0 shells")(frame) && idle(frame))
      yield* Effect.sleep("500 millis")
      yield* keep("user-killed")
      yield* dump
    }),
)
