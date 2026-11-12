/**
 * The guard test's work repository: one commit of a tracked file, then that
 * file left dirty. Shared by the run (which makes it) and the test (which
 * reads it back).
 *
 * @module
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { gitInit } from "../git-repo.ts"

/** The tracked file, as committed and as left dirty. */
export const KEPT_FILE = "kept.txt"
export const COMMITTED = "committed\n"
export const DIRTY = "dirty, not committed\n"

/** A git command in `work`, with no config but what it names; its stdout, trimmed. */
export const git = (work: string, ...args: ReadonlyArray<string>): string => {
  const run = Bun.spawnSync(["git", "-c", "user.name=guard", "-c", "user.email=guard@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd: work,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString()}`)
  return run.stdout.toString().trim()
}

/** Makes `work` (an existing, empty directory) the repository; its HEAD. */
export const makeRepo = (work: string): string => {
  gitInit(work, ["--quiet"])
  writeFileSync(join(work, KEPT_FILE), COMMITTED)
  git(work, "add", KEPT_FILE)
  git(work, "commit", "--quiet", "-m", "first")
  writeFileSync(join(work, KEPT_FILE), DIRTY)
  return git(work, "rev-parse", "HEAD")
}
