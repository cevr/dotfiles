// @reads all
// @reads-reason native TUI plugin loader reads at sim-tui/app.ts: createAppFixture({
// Every count on the dock's line opens the composer panel on its own tab, on
// the simulated TUI (sim-tui/): the fork's real TUI with Prime loaded by path,
// in front of the server double. The wake server and the queue are stand-ins
// on the double (`rpc`): one pending wake, one monitor, one running job and
// one queue item, so the dock reads `◆ 0 subagents · 0 shells · 1 queued ·
// 1 job · 1 wake · 1 monitor`. A click on the subagents count opens the panel
// on Subagents, on `1 queued` on Queue, on `1 job` on Jobs, on `1 wake` on
// Wakes and on `1 monitor` on Monitors; Escape puts it away between them. The
// pointer over a count brightens it in place, as it does the others.
import { Effect, Option, Schema } from "effect"
import type { JobShown } from "@dotfiles/opencode-wake/job"
import { WAKES } from "@dotfiles/opencode-wake/wake"
import { QUEUE } from "../../mods/queue/queue.ts"
import * as App from "../../sim-tui/app.ts"
import { type Model, type Rpc, text } from "../../sim-tui/server.ts"

const FILE = "cmd/prime/prime-dock-click.sim.test.tsx"
/** Seeds this file runs: a seed opens the panel five times and waits on readings, so 2 keep half the file's 5 s free. */
const SEEDS = 2
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime"], width: 140, height: 30 }

App.bootTest(BOOT)

const WAKE_NOTE = "WAKE-NOTE check the build"
const MONITOR_COMMAND = "MONITOR-COMMAND probe"
const JOB_NOTE = "JOB-NOTE run the suite"
const QUEUE_TEXT = "QUEUE-TEXT land the unit"
const model: Model = () => [text("Done.")]

const Session = Schema.Struct({ sessionID: Schema.String })

/** The wake server's and the queue's stand-ins: one alarm, one monitor, one running job, one open queue item. */
const rpc: Rpc = (call) => {
  if (call.rpcID === QUEUE.id && call.method === "get")
    return Option.some({ revision: 1, items: [{ id: "land", text: QUEUE_TEXT, state: "next", owner: "mine" }] })
  if (call.rpcID !== WAKES.id) return Option.none()
  if (call.method === "pending")
    return Option.some({
      now: App.EPOCH,
      entries: [
        { id: "wk01", kind: "alarm", dueAt: App.EPOCH + 3_600_000, setAt: App.EPOCH, note: WAKE_NOTE, mode: "wake" },
        { id: "mn01", kind: "monitor", dueAt: App.EPOCH + 7_200_000, setAt: App.EPOCH, note: "watch", mode: "wake", command: MONITOR_COMMAND, intervalSeconds: 60 },
      ],
      notices: [],
    })
  if (call.method !== "jobs") return Option.none()
  return Schema.decodeUnknownOption(Session)(call.input).pipe(
    Option.map(({ sessionID }) => ({
      now: App.EPOCH,
      jobs: [
        {
          id: "jb01",
          sessionID,
          note: JOB_NOTE,
          command: "bun test",
          cwd: "/nonexistent/loop-probe-x",
          setAt: App.EPOCH,
          startedAt: App.EPOCH,
          logTail: "",
          state: "running",
        } satisfies JobShown,
      ],
    })),
  )
}

/** Each count on the dock, and what its tab shows once it is the active one. */
const SEGMENTS = [
  { name: "subagents", shown: "◆ 0 subagents", tab: "Subagents", marker: "" },
  { name: "queue", shown: "1 queued", tab: "Queue", marker: QUEUE_TEXT },
  { name: "jobs", shown: "1 job", tab: "Jobs", marker: JOB_NOTE },
  { name: "wakes", shown: "1 wake", tab: "Wakes", marker: WAKE_NOTE },
  { name: "monitors", shown: "1 monitor", tab: "Monitors", marker: MONITOR_COMMAND },
] as const
type Shot = { readonly text: ReadonlyArray<string>; readonly frame: App.Frame }

