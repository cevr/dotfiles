// Workbox over its own scripts, run as child processes: `workrift <command>`
// and `workbox-rift-storage --check` with `df -h` of the Rift file system
// (WORKBOX_RIFT_MOUNT, else /workspaces). Without `workrift` (the Mac) every
// command fails NotOnWorkbox. `prune` only ever runs as `--dry-run`.
import { Effect, Layer } from "effect"
import { NotOnWorkbox, Workbox, type WorkboxCommand } from "../service.ts"
import { commands } from "./command.ts"

export interface Options {
  /** Whether this host has the workbox's scripts on PATH. */
  readonly workrift: boolean
  /** Variables added to every command's environment (a test's PATH). */
  readonly env?: Readonly<Record<string, string>>
}

/** The `workrift` arguments for `command`; `storage` is not a workrift command. */
export const argv = (command: Exclude<WorkboxCommand, { readonly _tag: "storage" }>): ReadonlyArray<string> => {
  switch (command._tag) {
    case "init":
      return ["workrift", "init", command.repository, ...(command.path === undefined ? [] : [command.path])]
    case "prune":
      return ["workrift", "prune", "--dry-run"]
    default:
      return ["workrift", command._tag]
  }
}

export const layer = (options: Options) => {
  const { run } = commands(options.env)
  const mount = options.env?.["WORKBOX_RIFT_MOUNT"] ?? process.env["WORKBOX_RIFT_MOUNT"] ?? "/workspaces"

  const runCommand = Effect.fn("Workbox.run")(function* (command: WorkboxCommand, cwd: string, source?: string) {
    if (!options.workrift) return yield* new NotOnWorkbox({ command: command._tag })
    if (command._tag === "storage") {
      const checked = yield* run(["workbox-rift-storage", "--check"], cwd)
      const used = yield* run(["df", "-h", mount], cwd)
      return `${checked.trimEnd()}\n${used.trimEnd()}\n`
    }
    return yield* run(argv(command), cwd, source === undefined ? {} : { WORKRIFT_SOURCE: source })
  })

  return Layer.succeed(Workbox, Workbox.of({ run: runCommand }))
}
