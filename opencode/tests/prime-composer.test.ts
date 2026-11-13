// Runs scenarios/prime-composer.ts with the Prime look and the wake plugin
// against an OpenCode checkout: the root sets an alarm and a monitor; ↓ on the
// empty prompt opens the host's composer panel, whose tab row ends with
// Prime's Wakes and Monitors; → reaches Wakes, which lists the alarm; Enter
// shows it whole; ctrl+d cancels it and the tab says it has none; Monitors
// lists the monitor with its newest output; closed, the dock counts the
// monitor and no wake; with the monitor cancelled too the count line is gone,
// and a turn that sets one alarm alone brings it back. It needs OPENCODE_DEV, the fork with `ui.composerTab`.
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ALARM, CLOSED, closedDock, DETAIL, panel, PANEL, underRule, type Want } from "../scenarios/prime-composer-frames.ts"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-composer.test.ts: skipped. Set OPENCODE_DEV to the fork to run it.")

const root = join(import.meta.dir, "..")
const names = ["panel", "wakes", "detail", "cancelled", "monitors", "closed", "none", "alarm"] as const
const frames = {} as Record<(typeof names)[number], ReadonlyArray<string>>

/** An expected line as a matcher (scenarios/prime-composer-frames.ts; the scenario waits on the same). */
const matcher = (want: Want) => expect.stringMatching(want)

describe.skipIf(!fork)("the composer panel's Wakes and Monitors tabs (OPENCODE_DEV)", () => {
  const kept = keptScratch(Boolean(fork), "prime-composer-")
  beforeAll(...kept.setup(async () => {
    const out = kept.dir("prime-composer-")
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-composer.ts"], {
      cwd: root,
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    for (const name of names) frames[name] = readFileSync(join(out, `composer-${name}.txt`), "utf8").split("\n")
  }, 300_000))

  test("↓ on the empty prompt opens the panel, its host tabs first, then Wakes and Monitors", kept.test(() => {
    // Prime's tab bar: the names between faint dots, with how many each lists; the alarm and the monitor are pending.
    expect(panel(frames.panel).tabs).toMatch(PANEL.panel.tabs)
    expect(panel(frames.panel).rows).toEqual(PANEL.panel.rows.map(matcher))
  }))

  test("Wakes lists the alarm in the panel's columns: its note, its mode and repeat, pending, and how long until it is due", kept.test(() => {
    expect(panel(frames.wakes).rows).toEqual(PANEL.wakes.rows.map(matcher))
    expect(panel(frames.wakes).hints).toMatch(PANEL.wakes.hints)
  }))

  test("Enter shows the alarm whole", kept.test(() => {
    // The wake's id, its repeat and its mode in words.
    for (const want of DETAIL) expect(frames.detail.join("\n")).toMatch(want)
  }))

  test("ctrl+d cancels it: the tab says it has none", kept.test(() => {
    expect(panel(frames.cancelled).rows).toEqual(PANEL.cancelled.rows.map(matcher))
  }))

  test("Monitors lists the monitor with its newest output, how long it has watched and when it last checked", kept.test(() => {
    expect(panel(frames.monitors).rows).toEqual(PANEL.monitors.rows.map(matcher))
  }))

  test("closed, the dock counts the monitor and no wake", kept.test(() => {
    expect(closedDock(frames.closed)).toBe(CLOSED)
  }))

  test("with the monitor cancelled too, nothing is active: the dock's count line is not drawn", kept.test(() => {
    const none = frames.none
    expect(none.some((line) => /◆ \d+ subagents?|\d+ shells?\b|\d+ (wake|monitor)s?\b/.test(line))).toBe(false)
    // No blank row stands in for it: under the rule, only the one gap row the dock always leaves before the host's footer.
    const rule = none.findLastIndex((line) => /^ ─{20,}$/.test(line))
    expect(rule).toBeGreaterThan(0)
    expect(none.slice(rule + 1, rule + 3).map((line) => line.trim())).toEqual(["", expect.stringContaining("Server")])
  }))

  test("a pending wake alone brings the line back, counting it, right under the rule", kept.test(() => {
    expect(underRule(frames.alarm, ALARM.length)).toEqual(ALARM.map(matcher))
  }))
})
