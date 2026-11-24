// @reads all
// @reads-reason computed read at mods/rex/process/simulators.ts: return yield* png(new Uint8Array(yield* Effect.tryPromise({ try: () => readFile(file), catch: (
// `rex-show feed` (and `open`, `sideshow`): the arguments it takes; the
// caller (the named session or the caller's own, one showcase, refused when
// there is none; any call keeps the caller's own as the showcase's feed; md
// and diff go to leaf beside when it is there); and the viewer, which runs
// the feed pane: the board's newest version on top, the timeline newest
// first with a dot on what came since, the newest post drawn by its kinds
// (a page shot, a Mermaid diagram shot from its Pele page), `[`/`]` walking
// a post's versions, `c` sending a comment as the user, an error line while
// Sideshow is down, and `q` quitting. A still view goes back to the feed on
// `q`, and leaves its first shot in the feed as a post.
import { describe, expect } from "bun:test"
import * as MemoryBrowser from "@dotfiles/opencode-rex/memory/browser"
import * as MemoryDiagrams from "@dotfiles/opencode-rex/memory/diagrams"
import * as MemoryOpener from "@dotfiles/opencode-rex/memory/opener"
import * as MemoryRex from "@dotfiles/opencode-rex/memory/rex"
import * as MemorySideshow from "@dotfiles/opencode-rex/memory/sideshow"
import * as MemorySimulators from "@dotfiles/opencode-rex/memory/simulators"
import * as MemorySpool from "@dotfiles/opencode-rex/memory/spool"
import type { Post, Shot } from "@dotfiles/opencode-rex/service"
import { Feed, type Spooled, Url } from "@dotfiles/opencode-rex/spool"
import { Array as Arr, ConfigProvider, Context, Effect, Exit, Fiber, Layer, Option, Queue, Ref, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { effectTest } from "../../sim-tui/effect-test.ts"
import { parse, Refused, Request, run, type Screen, viewer } from "./show.ts"
import { hangGuard } from "../../tests/hang-guard.ts"

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

const post = (id: string, title: string, at: string, surfaces: Post["surfaces"], version = 1): Post => ({ id, title, version, createdAt: at, updatedAt: at, surfaces })

describe("the arguments of rex-show feed", () => {
  effectTest(
    "feed, open and sideshow are one command: an optional SESSION, asked every 3 s by default; --every; two sessions or a bad interval is a usage error; diff passes its arguments on",
    Effect.gen(function* () {
      for (const command of ["feed", "open", "sideshow"]) {
        expect(yield* parse([command])).toEqual(Request.Follow({ session: Option.none(), every: 3 }))
        expect(yield* parse([command, "abc", "--every", "2"])).toEqual(Request.Follow({ session: Option.some("abc"), every: 2 }))
        for (const bad of [[command, "a", "b"], [command, "--every", "0"]]) {
          expect({ bad, code: refusalOf(yield* Effect.exit(parse(bad))) }).toEqual({ bad, code: Option.some(2) })
        }
      }
      expect(yield* parse(["diff", "--staged"])).toEqual(Request.Diff({ args: ["--staged"] }))
    }),
    hangGuard("local-fixture"),
  )
})

describe("the caller of rex-show feed", () => {
  const settings = { rex: Option.some("rex"), leaf: Option.none<string>(), spool: "/state/rex-show", self: ["/opt/bun", "/dotfiles/rex/show.ts"] }
  const quiet: Screen = { size: Effect.succeed({ cols: 80, rows: 24 }), cell: () => Effect.succeed({ width: 12, height: 38 }), display: () => Effect.void, input: Effect.succeed(Effect.never) }
  /** The systems of one call, from a pane of session:a, with `mine` as the caller's own Sideshow session. */
  const systems = (rex: Ref.Ref<MemoryRex.World>, spools: Ref.Ref<ReadonlyMap<string, Spooled>>, mine: Option.Option<string>) =>
    Layer.mergeAll(
      MemoryRex.layer(rex),
      MemorySpool.layer(spools),
      MemoryBrowser.layer(Ref.makeUnsafe<MemoryBrowser.Pages>(new Map())),
      MemorySideshow.layer(Ref.makeUnsafe({ ...MemorySideshow.empty, mine })),
      MemorySimulators.layer(Ref.makeUnsafe(MemorySimulators.empty)),
      MemoryDiagrams.layer,
      MemoryOpener.layer(Ref.makeUnsafe<ReadonlyArray<string>>([])),
      ConfigProvider.layer(ConfigProvider.fromEnvRecord({ REX_SESSION: "session:a", REX_BLOCK: MemoryRex.blockId(1) })),
    )
  const labelled = (rex: Ref.Ref<MemoryRex.World>, label: string) => Effect.map(Ref.get(rex), (world) => world.blocks.filter((held) => held.label === label))

  const named = { rex: Ref.makeUnsafe(MemoryRex.world([{ session: "session:a", label: "shell" }])), spools: Ref.makeUnsafe<ReadonlyMap<string, Spooled>>(new Map()) }
  effectTest(
    "follows the session it is given, else the caller's own, in one showcase",
    Effect.gen(function* () {
      yield* run(yield* parse(["feed", "s9", "--every", "4"]), quiet, settings)
      expect((yield* Ref.get(named.spools)).get("session:a")?.shown).toEqual(Feed.make({ base: BASE, session: "s9", name: "s9", every: 4 }))
      yield* run(yield* parse(["open"]), quiet, settings)
      expect((yield* Ref.get(named.spools)).get("session:a")?.shown).toEqual(Feed.make({ base: BASE, session: "own", name: "own", every: 3 }))
      expect((yield* labelled(named.rex, "showcase")).length).toBe(1)
    }).pipe(Effect.provide(systems(named.rex, named.spools, Option.some("own")))),
    hangGuard("local-fixture"),
  )

  const none = { rex: Ref.makeUnsafe(MemoryRex.world([{ session: "session:a", label: "shell" }])), spools: Ref.makeUnsafe<ReadonlyMap<string, Spooled>>(new Map()) }
  effectTest(
    "with no session named and none of its own, it is refused with exit 1 and makes no pane",
    Effect.gen(function* () {
      expect(refusalOf(yield* Effect.exit(run(yield* parse(["feed"]), quiet, settings)))).toEqual(Option.some(1))
      expect((yield* labelled(none.rex, "showcase")).length).toBe(0)
    }).pipe(Effect.provide(systems(none.rex, none.spools, Option.none()))),
    hangGuard("local-fixture"),
  )

  const kept = { rex: Ref.makeUnsafe(MemoryRex.world([{ session: "session:a", label: "shell" }])), spools: Ref.makeUnsafe<ReadonlyMap<string, Spooled>>(new Map()) }
  effectTest(
    "any call keeps the caller's own session as the showcase's feed, and never replaces one followed on purpose",
    Effect.gen(function* () {
      yield* run(yield* parse(["tally", "3 of 7"]), quiet, settings)
      expect((yield* Ref.get(kept.spools)).get("session:a")?.feed).toEqual(Feed.make({ base: BASE, session: "own", name: "own", every: 3 }))
      yield* run(yield* parse(["feed", "s9"]), quiet, settings)
      yield* run(yield* parse(["url", "http://localhost:3000"]), quiet, settings)
      expect((yield* Ref.get(kept.spools)).get("session:a")?.feed?.session).toBe("s9")
    }).pipe(Effect.provide(systems(kept.rex, kept.spools, Option.some("own")))),
    hangGuard("local-fixture"),
  )

  const leafy = { rex: Ref.makeUnsafe(MemoryRex.world([{ session: "session:a", label: "shell" }])), spools: Ref.makeUnsafe<ReadonlyMap<string, Spooled>>(new Map()) }
  effectTest(
    "with leaf on the host, md opens leaf beside the caller and diff runs leaf diff there; without it diff is refused with exit 1",
    Effect.gen(function* () {
      const withLeaf = { ...settings, leaf: Option.some("/usr/bin/leaf") }
      yield* run(yield* parse(["md", "/plans/plan.md"]), quiet, withLeaf)
      yield* run(yield* parse(["diff", "--staged"]), quiet, withLeaf)
      const leaves = yield* labelled(leafy.rex, "leaf")
      expect(leaves.map((block) => block.command)).toEqual([["/usr/bin/leaf", "/plans/plan.md"], ["/usr/bin/leaf", "diff", "--staged"]])
      expect((yield* labelled(leafy.rex, "showcase")).length).toBe(0)
      expect(refusalOf(yield* Effect.exit(run(yield* parse(["diff"]), quiet, settings)))).toEqual(Option.some(1))
    }).pipe(Effect.provide(systems(leafy.rex, leafy.spools, Option.none()))),
    hangGuard("local-fixture"),
  )
})

/** Each ask for a session's posts, as the viewer makes it. */
class Asks extends Context.Service<Asks, Queue.Queue<string>>()("test/RexFeedAsks") {}
/** The shots the memory browser takes. */
class Shots extends Context.Service<Shots, Queue.Queue<Shot>>()("test/RexFeedShots") {}
/** The frames the viewer draws. */
class Frames extends Context.Service<Frames, Queue.Queue<string>>()("test/RexFeedFrames") {}
/** The keys the pane's user types. */
class Keys extends Context.Service<Keys, Queue.Queue<string>>()("test/RexFeedKeys") {}

const world = Ref.makeUnsafe<MemorySideshow.World>(MemorySideshow.empty)
const pages = Ref.makeUnsafe<MemoryBrowser.Pages>(new Map())
const viewed = Ref.makeUnsafe<ReadonlyMap<string, Spooled>>(new Map([["session:a", { seq: 1, shown: Feed.make({ base: BASE, session: "s1", name: "s1", every: 0 }) }]]))
const queues = Layer.mergeAll(
  Layer.effect(Asks)(Queue.unbounded<string>()),
  Layer.effect(Shots)(Queue.unbounded<Shot>()),
  Layer.effect(Frames)(Queue.unbounded<string>()),
  Layer.effect(Keys)(Queue.unbounded<string>()),
)
const sideshow = Layer.unwrap(Asks.use((asks) => Effect.succeed(MemorySideshow.layer(world, (session) => Queue.offer(asks, session)))))
const browser = Layer.unwrap(Shots.use((shots) => Effect.succeed(MemoryBrowser.layer(pages, (shot) => Queue.offer(shots, shot)))))
const following = Layer.mergeAll(
  sideshow,
  browser,
  MemorySpool.layer(viewed),
  MemorySimulators.layer(Ref.makeUnsafe(MemorySimulators.empty)),
  MemoryDiagrams.layer,
  MemoryOpener.layer(Ref.makeUnsafe<ReadonlyArray<string>>([])),
).pipe(Layer.provideMerge(queues))

/** A pane of 120 × 40 cells of Rex's 12 × 38 px, its frames to `frames`, its keys from `keys`. */
const pane = (frames: Queue.Queue<string>, keys: Queue.Queue<string>): Screen => ({
  size: Effect.succeed({ cols: 120, rows: 40 }),
  cell: () => Effect.succeed({ width: 12, height: 38 }),
  display: (text) => Queue.offer(frames, text),
  input: Effect.succeed(Queue.take(keys)),
})

/** The session s1, titled Plan, holding `posts`; with `more` besides. */
const holding = (posts: ReadonlyArray<Post>, more: Partial<MemorySideshow.World> = {}) =>
  Ref.update(world, (now) => ({ ...now, sessions: new Map([["s1", { title: "Plan", posts }]]), ...more }))

/** The next frame holding every one of `wanted`, the frames before it dropped; fails after 200 frames. */
const frameWith = (frames: Queue.Queue<string>, ...wanted: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    for (let seen = 0; seen < 200; seen++) {
      const frame = yield* Queue.take(frames)
      if (wanted.every((text) => frame.includes(text))) return frame
    }
    return yield* Effect.fail(`no frame with ${wanted.join(", ")}`)
  }).pipe(Effect.timeoutOrElse({ duration: "4 seconds", orElse: () => Effect.fail(`no frame with ${wanted.join(", ")} in 4 s`) }))

