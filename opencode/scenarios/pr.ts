// The pr tool and its watcher in real OpenCode, with the real git server
// plugin and a stand-in `gh` (mods/git/process/fake-gh.ts) first on PATH,
// answering from a world file the scenario moves. The model watches the
// session's request while its checks run and ends its turn; the scenario then
// makes the checks pass, the watcher's next tick reads it, and its notice
// comes into the session as a `◈` row and wakes it for a turn.
import { Effect, Schedule, Stream } from "effect"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Llm, OpenCodeDriver } from "opencode-drive"
import { type FakeWorld, install } from "../mods/git/process/fake-gh.ts"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
const theme = process.env.SCENARIO_THEME ?? "prime"

const WORLD: FakeWorld = {
  repo: "biteinc/maitred",
  branchRequest: 412,
  requests: [{ number: 412, title: "Pay with points", head: "aaaaaaaa11", checks: [{ name: "test", word: "IN_PROGRESS", jobId: 9 }] }],
  branch: { name: "master", head: "bbbbbbbb22", checks: [{ name: "build", word: "SUCCESS" }] },
}
// A bundled scenario has no path of its own to fake-gh.ts: name the source.
const gh = install(out, WORLD, join(root, "mods/git/process/fake-gh.ts"))

type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]
const step = (id: string, name: string, input: ToolInput) => Stream.make(Llm.toolCall({ index: 0, id, name, input }), Llm.finish("tool-calls"))
const say = (text: string) => Stream.make(Llm.text(text), Llm.finish())

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV!, env: { ...gh.env, PATH: `${gh.bin}:${process.env.PATH ?? ""}` } },
    config: { autoupdate: false, plugins: [{ package: `${root}/cmd/git`, options: { intervalSeconds: 0.5 } }] },
    // The pr call its own row, as these frames read it; the default (low) verbosity folds a turn's calls into one.
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: theme, mode: "dark" },
      plugins: [`${root}/cmd/prime`],
      session: { verbosity: "medium" },
    },
    tui: { viewport: { cols: Number(process.env.SCENARIO_COLS ?? 144), rows: 50 } },
    project: { git: true, files: { "a.ts": "one\n" } },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.serve((input) => {
        const text = JSON.stringify(input)
        if (text.includes("You name conversations")) return say("PR watch")
        if (text.includes("PR watch · biteinc/maitred#412")) return say("pr-notice-read")
        if (text.includes("call_watch")) {
          // What the model read back from the tool, for a failure to name.
          writeFileSync(join(out, "pr-tool-result.json"), text)
          return say("pr-watch-set")
        }
        return step("call_watch", "pr", { action: "watch", note: "merge it when green" })
      })
      type Frame = { lines: readonly { spans: readonly { text: string }[] }[] }
      const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((s) => s.text).join("").trimEnd()).join("\n")
      const until = (ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 200 }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((f) => writeFileSync(join(out, "pr-timeout.txt"), text(f))))),
        )

      yield* ui.submit("watch-my-pr")
      yield* until((frame) => frame.includes("pr-watch-set"))
      writeFileSync(join(out, "pr-watch.txt"), text(yield* ui.capture()))

      // The checks pass; the watcher's next tick reads it and tells the session.
      gh.put({ ...WORLD, requests: [{ ...WORLD.requests[0]!, checks: [{ name: "test", word: "SUCCESS", jobId: 9 }] }] })
      yield* until((frame) => frame.includes("pr-notice-read"))
      writeFileSync(join(out, "pr-notice.txt"), text(yield* ui.capture()))
      console.log("screenshot:", yield* ui.screenshot("pr-notice"))
      writeFileSync(join(out, "gh-calls.json"), JSON.stringify(gh.calls()))
    }),
)