const DOCK = "◆ 0 subagents"
/** The composer panel's header row, its Subagents tab first. */
const PANEL = /^\s*┃\s+Subagents(\s|$)/
const panelRow = (frame: ReadonlyArray<string>) => frame.findIndex((line) => PANEL.test(line))
const isPanel = (frame: ReadonlyArray<string>) => panelRow(frame) >= 0
const has = (shown: string) => (frame: ReadonlyArray<string>) => frame.join("\n").includes(shown)
const dock = (frame: ReadonlyArray<string>) => frame.find((line) => line.includes(DOCK)) ?? ""
/** The cell `shown` starts at on the dock's line, counted in characters (every glyph here takes one cell). */
const dockCell = (frame: ReadonlyArray<string>, shown: string) => {
  const y = frame.findIndex((line) => line.includes(DOCK))
  const line = frame[y] ?? ""
  return { x: Array.from(line.slice(0, line.indexOf(shown))).length, y }
}
/** The colour the dock draws `shown` in. */
const colorOf = (shot: Shot, shown: string) => {
  const { y } = dockCell(shot.text, shown)
  return (shot.frame.lines[y]?.spans ?? []).find((span) => span.text.includes(shown))?.fg ?? "none"
}
/** The tabs the panel's tab bar draws in a colour no other of them has: the active one, alone. */
const activeTabs = (shot: Shot) => {
  const spans = shot.frame.lines[panelRow(shot.text)]?.spans ?? []
  const colors = SEGMENTS.map(({ tab }) => ({ tab, fg: String(spans.find((span) => span.text.trim().startsWith(tab))?.fg) }))
  const alone = (fg: string) => colors.filter((other) => other.fg === fg).length === 1
  return colors.flatMap(({ tab, fg }) => Option.toArray(Option.liftPredicate(tab, () => alone(fg))))
}

const play = (seed: number) =>
  App.seed(BOOT, { key: "prime-dock-click", seed, model, rpc }, (tui) =>
    Effect.gen(function* () {
      const shots = new Map<string, Shot>()
      const save = (name: string) => Effect.sync(() => shots.set(name, { text: tui.text(), frame: tui.frame() }))
      yield* tui.until("the dock's counts", (frame) => SEGMENTS.every((segment) => dock(frame).includes(segment.shown)), 10_000)
      // The pointer off the line: an earlier seed may have left it over a count.
      yield* tui.mouse({ action: "move", x: 0, y: 0 })
      yield* tui.advance(500)
      yield* save("rest")
      for (const segment of SEGMENTS) {
        // The pointer off the line, then over the count, then a click on it.
        yield* tui.mouse({ action: "move", x: 0, y: 0 })
        yield* tui.advance(200)
        const at = dockCell(tui.text(), segment.shown)
        const over = { x: at.x + 2, y: at.y }
        yield* tui.mouse({ action: "move", ...over })
        yield* tui.advance(200)
        yield* save(`${segment.name}-hover`)
        yield* tui.mouse({ action: "down", ...over })
        yield* tui.mouse({ action: "up", ...over })
        // A count that opens nothing leaves the panel away: wait a while, then read what is on screen.
        yield* tui.until(`${segment.name} opened`, (frame) => isPanel(frame) && (segment.marker === "" || has(segment.marker)(frame)), 3_000).pipe(Effect.ignore)
        yield* tui.advance(500)
        yield* save(segment.name)
        yield* tui.press({ name: "escape" })
        yield* tui.until("panel away", (frame) => !isPanel(frame)).pipe(Effect.ignore)
        yield* tui.advance(300)
      }
      return shots
    }),
  )

const played = new Map<number, Map<string, Shot>>()
const scenario = (seed: number) =>
  Option.match(Option.fromUndefinedOr(played.get(seed)), {
    onSome: Effect.succeed,
    onNone: () => play(seed).pipe(Effect.tap((run) => Effect.sync(() => played.set(seed, run)))),
  })
const shot = (shots: Map<string, Shot>, name: string): Shot => shots.get(name) ?? { text: [], frame: { lines: [] } }

seeded("the dock counts the subagents, shells, queue, job, wake and monitor on one line", ({ seed, expect }) =>
  Effect.gen(function* () {
    const shots = yield* scenario(seed)
    expect(dock(shot(shots, "rest").text)).toMatch(/◆ 0 subagents\s+·\s+0 shells\s+·\s+1 queued\s+·\s+1 job\s+·\s+1 wake\s+·\s+1 monitor/)
  }),
)

for (const segment of SEGMENTS)
  seeded(`a click on the dock's ${segment.shown} opens the panel on its ${segment.tab} tab`, ({ seed, expect }) =>
    Effect.gen(function* () {
      const shots = yield* scenario(seed)
      const opened = shot(shots, segment.name)
      expect(isPanel(opened.text)).toBe(true)
      if (segment.marker !== "") expect(has(segment.marker)(opened.text)).toBe(true)
      expect(activeTabs(opened)).toEqual([segment.tab])
    }),
  )

seeded("the pointer over each count brightens it in place", ({ seed, expect }) =>
  Effect.gen(function* () {
    const shots = yield* scenario(seed)
    const rest = shot(shots, "rest")
    for (const segment of SEGMENTS) {
      const hover = shot(shots, `${segment.name}-hover`)
      expect({ segment: segment.name, bright: colorOf(hover, segment.shown) !== colorOf(rest, segment.shown) }).toEqual({ segment: segment.name, bright: true })
      expect(dockCell(hover.text, segment.shown)).toEqual(dockCell(rest.text, segment.shown))
    }
  }),
)

App.closeTest()
