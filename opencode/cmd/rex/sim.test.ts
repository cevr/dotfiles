// `rex-show sim`: the arguments it takes, the caller (one showcase, the
// simulator and the Mac host spooled, no simulator asked), and the viewer
// over a fake screenshot source: the screen drawn under the device's name
// and OS, not drawn again while it does not change, drawn again once it
// does, and the pane's words when none is booted or the one named is not.
import { describe, expect } from "bun:test"
import * as MemoryBrowser from "@dotfiles/opencode-rex/memory/browser"
import * as MemoryRex from "@dotfiles/opencode-rex/memory/rex"
import * as MemorySideshow from "@dotfiles/opencode-rex/memory/sideshow"
import * as MemorySimulators from "@dotfiles/opencode-rex/memory/simulators"
import * as MemorySpool from "@dotfiles/opencode-rex/memory/spool"
import type { Device } from "@dotfiles/opencode-rex/sim"
import { Sim, type Spooled } from "@dotfiles/opencode-rex/spool"
import { ConfigProvider, Context, Effect, Exit, Fiber, Layer, Option, Queue, Ref, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { effectTest } from "../../sim-tui/effect-test.ts"
import { parse, Refused, Request, run, type Screen, viewer } from "./show.ts"

/** A PNG's first 24 bytes, `width` × `height`, then `mark` so two screens of one size differ. */
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

const HYMNAL: Device = { udid: "9969DB1A-0F0C-4F3E-B27B-055B1AA83E35", name: "verify-hymnal", os: "iOS 27.0", used: "2026-11-15T04:47:00Z" }
const HEARTSEED: Device = { udid: "26FBDB9E-3FFE-432A-8FE0-ABB32A69B378", name: "verify-heartseed", os: "iOS 27.0", used: "2026-11-15T01:26:08Z" }

describe("the arguments of rex-show sim", () => {
  effectTest(
    "an optional DEVICE, screenshot every second by default; --every; two devices or a bad interval is a usage error",
    Effect.gen(function* () {
      expect(yield* parse(["sim"])).toEqual(Request.Mirror({ device: Option.none(), every: 1 }))
      expect(yield* parse(["sim", "verify-hymnal", "--every", "3"])).toEqual(Request.Mirror({ device: Option.some("verify-hymnal"), every: 3 }))
      for (const bad of [["sim", "a", "b"], ["sim", "--every", "0"]]) {
        expect({ bad, code: refusalOf(yield* Effect.exit(parse(bad))) }).toEqual({ bad, code: Option.some(2) })
      }
    }),
    5_000,
  )
})

describe("the caller of rex-show sim", () => {
  const rex = Ref.makeUnsafe(MemoryRex.world([{ session: "session:a", label: "shell" }]))
  const spools = Ref.makeUnsafe<ReadonlyMap<string, Spooled>>(new Map())
  const settings = { rex: "rex", spool: "/state/rex-show", self: ["/opt/bun", "/dotfiles/rex/show.ts"] }
  const quiet: Screen = { size: Effect.succeed({ cols: 80, rows: 24 }), cell: () => Effect.succeed({ width: 12, height: 38 }), display: () => Effect.void, input: Effect.succeed(Effect.never) }

  effectTest(
    "spools the simulator asked for and the Mac REX_SHOW_SIM_HOST names, in one showcase, asking no simulator",
    Effect.gen(function* () {
      yield* run(yield* parse(["sim", "verify-hymnal"]), quiet, settings)
      expect((yield* Ref.get(spools)).get("session:a")?.shown).toEqual(Sim.make({ device: "verify-hymnal", host: "cvr@mac", name: "verify-hymnal", every: 1 }))
      yield* run(yield* parse(["sim"]), quiet, settings)
      expect((yield* Ref.get(spools)).get("session:a")?.shown).toEqual(Sim.make({ device: "", host: "cvr@mac", name: "simulator", every: 1 }))
      expect((yield* Ref.get(rex)).blocks.filter((held) => held.label === "showcase").length).toBe(1)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          MemoryRex.layer(rex),
          MemorySpool.layer(spools),
          MemoryBrowser.layer(Ref.makeUnsafe<MemoryBrowser.Pages>(new Map())),
          MemorySideshow.layer(Ref.makeUnsafe(MemorySideshow.empty)),
          MemorySimulators.layer(Ref.makeUnsafe(MemorySimulators.empty), () => Effect.die("the caller screenshot the simulator")),
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ REX_SESSION: "session:a", REX_BLOCK: MemoryRex.blockId(1), REX_SHOW_SIM_HOST: "cvr@mac" })),
        ),
      ),
    ),
    5_000,
  )
})

