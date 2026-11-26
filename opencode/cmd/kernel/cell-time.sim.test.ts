// @reads all
// @reads-reason computed read at mods/kernel/worker/workers.ts: the process workers ./server.ts imports; this file provides a stand-in Workers and starts no worker
// Time in cells (law W6) through the plugin, on the simulated host at the runner's seeds: the kernel plugin on its
// OpenCode storage and sessions, its workers a stand-in whose cell sleeps the milliseconds its code names in virtual
// time. A root that spends minute after minute in cells is told once, when its hour passes 15%, and again only an hour
// later, never once per cell; a restart in between keeps both the hour (the `time` RPC reads the same) and the notice
// already given (no second notice right after it). A subagent over the bound shows on the RPC and is told nothing.
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { KERNEL_TIME, TimeAnswer } from "@dotfiles/opencode-kernel/cell-time"
import * as FileStoreFiles from "@dotfiles/opencode-kernel/filestore/files"
import * as OpenCodeCellTimes from "@dotfiles/opencode-kernel/opencode/cell-times"
import * as OpenCodeSessions from "@dotfiles/opencode-kernel/opencode/sessions"
import * as OpenCodeSnapshots from "@dotfiles/opencode-kernel/opencode/snapshots"
import { Workers } from "@dotfiles/opencode-kernel/service"
import { make } from "./server.ts"
import { simulationRunner } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = simulationRunner("cmd/kernel/cell-time.sim.test.ts")
const WORK = "/scratch/cells"
const MINUTE = 60_000
/** One cell: three minutes, so the bound (15% of an hour, 9 min) is passed by the fourth. */
const CELL = 3 * MINUTE

/** Workers whose cell sleeps for the milliseconds its source names, in the world's time; nothing else. */
const sleepingWorkers = Layer.sync(Workers, () => {
  const alive = new Set<string>()
  return Workers.of({
    alive: (session) => Effect.sync(() => alive.has(session)),
    start: (session) => Effect.sync(() => void alive.add(session)),
    evaluate: (_session, cell) =>
      Effect.sleep(Number(cell.source)).pipe(Effect.as({ ok: true, output: "", display: "slept", truncated: false, bindings: [], attached: [] })),
    snapshot: () => Effect.succeed({ bindings: [], omitted: [] }),
    restore: () => Effect.succeed([]),
    stop: (session) => Effect.sync(() => void alive.delete(session)),
  })
})

const plugin = make(
  (ctx) =>
    Layer.mergeAll(
      sleepingWorkers,
      OpenCodeSnapshots.layer(ctx.storage),
      OpenCodeSessions.fromContext(ctx),
      FileStoreFiles.layer,
      OpenCodeCellTimes.layer(ctx.storage),
      OpenCodeCellTimes.noticesFromContext(ctx),
    ),
  () => Stream.never,
)

const decodeTimes = Schema.decodeUnknownEffect(TimeAnswer)

/**
 * The model: each `Run a cell of N ms` the conversation has not yet run is one kernel call of N ms, its code the
 * number the stand-in sleeps; once it has run, a line.
 */
const script: World.Script = (request) => {
  const asks = [...request.text.matchAll(/Run a cell of (\d+) ms/g)].map((match) => match[1] ?? "0")
  const ran = request.text.split("\ntool ").length - 1
  return Option.match(Option.liftPredicate(asks.at(-1) ?? "", () => request.kind === "primary" && ran < asks.length), {
    onNone: () => World.say("ok"),
    onSome: (ms) => World.call(`call_${asks.length}`, "kernel", { code: ms, description: `Wait ${ms} ms` }),
  })
}

seeded("a root is told once an hour, never per cell, and a restart keeps the hour and the notice", ({ seed, expect }) =>
  Effect.gen(function* () {
    const world = World.make({ seed, script })
    yield* world.load(plugin, { directory: WORK, options: { codeOnly: false } })
    const root = yield* world.session(WORK)
    const child = yield* world.session(WORK, { parentID: root, agent: "worker" })
    /** One turn of the session that runs one cell of `ms`, named, the clock moving while it sleeps. */
    const cell = (session: string, ms: number) =>
      Effect.gen(function* () {
        yield* world.prompt(session, `Run a cell of ${ms} ms`)
        // The cell's sleep in one step, then the model's answer after it in steps of a second.
        yield* world.advance(ms)
        yield* world.until(() => world.sessions.get(session)?.running !== true, MINUTE, 1_000)
      })
    /** The notices of the hour's bound the session holds, read or waiting for its next turn. */
    const notices = (session: string) => {
      const held = world.sessions.get(session)
      // The notice is a synthetic message: read if delivered, an inbox item while it waits.
      const synthetic = [...(held?.messages ?? []), ...(held?.inbox ?? [])].filter((item) => item.type === "synthetic")
      return synthetic.filter((item) => item.text.includes("over the 15% bound")).length
    }
    const time = (session: string) =>
      world.rpc(KERNEL_TIME, "time", { sessionIDs: [session] }).pipe(
        Effect.flatMap(decodeTimes),
        Effect.map((answer) => answer.times[0]!),
      )

    // Thirty minutes of three-minute cells: over 15% from the fourth on, and told once.
    for (let index = 0; index < 10; index++) yield* cell(root, CELL)
    expect(notices(root)).toBe(1)
    const before = yield* time(root)
    expect(before.cells).toBe(10)
    expect(before.unwell).toBe(true)
    expect(before.longest[0]?.description).toBe(`Wait ${CELL} ms`)

    // A restart keeps the hour, and the notice given: two more cells tell nothing new.
    yield* world.restart
    const after = yield* time(root)
    expect(after.cells).toBe(10)
    expect(after.share).toBeCloseTo(before.share, 6)
    for (let index = 0; index < 2; index++) yield* cell(root, CELL)
    expect(notices(root)).toBe(1)

    // An hour after the first notice, the next cell over the bound tells it again: once.
    for (let index = 0; index < 14; index++) yield* cell(root, CELL)
    expect(notices(root)).toBe(2)

    // A subagent over the bound shows on the RPC and is told nothing.
    for (let index = 0; index < 4; index++) yield* cell(child, CELL)
    expect((yield* time(child)).unwell).toBe(true)
    expect(notices(child)).toBe(0)
  }),
)
