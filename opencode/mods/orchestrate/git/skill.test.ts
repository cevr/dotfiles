// The skill read through real git: a scratch checkout whose `skills/orchestrate`
// is reached by a link, as `~/.claude/skills/orchestrate` reaches the dotfiles.
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Skill } from "../service.ts"
import * as GitSkill from "./skill.ts"

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "orchestrate-skill-")))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const repo = join(scratch, "dotfiles")
const skillDir = join(repo, "skills/orchestrate")
const link = join(scratch, "orchestrate")

const git = (...args: ReadonlyArray<string>) => {
  const run = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`)
  return run.stdout.toString().trim()
}
const commit = (path: string, subject: string) => {
  mkdirSync(join(repo, path, ".."), { recursive: true })
  writeFileSync(join(repo, path), subject)
  git("add", path)
  git("commit", "-q", "-m", subject)
  return git("rev-parse", "HEAD")
}

mkdirSync(skillDir, { recursive: true })
git("init", "-q")
const first = commit("skills/orchestrate/SKILL.md", "feat(orchestrate): first")
const second = commit("skills/orchestrate/protocol.md", "feat(orchestrate): second")
commit("README.md", "docs: outside the skill")
const third = commit("skills/orchestrate/SKILL.md", "fix(orchestrate): third")
symlinkSync(skillDir, link)

const skill = (dir: string) => Skill.pipe(Effect.provide(GitSkill.layer(dir)), Effect.runSync)

test("the version is the newest commit that touched the skill, read through the link", async () => {
  expect(await Effect.runPromise(skill(link).version)).toBe(third)
})

test("a newer version lists the skill's commit subjects since, newest first; the same, an older or a move outside the skill reads as such", async () => {
  const relation = skill(link).relation
  expect(await Effect.runPromise(relation(first, third))).toEqual({ _tag: "Newer", subjects: ["fix(orchestrate): third", "feat(orchestrate): second"] })
  expect(await Effect.runPromise(relation(third, third))).toEqual({ _tag: "Same" })
  expect(await Effect.runPromise(relation(third, first))).toEqual({ _tag: "Older" })
  expect(await Effect.runPromise(relation(second, git("rev-parse", "HEAD~1")))).toEqual({ _tag: "Same" })
})

test("a version not in the history is unrelated, with the newest subjects", async () => {
  expect(await Effect.runPromise(skill(link).relation("f".repeat(40), third))).toEqual({
    _tag: "Unrelated",
    subjects: ["fix(orchestrate): third", "feat(orchestrate): second", "feat(orchestrate): first"],
  })
})

test("no checkout gives no version and no relation", async () => {
  const gone = skill(join(scratch, "missing"))
  expect(await Effect.runPromise(gone.version)).toBeUndefined()
  expect(await Effect.runPromise(gone.relation(first, third))).toBeUndefined()
})
