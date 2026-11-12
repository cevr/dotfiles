// The owed post-land steps in their file: nothing before the first write, what was written read back by a
// fresh layer (a restarted server), the first version's file read as its owed steps, and a file that cannot be read holding nothing owed.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { noDebts, owe, OwedPostLand, type Debts } from "../owed.ts"
import { PostLandDebts } from "../service.ts"
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
          yield* first.write(kept)
          const restarted = yield* debtsAt(file)
          expect(yield* restarted.read).toEqual(kept)
          yield* first.write({ owed, loadedAt: Option.none() })
          expect(yield* restarted.read).toEqual({ owed, loadedAt: Option.none() })
          // The first version's file: the owed steps alone.
          writeFileSync(file, Schema.encodeSync(Schema.fromJsonString(Schema.Array(OwedPostLand)))(owed))
          expect(yield* restarted.read).toEqual({ owed, loadedAt: Option.none() })
          writeFileSync(file, "{ not json")
          expect(yield* restarted.read).toEqual(noDebts)
        }),
      ),
    ))
})