const board = (version: number, step: string) => post("b", "Board", "2026-11-15T09:00:00Z", [{ kind: "markdown", index: 0, markdown: `# Shipping the feed\n\n- ${step}` }], version)
const notes = post("p1", "notes", "2026-11-15T10:00:00Z", [{ kind: "markdown", index: 0, markdown: "# Notes\n\nthird draft" }], 3)
const sketch = post("p2", "sketch", "2026-11-15T10:01:00Z", [{ kind: "html", index: 0 }])
const flow = post("p3", "flow", "2026-11-15T10:02:00Z", [{ kind: "mermaid", index: 0, mermaid: "graph TD; A-->B" }])
const later = post("p4", "later", "2026-11-15T10:03:00Z", [{ kind: "markdown", index: 0, markdown: "seen at last" }])

effectTest(
  "the feed: the board's newest version, the timeline newest first with a dot on what came, the newest drawn by kind, versions walked, a comment sent, Sideshow down, q",
  Effect.gen(function* () {
    const shots = yield* Shots
    const frames = yield* Frames
    const keys = yield* Keys
    const shot = png(1000, 800, 1)
    const diagram = png(800, 400, 2)
    yield* Ref.set(pages, new Map([[`${BASE}/p/p2?surface=0&ver=1`, shot], [MemoryDiagrams.pageOf("graph TD; A-->B"), diagram]]))
    yield* Ref.set(world, {
      ...MemorySideshow.empty,
      history: new Map([["p1", [{ version: 1, title: "notes", at: "2026-11-15T10:00:00Z", surfaces: [{ kind: "markdown", index: 0, markdown: "first draft" }] }, { version: 2, title: "notes", at: "2026-11-15T10:00:30Z", surfaces: [{ kind: "markdown", index: 0, markdown: "second draft" }] }]]]),
    })
    yield* holding([board(1, "step one"), notes, sketch])
    const running = yield* Effect.forkChild(viewer("session:a", pane(frames, keys)))

    // The board on top, the timeline newest first, the newest (sketch) shot as its page.
    const first = yield* frameWith(frames, "feed · Plan", "◆ Board", "step one", Base64.encode(shot))
    expect(first.indexOf("sketch")).toBeLessThan(first.indexOf("notes"))
    expect((yield* Queue.take(shots)).url).toBe(`${BASE}/p/p2?surface=0&ver=1`)

    // A post comes: on top, and the view follows it, so it is seen and has no dot; its Mermaid drawn from its Pele page.
    yield* holding([board(1, "step one"), notes, sketch, flow])
    const came = yield* frameWith(frames, Base64.encode(diagram))
    expect(came.indexOf("flow")).toBeLessThan(came.indexOf("sketch"))
    expect(came).not.toContain("●")

    // The board picked, a post that comes keeps its dot until the view shows it.
    yield* Queue.offer(keys, "b")
    // The view's header names the board (the board's own says "◆ Board").
    yield* frameWith(frames, "\u001b[1mBoard\u001b[0m")
    yield* holding([board(1, "step one"), notes, sketch, flow, later])
    yield* frameWith(frames, "●", "later")
    yield* Queue.offer(keys, "j")
    expect(yield* frameWith(frames, "seen at last")).not.toContain("●")

    // The board revised: its newest version shows.
    yield* holding([board(2, "step two"), notes, sketch, flow, later])
    yield* frameWith(frames, "v2 · updated", "step two")

    // Sideshow down: the status line says so, the posts stay.
    yield* Ref.update(world, (now) => ({ ...now, down: true }))
    yield* frameWith(frames, `✗ Sideshow not reachable at ${BASE}: ECONNREFUSED`, "flow")
    yield* Ref.update(world, (now) => ({ ...now, down: false }))

    // Down thrice from the newest: notes, at its third version; [ walks back, ] forward.
    yield* Queue.offer(keys, "jjj")
    yield* frameWith(frames, "v3/3", "third draft")
    yield* Queue.offer(keys, "[")
    yield* frameWith(frames, "v2/3", "second draft")
    yield* Queue.offer(keys, "[")
    yield* frameWith(frames, "v1/3", "first draft")
    yield* Queue.offer(keys, "[")
    yield* Queue.offer(keys, "]")
    yield* frameWith(frames, "v2/3", "second draft")

    // c, a comment, Enter: sent as the user on notes.
    yield* Queue.offer(keys, "c")
    yield* Queue.offer(keys, "looks good")
    yield* frameWith(frames, "comment:", "looks good")
    yield* Queue.offer(keys, "\r")
    yield* frameWith(frames, "comment sent")
    expect((yield* Ref.get(world)).comments).toEqual([{ post: "p1", text: "looks good" }])

    // A board taller than its region, focused (B) and scrolled down five lines: its title scrolled out.
    yield* holding([board(3, Arr.makeBy(30, (n) => `later step ${n + 1}`).join("\n- ")), notes, sketch, flow, later])
    yield* frameWith(frames, "later step 1")
    yield* Queue.offer(keys, "B")
    yield* frameWith(frames, "board: j/k scroll")
    yield* Queue.offer(keys, "jjjjj")
    // Each j draws a frame; the fifth starts at step 4 (the title, its gap and steps 1 to 3 above it), 16 lines below.
    const hiddenBelow = "… 16 more lines"
    const scrolled = yield* frameWith(frames, "later step 4", hiddenBelow)
    expect([scrolled.includes("Shipping the feed"), /later step 3\b/.test(scrolled)]).toEqual([false, false])

    // A page shown in its place ends the feed pane; q back from it, the feed goes on where it was: notes at v2, the board scrolled as it was.
    const page = png(1280, 900, 4)
    const feed = Feed.make({ base: BASE, session: "s1", name: "s1", every: 0 })
    yield* Ref.update(pages, (now) => new Map([...now, ["http://localhost:3000/", page]]))
    yield* Ref.set(viewed, new Map([["session:a", { seq: 2, feed, shown: Url.make({ url: "http://localhost:3000/", name: "localhost:3000", every: 60, width: 1280 }) }]]))
    yield* frameWith(frames, "showcase · localhost:3000", Base64.encode(page))
    yield* Queue.offer(keys, "q")
    const back = yield* frameWith(frames, "feed · Plan", "v2/3", "second draft", "board: j/k scroll", "later step 6", hiddenBelow)
    expect([back.includes("Shipping the feed"), /later step 3\b/.test(back)]).toEqual([false, false])

    yield* Queue.offer(keys, "q")
    expect(yield* Fiber.join(running)).toBe("")
  }).pipe(Effect.provide(following)),
  hangGuard("short-fixture"),
)

