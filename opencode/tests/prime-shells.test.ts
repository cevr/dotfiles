// Public UI seam: real OpenCode with the fork's background shells, Prime and a
// scripted model (scenarios/prime-shells.ts). Read off the frames: a
// foreground call past its limit moves to the background and its row says so;
// the agent lists, reads and kills it; the reader's ctrl+b moves a blocking
// call; the dock's count opens the shell list, where ctrl+k kills one; the
// dock's count follows each move and kill.
import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const label = "prime-shells"
const names = ["moved", "list", "killed", "blocking", "user", "user-list", "user-killed"] as const
const frames = {} as Record<(typeof names)[number], ReadonlyArray<string>>
let requests: ReadonlyArray<string> = []

/** The transcript's lines, without the sidebar's column. */
const transcript = (lines: ReadonlyArray<string>) => lines.map((line) => line.slice(0, 108).trimEnd())
const lineOf = (lines: ReadonlyArray<string>, needle: string | RegExp) =>
  transcript(lines)
    .map((line) => line.trim())
    .find((line) => (typeof needle === "string" ? line.includes(needle) : needle.test(line)))
const DOCK = /^◆ \d+ subagents?  ·  \d+ shells?/
/** The tool results the scripted model was sent, in order. */
const results = () =>
  requests.flatMap((request) => {
    const body = JSON.parse(request) as { body?: { messages?: ReadonlyArray<{ role: string; content: unknown }> }; messages?: ReadonlyArray<{ role: string; content: unknown }> }
    const messages = body.body?.messages ?? body.messages ?? []
    const last = messages.at(-1)
    return last?.role === "tool" ? [String(last.content)] : []
  })

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-shells.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("background shells in Prime", () => {
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "prime-shells-"))
    const child = Bun.spawn(["bunx", "opencode-drive", "run", "scenarios/prime-shells.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timeout = join(out, `${label}-timeout.txt`)
    if (code !== 0) throw new Error(`prime-shells scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(timeout) ? readFileSync(timeout, "utf8") : ""}`)
    for (const name of names) frames[name] = readFileSync(join(out, `${label}-${name}.txt`), "utf8").split("\n")
    requests = JSON.parse(readFileSync(join(out, `${label}-requests.json`), "utf8"))
    console.log(`prime-shells artifacts: ${out}`)
  }, 240_000)

  test("past its limit, a foreground call moves to the background: its row says so, and the dock counts it", () => {
    const moved = frames.moved
    expect(lineOf(moved, "Ran printf")).toBe("● Ran printf 'tick 1\\n'; sleep 600 · moved to the background")
    expect(lineOf(moved, "Command is still running")).toMatch(/^│ Command is still running after 2 s, so it moved .*\(shell ID: sh_\w+\)\.$/)
    expect(lineOf(moved, DOCK)).toBe("◆ 0 subagents  ·  1 shell")
  })

  test("the agent gets the shell's ID, its output so far and how to check on it", () => {
    const [moved] = results()
    expect(moved).toMatch(/^Command is still running after 2 s, so it moved to the background \(shell ID: (sh_\w+)\)\.\nOutput so far \(last 20 lines\):\ntick 1\n/)
    expect(moved).toMatch(/Check it with shell_read\(\{ id: "sh_\w+" \}\), stop it with shell_kill\(\{ id: "sh_\w+" \}\), or list this session's commands with shell_list\./)
  })

  test("the agent lists, reads and kills it; a kill it asked for sends it no stop notice", () => {
    const [, listed, read, killed] = results()
    expect(listed).toMatch(/^sh_\w+ running · \d+\.\d s · 7 bytes · Long sleeper$/)
    expect(read).toMatch(/^sh_\w+ running · .* · bytes 0-7\ntick 1\n$/)
    expect(killed).toMatch(/^Killed: sh_\w+ killed · SIGTERM · /)
    // Its rows, named for what they did.
    expect(lineOf(frames.killed, "Listed shells")).toBe("● Listed shells")
    expect(lineOf(frames.killed, /^● Read sh_/)).toMatch(/^● Read sh_\w+$/)
    expect(lineOf(frames.killed, /^● Killed sh_/)).toMatch(/^● Killed sh_\w+$/)
    expect(lineOf(frames.killed, DOCK)).toBe("◆ 0 subagents  ·  0 shells")
    const id = /shell ID: (sh_\w+)/.exec(results()[0] ?? "")?.[1]
    expect(id).toBeDefined()
    expect(requests.some((request) => request.includes(`<shell id=\\"${id}\\"`))).toBe(false)
    // The reader's kill later does send one: the check above can see a notice.
    expect(requests.some((request) => request.includes(`<shell id=\\"`))).toBe(true)
  })

  test("a click on the dock's count lists the session's shells: state, runtime and last line, and the kill key", () => {
    const list = transcript(frames.list).join("\n")
    expect(list).toContain("Shells")
    expect(list).toMatch(/Running\s*\n.*Long sleeper running · \d+s · tick 1/)
    expect(list).toContain("kill ctrl+k")
  })

  test("a blocking call has no limit; ctrl+b moves it, and the agent hears the reader did", () => {
    expect(lineOf(frames.blocking, "Press ctrl+b")).toBe("Press ctrl+b to move running work to the background")
    const user = frames.user
    expect(lineOf(user, "Ran sleep 300")).toBe("● Ran sleep 300 · moved to the background")
    expect(lineOf(user, "The user moved")).toMatch(/^│ The user moved the command to the background after \d+ s \(shell ID: sh_\w+\)\.$/)
    expect(lineOf(user, DOCK)).toBe("◆ 0 subagents  ·  1 shell")
  })

  test("ctrl+k in the list kills the shell; the list shows it ended; the agent is told; the dock counts none", () => {
    const list = transcript(frames["user-list"]).join("\n")
    expect(list).toMatch(/Ended\s*\n(.*\n)*.*Blocking sleeper killed · \d+s · no output/)
    expect(list).toMatch(/Long sleeper killed · \d+s · tick 1/)
    expect(lineOf(frames["user-killed"], "Heard the blocking sleeper was killed.")).toBeDefined()
    expect(requests.some((request) => request.includes("Killed by SIGTERM") && request.includes("sleep 300"))).toBe(true)
    expect(lineOf(frames["user-killed"], DOCK)).toBe("◆ 0 subagents  ·  0 shells")
  })
})
