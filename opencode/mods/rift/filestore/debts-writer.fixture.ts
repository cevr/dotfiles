// One writer process of debts.test.ts's cross-process case: once the clock reaches the start time, it makes
// `count` changes of the shared post-land-owed.json through the file store's `update`, each owing one source
// named after `name`, so the test can tell whether every writer's every change was kept.
// argv: <debts file> <name> <count> <start at, epoch ms>
import { Clock, Duration, Effect } from "effect"
import { owe } from "../owed.ts"
import { PostLandDebts } from "../service.ts"
import { layer } from "./debts.ts"

const [file = "", name = "", count = "0", startAt = "0"] = Bun.argv.slice(2)

const owing = (index: number) => ({
  source: `/code/${name}-${index}`,
  main: "main",
  command: "bun scripts/post-land.ts",
  sessionID: "ses_1",
  land: { base: "base0", head: `${name}-${index}`, units: [], at: index },
})

const program = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis
  yield* Effect.sleep(Duration.millis(Math.max(0, Number(startAt) - now)))
  const debts = yield* PostLandDebts
  yield* Effect.forEach(
    Array.from({ length: Number(count) }, (_, index) => index),
    (index) => debts.update((kept) => ({ ...kept, owed: owe(kept.owed, owing(index)) })),
    { discard: true },
  )
})

// A failed change rejects the promise: the process exits non-zero, and the test reads that.
void Effect.runPromise(program.pipe(Effect.provide(layer(file))))
