// Captures as files in one directory, OpenCode's log directory by default
// (where the binary's SIGPROF profiles go too): `<stem>.cpuprofile`, the
// profile, which Chrome DevTools and speedscope open, and `<stem>.json`, its
// summary (the stall, the RSS around it and the memory at the window's end)
// with the profile's path. The summary is written first, so a profile on disk
// always has one.
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { CaptureFailed, Captures, Summary } from "../service.ts"

/** A summary file: the summary and the path of its profile. */
export const SummaryFile = Schema.Struct({ ...Summary.fields, profile: Schema.String })
const encodeSummary = Schema.encodeSync(Schema.fromJsonString(SummaryFile))

/** The captures in `dir`, which the first write or listing makes. */
export const layer = (dir: string) =>
  Layer.succeed(
    Captures,
    Captures.of({
      write: (stem, profile, summary) => {
        const path = join(dir, `${stem}.cpuprofile`)
        return Effect.tryPromise({
          try: () =>
            mkdir(dir, { recursive: true })
              .then(() => writeFile(join(dir, `${stem}.json`), `${encodeSummary({ ...summary, profile: path })}\n`))
              .then(() => writeFile(path, profile)),
          catch: (error) => new CaptureFailed({ path, message: String(error) }),
        }).pipe(Effect.as(path))
      },
      names: Effect.tryPromise({
        try: () => mkdir(dir, { recursive: true }).then(() => readdir(dir)),
        catch: (error) => new CaptureFailed({ path: dir, message: String(error) }),
      }),
      remove: (names) =>
        Effect.forEach(
          names,
          (name) =>
            Effect.tryPromise({
              try: () => rm(join(dir, name), { force: true }),
              catch: (error) => new CaptureFailed({ path: join(dir, name), message: String(error) }),
            }),
          { discard: true },
        ),
    }),
  )
