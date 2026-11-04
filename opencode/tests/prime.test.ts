// Runs scenarios/prime-demo.ts with the Prime look against an OpenCode checkout
// and asserts on the frames it saves: the text of each row, and the colour of a
// few key cells. It needs OPENCODE_DEV, the fork with the plugin hook points.
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const fork = process.env.OPENCODE_DEV
if (!fork)
  console.warn(
    "tests/prime.test.ts: skipped. Set OPENCODE_DEV to an OpenCode checkout with the TUI plugin hook points " +
      "(the prime-look fork) to run the Prime scenario.",
  )

type Rgba = readonly [number, number, number, number]
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string; fg: Rgba; bg: Rgba }> }> }
type Saved = { text: string; lines: ReadonlyArray<string>; frame: Frame }

const root = join(import.meta.dir, "..")
const label = "prime"
const frames: Record<"running" | "details" | "all" | "overview", Saved> = {} as never

// Prime's palette, from prime-agent-ui.md and the measured render.
const ACCENT = "#7c6faf"
const ERROR = "#d06f82"
const SUCCESS = "#7da876"
const BAND = "#1a1a1f"
/** The theme's `markdown.text`: assistant prose is a step dimmer than `text.base`. */
const PROSE = "#d8d8dc"
const DIFF = { addedBg: "#015f00", removedBg: "#5e0000", added: "#3fb950", removed: "#f85149" }

/** A tool row's exact line; `<t>` stands for a duration such as `12ms`, `5.2s` or `1m 05s`. */
const row = (line: string) =>
  new RegExp(
    `^${line
      .split("<t>")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("(?:\\d+m )?\\d+(?:\\.\\d+)?m?s")}$`,
    "m",
  )

const indexOf = (saved: Saved, pattern: RegExp) => saved.lines.findIndex((line) => new RegExp(pattern.source).test(line))

const hex = (rgba: Rgba) => `#${rgba
  .slice(0, 3)
  .map((value) => value.toString(16).padStart(2, "0"))
  .join("")}`

/** The colours of the cell `offset` columns into the first match of `needle`. */
function cell(saved: Saved, needle: string, offset = 0) {
  const y = saved.lines.findIndex((line) => line.includes(needle))
  if (y === -1) throw new Error(`no line contains ${JSON.stringify(needle)}:\n${saved.text}`)
  return cellAt(saved, y, saved.lines[y]!.indexOf(needle) + offset)
}

function cellAt(saved: Saved, y: number, x: number) {
  let start = 0
  for (const span of saved.frame.lines[y]!.spans) {
    if (x < start + span.text.length) return { fg: hex(span.fg), bg: hex(span.bg) }
    start += span.text.length
  }
  throw new Error(`no span at ${y}:${x}`)
}

function load(out: string, name: string): Saved {
  const text = readFileSync(join(out, `${name}.txt`), "utf8")
  return { text, lines: text.split("\n"), frame: JSON.parse(readFileSync(join(out, `${name}.json`), "utf8")) }
}

