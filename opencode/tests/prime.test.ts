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
/** A span's `attributes` is OpenTUI's text attribute bit set; bit 0 is bold. */
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string; fg: Rgba; bg: Rgba; attributes?: number }> }> }
type Saved = { text: string; lines: ReadonlyArray<string>; frame: Frame }

const root = join(import.meta.dir, "..")
const label = "prime"
const frames: Record<"running" | "details" | "all" | "overview", Saved> = {} as never

// Prime's palette, from prime-agent-ui.md and the measured render.
const ACCENT = "#7c6faf"
const ERROR = "#d06f82"
const SUCCESS = "#7da876"
const BAND = "#1a1a1f"
/** The theme's `text.base` and `text.muted`. */
const TEXT = "#f4f4f5"
const MUTED = "#a1a1aa"
/** The theme's `markdown.text`: assistant prose is a step dimmer than `text.base`. */
const PROSE = "#d8d8dc"
/** The theme's `syntax.keyword`. */
const KEYWORD = "#38bdf8"
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

  test("the user prompt is fx's user card: a heavy rail on every row, bold text, no band", () => {
    for (const saved of Object.values(frames)) {
      const first = indexOf(saved, /^ ┃ Fix the flaky retry test in src\/net\.py and have a reviewer check it\. It fails/)
      expect(first).toBeGreaterThan(0)
      // The prompt wraps at the viewport; the rail runs down the wrapped row too.
      expect(saved.lines[first + 1]).toMatch(/^ ┃ \S.*always on the last attempt\.$/)
      for (const y of [first, first + 1]) {
        // The rail is the text colour, as the rail composer's is; nothing sits on a band.
        expect(cellAt(saved, y, 1).fg).toBe(TEXT)
        for (const x of [0, 1, 3, 104]) expect(cellAt(saved, y, x).bg).not.toBe(BAND)
      }
      expect(cellAt(saved, first, 3).fg).toBe(TEXT)
      // The rail ends with the prompt: no padding rows above or below it.
      expect(saved.lines[first - 1]).not.toContain("┃")
      expect(saved.lines[first + 2]).not.toContain("┃")
    }
    // fx and gent draw what the reader typed in bold.
    const y = indexOf(frames.details, /^ ┃ Fix the flaky/)
    const span = frames.details.frame.lines[y]!.spans.find((item) => item.text.startsWith("Fix the flaky"))
    expect((span?.attributes ?? 0) & 1).toBe(1)
  })

  test("one blank row parts the prompt from what follows, at every level but Overview", () => {
    const prompt = (saved: Saved) => indexOf(saved, /^ ┃ \S.*always on the last attempt\.$/)
    expect(frames.details.lines.slice(prompt(frames.details) + 1, prompt(frames.details) + 3)).toEqual([
      "",
      "  Reading the retry test and its helper.",
    ])
    expect(frames.all.lines.slice(prompt(frames.all) + 1, prompt(frames.all) + 3)).toEqual([
      "",
      "  Look at the test first, then spawn a reviewer.",
    ])
    expect(frames.overview.lines[prompt(frames.overview) + 1]).toBe("  Reading the retry test and its helper.")
  })

  test("Details: each model step is a group of its own; a step's calls share its header; a lone call is one line", () => {
    const details = frames.details
    const rows = [
      "  Reading the retry test and its helper.",
      "  ● Ran printf 'test_net.py F\\n1 failed\\n'",
      "    │ test_net.py F",
      "    │ 1 failed",
      "  The backoff loop exits one attempt early. Patching it.",
      // One step, one call: the row is the group's line, and its diff hangs with no rail.
      "  ● Edited src/net.py +1 / -1",
      "      1   def fetch(url, retries=3):",
      "      2 -     for i in range(retries - 1):",
      "      2 +     for i in range(retries):",
      "      3           try:",
      "  ● Ran code-reviewer",
      "    │ ✉ Agent message · ↓ code-reviewer",
      // The step that made two calls in parallel: one header, a tree row per call.
      "  ✗ Searched 1 pattern · read 1 file · 1 failed",
      "  ├ Searched /retries/ in src",
      // A row ends in gent's failure word; the reason is the output under it.
      "  └ Read out/traces.jsonl · failed",
      "    │ File not found: out/traces.jsonl",
      "  The fix is in. 1 file changed, reviewer approved.",
    ]
    const at = rows.map((line) => {
      expect(details.text).toMatch(row(line))
      return indexOf(details, row(line))
    })
    expect(at).toEqual([...at].sort((a, b) => a - b))
    // Each step's group stacks tight; the next step's group opens a blank row below it.
    expect(at.slice(5, 10)).toEqual(Array.from({ length: 5 }, (_, index) => at[5]! + index))
    expect(at.slice(12, 16)).toEqual(Array.from({ length: 4 }, (_, index) => at[12]! + index))
    expect(details.lines[at[10]! - 1]).toBe("")
    expect(details.lines[at[12]! - 1]).toBe("")
    // Answer text and a group sit a blank row apart.
    expect(details.lines[at[5]! - 1]).toBe("")
    expect(details.lines[at[16]! - 1]).toBe("")
    // Thinking stays out of the inline view, as in fx.
    expect(details.text).not.toContain("Look at the test first")
    // Details keeps the diff's far context and the agent's reply collapsed.
    expect(details.text).not.toContain("backoff(i)")
    expect(details.text).not.toContain("Approved: the loop")
  })

  test("the dock: hint, fx rail composer, tray with context use, rule and activity counts", () => {
    const details = frames.details
    const hint = indexOf(details, /^ {40,}Details mode \(Ctrl\+O to expand\)$/)
    expect(hint).toBeGreaterThan(0)
    expect(details.lines.slice(hint + 1, hint + 5)).toEqual([
      " ┃",
      expect.stringMatching(/^ ← manage {20,}gpt-sim-model · 64k \(24%\)$/),
      ` ${"─".repeat(104)}`,
      " ◆ 0 subagents  ·  ▸ 0 shells  ·  goal",
    ])
    // The composer is fx's bare rail: drawn in the text colour, with no fill behind it.
    expect(cellAt(details, hint + 1, 1).fg).toBe(TEXT)
    expect(cellAt(details, hint + 1, 3).bg).not.toBe(BAND)
    expect(cell(details, "◆ 0 subagents").fg).not.toBe(SUCCESS)
  })

  test("while the reviewer runs: a running group, the Executing line and one subagent", () => {
    const running = frames.running
    // The reviewer's step is its own group, under the edit's: the running call is the newest line, with no connector.
    expect(running.text).toMatch(/^ {2}● Edited src\/net\.py \+1 \/ -1$/m)
    expect(running.text).toMatch(/^ {2}[○●] Running code-reviewer$/m)
    expect(running.text).not.toMatch(/[├└] Running code-reviewer/)
    expect(running.text).toMatch(/^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Executing · \d+s$/m)
    expect(running.text).toMatch(row(" ◆ 1 subagent  ·  ▸ 0 shells  ·  goal"))
    expect(running.text).not.toContain("Agent message")
    expect(running.text).not.toContain("reviewer approved")
    // The loader is the transcript's last row, a blank row under the running group (Prime's loader: a spacer, then the spinner).
    const executing = running.lines.findIndex((line) => line.includes("Executing"))
    expect(running.lines[executing - 1]!.trim()).toBe("")
    expect(running.lines[executing - 2]).toContain("Running code-reviewer")
    const spinner = running.lines[executing]!.trim()[0]!
    expect(cell(running, spinner).fg).toBe(ACCENT)
    // The running group's glyph blinks in the accent.
    const header = running.lines.find((line) => line.includes("Running code-reviewer"))!
    const glyph = header.trim()[0]!
    expect(cell(running, `${glyph} Running code-reviewer`).fg).toBe(ACCENT)
    expect(cell(running, "◆ 1 subagent").fg).toBe(SUCCESS)
  })

  test("All: a row per call with Prime's counts, the whole diff, output and the agent's reply", () => {
    const all = frames.all
    expect(all.text).toMatch(/^ {40,}Expanded mode \(Ctrl\+O to collapse\)$/m)
    const lines = [
      // A lone call is the group's line: what hangs under it has no rail.
      "  ✓ shell · printf 'test_net.py F\\n1 failed\\n' · ↑ 1 ↓ 2 lines · <t>",
      "    ╰─ test_net.py F",
      "       1 failed",
      // Each one-call step is its call's line alone; its body hangs with no rail.
      "  ✓ patch · src/net.py · ↑ 6 lines · <t>",
      "    ╰─ src/net.py +1 -1",
      "      6               backoff(i)",
      "  ✓ subagent · Review the diff in src/net.py. · ↑ 1 ↓ 1 lines · <t>",
      "    │ ✉ Agent message · ↓ code-reviewer",
      "    ╰─ Approved: the loop now makes every attempt.",
      // The step with two parallel calls keeps its header and tree.
      "  ✗ Searched 1 pattern · read 1 file · 1 failed",
      "  ├ ✓ grep · retries in src · ↑ 1 ↓ 5 lines · <t>",
      // As at Details and in fx, a row's body keeps the tree's rail while rows follow.
      "  │ ╰─ Found 2 matches",
      "  └ ✗ read · out/traces.jsonl · ↑ 1 lines · <t> · File not found",
    ]
    const at = lines.map((line) => {
      expect(all.text).toMatch(row(line))
      return indexOf(all, row(line))
    })
    expect(at).toEqual([...at].sort((a, b) => a - b))
    // The rail runs unbroken from the group's first row to its last, through every body, and stops there.
    const first = at[10]!
    const last = at[12]!
    for (const line of all.lines.slice(first, last + 1)) expect(line).toMatch(/^ {2}[├│└](?: |$)/)
    expect(all.lines[last + 1]).toBe("")
    // All opens the thoughts the other levels hide.
    expect(all.text).toMatch(row("  Look at the test first, then spawn a reviewer."))
    // The subagent's result envelope never shows.
    expect(all.text).not.toContain("<subagent")
  })

  test("Overview: each group is its header, plus a row per failure; no thinking, no diffs, no blank rows", () => {
    const overview = frames.overview
    expect(overview.text).toMatch(/^ {40,}Collapsed mode \(Ctrl\+O to expand\)$/m)
    expect(overview.text).not.toContain("Look at the test first")
    expect(overview.text).not.toContain("range(retries - 1)")
    const rows = [
      "  Reading the retry test and its helper.",
      "  ● Ran 1 command",
      "  The backoff loop exits one attempt early. Patching it.",
      // A header per step.
      "  ● Edited 1 file",
      "  ● Ran 1 agent",
      "  ✗ Searched 1 pattern · read 1 file · 1 failed",
      // gent's failure row: what failed, its failure word, then the reason.
      "  └ Read out/traces.jsonl · failed · File not found: out/traces.jsonl",
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
    // A settled group's glyph is muted; a failed one is the error colour, as is its failure count and reason.
    expect(cell(details, "● Ran printf").fg).toBe(MUTED)
    expect(cell(details, "✗ Searched").fg).toBe(ERROR)
    expect(cell(details, "· 1 failed", 2).fg).toBe(ERROR)
    expect(cell(details, "traces.jsonl · failed", "traces.jsonl · ".length).fg).toBe(ERROR)
    expect(cell(details, "│ File not found").fg).not.toBe(ERROR)
    expect(cell(details, "├ Searched").fg).toBe(MUTED)
    expect(cell(details, "✉ Agent").fg).toBe(SUCCESS)
    expect(cell(details, "+1 / -1").fg).toBe(DIFF.added)
    expect(cell(details, "+1 / -1", 5).fg).toBe(DIFF.removed)
    const removed = cell(details, "2 -     for")
    expect(removed).toEqual({ fg: DIFF.removed, bg: DIFF.removedBg })
    const added = cell(details, "2 +     for")
    expect(added).toEqual({ fg: DIFF.added, bg: DIFF.addedBg })
    // The code keeps its syntax colours on the band: `for` is a keyword.
    expect(cell(details, "2 +     for", 8)).toEqual({ fg: KEYWORD, bg: DIFF.addedBg })
    expect(cell(details, "2 -     for", 8)).toEqual({ fg: KEYWORD, bg: DIFF.removedBg })
    expect(cell(details, "for i in range(retries - 1)").bg).toBe(DIFF.removedBg)
    expect(cell(details, "for i in range(retries):").bg).toBe(DIFF.addedBg)
  })
})
