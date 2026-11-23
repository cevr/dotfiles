// `rex-show browse`: the arguments it takes, the caller (one showcase, the
// tab spooled, no browser started), and the viewer over a stand-in tab: the
// tab opened at the pane's size, each new frame drawn in place and a frame
// seen already skipped, a click sent at its page point, the header named
// after a navigation, `q` typed in a field but quitting outside one (the
// browser closed with the viewer), the tab closed when the spool changes,
// and a tab that cannot open said in the pane.
import { describe, expect } from "bun:test"
import * as MemoryBrowser from "@dotfiles/opencode-rex/memory/browser"
import * as MemoryDiagrams from "@dotfiles/opencode-rex/memory/diagrams"
import * as MemoryOpener from "@dotfiles/opencode-rex/memory/opener"
import * as MemoryRex from "@dotfiles/opencode-rex/memory/rex"
import * as MemorySideshow from "@dotfiles/opencode-rex/memory/sideshow"
import * as MemorySimulators from "@dotfiles/opencode-rex/memory/simulators"
import * as MemorySpool from "@dotfiles/opencode-rex/memory/spool"
import { encodeSgr, layoutOf, Mouse, NO_MODS, viewCommands } from "@dotfiles/opencode-rex/live"
import type { Command, Frame, Tab } from "@dotfiles/opencode-rex/service"
import { Browse, Page, type Spooled } from "@dotfiles/opencode-rex/spool"
import { ConfigProvider, Context, Effect, Exit, Fiber, Layer, Option, Queue, Ref, Schema } from "effect"
import { effectTest } from "../../sim-tui/effect-test.ts"
import { parse, Refused, Request, run, type Screen, viewer } from "./show.ts"

/** Hang guard for the in-memory viewer fixture. */
const HANG_GUARD_MS = 120_000
const PAGE = "http://127.0.0.1:8765/page.html"

const refusalOf = <A>(exit: Exit.Exit<A, unknown>) => Option.map(Option.filter(Exit.findErrorOption(exit), Schema.is(Refused)), (refused) => refused.code)

describe("the arguments of rex-show browse", () => {
  effectTest(
    "a URL, at the pane's width and 6 frames a second by default; --width and --fps; no URL, a file or a bad rate is a usage error",
    Effect.gen(function* () {
      expect(yield* parse(["browse", PAGE])).toEqual(Request.Live({ page: Browse.make({ url: PAGE, name: "127.0.0.1:8765/page.html", width: 0, fps: 6 }) }))
      expect(yield* parse(["browse", PAGE, "--width", "1280", "--fps", "2"])).toEqual(
        Request.Live({ page: Browse.make({ url: PAGE, name: "127.0.0.1:8765/page.html", width: 1280, fps: 2 }) }),
      )
      for (const bad of [["browse"], ["browse", "file:///etc/hosts"], ["browse", PAGE, "--fps", "0"], ["browse", PAGE, "--fps", "31"]]) {
        expect({ bad, code: refusalOf(yield* Effect.exit(parse(bad))) }).toEqual({ bad, code: Option.some(2) })
      }
    }),
    HANG_GUARD_MS,
  )
})

describe("the caller of rex-show browse", () => {
  const rex = Ref.makeUnsafe(MemoryRex.world([{ session: "session:a", label: "shell" }]))
  const spools = Ref.makeUnsafe<ReadonlyMap<string, Spooled>>(new Map())
  const settings = { rex: Option.some("rex"), leaf: Option.none<string>(), spool: "/state/rex-show", self: ["/opt/bun", "/dotfiles/rex/show.ts"] }
  const quiet: Screen = { size: Effect.succeed({ cols: 80, rows: 24 }), cell: () => Effect.succeed({ width: 12, height: 38 }), display: () => Effect.void, input: Effect.succeed(Effect.never) }

  effectTest(
    "spools the tab in one showcase, starting no browser",
    Effect.gen(function* () {
      yield* run(yield* parse(["browse", PAGE]), quiet, settings)
      yield* run(yield* parse(["browse", PAGE, "--fps", "3"]), quiet, settings)
      expect((yield* Ref.get(spools)).get("session:a")?.shown).toEqual(Browse.make({ url: PAGE, name: "127.0.0.1:8765/page.html", width: 0, fps: 3 }))
      expect((yield* Ref.get(rex)).blocks.filter((held) => held.label === "showcase").length).toBe(1)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          MemoryRex.layer(rex),
          MemorySpool.layer(spools),
          MemoryBrowser.layer(Ref.makeUnsafe<MemoryBrowser.Pages>(new Map()), () => Effect.void, () => Effect.die("the caller opened a tab")),
          MemorySideshow.layer(Ref.makeUnsafe(MemorySideshow.empty)),
          MemorySimulators.layer(Ref.makeUnsafe(MemorySimulators.empty)), MemoryDiagrams.layer, MemoryOpener.layer(Ref.makeUnsafe<ReadonlyArray<string>>([])),
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ REX_SESSION: "session:a", REX_BLOCK: MemoryRex.blockId(1) })),
        ),
      ),
    ),
    HANG_GUARD_MS,
  )
})

