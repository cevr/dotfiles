// The owed post-land steps in their file: nothing before the first write, what was written read back by a
// fresh layer (a restarted server), the first version's file read as its owed steps, and a file that cannot be read holding nothing owed.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Clock, Context, Deferred, Effect, Fiber, Layer, Option, Schema } from "effect"
import { noDebts, owe, OwedPostLand, type Debts } from "../owed.ts"
import { PostLandClaim, PostLandDebts } from "../service.ts"
import { debtsFile, layer } from "./debts.ts"

const debtsAt = (file: string) => Effect.map(Layer.build(layer(file)), (services) => Context.get(services, PostLandDebts))

const owing = (head: string, at: number) => ({
  source: "/code/app",
  main: "main",
  command: "bun scripts/post-land.ts",
  sessionID: "ses_1",
  land: { base: `base-${head}`, head, units: [{ path: `/code/.rifts/app/${head}`, branch: `feat/${head}` }], at },
})

describe("the owed post-land steps' file", () => {
  test("holds nothing before the first write, keeps what was written for a fresh layer, and reads a broken file as nothing owed", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scratch = mkdtempSync(join(tmpdir(), "rift-debts-"))
          yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(scratch, { recursive: true, force: true })))
          const file = debtsFile(join(scratch, "rift-land"))
          const first = yield* debtsAt(file)
          expect(yield* first.read).toEqual(noDebts)
          const owed: ReadonlyArray<OwedPostLand> = owe(owe([], owing("h1", 1_000)), owing("h2", 2_000))
          const kept: Debts = { owed, loadedAt: Option.some(1_500) }
          yield* first.update(() => kept)
          const restarted = yield* debtsAt(file)
          expect(yield* restarted.read).toEqual(kept)
          yield* first.update((before) => ({ ...before, loadedAt: Option.none() }))
          expect(yield* restarted.read).toEqual({ owed, loadedAt: Option.none() })
          // The first version's file: the owed steps alone.
          writeFileSync(file, Schema.encodeSync(Schema.fromJsonString(Schema.Array(OwedPostLand)))(owed))
          expect(yield* restarted.read).toEqual({ owed, loadedAt: Option.none() })
          writeFileSync(file, "{ not json")
          expect(yield* restarted.read).toEqual(noDebts)
        }),
      ),
    ))

  // Two layers on one file stand for two rift plugin instances of one server: OpenCode loads one per
  // directory, in one process, and each opens the lock files on its own.
  test("two instances on one host: the claim is one, and no change is lost", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scratch = mkdtempSync(join(tmpdir(), "rift-claim-"))
          yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(scratch, { recursive: true, force: true })))
          const file = debtsFile(join(scratch, "rift-land"))
          const [one, other] = [yield* instanceAt(file), yield* instanceAt(file)]
          const ran: Array<string> = []
          const inner = yield* one.claim.hold(other.claim.holdIfFree(Effect.sync(() => ran.push("other"))))
          expect(inner).toEqual(Option.none())
          expect(ran).toEqual([])
          expect(yield* other.claim.holdIfFree(Effect.sync(() => ran.push("other")))).toEqual(Option.some(1))
          // A waiting holder runs once the first lets go, never beside it.
          const order: Array<string> = []
          const release = yield* Deferred.make<boolean>()
          const holding = yield* Deferred.make<boolean>()
          const first = yield* Effect.forkChild(
            one.claim.hold(Effect.andThen(Deferred.succeed(holding, true), Effect.andThen(Deferred.await(release), Effect.sync(() => order.push("one out"))))),
          )
          yield* Deferred.await(holding)
          const second = yield* Effect.forkChild(other.claim.hold(Effect.sync(() => order.push("other"))))
          yield* Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true })
          yield* Deferred.succeed(release, true)
          yield* Fiber.join(first)
          yield* Fiber.join(second)
          expect(order).toEqual(["one out", "other"])
          // Changes from both, at once, each read and written as one step: every one is kept.
          yield* Effect.forEach(
            Array.from({ length: 40 }, (_, index) => index),
            (index) => [one, other][index % 2]!.debts.update((before) => ({ ...before, owed: owe(before.owed, { ...owing(`h${index}`, index), source: `/code/app${index}` }) })),
            { concurrency: 40 },
          )
          expect((yield* one.debts.read).owed.length).toBe(40)
        }),
      ),
    ))

  // The claim holder pays the step it ran with `update` while it holds the claim: the claim and a change are
  // two locks, so the change never waits on the claim its own caller holds.
  test("a change made while holding the claim goes through at once, waiting or not", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scratch = mkdtempSync(join(tmpdir(), "rift-nested-"))
          yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(scratch, { recursive: true, force: true })))
          const file = debtsFile(join(scratch, "rift-land"))
          const store = yield* instanceAt(file)
          const change = (head: string) => store.debts.update((before) => ({ ...before, owed: owe(before.owed, { ...owing(head, 1), source: `/code/${head}` }) }))
          const held = yield* Effect.timeoutOption(store.claim.hold(change("held")), "2 seconds")
          const free = yield* Effect.timeoutOption(store.claim.holdIfFree(change("free")), "2 seconds")
          expect(Option.map(held, (debts) => debts.owed.length)).toEqual(Option.some(1))
          expect(Option.flatMap(free, (ran) => Option.map(ran, (debts) => debts.owed.length))).toEqual(Option.some(2))
        }),
      ),
    ))

  // Real processes, as the server and `bun run daily` (or two servers) are: each writer makes COUNT changes
  // at once with the others, and every change of every writer is kept.
  for (const writers of [2, 3]) {
    test(
      `${writers} processes changing the file at once lose no change`,
      () =>
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const scratch = mkdtempSync(join(tmpdir(), "rift-writers-"))
              yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(scratch, { recursive: true, force: true })))
              const file = debtsFile(join(scratch, "rift-land"))
              const names = Array.from({ length: writers }, (_, index) => `w${index}`)
              const startAt = (yield* Clock.currentTimeMillis) + 1_500
              const codes = yield* Effect.forEach(names, (name) => writer(file, name, startAt), { concurrency: writers })
              const kept = (yield* (yield* debtsAt(file)).read).owed.map((owed) => owed.source).toSorted()
              const made = names.flatMap((name) => Array.from({ length: COUNT }, (_, index) => `/code/${name}-${index}`)).toSorted()
              expect({ kept: kept.length, lost: made.filter((source) => !kept.includes(source)).length, codes }).toEqual({ kept: made.length, lost: 0, codes: names.map(() => 0) })
              expect(kept).toEqual(made)
            }),
          ),
        ),
      60_000,
    )
  }
})

