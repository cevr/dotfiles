// Public UI seam: real OpenCode with the fork's /goal, the real wake server
// plugin, Prime and a scripted model (scenarios/prime-goal.ts). Read off the
// frames: the dock counts a background shell and a wake and shows no goal
// at all; the goal line above the composer (the only place a goal shows)
// follows the goal through active, paused, resumed and cancelled, each in its
// state's colour.
import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { owned } from "./owned.ts"

type Rgba = readonly [number, number, number, number]
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string; fg: Rgba }> }> }
type Saved = { lines: ReadonlyArray<string>; frame: Frame }

// Prime's theme: feedback.success, feedback.warning, text.base.
const SUCCESS = "#7da876"
const WARNING = "#f59e0b"
const TEXT = "#f4f4f5"

const label = "prime-goal"
const names = ["dock", "active", "paused", "resumed", "cancelled"] as const
const frames = {} as Record<(typeof names)[number], Saved>

const hex = (rgba: Rgba) => `#${rgba.slice(0, 3).map((value) => value.toString(16).padStart(2, "0")).join("")}`
/** The line with the needle, without the sidebar's column. */
const lineOf = (saved: Saved, needle: string | RegExp) =>
  saved.lines.map((line) => line.slice(0, 108).trim()).find((line) => (typeof needle === "string" ? line.includes(needle) : needle.test(line)))
const DOCK = /^◆ \d+ subagents?  ·  \d+ shells?/
/** The foreground of the first cell of `needle` on the first line matching `on` (or holding the needle). */
function fg(saved: Saved, needle: string, on: string | RegExp = needle) {
  const y = saved.lines.findIndex((line) => (typeof on === "string" ? line.includes(on) : on.test(line.trim())))
  if (y === -1) throw new Error(`no line matches ${on}:\n${saved.lines.join("\n")}`)
  const x = saved.lines[y]!.indexOf(needle)
  let start = 0
  for (const span of saved.frame.lines[y]!.spans) {
    if (x < start + span.text.length) return hex(span.fg)
    start += span.text.length
  }
  throw new Error(`no span at ${y}:${x}`)
}

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-goal.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("Prime's dock and goal line", () => {
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "prime-goal-"))
    const child = owned(["bunx", "opencode-drive", "run", "scenarios/prime-goal.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timeout = join(out, `${label}-timeout.txt`)
    if (code !== 0) throw new Error(`prime-goal scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(timeout) ? readFileSync(timeout, "utf8") : ""}`)
    for (const name of names)
      frames[name] = {
        lines: readFileSync(join(out, `${label}-${name}.txt`), "utf8").split("\n"),
        frame: JSON.parse(readFileSync(join(out, `${label}-${name}.json`), "utf8")),
      }
    console.log(`prime-goal artifacts: ${out}`)
  }, 240_000)

  test("the dock: shells, then the wakes in the success colour; no goal before one is set", () => {
    const dock = frames.dock
    expect(lineOf(dock, DOCK)).toMatch(/^◆ 0 subagents  ·  1 shell  ·  1 wake$/)
    expect(fg(dock, "1 wake", DOCK)).toBe(SUCCESS)
    expect(fg(dock, "1 shell", DOCK)).toBe(SUCCESS)
    // (The session's title, "Goal dock fixture", is the only goal-ish text.)
    expect(dock.lines.some((line) => /[●‖✓◎] goal|\/goal/i.test(line))).toBe(false)
  })

  test("active: the goal line above the composer, its rounds and commands, in the success colour; the dock shows no goal", () => {
    const active = frames.active
    expect(lineOf(active, "● goal")).toBe("● goal · ship the goal dock · 2↻ · /goal pause · /goal cancel")
    // Directly above the composer's rail.
    const at = active.lines.findIndex((line) => line.includes("● goal"))
    expect(active.lines[at + 1]!.slice(0, 108).trim()).toBe("┃")
    expect(fg(active, "● goal")).toBe(SUCCESS)
    expect(fg(active, "ship the goal dock", "● goal")).toBe(TEXT)
    expect(lineOf(active, DOCK)).toMatch(/^◆ 0 subagents  ·  1 shell  ·  1 wake$/)
  })

  test("paused: the reason and how to resume or cancel, in the warning colour", () => {
    const paused = frames.paused
    expect(lineOf(paused, "goal paused")).toBe("‖ goal paused · Paused by the user · /goal resume · /goal cancel")
    expect(lineOf(paused, "● goal")).toBeUndefined()
    expect(fg(paused, "‖ goal paused")).toBe(WARNING)
    expect(lineOf(paused, DOCK)).toMatch(/^◆ 0 subagents  ·  1 shell  ·  1 wake$/)
  })

  test("resumed: active again, the round count from the resume", () => {
    const resumed = frames.resumed
    expect(lineOf(resumed, "● goal")).toBe("● goal · ship the goal dock · 1↻ · /goal pause · /goal cancel")
    expect(lineOf(resumed, "goal paused")).toBeUndefined()
    expect(fg(resumed, "● goal")).toBe(SUCCESS)
  })

  test("cancelled: the goal line is gone; the dock is unchanged", () => {
    const cancelled = frames.cancelled
    expect(lineOf(cancelled, /^[●‖✓] goal/)).toBeUndefined()
    expect(lineOf(cancelled, DOCK)).toMatch(/^◆ 0 subagents  ·  1 shell  ·  1 wake$/)
  })

  test("goal continuations draw no rows: one row per round's command and answer, no continuation text", () => {
    const resumed = frames.resumed.lines.join("\n")
    for (const round of [0, 1, 2, 3]) expect(resumed).toContain(`Round ${round} ran.`)
    expect(resumed).not.toContain("continue")
    expect(resumed).not.toContain("untrusted_objective")
  })
})
