// tests/git-repo.ts: a test's temp git repository runs no background gc or maintenance, so a clone
// of it under load never races a lock file git's upkeep removes (batch ar: scripts/upstream.test.ts
// "the upstream reading" failed copying `.git/objects/maintenance.lock`).
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { QUIET_GIT, quietRepo } from "./git-repo.ts"
import { scratch } from "./scratch.ts"

const ROOT = fileURLToPath(new URL("..", import.meta.url))

/** What `git config --get` reads for each quiet key in the repository at `dir`. */
const settings = (dir: string) =>
  Object.fromEntries(Object.keys(QUIET_GIT).map((key) => [key, execFileSync("git", ["-C", dir, "config", "--get", key], { encoding: "utf8" }).trim()]))

/** A `git init` or `git clone` call as the tests write it: the subcommand, then its quiet flag. */
const MAKES_REPO = /"(init|clone)", "(-q|--quiet)"/

/** The files that make a test's git repositories: every test file, and the fixtures under tests/. */
const testFiles = () =>
  [...new Set(["**/*.test.ts", "tests/**/*.ts"].flatMap((glob) => [...new Bun.Glob(glob).scanSync({ cwd: ROOT })]))].filter((file) => !file.includes("node_modules/")).sort()

describe("a test's temp git repository", () => {
  test("quietRepo turns automatic gc and maintenance off in a work tree and a bare repository", () => {
    using dir = scratch("git-repo-")
    const work = join(dir.path, "work")
    const bare = join(dir.path, "bare.git")
    execFileSync("git", ["init", "-q", work])
    execFileSync("git", ["init", "-q", "--bare", bare])
    quietRepo(work)
    quietRepo(bare)
    expect({ work: settings(work), bare: settings(bare) }).toEqual({ work: { "gc.auto": "0", "maintenance.auto": "false" }, bare: { "gc.auto": "0", "maintenance.auto": "false" } })
  })

  test("every test file that makes a repository with git init or git clone quiets it through quietRepo", () => {
    const makers = testFiles().filter((file) => MAKES_REPO.test(readFileSync(join(ROOT, file), "utf8")))
    const loud = makers.filter((file) => !readFileSync(join(ROOT, file), "utf8").includes("quietRepo("))
    expect({ found: makers.length > 10, loud }).toEqual({ found: true, loud: [] })
  })
})