const still = Ref.makeUnsafe<ReadonlyMap<string, Spooled>>(new Map())
const watched = Ref.makeUnsafe<MemorySideshow.World>(MemorySideshow.empty)
const stillPages = Ref.makeUnsafe<MemoryBrowser.Pages>(new Map())

effectTest(
  "a page shown leaves its first shot and its command in the feed, and q goes back to the feed",
  Effect.gen(function* () {
    const frames = yield* Frames
    const keys = yield* Keys
    const shot = png(1280, 900, 3)
    const feed = Feed.make({ base: BASE, session: "s1", name: "s1", every: 0 })
    yield* Ref.set(stillPages, new Map([["http://localhost:3000/", shot]]))
    yield* Ref.set(watched, { ...MemorySideshow.empty, sessions: new Map([["s1", { title: "Plan", posts: [] }]]) })
    yield* Ref.set(still, new Map([["session:a", { seq: 2, feed, shown: Url.make({ url: "http://localhost:3000/", name: "localhost:3000", every: 60, width: 1280 }) }]]))
    const running = yield* Effect.forkChild(viewer("session:a", pane(frames, keys)))
    yield* frameWith(frames, "showcase · localhost:3000", Base64.encode(shot))
    // q: the feed again, where the entry shows once it is posted (in the background: its shot uploaded, then the post).
    yield* Queue.offer(keys, "q")
    yield* frameWith(frames, "feed · Plan", "url · localhost:3000")
    expect((yield* Ref.get(still)).get("session:a")?.shown).toEqual(feed)
    const entry = (yield* Ref.get(watched)).entries
    expect(entry.map((each) => each.title)).toEqual(["url · localhost:3000"])
    expect(entry[0]?.surfaces).toEqual([{ kind: "image", assetId: "asset-1" }, { kind: "terminal", text: "$ rex-show url http://localhost:3000/\n" }])
    yield* Queue.offer(keys, "q")
    expect(yield* Fiber.join(running)).toBe("")
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        MemorySideshow.layer(watched),
        MemoryBrowser.layer(stillPages),
        MemorySpool.layer(still),
        MemorySimulators.layer(Ref.makeUnsafe(MemorySimulators.empty)),
        MemoryDiagrams.layer,
        MemoryOpener.layer(Ref.makeUnsafe<ReadonlyArray<string>>([])),
      ).pipe(Layer.provideMerge(queues)),
    ),
  ),
  hangGuard("in-memory"),
)
