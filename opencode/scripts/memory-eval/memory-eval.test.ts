// The eval's deterministic parts, with no API call: the fake shell, the
// graders, the native memory handler's path guard, and our plugin as the eval
// hosts it (a save in session 1 reaches session 2's system prompt as the digest).
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HEADING } from "../../mods/memory/digest.ts"
import { grade, isRead } from "./grade.ts"
import { native, nativeCommand, ours, resolveMemoryPath } from "./memory.ts"
import { type Call, SCENARIOS } from "./scenarios.ts"
import { commitMessages, newWorld, runShell, segments, stagesAll } from "./world.ts"

const dirs: Array<string> = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-eval-test-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!
const shell = (command: string, output = ""): Call => ({ session: 2, step: 0, name: "shell", input: { command }, output, error: false })

describe("the fake shell", () => {
  test("splits a command line on && ; and newlines outside quotes", () => {
    expect(segments(`git add a.ts && git commit -m "fix: a; b && c"\ngit status`)).toEqual(["git add a.ts", `git commit -m "fix: a; b && c"`, "git status"])
  })

  test("tells staging everything from staging by path", () => {
    expect(stagesAll("git commit -am 'x'")).toBe(true)
    expect(stagesAll("git commit -a -m x")).toBe(true)
    expect(stagesAll("git add -A")).toBe(true)
    expect(stagesAll("git add .")).toBe(true)
    expect(stagesAll("git add src/a.ts src/b.ts")).toBe(false)
    expect(stagesAll(`git commit -m "fix: drop -a flag"`)).toBe(false)
    expect(stagesAll("git commit --amend --no-edit")).toBe(false)
  })

  test("reads commit messages from -m and from a heredoc", () => {
    expect(commitMessages(`git add x && git commit -m "BILL-207: add paid_at"`)).toEqual(["BILL-207: add paid_at"])
    expect(commitMessages(`git commit -F - <<'EOF'\nBILL-207: add paid_at\n\nbody\nEOF`)).toEqual(["BILL-207: add paid_at"])
  })

  test("lists, finds and greps the fake repository, through pipes and absolute paths", () => {
    const s = scenario("orders")
    const world = newWorld(s.cwd, s.files, "main", s.noise)
    expect(runShell(`ls -la ${s.cwd}/internal/orders/`, world, s.rules).out).toBe("repo_test.go\nsku.go\ntotal.go\ntotal_test.go")
    expect(runShell(`find ${s.cwd} -name "*_test.go" -type f 2>/dev/null | head -1`, world, s.rules).out).toBe(`${s.cwd}/internal/orders/total_test.go`)
    expect(runShell(`grep -rn "ParseSKU" internal/`, world, s.rules).out).toContain("internal/orders/sku.go:11:func ParseSKU")
    expect(runShell("cat go.mod | head -1", world, s.rules).out).toBe("module github.com/acme/orders")
    runShell(`git commit -m "fix: sku case"`, world, s.rules)
    expect(runShell("git log --oneline -2", world, s.rules).out.split("\n")[0]).toEndWith("(HEAD -> main) fix: sku case")
  })

  test("follows cd, lists the directories around the repository, and runs package scripts from the nearest package.json", () => {
    const s = scenario("dotfiles")
    const world = newWorld(s.cwd, s.files, "main", s.noise, s.outside)
    expect(runShell("ls ~/Developer", world, s.rules).out).toBe("dotfiles/\nopencode/")
    expect(runShell("cd .. && pwd && ls", world, s.rules).out).toBe("/Users/dev/Developer\ndotfiles/\nopencode/")
    expect(runShell("cd /Users/dev/Developer/dotfiles && npm test", world, s.rules).out).toContain("no package.json")
    expect(runShell("cd opencode && bun run lint", world, s.rules).out).toBe("$ oxlint")
    expect(runShell("cat mods/notes/text.ts | head -1", world, s.rules).out).toStartWith("export const titleCase")
    expect(runShell("cd /nonexistent/loop-probe-x", world, s.rules).code).toBe(1)
  })

  test("answers the gotcha only when the command gets it wrong", () => {
    const s = scenario("dotfiles")
    const world = () => newWorld(s.cwd, s.files, "main", s.noise)
    expect(runShell("cd opencode && OPENCODE_DEV=~/Developer/opencode bun run gate", world(), s.rules).out).toContain("Write the path with $HOME")
    expect(runShell("cd opencode && OPENCODE_DEV=$HOME/Developer/opencode bun run gate", world(), s.rules).out).toContain("gate green")
    const exported = world()
    expect(runShell("export OPENCODE_DEV=$HOME/Developer/opencode; bun run gate", exported, s.rules).out).toContain("gate green")
  })
})

