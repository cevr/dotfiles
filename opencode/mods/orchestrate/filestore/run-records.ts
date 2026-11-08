// What a run dir keeps about the skill, as files: the version the run last
// saw in `<run dir>/skill-version` (skill-drift.ts `SEEN_FILE`), and the
// "Departs from" lines of the run's own top-level Markdown files (common.md,
// plan.md, rules files; unit dirs are the units', not the run's).
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { RunRecords } from "../service.ts"
import { departuresOf, SEEN_FILE } from "../skill-drift.ts"

export const layer = Layer.succeed(RunRecords, {
  seen: (runDir) =>
    Effect.tryPromise(() => readFile(join(runDir, SEEN_FILE), "utf8")).pipe(
      Effect.map((text) => text.trim() || undefined),
      Effect.orElseSucceed(() => undefined),
      Effect.withSpan("RunRecords.seen"),
    ),
  see: (runDir, version) =>
    Effect.tryPromise(() => writeFile(join(runDir, SEEN_FILE), `${version}\n`)).pipe(Effect.ignore, Effect.withSpan("RunRecords.see")),
  departures: (runDir) =>
    Effect.gen(function* () {
      const entries = yield* Effect.tryPromise(() => readdir(runDir, { withFileTypes: true })).pipe(Effect.orElseSucceed(() => []))
      const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name).sort()
      const found = yield* Effect.forEach(files, (file) =>
        Effect.tryPromise(() => readFile(join(runDir, file), "utf8")).pipe(
          Effect.map((text) => departuresOf(file, text)),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        ),
      )
      return found.flat()
    }).pipe(Effect.withSpan("RunRecords.departures")),
})