/** The stand-in tab's side: frames and addresses the test gives it, what the viewer sent it, what it was opened with, and whether it is still open. */
interface Stand {
  readonly frames: Queue.Queue<Frame>
  readonly urls: Queue.Queue<string>
  readonly sent: Queue.Queue<Command>
  readonly opened: Queue.Queue<{ readonly url: string; readonly setup: ReadonlyArray<Command> }>
  readonly editing: Ref.Ref<boolean>
  readonly open: Ref.Ref<boolean>
}
class Stands extends Context.Service<Stands, Stand>()("test/RexBrowseStand") {}
/** The frames the viewer draws, and the pane's input the test types. */
class Frames extends Context.Service<Frames, Queue.Queue<string>>()("test/RexBrowseFrames") {}
class Typed extends Context.Service<Typed, Queue.Queue<string>>()("test/RexBrowseTyped") {}

const viewed = Ref.makeUnsafe<ReadonlyMap<string, Spooled>>(new Map())
const stand = Layer.effect(Stands)(
  Effect.gen(function* () {
    return {
      frames: yield* Queue.unbounded<Frame>(),
      urls: yield* Queue.unbounded<string>(),
      sent: yield* Queue.unbounded<Command>(),
      opened: yield* Queue.unbounded<{ readonly url: string; readonly setup: ReadonlyArray<Command> }>(),
      editing: yield* Ref.make(false),
      open: yield* Ref.make(false),
    }
  }),
)
const browser = Layer.unwrap(
  Stands.use((side) =>
    Effect.succeed(
      MemoryBrowser.layer(Ref.makeUnsafe<MemoryBrowser.Pages>(new Map()), () => Effect.void, (url, setup) =>
        Effect.gen(function* () {
          yield* Queue.offer(side.opened, { url, setup })
          yield* Effect.acquireRelease(Ref.set(side.open, true), () => Ref.set(side.open, false))
          return {
            frame: Queue.take(side.frames),
            url: Queue.take(side.urls),
            send: (commands) => Effect.asVoid(Queue.offerAll(side.sent, commands)),
            ask: () => Ref.get(side.editing),
          } satisfies Tab
        }),
      ),
    ),
  ),
)
const queues = Layer.mergeAll(stand, Layer.effect(Frames)(Queue.unbounded<string>()), Layer.effect(Typed)(Queue.unbounded<string>()))
const browsing = Layer.mergeAll(
  browser,
  MemorySpool.layer(viewed),
  MemorySideshow.layer(Ref.makeUnsafe(MemorySideshow.empty)),
  MemorySimulators.layer(Ref.makeUnsafe(MemorySimulators.empty)), MemoryDiagrams.layer, MemoryOpener.layer(Ref.makeUnsafe<ReadonlyArray<string>>([])),
).pipe(Layer.provideMerge(queues))

/** A pane of 80 × 24 cells of 8 × 16 px, its frames to `frames`, its input what the test types. */
const pane = (frames: Queue.Queue<string>, typed: Queue.Queue<string>): Screen => ({
  size: Effect.succeed({ cols: 80, rows: 24 }),
  cell: () => Effect.succeed({ width: 8, height: 16 }),
  display: (text) => Queue.offer(frames, text),
  input: Effect.succeed(Queue.take(typed)),
})

const tabbed = (seq: number): ReadonlyMap<string, Spooled> =>
  new Map([["session:a", { seq, shown: Browse.make({ url: PAGE, name: "127.0.0.1:8765/page.html", width: 0, fps: 30 }) }]])