describe("the graders", () => {
  test("webapp: branch prefix, TEST_ENV on the first test run, staging by path", () => {
    const good = [shell("git checkout -b cvr/slug-dashes"), shell("TEST_ENV=unit bun run test"), shell("git add src/lib/slug.ts && git commit -m 'fix: trim dashes'")]
    expect(scenario("webapp").grade(good)).toEqual({ "branch-prefix": true, "unit-env": true, "stage-by-path": true })
    const bad = [shell("git checkout -b fix/slug"), shell("bun run test"), shell("TEST_ENV=unit bun run test"), shell("git commit -am 'fix'")]
    expect(scenario("webapp").grade(bad)).toEqual({ "branch-prefix": false, "unit-env": false, "stage-by-path": false })
  })

  test("orders: a deploy without ENV goes to production", () => {
    const calls = [shell("go test -short ./..."), shell("gh pr create --title x --body y --reviewer mlee"), shell("make deploy")]
    expect(scenario("orders").grade(calls)).toEqual({ "go-short": true, "staging-first": false, reviewer: true })
  })

  test("billing: a hand-written migration fails the autogenerate fact", () => {
    const calls: Array<Call> = [
      { session: 2, step: 0, name: "write", input: { path: "migrations/versions/0008_paid_at.py", content: "" }, output: "", error: false },
      shell("uv run pytest"),
      shell(`git commit -m "BILL-207: add paid_at"`),
    ]
    expect(scenario("billing").grade(calls)).toEqual({ "uv-run": true, autogenerate: false, "ticket-prefix": true })
  })

  test("a fact is saved when every key matches one stored document; off-list notes are counted", () => {
    const s = scenario("dotfiles")
    const stored = { units: ["Gate: OPENCODE_DEV=$HOME/Developer/opencode, not ~", "Fixed titleCase, task completed"], documents: ["Gate: OPENCODE_DEV=$HOME/Developer/opencode, not ~", "Fixed titleCase, task completed"] }
    const graded = grade(s, [], [shell("git status")], [], stored, stored)
    expect(graded.saved).toEqual({ "gate-home": true, "no-config": false, "no-push": false })
    expect(graded.offList1).toBe(1)
    expect(graded.taskState1).toBe(1)
    expect(graded.readBeforeAct).toBe(false)
    expect(isRead({ name: "memory", input: { command: "view", path: "/memories" } })).toBe(true)
  })
})

describe("the native memory handler", () => {
  test("refuses paths outside /memories", () => {
    const base = scratch()
    expect(resolveMemoryPath(base, "/memories/notes.md")).toBe(join(base, "notes.md"))
    for (const path of ["/etc/passwd", "/memories/../secrets", "/memories/%2e%2e/x", "/memoriesx/a", "memories/a", "/memories/a\\..\\b"])
      expect(resolveMemoryPath(base, path)).toBeUndefined()
    expect(nativeCommand(base, { command: "create", path: "/memories/../../x", file_text: "x" }).error).toBe(true)
  })

  test("creates, views, edits and lists files as the docs' handler does", async () => {
    const arm = await native(scratch())
    expect((await arm.call("s", "memory", { command: "view", path: "/memories" })).text).toStartWith("Here're the files and directories up to 2 levels deep in /memories")
    await arm.call("s", "memory", { command: "create", path: "/memories/repo.md", file_text: "# Repo\n- use TEST_ENV=unit\n" })
    await arm.call("s", "memory", { command: "str_replace", path: "/memories/repo.md", old_str: "TEST_ENV=unit", new_str: "TEST_ENV=unit for tests" })
    expect((await arm.call("s", "memory", { command: "view", path: "/memories/repo.md" })).text).toContain("     2\t- use TEST_ENV=unit for tests")
    expect(arm.stored().units).toEqual(["use TEST_ENV=unit for tests"])
  })
})

describe("our plugin as the eval hosts it", () => {
  test("offers its three tools; a note saved in one session is the next session's digest", async () => {
    const arm = await ours(scratch())
    try {
      expect([...arm.names]).toEqual(["memory_save", "memory_search", "memory_forget"])
      expect(await arm.system("session-1")).toEqual([])
      const saved = await arm.call("session-1", "memory_save", { text: "acme-web: run tests with TEST_ENV=unit", tags: ["tests"] })
      expect(saved).toEqual({ text: "Saved #1 (project).", error: false })
      const [digest] = await arm.system("session-2")
      expect(digest).toStartWith(HEADING)
      expect(digest).toContain("TEST_ENV=unit")
      expect(arm.stored().units).toEqual(["acme-web: run tests with TEST_ENV=unit tests"])
      expect((await arm.call("session-2", "memory_save", { text: "" })).error).toBe(true)
    } finally {
      await arm.close()
    }
  })
})
