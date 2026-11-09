// Runs scenarios/escape-send.ts with the escape plugin beside Prime against an
// OpenCode checkout and asserts what one Ctrl+Enter does to a turn stuck in a
// long shell call, with one prompt queued and a second in the composer: the
// shell call is cut (as Escape cuts it), the turn reads `■ Interrupted`, and
// both prompts go out in the next turn, the queued one first, each exactly
// once (in the transcript and in what the model is sent), with no toast that
// the turn is still running; nothing waits after, and a second press with nothing waiting interrupts nothing. Before
// the press the hint line names the key. It runs once with Ctrl+Enter (sent
// as the kitty keyboard protocol's `ESC [13;5u`, as Ghostty and herdr send
// it) and once with the fallback chord, leader (Ctrl+X) then F. Needs
// OPENCODE_DEV.
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/escape-send.test.ts: skipped. Set OPENCODE_DEV to the fork to run it.")

const root = join(import.meta.dir, "..")
const ASK = "Run the slow suite."
const LATER = "Then tag the release."
const DRAFT = "Skip the suite, ship it."
const ANSWER = "Shipped and tagged."

/** How many times `needle` occurs in `text`. */
const count = (text: string, needle: string) => text.split(needle).length - 1

describe.skipIf(!fork).each(["ctrl", "leader"])("%s chord interrupts a turn stuck in a shell call and sends what waits (OPENCODE_DEV)", (chord) => {
  let before = ""
  let after = ""
  let checked = ""
  let tool = ""
  let requests: ReadonlyArray<ReadonlyArray<string>> = []

  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), `escape-send-${chord}-`))
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/escape-send.ts"], {
      cwd: root,
      env: { ...process.env, CHORD: chord, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    before = readFileSync(join(out, "before.txt"), "utf8")
    after = readFileSync(join(out, "after.txt"), "utf8")
    checked = readFileSync(join(out, "checked.txt"), "utf8")
    tool = readFileSync(join(out, "tool.txt"), "utf8")
    requests = JSON.parse(readFileSync(join(out, "requests.json"), "utf8"))
  }, 300_000)

  test("before the press: the shell runs, one prompt is queued, the draft is in the composer and the hint names the key", () => {
    // The running call's dot pulses.
    expect(before).toMatch(/[●○] Running sleep 600/)
    expect(before).toContain(`◌ after the turn · ${LATER}`)
    expect(before).toContain(` ┃ ${DRAFT}`)
    expect(before).toMatch(/^ Ctrl\+Enter interrupt and send +Details mode \(Ctrl\+O to expand\)$/m)
  })

  test("the press cuts the shell call, as Escape does, and the turn reads interrupted once", () => {
    expect(tool).toBe("interrupted")
    expect(after).toContain("● Ran sleep 600 · cancelled")
    expect(count(after, "■ Interrupted")).toBe(1)
  })

  test("both prompts go out after the interrupt, the queued one first, each once, and the answer comes", () => {
    const order = [ASK, "■ Interrupted", LATER, DRAFT].map((line) => after.indexOf(line))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect(order).toEqual(order.toSorted((a, b) => a - b))
    for (const prompt of [ASK, LATER, DRAFT]) expect(count(after, `┃ ${prompt}`)).toBe(1)
    // 6.5 s after the press, the next turn still running: the interrupted turn stopped, so no "Still running" toast.
    expect(checked).toContain(`┃ ${DRAFT}`)
    expect(checked).toMatch(/Executing · \d+s/)
    expect(checked).not.toContain("Still running")
    expect(after.lastIndexOf(ANSWER)).toBeGreaterThan(after.indexOf(`┃ ${DRAFT}`))
    // Nothing waits, the composer is empty (the second press typed nothing) and no hint is left.
    expect(after).not.toContain("◌")
    expect(after).toMatch(/^ ┃$/m)
    expect(after).not.toContain("interrupt and send")
  })

  test("the model is sent each prompt once, the queued one first; the draft in the same request or the turn's next step", () => {
    expect(requests.length).toBeGreaterThanOrEqual(1)
    expect(requests.length).toBeLessThanOrEqual(2)
    expect(requests[0]?.slice(0, 2)).toEqual([ASK, LATER])
    expect(requests.at(-1)).toEqual([ASK, LATER, DRAFT])
  })
})