/** How many changes each writer process makes. */
const COUNT = 100
const FIXTURE = require.resolve("./debts-writer.fixture.ts")
/** The writers whose process has ended: one never signalled after it is gone. */
const exited = new Set<number>()

/**
 * One writer process (debts-writer.fixture.ts) over `file`, in a process group of its own, killed with its
 * group when the scope ends before it does or when it outlasts 45 seconds; answers its exit code.
 */
const writer = (file: string, name: string, startAt: number) =>
  Effect.acquireRelease(
    Effect.sync(() => Bun.spawn([process.execPath, FIXTURE, file, name, String(COUNT), String(startAt)], { detached: true, stdout: "inherit", stderr: "inherit" })),
    (child) =>
      Effect.sync(() => {
        if (!exited.has(child.pid)) process.kill(-child.pid, "SIGKILL")
      }),
  ).pipe(
    Effect.flatMap((child) => Effect.tap(Effect.promise(() => child.exited), () => Effect.sync(() => exited.add(child.pid)))),
    Effect.timeoutOption("45 seconds"),
    Effect.map((code) => Option.getOrElse(code, () => -1)),
  )

const instanceAt = (file: string) =>
  Effect.map(Layer.build(layer(file)), (services) => ({ debts: Context.get(services, PostLandDebts), claim: Context.get(services, PostLandClaim) }))
