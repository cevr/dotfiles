// Public UI seam: real OpenCode with the fork's background shells, Prime and a
// scripted model (scenarios/prime-shells.ts). Read off the frames: a
// foreground call past its limit moves to the background, returns its handle
// and its row says so; the agent lists the shells, checks, waits on and kills
// it through its handle, and starts one in the background; the reader's
// ctrl+b moves a blocking
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
    // The row's body is the handle's output, without the header the row already says.
    expect(transcript(moved).join("\n")).toMatch(/moved to the background\n\s*│ tick 1\n\s*│ It keeps running/)
    expect(lineOf(moved, "Started printf")).toBe("● Started printf 'bg\\n'; sleep 600 in the background")
    expect(lineOf(moved, DOCK)).toBe("◆ 0 subagents  ·  2 shells")
  })

  test("the agent gets the shell's handle at the move: its header, its output so far and how to act on it", () => {
    const [moved] = results()
    expect(moved).toMatch(/^(sh_\w+) · running · \d+\.\d s · moved to the background at its 2 s limit\ntick 1\nIt keeps running, and you will be notified when it ends\. /)
    expect(moved).toMatch(/shell\(\{ id: "sh_\w+" \}\) checks it, shell\(\{ id: "sh_\w+", wait: <ms> \}\) waits for it to end, shell\(\{ id: "sh_\w+", kill: true \}\) stops it\./)
    const started = results()[4]
    expect(started).toMatch(/^sh_\w+ · running · \d+\.\d s · started in the background\n\(no output yet\)\nIt keeps running/)
  })

  test("the agent lists, checks, waits on and kills through the handle; a kill it asked for sends it no stop notice", () => {
    const [moved, listed, checked, waited, started, killedLong, killedBg] = results()
    const long = /^(sh_\w+) · /.exec(moved ?? "")?.[1]
    const bg = /^(sh_\w+) · /.exec(started ?? "")?.[1]
    expect(long).toBeDefined()
    expect(bg).toBeDefined()
    expect(listed).toBe(`${long} · running · ${/ · (\d+\.\d s) · /.exec(listed ?? "")?.[1]} · 7 bytes · Long sleeper`)
    expect(checked).toMatch(new RegExp(`^${long} · running · \\d+\\.\\d s · next 7\ntick 1\n$`))
    expect(waited).toMatch(new RegExp(`^${long} · running · \\d+\\.\\d s · still running after waiting 0\\.5 s · next 7\n\\(no new output\\)$`))
    expect(killedLong).toMatch(new RegExp(`^${long} · killed SIGTERM · \\d+\\.\\d s · next 7\n\\(no new output\\)$`))
    expect(killedBg).toMatch(new RegExp(`^${bg} · killed SIGTERM · \\d+\\.\\d s · next 3\nbg\n$`))
    // Its rows, named for what they did.
    const killed = frames.killed
    expect(lineOf(killed, "Listed shells")).toBe("● Listed shells")
    expect(lineOf(killed, /^● Checked sh_/)).toBe(`● Checked ${long}`)
    expect(lineOf(killed, /^● Waited on sh_/)).toBe(`● Waited on ${long}`)
    expect(lineOf(killed, `● Killed ${long}`)).toBe(`● Killed ${long}`)
    expect(lineOf(killed, `● Killed ${bg}`)).toBe(`● Killed ${bg}`)
    expect(lineOf(killed, DOCK)).toBe("◆ 0 subagents  ·  0 shells")
    expect(requests.some((request) => request.includes(`<shell id=\\"${long}\\"`) || request.includes(`<shell id=\\"${bg}\\"`))).toBe(false)
    // The reader's kill later does send one: the check above can see a notice.
    expect(requests.some((request) => request.includes(`<shell id=\\"`))).toBe(true)
  })

  test("a click on the dock's count lists the session's shells: state, runtime and last line, and the kill key", () => {
    const list = transcript(frames.list).join("\n")
    expect(list).toContain("Shells")
    expect(list).toMatch(/Running\s*\n(.*\n)*.*Long sleeper running · \d+s · tick 1/)
    expect(list).toMatch(/Background sleeper running · \d+s · bg/)
    expect(list).toContain("kill ctrl+k")
  })

  test("a blocking call has no limit; ctrl+b moves it, and the agent hears the reader did", () => {
    expect(lineOf(frames.blocking, "Press ctrl+b")).toBe("Press ctrl+b to move running work to the background")
    const user = frames.user
    expect(lineOf(user, "Ran sleep 300")).toBe("● Ran sleep 300 · moved to the background")
    expect(transcript(user).join("\n")).toMatch(/Ran sleep 300 · moved to the background\n\s*│ \(no output yet\)\n/)
    expect(results().at(-1)).toMatch(/^sh_\w+ · running · \d+\.\d s · moved to the background by the user\n\(no output yet\)\n/)
    expect(lineOf(user, DOCK)).toBe("◆ 0 subagents  ·  1 shell")
  })

  test("ctrl+k in the list kills the shell; the list shows it ended; the agent is told with its final handle; the dock counts none", () => {
    const list = transcript(frames["user-list"]).join("\n")
    expect(list).toMatch(/Ended\s*\n(.*\n)*.*Blocking sleeper killed · \d+s · no output/)
    expect(list).toMatch(/Long sleeper killed · \d+s · tick 1/)
    expect(list).toMatch(/Background sleeper killed · \d+s · bg/)
    expect(lineOf(frames["user-killed"], "Heard the blocking sleeper was killed.")).toBeDefined()
    expect(requests.some((request) => /<shell id=\\"sh_\w+\\" [^>]*command=\\"sleep 300\\">\\nsh_\w+ · killed SIGTERM · /.test(request))).toBe(true)
    expect(lineOf(frames["user-killed"], DOCK)).toBe("◆ 0 subagents  ·  0 shells")
  })
})
