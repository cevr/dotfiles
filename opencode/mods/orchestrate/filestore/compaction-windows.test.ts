// compact.json in a scratch directory: the laws, and a rewrite the next read
// picks up.
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { DEFAULTS } from "../compaction.ts"
import { compactionWindowsLaws } from "../laws.ts"
import { CompactionWindows } from "../service.ts"
import * as FileCompactionWindows from "./compaction-windows.ts"

const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "orchestrate-compact-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

compactionWindowsLaws("compact.json's CompactionWindows", (world) =>
  Layer.unwrap(
    Effect.map(scratch, (dir) => {
      const file = join(dir, "compact.json")
      if (world !== undefined) writeFileSync(file, world)
      return FileCompactionWindows.layer(file)
    }),
  ),
)

test("each read takes the file as it is now, so the tuner's rewrite counts", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const file = join(yield* scratch, "compact.json")
        const read = CompactionWindows.use((windows) => windows.read).pipe(Effect.provide(FileCompactionWindows.layer(file)))
        expect(yield* read).toEqual(DEFAULTS)
        writeFileSync(file, JSON.stringify({ windows: { worker: 120_000 } }))
        expect(yield* read).toEqual({ ...DEFAULTS, worker: 120_000 })
      }),
    ),
  ))
