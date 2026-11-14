// A TUI window's session tabs are its own (owner, 2026-11-13, q61), on the
// simulated TUI (sim-tui/): the fork's real TUI with Prime loaded by path, its
// tabs on with the `window` scope `bun run daily` writes into cli.json. Another
// TUI on the same machine has its tabs in the state dir both share
// (`test/tui/tabs.json`, under the global and this directory's sets); this
// window shows none of them, only the sessions opened in it: one it opens, then
// one more it switches to, and a subagent's view keeps its root's tab; then
// more than the strip holds, whose overflow counts are not tabs.
import { Effect, Option } from "effect"
import * as App from "../../sim-tui/app.ts"
import { type Model, stall, text } from "../../sim-tui/server.ts"

const FILE = "cmd/prime/own-tabs.sim.test.tsx"
/**
 * Seeds this file runs: a seed opens eleven sessions and types nothing, and each seed's strip holds every
 * earlier seed's tabs, so later seeds cost more. 3 and the pinned seed (sim/seeds.json) took 2565–2578 ms of
 * CPU at load 4, about half its 5 s.
 */
const SEEDS = 3
const { seeded } = App.runner(FILE, SEEDS)

/** The other TUI's open sessions, as the workbox's shared tab file held them. */
const OTHERS = ["Ergo planning", "Bite review", "vperf2 run", "sync-engine fix"]
const BOOT: App.BootOptions = {
  file: FILE,
  plugins: ["cmd/prime"],
  width: 160,
  height: 30,
  config: { tabs: { mode: "on", scope: "window" } },
  otherTabs: OTHERS.map((title, at) => ({ sessionID: `ses_other${at}`, title })),
}

App.bootTest(BOOT)

const MINE = "window own work"
const SECOND = "window second work"
const CHILD = "window child work"
/** The sessions a seed opens past the strip's width at NARROW columns (tabs shrink to 8 cells before it overflows: 8 or so tabs). */
const MORE = "more"
const MORE_COUNT = 8
const NARROW = 80
const model: Model = ({ step }) => [[text("ok"), stall]][step] ?? []

const play = (seed: number) =>
  App.seed(BOOT, { key: "own-tabs", seed, model }, (tui) =>
    Effect.gen(function* () {
      const has = (shown: string) => (frame: ReadonlyArray<string>) => frame.join("\n").includes(shown)
      yield* tui.navigate(tui.server.session({ title: MINE }))
      yield* tui.until("its own session's tab", (frame) => (frame[0] ?? "").includes(MINE))
      const first = tui.text()
      const second = tui.server.session({ title: SECOND })
      yield* tui.navigate(second)
      yield* tui.until("the session it switched to", (frame) => (frame[0] ?? "").includes(SECOND))
      const switched = tui.text()
      const child = tui.server.session({ title: CHILD, parentID: second })
      yield* tui.navigate(child)
      yield* tui.until("the subagent's view", has(CHILD))
      yield* tui.advance(500)
      const subagent = tui.text()
      // More sessions than a narrow strip holds, so every seed (not only a late one in a swarm) draws the overflow markers.
      // The next seed starts back at the file's size.
      yield* tui.resize(NARROW, BOOT.height)
      for (let at = 0; at < MORE_COUNT; at++) yield* tui.navigate(tui.server.session({ title: `${MORE} ${at}` }))
      yield* tui.until("the strip past its width", (frame) => (frame[0] ?? "").includes(`${MORE} ${MORE_COUNT - 1}`) && /‹\d+/.test(frame[0] ?? ""))
      const full = tui.text()
      return { first, switched, subagent, full }
    }),
  )

/** The seed's four frames, played once a seed (both tests read the same run). */
type Frames = Effect.Success<ReturnType<typeof play>>
const played = new Map<number, Frames>()
const scenario = (seed: number) =>
  Option.match(Option.fromUndefinedOr(played.get(seed)), {
    onSome: Effect.succeed,
    onNone: () => play(seed).pipe(Effect.tap((frames) => Effect.sync(() => played.set(seed, frames)))),
  })

/**
 * The tab strip, the frame's first line: each tab's title (cut short when the strip is full). The
 * strip's own marks are not tabs: the `+` that adds one, and the overflow counts `‹N` and `N›`
 * (the fork's session-tabs.tsx) a full strip draws for the tabs scrolled out on either side.
 */
const tabs = (frame: ReadonlyArray<string>) =>
  (frame[0] ?? "")
    .replaceAll(/‹\d+|\d+›/g, "  ")
    .split(/\s{2,}/)
    .map((tab) => tab.trim())
    .filter((tab) => tab !== "" && tab !== "+")
/** What this window opened over the file's seeds: the boot's lobby, each seed's own new session, and the sessions this scenario opens. */
const OPENED = ["lobby", "New session", MINE, SECOND, MORE]
const opened = (tab: string) => OPENED.some((title) => title.startsWith(tab.replace(/…$/, "")) || tab.startsWith(title))

seeded("a window shows none of the other TUI's tabs", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    for (const frame of [frames.first, frames.switched, frames.subagent, frames.full])
      expect(OTHERS.filter((title) => frame.join("\n").includes(title))).toEqual([])
  }),
)

seeded("a window's tabs are the sessions opened in it, and a subagent's view keeps its root's tab", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    for (const frame of [frames.first, frames.switched, frames.subagent, frames.full]) expect(tabs(frame).filter((tab) => !opened(tab))).toEqual([])
    // The full strip still names its active tab, and no overflow count is read as a title.
    expect(tabs(frames.full)).toContain(`${MORE} ${MORE_COUNT - 1}`)
    expect(tabs(frames.full).filter((tab) => /[‹›]/.test(tab))).toEqual([])
    expect(tabs(frames.first)).toContain(MINE)
    expect(tabs(frames.switched)).toContain(SECOND)
    expect(tabs(frames.subagent)).toContain(SECOND)
    expect(frames.subagent[0]).not.toContain(CHILD)
  }),
)

App.closeTest()
