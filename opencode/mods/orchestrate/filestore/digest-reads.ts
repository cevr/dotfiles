// What the run's digest lines read off the host: its name, and a findings file's text for its verdict table. A file
// that cannot be read reads as none: the verdict still goes, without its rows.
import { readFile } from "node:fs/promises"
import { hostname } from "node:os"
import { Effect, Option } from "effect"

/** This host's name, as the digest files a run under it. */
export const hostName = (): string => hostname()

/** A file's text; none when it cannot be read. */
export const readText = (path: string): Effect.Effect<Option.Option<string>> =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none()),
  )
