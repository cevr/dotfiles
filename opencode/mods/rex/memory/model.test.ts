// The showcase rule as a property: whatever calls come, one at a time or
// several at once interleaved at every call to Rex, from any pane of any
// session, and whatever the user does between them (closing a showcase,
// labeling another pane `showcase`), each session a call came from ends with
// exactly one showcase pane, its viewer running (one that exited is made
// again), every other session's panes are as they were, and no caller's
// pane is ever closed. Seeded; a failure names its seed.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Data, Effect, Layer, Option, Ref } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import * as MemoryRex from "./rex.ts"
import * as MemorySpool from "./spool.ts"
import { ensureShowcase, setTally, showFile, showLive } from "../model.ts"
import type { Pane } from "../pane.ts"
import type { Rex, Spool } from "../service.ts"
import { arrange, LABEL } from "../showcase.ts"
import { Browse, Feed, Picture, Sim, type Spooled, Url } from "../spool.ts"

/** Hang guard for the generated in-memory cases. */
const HANG_GUARD_MS = 30_000

/** A seeded generator of numbers in [0, 1) (mulberry32). */
const drawer = (seed: number) => {
  const state = { at: seed >>> 0 }
  return () => {
    state.at = (state.at + 0x6d2b79f5) >>> 0
    const mixed = Math.imul(state.at ^ (state.at >>> 15), 1 | state.at)
    const more = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((more ^ (more >>> 14)) >>> 0) / 4294967296
  }
}

const SESSIONS = ["session:a", "session:b", "session:c"]
const VIEWER = ["rex-show", "view"]

/** What a call shows: a picture, a tally, or a live item (a simulator, a Sideshow session, a web page, a live tab). */
const KINDS = ["image", "tally", "sim", "sideshow", "url", "browse"] as const
type Kind = (typeof KINDS)[number]

interface Call {
  readonly pane: Pane
  readonly kind: Kind
}

type Step = Data.TaggedEnum<{
  Calls: { readonly calls: ReadonlyArray<Call> }
  CloseShowcase: { readonly session: string }
  ViewerExits: { readonly session: string }
  LabelShowcase: { readonly block: string }
}>
const Step = Data.taggedEnum<Step>()

const showcasesIn = (world: MemoryRex.World, session: string) => world.blocks.filter((block) => block.session === session && block.label === LABEL)
const panesIn = (world: MemoryRex.World, session: string) => world.blocks.filter((block) => block.session === session && block.label !== LABEL)
const blocksIn = (world: MemoryRex.World, session: string) => world.blocks.filter((block) => block.session === session)

/** One seed's world, its spools, and its draws. */
interface Seeded {
  readonly seed: number
  readonly draw: () => number
  readonly rex: Ref.Ref<MemoryRex.World>
  readonly services: Layer.Layer<Rex | Spool>
}

const seeded = (seed: number): Seeded => {
  const draw = drawer(seed)
  const start = MemoryRex.world(SESSIONS.flatMap((session) => Array.from({ length: 1 + Math.floor(draw() * 3) }, () => ({ session, label: "shell" }))))
  const rex = Ref.makeUnsafe(start)
  const spools = Ref.makeUnsafe<ReadonlyMap<string, Spooled>>(new Map())
  return { seed, draw, rex, services: Layer.mergeAll(MemoryRex.layer(rex, () => Math.floor(draw() * 4)), MemorySpool.layer(spools)) }
}

const pick = <A>(draw: () => number, items: ReadonlyArray<A>): A => items[Math.floor(draw() * items.length)]

/** The next step: mostly a batch of one to three calls, sometimes the user closing or labeling a pane. */
const stepOf = (draw: () => number, world: MemoryRex.World): Step => {
  const roll = draw()
  if (roll >= 0.85) return Step.LabelShowcase({ block: pick(draw, world.blocks).id })
  if (roll >= 0.75) return Step.CloseShowcase({ session: pick(draw, SESSIONS) })
  if (roll >= 0.65) return Step.ViewerExits({ session: pick(draw, SESSIONS) })
  const call = (): Call => {
    const session = pick(draw, SESSIONS)
    return { pane: { session, block: pick(draw, panesIn(world, session)).id }, kind: pick(draw, KINDS) }
  }
  return Step.Calls({ calls: Array.from({ length: 1 + Math.floor(draw() * 3) }, call) })
}

const CALLS: Record<Kind, (pane: Pane) => ReturnType<typeof showLive>> = {
  image: (pane) => showFile(pane, Picture.make({ file: "x.png", name: "x.png" }), VIEWER),
  tally: (pane) => setTally(pane, { msg: "2 of 5 done", state: "working", progress: 40 }, VIEWER),
  sim: (pane) => showLive(pane, Sim.make({ device: "", host: "", name: "simulator", every: 1 }), VIEWER),
  sideshow: (pane) => showLive(pane, Feed.make({ base: "http://localhost:8228", session: "s1", name: "s1", every: 3 }), VIEWER),
  url: (pane) => showLive(pane, Url.make({ url: "http://localhost:3000/", name: "localhost:3000", every: 5, width: 1280 }), VIEWER),
  browse: (pane) => showLive(pane, Browse.make({ url: "http://localhost:3000/", name: "localhost:3000", width: 0, fps: 6 }), VIEWER),
}

