// A Rift's branch read through real git: a scratch checkout on a branch, the
// same detached, a directory that is no checkout, and a path that is not there.
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { quietRepo } from "../../../tests/git-repo.ts"
import { branchAt, expand } from "./branches.ts"

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "orchestrate-branches-")))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const git = (cwd: string, ...args: ReadonlyArray<string>) => {
  const run = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`)
  return run.stdout.toString().trim()
}

test("the branch checked out at a path; none when detached, no checkout, or nothing there", async () => {
  const rift = join(scratch, ".rifts/app/scratch-17")
  mkdirSync(rift, { recursive: true })
  git(rift, "init", "-q", "-b", "feat/web-3")
  quietRepo(rift)
  writeFileSync(join(rift, "a"), "a")
  git(rift, "add", "a")
  git(rift, "commit", "-q", "-m", "a")
  expect(await Effect.runPromise(branchAt(rift))).toBe("feat/web-3")
  expect(await Effect.runPromise(branchAt(`${rift}/`))).toBe("feat/web-3")
  const plain = join(scratch, "plain")
  mkdirSync(plain)
  expect(await Effect.runPromise(branchAt(plain))).toBeUndefined()
  expect(await Effect.runPromise(branchAt("/nonexistent/loop-probe-x"))).toBeUndefined()
  git(rift, "checkout", "-q", "--detach")
  expect(await Effect.runPromise(branchAt(rift))).toBeUndefined()
})

test("~/ is read from home", () => {
  expect(expand("~/.rifts/app/web", "/h")).toBe("/h/.rifts/app/web")
  expect(expand("~", "/h")).toBe("/h")
  expect(expand("/abs/~/x", "/h")).toBe("/abs/~/x")
})
