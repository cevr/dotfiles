// Public UI seam: real OpenCode with the real git plugins (server and TUI)
// over a real checkout one commit ahead of its upstream, with a stand-in `gh`
// and a stand-in `hunk` first on PATH (scenarios/git.ts). The sidebar shows
// the branch, the totals and the pull request; /git lists the files, and
// Enter hands the terminal to hunk and takes it back.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PULL_REQUEST_FIELDS } from "../mods/git/pull-request.ts"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/git.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("the Git sidebar section and /git", () => {
  test("show the branch against its upstream, the totals and the pull request, and review a file with hunk", async () => {
    const out = mkdtempSync(join(tmpdir(), "git-pane-"))
    const child = owned(["bunx", "opencode-drive", "run", "scenarios/git.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe", stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(`git scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(join(out, "git-timeout.txt")) ? readFileSync(join(out, "git-timeout.txt"), "utf8") : ""}`)

    // The sidebar shares its rows with the transcript, so match its lines in order.
    const rows = readFileSync(join(out, "git-sidebar.txt"), "utf8").split("\n")
    const at = (line: RegExp) => rows.findIndex((row) => line.test(row))
    // The request's line is wider than the sidebar, so the host wraps it.
    const section = [/\sGit$/, /\smain · ↑1 origin\/main$/, /\s2 files \+6 −1$/, /\s#123 Port git · open · checks ✓ ·$/, /\sreview required$/].map(at)
    const [first = -1] = section
    expect(first).toBeGreaterThan(-1)
    expect(section).toEqual([first, first + 1, first + 2, first + 3, first + 4])

    // gh ran in the session's directory, asked only for the fields the line reads.
    const ghCalls = readFileSync(join(out, "gh-calls"), "utf8").trim().split("\n")
    expect(ghCalls.length).toBeGreaterThan(0)
    for (const call of ghCalls) expect(call).toMatch(new RegExp(`/files \\| pr view --json ${PULL_REQUEST_FIELDS}$`))

    const pane = readFileSync(join(out, "git-pane.txt"), "utf8")
    for (const text of ["main ↑1 → origin/main · 2 files +6 −1", "#123 Port git · open · checks ✓ · review required", "Changed files", "▸ M  a.ts  +3 −1", "  ?  b.ts  +3 −0", "↑↓ pick · Enter review · Esc close"])
      expect(pane).toContain(text)
    expect(pane).not.toContain("service-local.json")

    // Enter ran hunk at the checkout's top on the selected file, and the pane came back when it ended.
    expect(readFileSync(join(out, "hunk-calls"), "utf8").trim()).toMatch(/\/files \| diff --watch HEAD -- a\.ts$/)
    const after = readFileSync(join(out, "git-after-review.txt"), "utf8")
    expect(after).toContain("▸ M  a.ts  +3 −1")
    expect(after).not.toContain("hunk not found")
    console.log(`Git pane artifacts: ${out}`)
  }, 150_000)
})