/** Each screenshot the viewer takes, by udid. */
class Taken extends Context.Service<Taken, Queue.Queue<string>>()("test/RexSimTaken") {}
/** The frames the viewer draws. */
class Frames extends Context.Service<Frames, Queue.Queue<string>>()("test/RexSimFrames") {}

const world = Ref.makeUnsafe<MemorySimulators.World>(MemorySimulators.empty)
const viewed = Ref.makeUnsafe<ReadonlyMap<string, Spooled>>(new Map([["session:a", { seq: 1, shown: Sim.make({ device: "", host: "", name: "simulator", every: 0 }) }]]))
const queues = Layer.mergeAll(Layer.effect(Taken)(Queue.unbounded<string>()), Layer.effect(Frames)(Queue.unbounded<string>()))
const simulators = Layer.unwrap(Taken.use((taken) => Effect.succeed(MemorySimulators.layer(world, (udid) => Queue.offer(taken, udid)))))
const mirroring = Layer.mergeAll(
  simulators,
  MemorySpool.layer(viewed),
  MemoryBrowser.layer(Ref.makeUnsafe<MemoryBrowser.Pages>(new Map())),
  MemorySideshow.layer(Ref.makeUnsafe(MemorySideshow.empty)),
).pipe(Layer.provideMerge(queues))

/** A pane of 82 × 35 cells of Rex's 12 × 38 px, its frames to `frames`. */
const pane = (frames: Queue.Queue<string>): Screen => ({
  size: Effect.succeed({ cols: 82, rows: 35 }),
  cell: () => Effect.succeed({ width: 12, height: 38 }),
  display: (text) => Queue.offer(frames, text),
  input: Effect.succeed(Effect.never),
})

effectTest(
  "the viewer mirrors the simulator used last, named in the header, draws a screen again only when it changes, and says when none is booted",
  Effect.gen(function* () {
    const taken = yield* Taken
    const frames = yield* Frames
    const home = png(1206, 2622, 1)
    yield* Ref.set(world, { ...MemorySimulators.empty, booted: [HEARTSEED, HYMNAL], screens: new Map([[HYMNAL.udid, home], [HEARTSEED.udid, png(1206, 2622, 9)]]) })
    const running = yield* Effect.forkChild(viewer("session:a", pane(frames)))
    expect(yield* Queue.take(taken)).toBe(HYMNAL.udid)
    const first = yield* Queue.take(frames)
    expect(first).toContain("showcase · verify-hymnal · iOS 27.0")
    expect(first).toContain(Base64.encode(home))
    // A tall screen in a wide pane: 33 rows bind, so 1206 × 2622 px takes round(33 × 38 × 1206 / 2622 / 12) = 48 columns.
    expect(first).toContain("a=T,f=100,q=2,c=48,r=33,")
    // The same screen twice more: screenshot, never drawn again.
    yield* Queue.take(taken)
    yield* Queue.take(taken)
    expect(yield* Queue.size(frames)).toBe(0)
    const tapped = png(1206, 2622, 2)
    yield* Ref.update(world, (now) => ({ ...now, screens: new Map([[HYMNAL.udid, tapped]]) }))
    expect(yield* Queue.take(frames)).toContain(Base64.encode(tapped))
    yield* Ref.update(world, (now) => ({ ...now, booted: [] }))
    expect(yield* Queue.take(frames)).toContain("showcase · simulator\u001b[0m\r\n\u001b[31m✗ no iOS simulator is booted: boot one in Xcode")
    yield* Ref.update(world, (now) => ({ ...now, unreachable: Option.some("cannot reach cvr@mac with ssh (Permission denied (publickey))") }))
    expect(yield* Queue.take(frames)).toContain("✗ cannot reach cvr@mac with ssh")
    yield* Fiber.interrupt(running)
  }).pipe(Effect.provide(mirroring)),
  15_000,
)
