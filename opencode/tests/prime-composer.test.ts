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
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-composer.test.ts: skipped. Set OPENCODE_DEV to the fork to run it.")

const root = join(import.meta.dir, "..")
const names = ["panel", "wakes", "detail", "cancelled", "monitors", "closed", "none", "alarm"] as const
const frames = {} as Record<(typeof names)[number], ReadonlyArray<string>>

/** The panel: its tab row, then its entries up to its hint line, without the rail. */
function panel(frame: ReadonlyArray<string>) {
  const at = frame.findIndex((line) => line.includes("Subagents") && line.includes("Monitors"))
  const end = frame.findIndex((line, index) => index > at && line.includes("←/→ tabs"))
  const clean = (line: string | undefined) => (line ?? "").replace(/^ ┃/, "").trim()
  return { tabs: clean(frame[at]), rows: frame.slice(at + 1, end).map(clean).filter(Boolean), hints: clean(frame[end]) }
}

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
    expect(panel(frames.panel).tabs).toMatch(/^Subagents {2}· {2}Shell {2}· {2}Terminals {2}· {2}Wakes 1 {2}· {2}Monitors 1 +esc$/)
    expect(panel(frames.panel).rows).toEqual(["No active subagents"])
  }))

  test("Wakes lists the alarm in the panel's columns: its note, its mode and repeat, pending, and how long until it is due", kept.test(() => {
    expect(panel(frames.wakes).rows).toEqual([expect.stringMatching(/^◇ ALPHA: check the deploy {2}wake · once +pending {2}in (9m \d\ds|10m)$/)])
    expect(panel(frames.wakes).hints).toBe("Enter detail · Ctrl+D cancel · ←/→ tabs")
  }))

  test("Enter shows the alarm whole", kept.test(() => {
    const text = frames.detail.join("\n")
    expect(text).toMatch(/Wake w[0-9a-z]{6}/)
    expect(text).toContain("Repeat: once")
    expect(text).toContain("Mode: wake: its fire starts a turn")
  }))

  test("ctrl+d cancels it: the tab says it has none", kept.test(() => {
    expect(panel(frames.cancelled).rows).toEqual(["No pending wakes"])
  }))

  test("Monitors lists the monitor with its newest output, how long it has watched and when it last checked", kept.test(() => {
    expect(panel(frames.monitors).rows).toEqual([expect.stringMatching(/^[◆◇] echo still-waiting {2}still-waiting +watching +\d+s {2}checked \d+s ago$/)])
  }))

  test("closed, the dock counts the monitor and no wake", kept.test(() => {
    const dock = frames.closed.find((line) => line.includes("subagents  ·"))
    expect(dock?.trim()).toBe("◆ 0 subagents  ·  0 shells  ·  1 monitor")
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
    const alarm = frames.alarm
    const rule = alarm.findLastIndex((line) => /^ ─{20,}$/.test(line))
    expect(alarm.slice(rule + 1, rule + 4).map((line) => line.trim())).toEqual([
      "◆ 0 subagents  ·  0 shells  ·  1 wake",
      "",
      expect.stringContaining("Server"),
    ])
  }))
})
