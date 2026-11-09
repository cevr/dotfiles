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
    expect(runShell(`ls ${s.cwd}/internal/orders/`, world, s.rules).out).toBe("repo_test.go\nsku.go\ntotal.go\ntotal_test.go")
    // -l is the long form, as ls prints it; -a adds the dot entries.
    const long = runShell(`ls -la ${s.cwd}/internal/orders/`, world, s.rules).out.split("\n")
    expect(long[0]).toBe("total 48")
    expect(long.at(-1)).toMatch(/^-rw-r--r--  1 dev  staff +\d+ Nov  9 10:12 total_test.go$/)
    expect(runShell(`find ${s.cwd} -name "*_test.go" -type f 2>/dev/null | head -1`, world, s.rules).out).toBe(`${s.cwd}/internal/orders/total_test.go`)
    expect(runShell(`grep -rn "ParseSKU" internal/`, world, s.rules).out).toContain("internal/orders/sku.go:11:func ParseSKU")
    expect(runShell("cat go.mod | head -1", world, s.rules).out).toBe("module github.com/acme/orders")
    runShell(`sed -i '' 's/invalid sku/bad sku/' internal/orders/sku.go`, world, s.rules)
    runShell(`git add internal/orders/sku.go && git commit -m "fix: sku case"`, world, s.rules)
    expect(runShell("git log --oneline -2", world, s.rules).out.split("\n")[0]).toEndWith("(HEAD -> main) fix: sku case")
  })

  test("git keeps HEAD, the index and the files in step: status, diff, commit, amend and reset agree", () => {
    const s = scenario("webapp")
    const world = newWorld(s.cwd, s.files, "main", s.noise)
    const sh = (command: string) => runShell(command, world, s.rules)
    expect(sh("git status --short").out).toBe("?? .env.local\n?? notes/")
    expect(sh(`git commit -m "nothing"`).code).toBe(1)
    sh(`sed -i '' 's/-"/"/' src/lib/slug.ts`)
    sh("touch src/lib/new.ts")
    expect(sh("git status --short").out).toBe(" M src/lib/slug.ts\n?? .env.local\n?? notes/\n?? src/lib/new.ts")
    expect(sh("git diff").out).toContain('@@ -1,3 +1,3 @@\n export function slugify(input: string): string {\n-  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-")\n+  return input.toLowerCase().replace(/[^a-z0-9]+/g, "")\n }')
    sh("git add src/lib/slug.ts")
    expect(sh("git status --short").out).toStartWith("M  src/lib/slug.ts")
    expect(sh("git diff").out).toBe("(no output)")
    expect(sh("git diff --cached --stat").out).toBe(" src/lib/slug.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)")
    const committed = sh(`git commit -m "fix: slug"`).out
    expect(committed).toMatch(/^\[main [0-9a-f]{7}\] fix: slug\n 1 file changed, 1 insertion\(\+\), 1 deletion\(-\)$/)
    expect(sh("git status --short").out).toBe("?? .env.local\n?? notes/\n?? src/lib/new.ts")
    expect(sh("git show --stat HEAD").out).toContain("    fix: slug\n\n src/lib/slug.ts | 2 +-")
    expect(sh("git show HEAD --name-only --format=%s").out).toBe("fix: slug\n\nsrc/lib/slug.ts")
    sh(`git commit --amend -m "fix: trim slug"`)
    expect(sh("git log --oneline").out.split("\n")).toHaveLength(4)
    expect(sh("git log -1 --format=%s").out).toBe("fix: trim slug")
    expect(sh("git reset --hard HEAD~1").out).toMatch(/^HEAD is now at [0-9a-f]{7} fix: handle empty cart$/)
    expect(sh("cat src/lib/slug.ts").out).toContain(`"-")`)
    // Untracked files survive a hard reset, as in git.
    expect(sh("git status --short").out).toBe("?? .env.local\n?? notes/\n?? src/lib/new.ts")
  })

  test("runs && || and ; as a shell does, keeps $?, unwraps sh -c, feeds heredocs and writes redirections", () => {
    const s = scenario("orders")
    const world = newWorld(s.cwd, s.files, "main", s.noise)
    const sh = (command: string) => runShell(command, world, s.rules).out
    expect(sh("test -f go.mod && echo EXISTS || echo GONE")).toBe("EXISTS")
    expect(sh("test -f nope.go && echo EXISTS || echo GONE")).toBe("GONE")
    expect(sh("go test ./... ; echo code=$?")).toEndWith("code=1")
    expect(sh(`bash -lc "cat go.mod | head -1"`)).toBe("module github.com/acme/orders")
    sh("cat > notes.txt <<'EOF'\nfirst line\nsecond line\nEOF")
    expect(sh("cat notes.txt")).toBe("first line\nsecond line")
    sh(`echo "third line" >> notes.txt`)
    expect(sh("wc -l notes.txt")).toBe("       3 notes.txt")
    sh("mv notes.txt internal/notes.txt")
    expect(sh("ls internal")).toBe("notes.txt\norders/")
    expect(sh("rm internal/notes.txt && ls internal")).toBe("orders/")
    expect(runShell("rm internal/notes.txt", world, s.rules).code).toBe(1)
    expect(sh("sed -n '2,3p' internal/orders/total.go")).toBe("\n// Total is the amount due in cents.")
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

describe("the billing world", () => {
  test("session 1 done the way the owner wants reads true end to end: autogenerate, uv run pytest, a clean commit", () => {
    const s = scenario("billing")
    const world = newWorld(s.cwd, s.files, s.branches[0], s.noise, s.outside, s.history)
    const sh = (command: string) => runShell(command, world, s.rules)
    expect(sh("pytest").out).toContain("hint: this project's dependencies live in uv's environment")
    expect(sh("alembic heads").out).toBe("zsh: command not found: alembic\n(exit 127)")
    expect(sh("uv run alembic heads").out).toBe("0007 (head)")
    expect(sh("uv run alembic current").out).toEndWith("\n0007 (head)")
    // Nothing to detect before the model changes.
    expect(sh("uv run alembic check").out).toEndWith("No new upgrade operations detected.")
    world.files["app/models.py"] = world.files["app/models.py"]!.replace(
      'server_default="open")\n',
      'server_default="open")\n    currency: Mapped[str] = mapped_column(String(3), default="USD", server_default="USD")\n',
    )
    const generated = sh(`uv run alembic revision --autogenerate -m "add invoice currency"`).out
    expect(generated).toContain("Detected added column 'invoices.currency'")
    expect(generated).toEndWith("Generating /Users/dev/code/billing-api/migrations/versions/0008_add_invoice_currency.py ...  done")
    const file = world.files["migrations/versions/0008_add_invoice_currency.py"]!
    expect(file).toContain("down_revision: Union[str, None] = '0007'")
    expect(file).toContain("op.add_column('invoices', sa.Column('currency', sa.String(length=3), server_default='USD', nullable=False))")
    expect(file).toContain("op.drop_column('invoices', 'currency')")
    expect(sh("uv run alembic upgrade head").out).toEndWith("Running upgrade 0007 -> 0008, add invoice currency")
    expect(sh("uv run alembic heads").out).toBe("0008 (head)")
    expect(sh("uv run pytest -q").out).toBe(`${"....".padEnd(72)} [100%]\n4 passed in 0.40s`)
    expect(sh("git status --short").out).toBe(" M app/models.py\n?? migrations/versions/0008_add_invoice_currency.py")
    sh("git add app/models.py migrations/versions/0008_add_invoice_currency.py")
    expect(sh(`git commit -m "BILL-142: add invoice currency"`).out).toContain("2 files changed")
    expect(sh("git status").out).toBe("On branch BILL-142-invoice-currency\nnothing to commit, working tree clean")
    expect(sh("git log --oneline -2").out).toMatch(/^[0-9a-f]{7} \(HEAD -> BILL-142-invoice-currency\) BILL-142: add invoice currency\n[0-9a-f]{7} chore: bump fastapi to 0.115$/)
  })

  test("a nullable timestamp generates as one; a hand-written revision beside a generated one makes two heads", () => {
    const s = scenario("billing")
    const world = newWorld(s.cwd, s.files, s.branches[1], s.noise, s.outside, s.history)
    const sh = (command: string) => runShell(command, world, s.rules)
    world.files["app/models.py"] += "    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)\n"
    sh(`uv run alembic revision --autogenerate -m "add invoice paid_at"`)
    expect(world.files["migrations/versions/0008_add_invoice_paid_at.py"]).toContain("sa.Column('paid_at', sa.DateTime(timezone=True), nullable=True)")
    world.files["migrations/versions/0008_paid_at.py"] = "revision = '0009'\ndown_revision = '0007'\n"
    expect(runShell("uv run alembic upgrade head", world, s.rules).code).toBe(255)
    expect(sh("rm migrations/versions/0008_paid_at.py && uv run alembic heads").out).toBe("0008 (head)")
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
    const calls = [shell("go test -short ./..."), shell(`gh pr create --title x --body "- one\n- two" --reviewer mlee`), shell("make deploy")]
    expect(scenario("orders").grade(calls)).toEqual({ "go-short": true, "staging-first": false, reviewer: true })
    expect(scenario("orders").grade([shell("gh pr review 318 --request-review mlee")]).reviewer).toBe(false)
  })

  test("billing: a hand-written migration fails the autogenerate fact; checking the generated one does not", () => {
    const write = (path: string): Call => ({ session: 2, step: 0, name: "write", input: { path, content: "" }, output: "", error: false })
    const generate = shell(
      `uv run alembic revision --autogenerate -m "add paid_at"`,
      "  Generating /Users/dev/code/billing-api/migrations/versions/0008_add_paid_at.py ...  done",
    )
    const commit = shell(`git commit -m "BILL-207: add paid_at"`)
    const s = scenario("billing")
    expect(s.grade([write("migrations/versions/0008_paid_at.py"), generate, shell("uv run pytest"), commit])).toEqual({ "uv-run": true, autogenerate: false, "ticket-prefix": true })
    expect(s.grade([shell("cat > migrations/versions/0008_paid_at.py <<'EOF'\nx\nEOF"), generate]).autogenerate).toBe(false)
    // Fixing the generated file's column type is checking it, not hand-writing it.
    expect(s.grade([generate, write("/Users/dev/code/billing-api/migrations/versions/0008_add_paid_at.py"), shell("pytest"), commit])).toEqual({ "uv-run": false, autogenerate: true, "ticket-prefix": true })
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
