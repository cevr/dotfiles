import { execFileSync } from "node:child_process"
import { env as processEnv } from "node:process"

/**
 * The settings that keep git's background upkeep out of a test's temp repository. A commit, a
 * push or a fetch may start `git maintenance run --auto` or `git gc --auto` in the background;
 * under load it still runs while the test clones the repository, and the clone fails copying a
 * lock file that vanished (`.git/objects/maintenance.lock`).
 */
export const QUIET_GIT = { "gc.auto": "0", "maintenance.auto": "false" }

/** The environment a test's git runs in: its own HOME, PATH or config switches, or this process's. */
export type GitEnv = typeof processEnv

/** This process's environment with `extra` over it, for a test whose own git env names only what it changes. */
export const withProcessEnv = (extra: Readonly<Record<string, string>>): GitEnv => ({ ...processEnv, ...extra })

/** Runs git with `args`; a failure throws with git's own message. */
const run = (args: ReadonlyArray<string>, env: GitEnv) => {
  execFileSync("git", [...args], { env, stdio: ["ignore", "ignore", "pipe"] })
}

/** Turns git's automatic gc and maintenance off in the repository at `dir` (a work tree or a bare repository), in its own config. */
export const quietRepo = (dir: string, env: GitEnv = processEnv): void => {
  for (const [key, value] of Object.entries(QUIET_GIT)) run(["-C", dir, "config", key, value], env)
}

/**
 * A test's new repository: `git init <flags> <dir>`, then quieted. The one way a test makes a
 * repository (tests/git-repo.test.ts refuses a raw `"init"`), so no repository a test clones runs
 * git's upkeep while the clone copies it.
 */
export const gitInit = (dir: string, flags: ReadonlyArray<string> = [], env: GitEnv = processEnv): void => {
  run(["init", ...flags, dir], env)
  quietRepo(dir, env)
}

/** A test's clone: `git clone <flags> <source> <dir>`, quieted from the start (a clone does not take its origin's config). */
export const gitClone = (source: string, dir: string, flags: ReadonlyArray<string> = [], env: GitEnv = processEnv): void => {
  run(["clone", ...Object.entries(QUIET_GIT).flatMap(([key, value]) => ["-c", `${key}=${value}`]), ...flags, source, dir], env)
}
