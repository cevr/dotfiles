// @reads all
// @reads-reason native TUI plugin loader reads at sim-tui/app.ts: createAppFixture({
// A session's jobs in the dock and the composer panel, on the simulated TUI
// (sim-tui/): the fork's real TUI in this process with Prime loaded by path,
// in front of the server double, on a virtual clock. The wake server plugin is
// a stand-in on the double (`rpc`): its `jobs` answers the seed's one job,
// running until the seed ends it or kills it, its `kill` ends it as killed,
// and its `pending` answers no wakes. While the job runs the dock counts
// `1 job` beside the shells; the panel's Jobs tab (↓ on an empty composer,
// then → to it) lists it with its id, note, command, state and time, and its
// log tail under the row. Once it exits the dock drops it and the tab says
// `exited 3`; ctrl+d on a running one asks the server to kill it, and the tab
// says `killed`.
import { Effect, Option, Schema } from "effect"
import type { JobShown } from "@dotfiles/opencode-wake/job"
import { WAKES } from "@dotfiles/opencode-wake/wake"
import * as App from "../../sim-tui/app.ts"
import { type Model, type Rpc, text } from "../../sim-tui/server.ts"

const FILE = "cmd/prime/prime-jobs.sim.test.tsx"
/** Seeds this file runs: a seed boots a session, opens the panel and waits on two readings, so 3 a case keep most of the file's 5 s free. */
const SEEDS = 3
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime"], width: 140, height: 30 }

App.bootTest(BOOT)

const ID = "jdock01"
const NOTE = "Read the build's failures."
const COMMAND = "bun run build --verbose"
const LOG = "compiling 12 files\nlinking\nLAST-LOG-LINE"
const model: Model = () => [text("Done.")]

/** The stand-in's one job: running from the epoch until the seed ends it. */
type Job = { state: JobShown["state"]; exitCode?: number; endedAt?: number }

const Session = Schema.Struct({ sessionID: Schema.String })
const Kill = Schema.Struct({ sessionID: Schema.String, id: Schema.String })

/** The wake RPC's stand-in over `job`, recording the id of each kill it was asked for. */
const wakes = (job: Job, killed: Array<string>): Rpc => (call) => {
  if (call.rpcID !== WAKES.id) return Option.none()
  if (call.method === "pending") return Option.some({ now: App.EPOCH, entries: [], notices: [] })
  if (call.method === "kill")
    return Schema.decodeUnknownOption(Kill)(call.input).pipe(
      Option.map(({ id }) => {
        killed.push(id)
        Object.assign(job, { state: "killed", endedAt: App.EPOCH + 9000 })
        return { outcome: "killed" }
      }),
    )
  if (call.method !== "jobs") return Option.none()
  return Schema.decodeUnknownOption(Session)(call.input).pipe(
    Option.map(({ sessionID }) => ({
      now: App.EPOCH,
      jobs: [
        {
          id: ID,
          sessionID,
          note: NOTE,
          command: COMMAND,
          cwd: "/nonexistent/loop-probe-x",
          setAt: App.EPOCH,
          startedAt: App.EPOCH,
          logTail: LOG,
          ...job,
        } satisfies JobShown,
      ],
    })),
  )
}

const has = (shown: string) => (frame: ReadonlyArray<string>) => frame.join("\n").includes(shown)
/** The dock's count line: the row that counts the subagents. */
const dock = (frame: ReadonlyArray<string>) => frame.find((line) => line.includes("◆ 0 subagents")) ?? ""
/** The job's row in the Jobs tab. */
const row = (frame: ReadonlyArray<string>) => frame.find((line) => line.includes(ID) && line.includes(NOTE)) ?? ""

/** How the row says each end. */
const ENDED = { exit: "exited 3", kill: "killed" } as const

/** The seed's frames: the dock while it runs, the tab while it runs, then the tab and the dock after `end`. */
const play = (seed: number, end: "exit" | "kill") => {
  const job: Job = { state: "running" }
  const killed: Array<string> = []
  return App.seed(BOOT, { key: `prime-jobs-${end}`, seed, model, rpc: wakes(job, killed) }, (tui) =>
    Effect.gen(function* () {
      yield* tui.until("the dock's job", (frame) => dock(frame).includes("1 job"))
      const running = tui.text()
      yield* tui.press({ name: "down" })
      yield* tui.until("the panel", has("Subagents"))
      for (let step = 0; step < 8 && !has(NOTE)(tui.text()); step++) yield* tui.press({ name: "right" })
      yield* tui.until("the Jobs tab's row", (frame) => row(frame).includes("running"))
      yield* tui.advance(1000)
      const tab = tui.text()
      if (end === "kill") yield* tui.press({ name: "d", ctrl: true })
      else Object.assign(job, { state: "exited", exitCode: 3, endedAt: App.EPOCH + 7000 })
      yield* tui.until("the ended row", (frame) => row(frame).includes(ENDED[end]))
      const ended = tui.text()
      yield* tui.press({ name: "escape" })
      yield* tui.advance(500)
      return { running, tab, ended, closed: tui.text(), killed }
    }),
  )
}

seeded("a running job shows in the dock and in the Jobs tab with its id, note, command, state, time and log tail", ({ seed, expect }) =>
  Effect.gen(function* () {
    const seen = yield* play(seed, "exit")
    expect(dock(seen.running)).toMatch(/◆ 0 subagents\s+·\s+0 shells\s+·\s+1 job\b/)
    expect(row(seen.tab)).toMatch(new RegExp(`${ID} +${NOTE.replaceAll(".", "\\.")} +${COMMAND} +running +\\d+s`))
    expect(seen.tab.join("\n")).toContain("LAST-LOG-LINE")
    expect(seen.tab.some((line) => /Jobs 1/.test(line))).toBe(true)
  }),
)

seeded("after the job exits the dock drops it and the tab says how it ended", ({ seed, expect }) =>
  Effect.gen(function* () {
    const seen = yield* play(seed, "exit")
    expect(row(seen.ended)).toMatch(/exited 3 +7s/)
    expect(seen.killed).toEqual([])
    expect(seen.closed.join("\n")).not.toMatch(/\b1 job\b/)
  }),
)

seeded("ctrl+d in the Jobs tab kills the running job through the wake server", ({ seed, expect }) =>
  Effect.gen(function* () {
    const seen = yield* play(seed, "kill")
    expect(seen.killed).toEqual([ID])
    expect(row(seen.ended)).toContain("killed")
    expect(seen.closed.join("\n")).not.toMatch(/\b1 job\b/)
  }),
)

App.closeTest()
