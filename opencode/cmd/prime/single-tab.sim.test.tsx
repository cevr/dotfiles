// A window's tab row hides while the window holds only the session it shows
// (owner, 2026-11-15, q68), on the simulated TUI (sim-tui/): the fork's real
// TUI with Prime loaded by path, with the `window` scope `bun run daily` writes
// into cli.json and its tabs on, as outside herdr ("auto" keeps them off inside
// herdr, the owner's choice). Each seed starts from a window with only its own
// session open (the others closed): no tab row; a second session opened there
// shows the row with both; a subagent's view keeps it; closing the second
// session leaves the first alone again, and the row hides.
import { Effect, Option } from "effect"
import * as App from "../../sim-tui/app.ts"
import { router } from "../../sim-tui/route/registry.ts"
import { type Model, stall, text } from "../../sim-tui/server.ts"

const FILE = "cmd/prime/single-tab.sim.test.tsx"
/** Seeds this file runs: sim-tui's measured headroom rule (a file keeps half its 5 s of CPU). */
const SEEDS = 4
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = {
  file: FILE,
  plugins: ["cmd/prime"],
  width: 120,
  height: 30,
  config: { tabs: { mode: "on", scope: "window" } },
}

App.bootTest(BOOT)

const FIRST = "single first work"
const SECOND = "single second work"
const CHILD = "single child work"
const model: Model = ({ step }) => [[text("ok"), stall]][step] ?? []

/** The window's tabs the route plugin lent (sim-tui/route). */
const windowTabs = () =>
  Option.match(router().tabs, {
    onNone: () => Effect.die(new Error("the route plugin (sim-tui/route) lent no tabs")),
    onSome: Effect.succeed,
  })

/**
 * The tab row, the frame's first line when shown: the strip ends in the `+` that adds a tab
 * (the fork's session-tabs.tsx), which no session header draws.
 */
const strip = (frame: ReadonlyArray<string>) => Option.liftPredicate(frame[0] ?? "", (line) => /\s\+$/.test(line))

/**
 * The session the body shows: its header line, the title beside its cost (`… single first work  $0.00`), which the
 * tab strip never draws. A title in the strip alone is not the session shown: while the client reconnects (its event
 * stream's 45 s idle watchdog fires about every 13th seed of a process, the double sending no keepalive), the strip
 * still names the tabs and the body is blank.
 */
const shows = (title: string) => (frame: ReadonlyArray<string>) =>
  frame.some((line, y) => !(y === 0 && Option.isSome(strip(frame))) && line.includes(title) && /\$\d+\.\d\d/.test(line))

const play = (seed: number) =>
  App.seed(BOOT, { key: "single-tab", seed, model }, (tui) =>
    Effect.gen(function* () {
      const tabs = yield* windowTabs()
      const first = tui.server.session({ title: FIRST })
      yield* tui.navigate(first)
      yield* tui.until("the first session's body", shows(FIRST))
      // The window keeps only the session it shows: the lobby's and the earlier seeds' tabs closed.
      for (const sessionID of tabs.list()) if (sessionID !== first) tabs.close(sessionID)
      yield* tui.settle
      yield* tui.advance(500)
      const alone = { text: tui.text(), tabs: tabs.list() }
      const second = tui.server.session({ title: SECOND })
      yield* tui.navigate(second)
      yield* tui.until("the second session's body and row", (frame) => shows(SECOND)(frame) && Option.exists(strip(frame), (row) => row.includes(SECOND)))
      const both = { text: tui.text(), tabs: tabs.list() }
      const child = tui.server.session({ title: CHILD, parentID: second })
      yield* tui.navigate(child)
      yield* tui.until("the subagent's view", shows(CHILD))
      yield* tui.advance(500)
      const subagent = { text: tui.text(), tabs: tabs.list() }
      tabs.close(second)
      yield* tui.until("back on the first", (frame) => shows(FIRST)(frame) && !frame.join("\n").includes(SECOND))
      yield* tui.advance(500)
      const back = { text: tui.text(), tabs: tabs.list() }
      return { first, second, alone, both, subagent, back }
    }),
  )

type Run = Effect.Success<ReturnType<typeof play>>
const played = new Map<number, Run>()
const scenario = (seed: number) =>
  Option.match(Option.fromUndefinedOr(played.get(seed)), {
    onSome: Effect.succeed,
    onNone: () => play(seed).pipe(Effect.tap((run) => Effect.sync(() => played.set(seed, run)))),
  })

seeded("a window with only the session it shows draws no tab row, though that session is its tab", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* scenario(seed)
    expect(run.alone.tabs).toEqual([run.first])
    expect(Option.isNone(strip(run.alone.text))).toBe(true)
    expect(shows(FIRST)(run.alone.text)).toBe(true)
    expect(run.back.tabs).toEqual([run.first])
    expect(Option.isNone(strip(run.back.text))).toBe(true)
    expect(shows(FIRST)(run.back.text)).toBe(true)
  }),
)

seeded("a second session opened in the window shows the row with both, and a subagent's view keeps it", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* scenario(seed)
    expect(run.both.tabs).toEqual([run.first, run.second])
    const row = Option.getOrElse(strip(run.both.text), () => "")
    expect(row).toContain(FIRST)
    expect(row).toContain(SECOND)
    expect(run.subagent.tabs).toEqual([run.first, run.second])
    expect(Option.isSome(strip(run.subagent.text))).toBe(true)
    expect(Option.getOrElse(strip(run.subagent.text), () => "")).not.toContain(CHILD)
  }),
)

App.closeTest()