effectTest(
  "the viewer opens the tab at the pane's size, draws each new frame, sends a click to its page point, renames the header, types q in a field and quits on it outside one",
  Effect.gen(function* () {
    const side = yield* Stands
    const frames = yield* Frames
    const typed = yield* Typed
    yield* Ref.set(viewed, tabbed(1))
    const running = yield* Effect.forkChild(viewer("session:a", pane(frames, typed)))
    expect(yield* Queue.take(frames)).toContain(`opening ${PAGE}…`)
    const layout = layoutOf({ cols: 80, rows: 24 }, { width: 8, height: 16 }, Option.none())
    expect(yield* Queue.take(side.opened)).toEqual({ url: PAGE, setup: viewCommands(layout) })
    expect(layout.view).toEqual({ width: 640, height: 352 })
    yield* Queue.offer(side.frames, { data: "AAAA", width: 640, height: 352 })
    const drawn = yield* Queue.take(frames)
    expect(drawn).toStartWith("\u001b[2;1H\u001b_Ga=T,f=100,q=2,c=80,r=22,i=7501,C=1,m=0;AAAA")
    // The same frame again is skipped: the next drawn is the next new one.
    yield* Queue.offer(side.frames, { data: "AAAA", width: 640, height: 352 })
    yield* Queue.offer(side.frames, { data: "BBBB", width: 640, height: 352 })
    expect(yield* Queue.take(frames)).toContain(";BBBB")
    yield* Queue.offer(typed, encodeSgr(Mouse.Press({ button: "left", col: 9, row: 3, mods: NO_MODS })) + encodeSgr(Mouse.Release({ button: "left", col: 9, row: 3, mods: NO_MODS })))
    expect((yield* Queue.take(side.sent)).params).toMatchObject({ type: "mousePressed", x: 68, y: 24, button: "left" })
    expect((yield* Queue.take(side.sent)).params).toMatchObject({ type: "mouseReleased", x: 68, y: 24 })
    yield* Queue.offer(side.urls, "http://127.0.0.1:8765/second.html")
    expect(yield* Queue.take(frames)).toContain("http://127.0.0.1:8765/second.html · Alt-← back")
    yield* Ref.set(side.editing, true)
    yield* Queue.offer(typed, "q")
    expect((yield* Queue.take(side.sent)).params).toMatchObject({ type: "keyDown", text: "q" })
    yield* Queue.take(side.sent)
    yield* Ref.set(side.editing, false)
    yield* Queue.offer(typed, "q")
    expect(yield* Fiber.join(running)).toBe("")
    expect(yield* Ref.get(side.open)).toBe(false)
  }).pipe(Effect.provide(browsing)),
  15_000,
)

effectTest(
  "the viewer closes the tab when the spool shows something else",
  Effect.gen(function* () {
    const side = yield* Stands
    const frames = yield* Frames
    const typed = yield* Typed
    yield* Ref.set(viewed, tabbed(1))
    const running = yield* Effect.forkChild(viewer("session:a", pane(frames, typed)))
    yield* Queue.take(side.opened)
    expect(yield* Ref.get(side.open)).toBe(true)
    yield* Ref.set(viewed, new Map([["session:a", { seq: 2, shown: Page.make({ file: "/nonexistent/loop-probe-x.md", name: "notes.md" }) }]]))
    let after = yield* Queue.take(frames)
    while (!after.includes("cannot read notes.md")) after = yield* Queue.take(frames)
    expect(yield* Ref.get(side.open)).toBe(false)
    yield* Fiber.interrupt(running)
  }).pipe(Effect.provide(browsing)),
  15_000,
)

effectTest(
  "the viewer says in the pane when a tab cannot open",
  Effect.gen(function* () {
    const frames = yield* Frames
    const typed = yield* Typed
    yield* Ref.set(viewed, tabbed(3))
    const running = yield* Effect.forkChild(viewer("session:a", pane(frames, typed)))
    let failed = yield* Queue.take(frames)
    while (!failed.includes("✗ no live tab in this test")) failed = yield* Queue.take(frames)
    yield* Fiber.interrupt(running)
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        MemoryBrowser.layer(Ref.makeUnsafe<MemoryBrowser.Pages>(new Map())),
        MemorySpool.layer(viewed),
        MemorySideshow.layer(Ref.makeUnsafe(MemorySideshow.empty)),
        MemorySimulators.layer(Ref.makeUnsafe(MemorySimulators.empty)), MemoryDiagrams.layer, MemoryOpener.layer(Ref.makeUnsafe<ReadonlyArray<string>>([])),
      ).pipe(Layer.provideMerge(queues)),
    ),
  ),
  15_000,
)
