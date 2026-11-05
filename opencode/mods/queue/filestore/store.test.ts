import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { storeLaws } from "../laws.ts"
import { QueueStore } from "../service.ts"
import * as FileStore from "./store.ts"

/** A scratch directory for one test, removed after it. */
const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "queue-store-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

storeLaws(
  "filestore QueueStore",
  Effect.map(scratch, (dir) => {
    // The directory does not exist until the first write.
    const queues = join(dir, "queues")
    return {
      layer: FileStore.layer(queues),
      spoil: (sessionID) => Effect.sync(() => writeFileSync(FileStore.fileOf(queues, sessionID), "{ not json")),
    }
  }),
)

describe("filestore QueueStore", () => {
  test("keeps a session id inside its directory, and leaves no staged file behind", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* scratch
          const store = QueueStore.use((service) => service.write("../escape", { revision: 1, items: [] })).pipe(Effect.provide(FileStore.layer(dir)))
          yield* store
          expect(existsSync(join(dir, "..", "escape.json"))).toBe(false)
          expect(readdirSync(dir)).toEqual(["..%2Fescape.json"])
        }),
      ),
    ))
})
