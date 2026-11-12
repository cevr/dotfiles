import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { exclusivelySync } from "@dotfiles/opencode-rift/process/flock"
import { buildName, stagingName } from "../builds.ts"
import { stagedText } from "../process/install.ts"

/** One build daily stages: the file it built, where it goes, and what the record says of it. */
export interface Stage {
  /** The release binary daily built. */
  readonly built: string
  /** The share directory (`settings.ts` `shareDir`). */
  readonly share: string
  readonly version: string
  /** The installed record (`installed.json`). */
  readonly record: string
  /** The builds lock (`settings.ts` `buildsLock`). */
  readonly lock: string
  readonly dotfiles: string
  readonly fork: string
  /** Daily's own process, which names its copy in flight. */
  readonly pid: number
}

/**
 * Stages a build, holding the builds lock from its copy into the share directory through the staged
 * record's write: a handoff's prune takes the same lock to read the record and list the directory, so
 * it never sees a build the record does not name yet (`filestore/builds.ts`). It copies the build
 * beside its name, then renames it over that name: Linux refuses to write a binary the running service
 * executes (ETXTBSY), and a rename leaves that process on the old file. Answers the build's path.
 * `flock` is libc's, but for a test.
 */
export const stageBuild = (stage: Stage, flock?: (descriptor: number, operation: number) => number): string => {
  const binary = join(stage.share, buildName(stage.version))
  exclusivelySync(stage.lock, flock)(() => {
    mkdirSync(stage.share, { recursive: true })
    const copy = join(stage.share, stagingName(stage.version, stage.pid))
    copyFileSync(stage.built, copy)
    chmodSync(copy, 0o755)
    renameSync(copy, binary)
    // Staged, not installed: the handoff installs it as it restarts, and the health check proves it (mods/update).
    mkdirSync(dirname(stage.record), { recursive: true })
    const last = readFileSync(stage.record, { encoding: "utf8", flag: "a+" })
    writeFileSync(`${stage.record}.${stage.pid}`, stagedText(last, { version: stage.version, command: [binary], dotfiles: stage.dotfiles, fork: stage.fork }, readdirSync(stage.share)))
    renameSync(`${stage.record}.${stage.pid}`, stage.record)
  })
  return binary
}