describe.skipIf(!fork)("the Prime look on the demo scenario (OPENCODE_DEV)", () => {
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "prime-scenario-"))
    const run = Bun.spawn(["bunx", "opencode-drive", "run", "scenarios/prime-demo.ts"], {
      cwd: root,
      env: {
        ...process.env,
        SCENARIO_PRIME: "1",
        SCENARIO_CYCLE: "1",
        SCENARIO_THEME: "prime",
        SCENARIO_OUT: out,
        SCENARIO_LABEL: label,
        OPENCODE_DRIVE_MEDIA_DIR: join(out, "media"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ])
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    frames.running = load(out, `${label}-running`)
    frames.details = load(out, label)
    frames.all = load(out, `${label}-all`)
    frames.overview = load(out, `${label}-overview`)
  }, 300_000)

  test("the top bar centres the title and the cost", () => {
    for (const saved of Object.values(frames)) {
      expect(saved.lines[0]).toMatch(/^ {30,}fix flaky retry test  \$\d+\.\d\d$/)
    }
  })

  test("the user prompt is a full-width band", () => {
    const details = frames.details
    expect(details.text).toMatch(row("   Fix the flaky retry test in src/net.py and have a reviewer check it."))
    expect(cell(details, "Fix the flaky").bg).toBe(BAND)
    const band = indexOf(details, row("   Fix the flaky retry test in src/net.py and have a reviewer check it."))
    // The band's own padding rows sit above and below the text in the band colour,
    // from the inset (column 1) to the last column before the right inset.
    for (const y of [band - 1, band, band + 1]) {
      expect(cellAt(details, y, 0).bg).not.toBe(BAND)
      expect(cellAt(details, y, 1).bg).toBe(BAND)
      expect(cellAt(details, y, 104).bg).toBe(BAND)
    }
  })

  test("Details: one line per tool call, stacked tight, with the edit and its diff bands", () => {
    const details = frames.details
    const rows = [
      "  Look at the test first, then spawn a reviewer.",
      "  Reading the retry test and its helper.",
      "  ✓ shell · printf 'test_net.py F\\n1 failed\\n' · ↑ 1 ↓ 2 lines · <t>",
      "  The backoff loop exits one attempt early. Patching it.",
      "  ✓ patch · src/net.py · ↑ 6 lines · <t>",
      "     ╰─ src/net.py +1 -1",
      "   1   def fetch(url, retries=3):",
      "   2 -     for i in range(retries - 1):",
      "   2 +     for i in range(retries):",
      "   3           try:",
      "  ✓ subagent · Review the diff in src/net.py. · ↑ 1 ↓ 1 lines · <t>",
      "  ✉ Agent message · ↓ code-reviewer",
      "  ✓ grep · retries in src · ↑ 1 ↓ 5 lines · <t>",
      "  ✗ read · out/traces.jsonl · ↑ 1 lines · <t> · File not found",
      "  The fix is in. 1 file changed, reviewer approved.",
    ]
    const at = rows.map((line) => {
      expect(details.text).toMatch(row(line))
      return indexOf(details, row(line))
    })
    // In order; the edit summary and diff rows sit straight under the patch call,
    // and calls from different steps stack without a blank row.
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(at.slice(4, 14)).toEqual(Array.from({ length: 10 }, (_, index) => at[4]! + index))
    // Details keeps tool output and the diff's far context collapsed.
    expect(details.text).not.toMatch(/^ +1 failed$/m)
    expect(details.text).not.toContain("backoff(i)")
    expect(details.text).not.toContain("Approved: the loop")
  })

  test("the dock: hint, band composer, tray with context use, rule and activity counts", () => {
    const details = frames.details
    const hint = indexOf(details, /^ {40,}Details mode \(Ctrl\+O to expand\)$/)
    expect(hint).toBeGreaterThan(0)
    expect(details.lines.slice(hint + 1, hint + 7)).toEqual([
      " ┃",
      " ┃>",
      " ┃",
      expect.stringMatching(/^ ← manage {20,}gpt-sim-model · 64k \(24%\)$/),
      ` ${"─".repeat(104)}`,
      " ◆ 0 subagents  ·  ▸ 0 shells  ·  goal",
    ])
    // The composer is a band: its bar is painted in the band colour, so only `>` shows.
    expect(cell(details, "┃>").fg).toBe(BAND)
    expect(cell(details, "◆ 0 subagents").fg).not.toBe(SUCCESS)
  })

  test("while the reviewer runs: a running call, the Executing line and one subagent", () => {
    const running = frames.running
    expect(running.text).toMatch(row("  ◆ subagent · Review the diff in src/net.py. · ↑ 1 lines"))
    expect(running.text).toMatch(/^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Executing · \d+s$/m)
    expect(running.text).toMatch(row(" ◆ 1 subagent  ·  ▸ 0 shells  ·  goal"))
    expect(running.text).not.toContain("Agent message")
    expect(running.text).not.toContain("reviewer approved")
    const spinner = running.lines.find((line) => line.includes("Executing"))!.trim()[0]!
    expect(cell(running, spinner).fg).toBe(ACCENT)
    expect(cell(running, "◆ subagent").fg).toBe(SUCCESS)
    expect(cell(running, "◆ 1 subagent").fg).toBe(SUCCESS)
  })

  test("All: expands tool output, the whole diff and the agent's reply", () => {
    const all = frames.all
    expect(all.text).toMatch(/^ {40,}Expanded mode \(Ctrl\+O to collapse\)$/m)
    for (const line of [
      "  ✓ shell · printf 'test_net.py F\\n1 failed\\n' · ↑ 1 ↓ 2 lines · <t>",
      "     ╰─ test_net.py F",
      "        1 failed",
      "   6               backoff(i)",
      "  ✉ Agent message · ↓ code-reviewer",
      "     ╰─ Approved: the loop now makes every attempt.",
      "     ╰─ Found 2 matches",
      "  ✗ read · out/traces.jsonl · ↑ 1 lines · <t> · File not found",
    ])
      expect(all.text).toMatch(row(line))
    // The subagent's result envelope never shows.
    expect(all.text).not.toContain("<subagent")
  })

  test("Overview: no thinking, no diff rows, no blank rows between items", () => {
    const overview = frames.overview
    expect(overview.text).toMatch(/^ {40,}Collapsed mode \(Ctrl\+O to expand\)$/m)
    expect(overview.text).not.toContain("Look at the test first")
    expect(overview.text).not.toContain("range(retries - 1)")
    const rows = [
      "  Reading the retry test and its helper.",
      "  ✓ shell · printf 'test_net.py F\\n1 failed\\n' · ↑ 1 ↓ 2 lines · <t>",
      "  The backoff loop exits one attempt early. Patching it.",
      "  ✓ patch · src/net.py · ↑ 6 lines · <t>",
      "     ╰─ src/net.py +1 -1",
      "  ✓ subagent · Review the diff in src/net.py. · ↑ 1 ↓ 1 lines · <t>",
      "  ✉ Agent message · ↓ code-reviewer",
      "  ✓ grep · retries in src · ↑ 1 ↓ 5 lines · <t>",
      "  ✗ read · out/traces.jsonl · ↑ 1 lines · <t> · File not found",
      "  The fix is in. 1 file changed, reviewer approved.",
    ]
    const first = indexOf(overview, row(rows[0]!))
    expect(first).toBeGreaterThan(0)
    rows.forEach((line, index) => expect(overview.lines[first + index]).toMatch(row(line)))
  })

  test("the splash stays on screen in every mode", () => {
    for (const saved of Object.values(frames)) {
      expect(saved.text).toMatch(/^ {2}opencode \S+\n {2}model simulation\/gpt-sim-model\n {2}cwd \S+$/m)
    }
  })

  test("key cells carry Prime's colours", () => {
    const details = frames.details
    expect(cell(details, "Reading the retry test").fg).toBe(PROSE)
    expect(cell(details, "✓ shell").fg).toBe(SUCCESS)
    expect(cell(details, "✉ Agent").fg).toBe(SUCCESS)
    expect(cell(details, "✗ read").fg).toBe(ERROR)
    expect(cell(details, "File not found").fg).toBe(ERROR)
    expect(cell(details, "+1 -1").fg).toBe(DIFF.added)
    expect(cell(details, "+1 -1", 3).fg).toBe(DIFF.removed)
    const removed = cell(details, "2 -     for")
    expect(removed).toEqual({ fg: DIFF.removed, bg: DIFF.removedBg })
    const added = cell(details, "2 +     for")
    expect(added).toEqual({ fg: DIFF.added, bg: DIFF.addedBg })
    expect(cell(details, "for i in range(retries - 1)").bg).toBe(DIFF.removedBg)
    expect(cell(details, "for i in range(retries):").bg).toBe(DIFF.addedBg)
  })
})
