import { Effect, Layer, Option } from "effect"
import { parseRecord, recordText } from "../record.ts"
import { Records, UpdateFailed } from "../service.ts"
import type { Settings } from "../settings.ts"
import { readText, writeText } from "./files.ts"
import { writeLauncher } from "./stage.ts"

/**
 * The installed record in its file, `<XDG state>/opencode/installed.json`, and the launcher that
 * follows it: each write points the launcher at the build the record installs, after the record, so
 * the launcher never runs a build the record does not know (`stage.ts` `writeLauncher`). `pid` is
 * the writing process.
 */
export const layer = (settings: Pick<Settings, "record" | "launcher" | "resident">, pid: number) =>
  Layer.succeed(
    Records,
    Records.of({
      read: readText(settings.record).pipe(Effect.map((text) => Option.flatMap(text, parseRecord))),
      write: (record) =>
        writeText("write the installed record", settings.record, recordText(record)).pipe(
          Effect.andThen(
            Effect.try({
              try: () => writeLauncher(settings.launcher, settings.resident, record, pid),
              catch: (cause) => new UpdateFailed({ step: "write the launcher", message: String(cause) }),
            }),
          ),
        ),
    }),
  )
