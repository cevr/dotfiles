// The fork's TUI test preload (packages/tui/test/preload.ts, imported by
// app.ts) points HOME, the XDG roots and TMPDIR at a scratch home it makes,
// and removes that home in an `afterAll`. Bun runs every test file of one
// `bun test` in one process and evaluates a module once, so imported here (not
// run as a preload) that `afterAll` is the first TUI file's: the home goes
// when that file ends, and a later file's `mkdtemp` under TMPDIR fails with
// ENOENT. The harness takes the home over per file instead: each start makes
// its temp directory again (`restore`), each close removes the home
// (`release`), so every file runs in the same scratch roots and none outlives
// the process.
//
// Imported before the preload, this module reads whether the home was given
// (a runner that set OPENCODE_TEST_HOME first, as the fork's script/test.ts
// does): a given home is the runner's, never removed here.
import { Config, ConfigProvider, Effect, FileSystem, Option } from "effect"

/**
 * A directory named by the environment variable `name`, when it names one, read from the environment as it is now:
 * the default provider copies the environment once, at its first read, and the preload changes it after this import.
 */
const directory = (name: string) =>
  Effect.suspend(() =>
    Config.option(Config.String(name)).pipe(
      Effect.map(Option.filter((dir) => dir !== "")),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
    ),
  )

/** Whether a runner gave the scratch home: read once, at import, before the fork's preload makes one. */
const given = Option.isSome(Effect.runSync(directory("OPENCODE_TEST_HOME")))

/** Makes the process's temp directory again when an earlier file's end removed it with the scratch home. */
export const restore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const temporary = yield* directory("TMPDIR")
  if (Option.isSome(temporary)) yield* fs.makeDirectory(temporary.value, { recursive: true })
})

/** Removes the scratch home the preload made, with the temp directory in it; a given home stays. */
export const release = Effect.gen(function* () {
  if (given) return
  const fs = yield* FileSystem.FileSystem
  const home = yield* directory("OPENCODE_TEST_HOME")
  if (Option.isSome(home)) yield* fs.remove(home.value, { recursive: true, force: true })
})
