// Launchers on disk: each script in `<dir>/<hash of the script>/<name>`, so a
// changed limit or shell gets a new file and a running command keeps its old
// one. A file is written once, through a temporary file and a rename, so a
// shell never spawns a half-written launcher.
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { Launchers, LauncherUnavailable } from "../service.ts"

export const layer = (dir: string) =>
  Layer.succeed(
    Launchers,
    Launchers.of({
      install: Effect.fn("Launchers.install")(function* (name: string, script: string) {
        const path = join(dir, Bun.hash(script).toString(36), name)
        if (existsSync(path)) return path
        return yield* Effect.try({
          try: () => {
            mkdirSync(join(path, ".."), { recursive: true })
            const staged = `${path}.${process.pid}`
            writeFileSync(staged, script)
            chmodSync(staged, 0o755)
            renameSync(staged, path)
            return path
          },
          catch: (cause) => new LauncherUnavailable({ message: cause instanceof Error ? cause.message : String(cause) }),
        })
      }),
    }),
  )
