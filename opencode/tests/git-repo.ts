import { execFileSync } from "node:child_process"

/**
 * The settings that keep git's background upkeep out of a test's temp repository. A commit, a
 * push or a fetch may start `git maintenance run --auto` or `git gc --auto` in the background;
 * under load it still runs while the test clones the repository, and the clone fails copying a
 * lock file that vanished (`.git/objects/maintenance.lock`).
 */
export const QUIET_GIT = { "gc.auto": "0", "maintenance.auto": "false" }

/**
 * Turns git's automatic gc and maintenance off in the repository at `dir` (a work tree or a bare
 * repository), in its own config. Call it on every repository a test makes, right after its
 * `git init` or `git clone`; a clone does not take its origin's config.
 */
export const quietRepo = (dir: string): void => {
  for (const [key, value] of Object.entries(QUIET_GIT)) execFileSync("git", ["-C", dir, "config", key, value], { stdio: "ignore" })
}
