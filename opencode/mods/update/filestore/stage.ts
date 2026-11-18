import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { exclusivelySync } from "@dotfiles/opencode-work/process/flock"
import { buildName, stagingName } from "../builds.ts"
import { parseRecord, type Record, recordText, stagedRecord } from "../record.ts"
import { launcher } from "./launcher.ts"

/** One build daily stages: the file it built, where it goes, and what the record says of it. */
export interface Stage {
  /** The release binary daily built. */
  readonly built: string
  /** The share directory (`settings.ts` `shareDir`). */
  readonly share: string
  readonly version: string
  /** The installed record (`installed.json`). */
  readonly record: string
  /** The launcher, `~/.local/bin/opencode` (`launcher.ts`). */
  readonly launcher: string
  /** The resident location the launcher loads after a service start (`settings.ts` `resident`). */
  readonly resident: string
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
 * executes (ETXTBSY), and a rename leaves that process on the old file. The launcher stays on the build
 * the record installs, the running one, until the handoff installs the staged one (`launcher.ts`).
 * Answers the build's path. `flock` is libc's, but for a test.
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
    const record = stagedRecord(parseRecord(last), { version: stage.version, command: [binary], dotfiles: stage.dotfiles, fork: stage.fork }, readdirSync(stage.share))
    writeFileSync(`${stage.record}.${stage.pid}`, recordText(record))
    renameSync(`${stage.record}.${stage.pid}`, stage.record)
    writeLauncher(stage.launcher, stage.resident, record, stage.pid)
  })
  return binary
}

/**
 * Points the launcher at the build `record` installs, never at a staged one. A client of a build the
 * record does not know (neither installed nor superseded) starts the service on its own build and
 * replaces the running one (the fork's `ServiceConfig.serviceBuild` and `service.ensure`): a launcher
 * on a staged build made every new TUI stop the shared service until the handoff ran (workbox,
 * 2026-11-18). So the launcher moves only with the record: daily's stage, and the handoff's install
 * and rollback (`records.ts`). Written beside its path and renamed over it, since a terminal may run
 * it at any moment; `pid`, the writing process, names its copy in flight.
 */
export const writeLauncher = (path: string, resident: string, record: Record, pid: number): void => {
  const next = `${path}.${pid}`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(next, launcher(record.command[0], resident))
  chmodSync(next, 0o755)
  renameSync(next, path)
}