const callOf = (call: Call) => CALLS[call.kind](call.pane)

/** The user closes a session's oldest showcase. */
const closeShowcase = (rex: Ref.Ref<MemoryRex.World>, session: string) =>
  Ref.update(rex, (now) => {
    const gone = Arr.head(showcasesIn(now, session))
    return { ...now, blocks: now.blocks.filter((block) => Option.match(gone, { onNone: () => true, onSome: (held) => held.id !== block.id })) }
  })

/** The viewer of a session's oldest showcase exits; Rex keeps its pane open, showing it exited. */
const viewerExits = (rex: Ref.Ref<MemoryRex.World>, session: string) =>
  Ref.update(rex, (now) => {
    const ended = Arr.head(showcasesIn(now, session))
    return { ...now, blocks: now.blocks.map((block) => Option.match(Option.filter(ended, (held) => held.id === block.id), { onNone: () => block, onSome: () => ({ ...block, exited: true }) })) }
  })

/** The user labels a pane `showcase`, unless it is the last plain pane of its session: a session keeps a pane to call from. */
const labelShowcase = (rex: Ref.Ref<MemoryRex.World>, id: string) =>
  Ref.update(rex, (now) => {
    const held = now.blocks.filter((block) => block.id === id && panesIn(now, block.session).length > 1)
    if (held.length === 0) return now
    return { ...now, blocks: now.blocks.map((block) => Option.match(Option.liftPredicate(block, (each) => each.id === id), { onNone: () => block, onSome: (each) => ({ ...each, label: LABEL }) })) }
  })

/** A batch of calls at once, then the property over every session. */
const calls = (run: Seeded, step: number, batch: ReadonlyArray<Call>) =>
  Effect.gen(function* () {
    const before = yield* Ref.get(run.rex)
    yield* Effect.all(batch.map(callOf), { concurrency: 3 })
    const after = yield* Ref.get(run.rex)
    const called = new Set(batch.map((call) => call.pane.session))
    for (const session of SESSIONS) {
      const where = `seed ${run.seed}, step ${step}, ${session}`
      if (called.has(session))
        expect({ where, showcases: showcasesIn(after, session).map((block) => block.exited === true) }).toEqual({ where, showcases: [false] })
      else expect({ where, blocks: blocksIn(after, session) }).toEqual({ where, blocks: blocksIn(before, session) })
    }
    for (const call of batch) expect({ where: `seed ${run.seed}, step ${step}`, kept: after.blocks.some((block) => block.id === call.pane.block) }).toMatchObject({ kept: true })
  })

/** One seed's run: up to twelve steps, the property checked after each batch of calls. */
const play = (run: Seeded) =>
  Effect.forEach(
    Array.from({ length: 1 + Math.floor(run.draw() * 12) }, (_, step) => step),
    (step) =>
      Effect.flatMap(Ref.get(run.rex), (world) =>
        Step.$match(stepOf(run.draw, world), {
          Calls: ({ calls: batch }) => calls(run, step, batch),
          CloseShowcase: ({ session }) => closeShowcase(run.rex, session),
          ViewerExits: ({ session }) => viewerExits(run.rex, session),
          LabelShowcase: ({ block }) => labelShowcase(run.rex, block),
        }),
      ),
    { discard: true },
  )

describe("the showcase rule", () => {
  test("keeps the oldest showcase and closes the others, never the caller's pane", () => {
    const blocks = [
      { id: "block:3", label: LABEL },
      { id: "block:1", label: "shell" },
      { id: "block:2", label: LABEL },
      { id: "block:4", label: LABEL },
    ]
    expect(arrange(blocks, "block:1")).toEqual({ keep: Option.some("block:2"), close: ["block:3", "block:4"] })
    expect(arrange(blocks, "block:2").close).toEqual(["block:4"])
    expect(Option.isNone(arrange([{ id: "block:1", label: "shell" }], "block:1").keep)).toBe(true)
  })

  const one = seeded(0)
  const pane = { session: "session:a", block: MemoryRex.blockId(1) }
  effectTest(
    "makes one showcase beside the caller, then reuses it",
    Effect.gen(function* () {
      yield* Ref.set(one.rex, MemoryRex.world([{ session: "session:a", label: "shell" }]))
      const first = yield* ensureShowcase(pane, VIEWER)
      expect(yield* ensureShowcase(pane, VIEWER)).toBe(first)
      expect((yield* Ref.get(one.rex)).blocks.map((block) => block.label)).toEqual(["shell", LABEL])
    }).pipe(Effect.provide(one.services)),
    HANG_GUARD_MS,
  )

  const runs = Array.from({ length: 300 }, (_, seed) => seeded(seed))
  effectTest(
    "any sequence of calls leaves exactly one showcase in each calling session, and touches no other",
    Effect.forEach(runs, (run) => play(run).pipe(Effect.provide(run.services)), { discard: true }),
    30_000,
  )
})
