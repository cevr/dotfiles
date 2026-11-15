// `rex-show sideshow`: the arguments it takes, the caller (the named session
// or the caller's own, one showcase, refused when there is none), and the
// viewer, which follows the session: the latest post drawn by its kind
// (Markdown as text, a page as a settled shot, an image as itself, the rest
// flattened), the title in the header and the post count as the tally, no
// redraw while nothing changed, and an error line while Sideshow is down.
import { describe, expect } from "bun:test"
import * as MemoryBrowser from "@dotfiles/opencode-rex/memory/browser"
import * as MemoryRex from "@dotfiles/opencode-rex/memory/rex"
import * as MemorySideshow from "@dotfiles/opencode-rex/memory/sideshow"
import * as MemorySimulators from "@dotfiles/opencode-rex/memory/simulators"
import * as MemorySpool from "@dotfiles/opencode-rex/memory/spool"
import type { Post, Shot } from "@dotfiles/opencode-rex/service"
import { Feed, type Spooled } from "@dotfiles/opencode-rex/spool"
import { ConfigProvider, Context, Effect, Exit, Fiber, Layer, Option, Queue, Ref, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { effectTest } from "../../sim-tui/effect-test.ts"
import { parse, Refused, Request, run, type Screen, viewer } from "./show.ts"

const BASE = MemorySideshow.BASE

/** A PNG's first 24 bytes, `width` × `height`, then `mark` so two pictures of one size differ. */
const png = (width: number, height: number, mark: number) => {
  const bytes = new Uint8Array(25)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  bytes[24] = mark
  return bytes
}

const refusalOf = <A>(exit: Exit.Exit<A, unknown>) => Option.map(Option.filter(Exit.findErrorOption(exit), Schema.is(Refused)), (refused) => refused.code)

const post = (id: string, title: string, at: string, surfaces: Post["surfaces"]): Post => ({ id, title, version: 1, updatedAt: at, surfaces })

describe("the arguments of rex-show sideshow", () => {
  effectTest(
    "an optional SESSION, asked every 3 s by default; --every; two sessions or a bad interval is a usage error",
    Effect.gen(function* () {
      expect(yield* parse(["sideshow"])).toEqual(Request.Follow({ session: Option.none(), every: 3 }))
      expect(yield* parse(["sideshow", "abc", "--every", "2"])).toEqual(Request.Follow({ session: Option.some("abc"), every: 2 }))
      for (const bad of [["sideshow", "a", "b"], ["sideshow", "--every", "0"]]) {
        expect({ bad, code: refusalOf(yield* Effect.exit(parse(bad))) }).toEqual({ bad, code: Option.some(2) })
      }
    }),
    5_000,
  )
})

describe("the caller of rex-show sideshow", () => {
  const settings = { rex: "rex", spool: "/state/rex-show", self: ["/opt/bun", "/dotfiles/rex/show.ts"] }
  const quiet: Screen = { size: Effect.succeed({ cols: 80, rows: 24 }), cell: () => Effect.succeed({ width: 12, height: 38 }), display: () => Effect.void }
  /** The systems of one call, from a pane of session:a, with `mine` as the caller's own Sideshow session. */
  const systems = (rex: Ref.Ref<MemoryRex.World>, spools: Ref.Ref<ReadonlyMap<string, Spooled>>, mine: Option.Option<string>) =>
    Layer.mergeAll(
      MemoryRex.layer(rex),
      MemorySpool.layer(spools),
      MemoryBrowser.layer(Ref.makeUnsafe<MemoryBrowser.Pages>(new Map())),
      MemorySideshow.layer(Ref.makeUnsafe({ ...MemorySideshow.empty, mine })),
      MemorySimulators.layer(Ref.makeUnsafe(MemorySimulators.empty)),
      ConfigProvider.layer(ConfigProvider.fromEnvRecord({ REX_SESSION: "session:a", REX_BLOCK: MemoryRex.blockId(1) })),
    )
  const showcases = (rex: Ref.Ref<MemoryRex.World>) => Effect.map(Ref.get(rex), (world) => world.blocks.filter((held) => held.label === "showcase").length)

  const named = { rex: Ref.makeUnsafe(MemoryRex.world([{ session: "session:a", label: "shell" }])), spools: Ref.makeUnsafe<ReadonlyMap<string, Spooled>>(new Map()) }
  effectTest(
    "follows the session it is given, else the caller's own, in one showcase",
    Effect.gen(function* () {
      yield* run(yield* parse(["sideshow", "s9", "--every", "4"]), quiet, settings)
      expect((yield* Ref.get(named.spools)).get("session:a")?.shown).toEqual(Feed.make({ base: BASE, session: "s9", name: "s9", every: 4 }))
      yield* run(yield* parse(["sideshow"]), quiet, settings)
      expect((yield* Ref.get(named.spools)).get("session:a")?.shown).toEqual(Feed.make({ base: BASE, session: "own", name: "own", every: 3 }))
      expect(yield* showcases(named.rex)).toBe(1)
    }).pipe(Effect.provide(systems(named.rex, named.spools, Option.some("own")))),
    5_000,
  )

  const none = { rex: Ref.makeUnsafe(MemoryRex.world([{ session: "session:a", label: "shell" }])), spools: Ref.makeUnsafe<ReadonlyMap<string, Spooled>>(new Map()) }
  effectTest(
    "with no session named and none of its own, it is refused with exit 1 and makes no pane",
    Effect.gen(function* () {
      expect(refusalOf(yield* Effect.exit(run(yield* parse(["sideshow"]), quiet, settings)))).toEqual(Option.some(1))
      expect(yield* showcases(none.rex)).toBe(0)
    }).pipe(Effect.provide(systems(none.rex, none.spools, Option.none()))),
    5_000,
  )
})

/** Each ask for a session's posts, as the viewer makes it. */
class Asks extends Context.Service<Asks, Queue.Queue<string>>()("test/RexSideAsks") {}
/** The shots the memory browser takes. */
class Shots extends Context.Service<Shots, Queue.Queue<Shot>>()("test/RexSideShots") {}
/** The frames the viewer draws. */
class Frames extends Context.Service<Frames, Queue.Queue<string>>()("test/RexSideFrames") {}

const world = Ref.makeUnsafe<MemorySideshow.World>(MemorySideshow.empty)
const pages = Ref.makeUnsafe<MemoryBrowser.Pages>(new Map())
const viewed = Ref.makeUnsafe<ReadonlyMap<string, Spooled>>(new Map([["session:a", { seq: 1, shown: Feed.make({ base: BASE, session: "s1", name: "s1", every: 0 }) }]]))
const queues = Layer.mergeAll(Layer.effect(Asks)(Queue.unbounded<string>()), Layer.effect(Shots)(Queue.unbounded<Shot>()), Layer.effect(Frames)(Queue.unbounded<string>()))
const sideshow = Layer.unwrap(Asks.use((asks) => Effect.succeed(MemorySideshow.layer(world, (session) => Queue.offer(asks, session)))))
const browser = Layer.unwrap(Shots.use((shots) => Effect.succeed(MemoryBrowser.layer(pages, (shot) => Queue.offer(shots, shot)))))
const following = Layer.mergeAll(sideshow, browser, MemorySpool.layer(viewed), MemorySimulators.layer(Ref.makeUnsafe(MemorySimulators.empty))).pipe(Layer.provideMerge(queues))

/** A pane of 82 × 35 cells of Rex's 12 × 38 px, its frames to `frames`. */
const pane = (frames: Queue.Queue<string>): Screen => ({
  size: Effect.succeed({ cols: 82, rows: 35 }),
  cell: () => Effect.succeed({ width: 12, height: 38 }),
  display: (text) => Queue.offer(frames, text),
})

/** The session s1, titled Plan, holding `posts`; with `more` besides. */
const holding = (posts: ReadonlyArray<Post>, more: Partial<MemorySideshow.World> = {}) =>
  Ref.set(world, { ...MemorySideshow.empty, sessions: new Map([["s1", { title: "Plan", posts }]]), ...more })

effectTest(
  "the viewer draws the session's latest post by its kind, titled and counted, again only when it changes, and an error line while Sideshow is down",
  Effect.gen(function* () {
    const asks = yield* Asks
    const shots = yield* Shots
    const frames = yield* Frames
    const notes = post("p1", "notes", "2026-11-15T10:00:00Z", [{ kind: "markdown", index: 0, markdown: "# Notes\n\n- one point" }])
    yield* holding([notes])
    const running = yield* Effect.forkChild(viewer("session:a", pane(frames)))
    const first = yield* Queue.take(frames)
    expect(first).toContain("showcase · Plan")
    expect(first).toContain("1 post · notes")
    expect(first).toContain("one point")
    // Nothing changed over two more asks: no frame.
    yield* Queue.take(asks)
    yield* Queue.take(asks)
    expect(yield* Queue.size(frames)).toBe(0)

    const sketch = post("p2", "sketch", "2026-11-15T10:01:00Z", [{ kind: "html", index: 0 }])
    const shot = png(1000, 1239, 1)
    yield* Ref.set(pages, new Map([[`${BASE}/p/p2?surface=0&ver=1`, shot]]))
    yield* holding([notes, sketch])
    const second = yield* Queue.take(frames)
    // 32 rows under the header, the tally and a blank: 1000 px wide fills 82 × 12 px, so 32 × 38 px of height is 1000 × 1216 / 984 = 1236 px.
    expect(yield* Queue.take(shots)).toEqual({ url: `${BASE}/p/p2?surface=0&ver=1`, width: 1000, height: 1236, settle: 5_000 })
    expect(second).toContain(Base64.encode(shot))
    expect(second).toContain("2 posts · sketch")
    // The same post over two more asks: not shot again, not drawn again.
    yield* Queue.take(asks)
    yield* Queue.take(asks)
    expect(yield* Queue.size(shots)).toBe(0)
    expect(yield* Queue.size(frames)).toBe(0)

    const picture = png(400, 300, 2)
    const image = post("p3", "screenshot", "2026-11-15T10:02:00Z", [{ kind: "image", index: 0, assetId: "a1" }])
    yield* holding([notes, sketch, image], { assets: new Map([["a1", picture]]) })
    expect(yield* Queue.take(frames)).toContain(Base64.encode(picture))
    expect(yield* Queue.size(shots)).toBe(0)

    const tree = post("p4", "data", "2026-11-15T10:03:00Z", [{ kind: "json", index: 0 }])
    yield* holding([notes, sketch, image, tree], { flat: new Map([["p4", "## data\n\nflattened tree"]]) })
    expect(yield* Queue.take(frames)).toContain("flattened tree")

    yield* Ref.update(world, (now) => ({ ...now, down: true }))
    expect(yield* Queue.take(frames)).toContain(`✗ Sideshow not reachable at ${BASE}: ECONNREFUSED`)
    yield* Fiber.interrupt(running)
  }).pipe(Effect.provide(following)),
  15_000,
)
