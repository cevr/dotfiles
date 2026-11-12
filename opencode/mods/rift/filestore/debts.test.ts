// The owed post-land steps in their file: nothing before the first write, what was written read back by a
// fresh layer (a restarted server), the first version's file read as its owed steps, and a file that cannot be read holding nothing owed.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Deferred, Effect, Fiber, Layer, Option, Schema } from "effect"
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
})

const instanceAt = (file: string) =>
  Effect.map(Layer.build(layer(file)), (services) => ({ debts: Context.get(services, PostLandDebts), claim: Context.get(services, PostLandClaim) }))
