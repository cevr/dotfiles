// The units' logs on disk, written by this checkout's orchestrate log.ts, in a
// scratch checkout: the laws, and a `~/` path.
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { unitLogsLaws } from "../laws.ts"
import { UnitLogs } from "../service.ts"
import * as FileUnitLogs from "./unit-logs.ts"

/** The orchestrate skill's log.ts in this checkout. */
const LOG_SCRIPT = join(import.meta.dir, "../../../../skills/orchestrate/scripts/log.ts")

const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "orchestrate-unit-logs-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

/** A log's moves without their times. */
const movesIn = (dir: string) =>
  Effect.sync(() => {
    const file = join(dir, "log.md")
    if (!existsSync(file)) return []
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.replace(/^\S+Z /, ""))
  })

unitLogsLaws(
  "the log.ts UnitLogs",
  Effect.map(scratch, (checkout) => ({
    layer: FileUnitLogs.layer(LOG_SCRIPT),
    checkout,
    make: (path: string) =>
      Effect.sync(() => {
        mkdirSync(join(checkout, path), { recursive: true })
        return join(checkout, path)
      }),
    touch: (path: string) =>
      Effect.sync(() => {
        mkdirSync(dirname(join(checkout, path)), { recursive: true })
        writeFileSync(join(checkout, path), "")
      }),
    moves: movesIn,
  })),
)

test("a path under `~/` is found in the home given", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* scratch
        mkdirSync(join(home, "work/tmp/orchestrate/web/auth"), { recursive: true })
        writeFileSync(join(home, "work/tmp/orchestrate/web/plan.md"), "")
        const found = yield* Effect.provide(
          UnitLogs.use((logs) => logs.find({ unit: "auth", named: ["~/work/tmp/orchestrate/web/auth"] })),
          FileUnitLogs.layer(LOG_SCRIPT, home),
        )
        expect(found).toBe(join(home, "work/tmp/orchestrate/web/auth"))
      }),
    ),
  ))
