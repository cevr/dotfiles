// What a run dir keeps about the skill, as files: the version the run last
// saw in `<run dir>/skill-version` (skill-drift.ts `SEEN_FILE`), the
// "Departs from" lines of the run's own top-level Markdown files (common.md,
// plan.md, rules files; unit dirs are the units', not the run's), and the
// run's own log.md, where each verdict adds the root's drift (drift.ts).
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { Effect, Layer } from "effect"
import { RunRecords } from "../service.ts"
import { departuresOf, SEEN_FILE } from "../skill-drift.ts"

/** The run dir holding `file`: its dir, or that dir's parent when the dir is a unit's (it holds spec.md). */
const runDirOf = (file: string) => {
  const dir = dirname(file)
  return existsSync(join(dir, "spec.md")) ? dirname(dir) : dir
}

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

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
  log: ({ near, line, directory }) =>
    Effect.sync(() => {
      const file = near.startsWith("~/") ? join(homedir(), near.slice(2)) : isAbsolute(near) ? near : directory === undefined ? undefined : resolve(directory, near)
      if (file === undefined) return
      const runDir = runDirOf(file)
      if (!isDirectory(runDir)) return
      const log = join(runDir, "log.md")
      try {
        const before = existsSync(log) ? readFileSync(log, "utf8") : ""
        appendFileSync(log, `${before !== "" && !before.endsWith("\n") ? "\n" : ""}${line}\n`)
      } catch {
        // Dropped: see the contract.
      }
    }).pipe(Effect.withSpan("RunRecords.log")),
})
