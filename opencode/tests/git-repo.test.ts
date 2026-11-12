// tests/git-repo.ts: a test's temp git repository runs no background gc or maintenance, so a clone
// of it under load never races a lock file git's upkeep removes (batch ar: scripts/upstream.test.ts
// "the upstream reading" failed copying `.git/objects/maintenance.lock`). Every test makes its
// repositories through gitInit and gitClone, which quiet each one; a raw `"init"` or `"clone"` git
// argument in a test file is refused, so no repository is left loud.
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { gitClone, gitInit, QUIET_GIT } from "./git-repo.ts"
import { scratch } from "./scratch.ts"

const ROOT = fileURLToPath(new URL("..", import.meta.url))

/** What `git config --get` reads for each quiet key in the repository at `dir`. */
const settings = (dir: string) =>
  Object.fromEntries(Object.keys(QUIET_GIT).map((key) => [key, execFileSync("git", ["-C", dir, "config", "--get", key], { encoding: "utf8" }).trim()]))

const QUIET = { "gc.auto": "0", "maintenance.auto": "false" }

/**
 * A raw git `init` or `clone` as test code writes it: the subcommand as a string argument
 * (`git(dir, "init", …)`, `sh(root, ["git", "clone", …])`, `at("init", …)`), but not a `rift init`
 * or `workrift init`, which make no git repository of their own, nor a commit message `-m "init"`.
 */
const RAW_SITE = /(^|[(\[,]\s*)(?<!"(?:rift|workrift|-m|-qm)",\s*)"(init|clone)"\s*[,)]/

/** The file that runs `git init` and `git clone` for the tests, and its test, whose samples are raw on purpose. */
const HELPERS = ["tests/git-repo.ts", "tests/git-repo.test.ts"]

/** Every test file, and every file under tests/ (fixtures and helpers the tests run). */
const testFiles = () =>
  [...new Set(["**/*.test.ts", "tests/**/*.ts"].flatMap((glob) => [...new Bun.Glob(glob).scanSync({ cwd: ROOT })]))].filter((file) => !file.includes("node_modules/")).sort()

/** Each raw init or clone in `text`, as `line: code`. */
const rawSites = (text: string) =>
  text
    .split("\n")
    .map((line, index) => `${index + 1}: ${line.trim()}`)
    .filter((site) => RAW_SITE.test(site.slice(site.indexOf(": ") + 2)))

describe("a test's temp git repository", () => {
  test("gitInit makes a quiet work tree and a quiet bare repository, and gitClone a quiet clone", () => {
    using dir = scratch("git-repo-")
    const work = join(dir.path, "work")
    const bare = join(dir.path, "bare.git")
    const clone = join(dir.path, "clone")
    gitInit(work, ["-q", "-b", "main"])
    gitInit(bare, ["-q", "--bare"])
    gitClone(bare, clone, ["-q"])
    expect({ work: settings(work), bare: settings(bare), clone: settings(clone) }).toEqual({ work: QUIET, bare: QUIET, clone: QUIET })
  })

  test("a raw init or clone is found wherever test code writes one, and a rift init is not", () => {
    const found = rawSites(
      [
        `git(root, "init", "-q")`,
        `  sh(dir, "init", "-q", "-b", "dev")`,
        `sh(root, ["git", "clone", "-q", origin, "other"])`,
        `yield* at("init", "-q", "-b", "main")`,
        `git("init")`,
        `sh(source, env, "rift", "init", "--here")`,
        `sh(source, env, "git", "commit", "-q", "-m", "init")`,
        `commit(dir, "base", { a: "init" })`,
        `const action = { action: "init", repository }`,
      ].join("\n"),
    )
    expect(found.map((site) => Number(site.split(":")[0]))).toEqual([1, 2, 3, 4, 5])
  })

  test("no test file makes a repository with a raw git init or clone: each goes through gitInit or gitClone", () => {
    const raw = testFiles()
      .filter((file) => !HELPERS.includes(file))
      .flatMap((file) => rawSites(readFileSync(join(ROOT, file), "utf8")).map((site) => `${file}:${site}`))
    expect(raw).toEqual([])
  })
})
