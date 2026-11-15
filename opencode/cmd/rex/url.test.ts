// `rex-show url`: the arguments it takes, the caller (one showcase, the page
// spooled, no check of the page: that is the pane's to show), and the
// viewer, which shoots the page as tall as the pane's shape, draws a shot
// only when it differs from the last, draws a page that does not answer as
// an error line, and draws the page again once it answers again.
import { describe, expect } from "bun:test"
import * as MemoryBrowser from "@dotfiles/opencode-rex/memory/browser"
import * as MemorySideshow from "@dotfiles/opencode-rex/memory/sideshow"
import * as MemoryRex from "@dotfiles/opencode-rex/memory/rex"
import * as MemorySpool from "@dotfiles/opencode-rex/memory/spool"
import type { Shot } from "@dotfiles/opencode-rex/service"
import { Url, type Spooled } from "@dotfiles/opencode-rex/spool"
import { ConfigProvider, Context, Effect, Exit, Fiber, Layer, Option, Queue, Ref, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { effectTest } from "../../sim-tui/effect-test.ts"
import { parse, Refused, Request, run, type Screen, viewer } from "./show.ts"

const PAGE = "http://localhost:4321/"

/** A PNG's first 24 bytes, `width` × `height`, then `mark` so two shots of one size differ. */
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

describe("the arguments of rex-show url", () => {
  effectTest(
    "a URL, every 5 s at 1280 px by default; --every and --width; anything not http or https, or out of range, is a usage error",
    Effect.gen(function* () {
      expect(yield* parse(["url", "http://localhost:4321"])).toEqual(
        Request.Visit({ page: Url.make({ url: PAGE, name: "localhost:4321", every: 5, width: 1280 }) }),
      )
      expect(yield* parse(["url", "https://example.com/a/b/", "--every", "2", "--width", "800"])).toEqual(
        Request.Visit({ page: Url.make({ url: "https://example.com/a/b/", name: "example.com/a/b", every: 2, width: 800 }) }),
      )
      for (const bad of [["url"], ["url", "localhost:4321"], ["url", "file:///etc/hosts"], ["url", PAGE, "--every", "0"], ["url", PAGE, "--width", "50"], ["url", PAGE, PAGE]]) {
        expect({ bad, code: refusalOf(yield* Effect.exit(parse(bad))) }).toEqual({ bad, code: Option.some(2) })
      }
    }),
    5_000,
  )
})

describe("the caller of rex-show url", () => {
  const rex = Ref.makeUnsafe(MemoryRex.world([{ session: "session:a", label: "shell" }]))
  const spools = Ref.makeUnsafe<ReadonlyMap<string, Spooled>>(new Map())
  const settings = { rex: "rex", spool: "/state/rex-show", self: ["/opt/bun", "/dotfiles/rex/show.ts"] }
  const quiet: Screen = { size: Effect.succeed({ cols: 80, rows: 24 }), cell: () => Effect.succeed({ width: 12, height: 38 }), display: () => Effect.void }

  effectTest(
    "spools the page and makes one showcase, whether or not the page answers (no browser is asked)",
    Effect.gen(function* () {
      const block = yield* run(yield* parse(["url", "http://localhost:9/"]), quiet, settings)
      expect((yield* Ref.get(rex)).blocks.filter((held) => held.label === "showcase").map((held) => held.id)).toEqual([block])
      expect((yield* Ref.get(spools)).get("session:a")).toMatchObject({ shown: Url.make({ url: "http://localhost:9/", name: "localhost:9", every: 5, width: 1280 }) })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          MemoryRex.layer(rex),
          MemorySpool.layer(spools),
          MemoryBrowser.layer(Ref.makeUnsafe<MemoryBrowser.Pages>(new Map()), () => Effect.die("the caller shot the page")),
          MemorySideshow.layer(Ref.makeUnsafe(MemorySideshow.empty)),
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ REX_SESSION: "session:a", REX_BLOCK: MemoryRex.blockId(1) })),
        ),
      ),
    ),
    5_000,
  )
})

/** The shots the memory browser takes, as they are taken. */
class Shots extends Context.Service<Shots, Queue.Queue<Shot>>()("test/RexUrlShots") {}
/** The frames the viewer draws, as they are drawn. */
class Frames extends Context.Service<Frames, Queue.Queue<string>>()("test/RexUrlFrames") {}

const pages = Ref.makeUnsafe<MemoryBrowser.Pages>(new Map())
const viewed = Ref.makeUnsafe<ReadonlyMap<string, Spooled>>(new Map([["session:a", { seq: 1, shown: Url.make({ url: PAGE, name: "localhost:4321", every: 0, width: 1200 }) }]]))
const queues = Layer.mergeAll(Layer.effect(Shots)(Queue.unbounded<Shot>()), Layer.effect(Frames)(Queue.unbounded<string>()))
const browser = Layer.unwrap(Shots.use((shots) => Effect.succeed(MemoryBrowser.layer(pages, (shot) => Queue.offer(shots, shot)))))
const watching = Layer.mergeAll(browser, MemorySpool.layer(viewed), MemorySideshow.layer(Ref.makeUnsafe(MemorySideshow.empty))).pipe(Layer.provideMerge(queues))

/** A pane of 82 × 35 cells of Rex's 12 × 38 px, its frames to `frames`. */
const pane = (frames: Queue.Queue<string>): Screen => ({
  size: Effect.succeed({ cols: 82, rows: 35 }),
  cell: () => Effect.succeed({ width: 12, height: 38 }),
  display: (text) => Queue.offer(frames, text),
})

effectTest(
  "the viewer shoots the page to fill the pane, redraws only a changed shot, shows an error line while it does not answer, and the page again after",
  Effect.gen(function* () {
    const shots = yield* Shots
    const frames = yield* Frames
    const first = png(1200, 2513, 1)
    yield* Ref.set(pages, new Map([[PAGE, first]]))
    const running = yield* Effect.forkChild(viewer("session:a", pane(frames)))
    // 33 rows under the header: 1200 px wide fills 82 × 12 px, so 33 × 38 px of height is 1200 × 1254 / 984 = 1529 px.
    expect(yield* Queue.take(shots)).toEqual({ url: PAGE, width: 1200, height: 1529 })
    expect(yield* Queue.take(frames)).toContain(Base64.encode(first))
    // The same shot twice more: shot, never drawn again.
    yield* Queue.take(shots)
    yield* Queue.take(shots)
    expect(yield* Queue.size(frames)).toBe(0)
    const second = png(1200, 2513, 2)
    yield* Ref.set(pages, new Map([[PAGE, second]]))
    expect(yield* Queue.take(frames)).toContain(Base64.encode(second))
    yield* Ref.set(pages, new Map())
    expect(yield* Queue.take(frames)).toContain(`✗ cannot reach ${PAGE}: ECONNREFUSED`)
    yield* Ref.set(pages, new Map([[PAGE, second]]))
    expect(yield* Queue.take(frames)).toContain(Base64.encode(second))
    yield* Fiber.interrupt(running)
  }).pipe(Effect.provide(watching)),
  15_000,
)
