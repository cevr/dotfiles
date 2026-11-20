import { Effect, Layer, Schema } from "effect"
import { writeText } from "../filestore/files.ts"
import { Builder, UpdateFailed } from "../service.ts"
import { files, type Settings } from "../settings.ts"
import { versionOf } from "./pin.ts"
import { run, said, spawned } from "./run.ts"

/**
 * The stage command of a build with its tree: the tree's own daily (`--from-tree`), so the build logic
 * is the target's, run in the tree's `opencode/`; it touches no dotfiles checkout.
 */
export const treeStageCommand = (settings: Settings, tree: string, fork: string, dotfiles: string): ReadonlyArray<string> => [
  settings.bun,
  `${tree}/opencode/scripts/daily.ts`,
  "--stage",
  "--from-tree",
  "--fork-target",
  fork,
  "--dotfiles-target",
  dotfiles,
]

const CliPackage = Schema.Struct({ version: Schema.String })
const decodeCli = Schema.decodeUnknownEffect(Schema.fromJsonString(CliPackage))

/** The Builder over daily: each step's whole output goes to the stage log, its tail into a failure. */
export const layer = (settings: Settings, env: Readonly<globalThis.Record<string, string>>) => {
  const daily = (step: string, command: ReadonlyArray<string>, cwd: string) =>
    Effect.gen(function* () {
      const ran = yield* spawned(step, command, { cwd, env })
      yield* writeText("write the stage log", files(settings).stage, `${ran.stdout}${ran.stderr}`)
      if (ran.code !== 0) return yield* new UpdateFailed({ step, message: said(ran) })
    })
  const fork = { cwd: settings.fork, env }
  /** The fork commit `commit` in full, fetched into the fork checkout's object store when it lacks it (its branch and files untouched). */
  const forkCommit = (commit: string) =>
    Effect.gen(function* () {
      const look = spawned("look for the fork commit", ["git", "rev-parse", "--verify", "--quiet", `${commit}^{commit}`], fork)
      const first = yield* look
      if (first.code === 0) return first.stdout.trim()
      yield* run("fetch the fork", ["git", "fetch", "--quiet", "origin"], fork)
      const again = yield* look
      if (again.code === 0) return again.stdout.trim()
      return yield* new UpdateFailed({ step: "find the fork commit", message: `${settings.fork} has no commit ${commit.slice(0, 10)}, after a fetch from its origin` })
    })
  return Layer.succeed(
    Builder,
    Builder.of({
      version: (target) =>
        forkCommit(target.fork).pipe(
          Effect.flatMap((commit) =>
            run("read the fork's version", ["git", "show", `${commit}:packages/cli/package.json`], fork).pipe(
              Effect.flatMap((text) => decodeCli(text).pipe(Effect.mapError((cause) => new UpdateFailed({ step: "read the fork's version", message: String(cause) })))),
              Effect.map((cli) => versionOf(cli.version, commit, target.dotfiles, true)),
            ),
          ),
        ),
      stage: (target, tree) => daily("stage the build", treeStageCommand(settings, tree, target.fork, target.dotfiles), `${tree}/opencode`),
    }),
  )
}
