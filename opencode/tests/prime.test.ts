// Runs scenarios/prime-demo.ts with the Prime look against an OpenCode checkout
// and asserts on the frames it saves: the text of each row, and the colour of a
// few key cells. It needs OPENCODE_DEV, the fork with the plugin hook points.
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

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
const ERROR = "#d06f82"
const SUCCESS = "#7da876"
const BAND = "#1a1a1f"
/** The theme's `text.base` and `text.muted`. */
const TEXT = "#f4f4f5"
const MUTED = "#a1a1aa"
/** The theme's `text.faint`. */
const FAINT = "#71717a"
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
  const kept = keptScratch(Boolean(fork), "prime-")
  beforeAll(...kept.setup(async () => {
    const out = kept.dir("prime-scenario-")
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-demo.ts"], {
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
  }, 300_000))

  test("the top bar centres the title and the cost", kept.test(() => {
    for (const saved of Object.values(frames)) {
      expect(saved.lines[0]).toMatch(/^ {30,}fix flaky retry test  \$\d+\.\d\d$/)
    }
  }))

  test("the user prompt is fx's user card: a heavy rail on every row, bold text, no band", kept.test(() => {
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
  }))

  test("one blank row parts the prompt from what follows, at every level but Overview", kept.test(() => {
    const prompt = (saved: Saved) => indexOf(saved, /^ ┃ \S.*always on the last attempt\.$/)
    // The first step thought, then answered: its thought is a one-node group under the prompt.
    expect(frames.details.lines.slice(prompt(frames.details) + 1, prompt(frames.details) + 3)).toEqual([
      "",
      "  ● Thought",
    ])
    expect(frames.all.lines.slice(prompt(frames.all) + 1, prompt(frames.all) + 3)).toEqual([
      "",
      "  ● Thought",
    ])
    expect(frames.overview.lines[prompt(frames.overview) + 1]).toBe("  Reading the retry test and its helper.")
  }))

  test("Details: each model step is a group of its own; a step's calls share its header; a lone call is one line", kept.test(() => {
    const details = frames.details
    const rows = [
      // A step that thought, then answered: a one-node tree, its thought folded to a line, faint.
      "  ● Thought",
      "  └ thinking  Look at the test first, then spawn a reviewer.",
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
      // OpenCode runs every subagent in the background: its answer comes back as a completion notice group.
      "  ● General finished · code-reviewer",
      "  └ Approved: the loop now makes every attempt.",
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
    expect(at[1]).toBe(at[0]! + 1)
    expect(at.slice(7, 12)).toEqual(Array.from({ length: 5 }, (_, index) => at[7]! + index))
    expect(at[15]).toBe(at[14]! + 1)
    expect(at.slice(16, 20)).toEqual(Array.from({ length: 4 }, (_, index) => at[16]! + index))
    expect(details.lines[at[12]! - 1]).toBe("")
    expect(details.lines[at[14]! - 1]).toBe("")
    expect(details.lines[at[16]! - 1]).toBe("")
    // Answer text and a group sit a blank row apart.
    expect(details.lines[at[2]! - 1]).toBe("")
    expect(details.lines[at[7]! - 1]).toBe("")
    expect(details.lines[at[20]! - 1]).toBe("")
    // The thought's label reads as a call row's verb does; its words are faint.
    expect(cell(details, "└ thinking", 2).fg).toBe(MUTED)
    expect(cell(details, "Look at the test first").fg).toBe(FAINT)
    // Details keeps the diff's far context collapsed, and the call's background-start answer.
    expect(details.text).not.toContain("backoff(i)")
    expect(details.text).not.toContain("working in the background")
  }))

  test("the dock: an empty hint line, fx rail composer, tray with context use, rule, and no activity counts with nothing active", kept.test(() => {
    const details = frames.details
    // The hint line keeps its row but stands empty: no subagent to move to, no standing Ctrl+O hint, and no update
    // notice (opencode-drive's scratch XDG state dir holds no upstream reading, update.ts `upstreamFile`).
    const hint = details.lines.findLastIndex((line) => line === " ┃") - 1
    expect(hint).toBeGreaterThan(0)
    expect(details.lines[hint]).toBe("")
    expect(details.text).not.toContain("Ctrl+O to")
    expect(details.lines.slice(hint + 1, hint + 5)).toEqual([
      " ┃",
      expect.stringMatching(/^ {20,}gpt-sim-model · 64k \(24%\)$/),
      ` ${"─".repeat(104)}`,
      // Nothing works, runs or is pending: no count line, the finished reviewer's lingering row sits right under the rule.
      " ◆ general gpt  code-reviewer  1 step",
    ])
    expect(details.text).not.toMatch(/◆ \d+ subagents?|\d+ shells?\b/)
    // The composer is fx's bare rail: drawn in the text colour, with no fill behind it.
    expect(cellAt(details, hint + 1, 1).fg).toBe(TEXT)
    expect(cellAt(details, hint + 1, 3).bg).not.toBe(BAND)
  }))

  test("while the reviewer runs: its call has returned, the parent waits idle, and the dock counts one subagent", kept.test(() => {
    const running = frames.running
    // OpenCode runs every subagent in the background: the call ends as the reviewer starts, a group of its own
    // under the edit's, and the parent's turn ends with no loader while the reviewer works.
    expect(running.text).toMatch(/^ {2}● Edited src\/net\.py \+1 \/ -1$/m)
    const call = indexOf(running, /^ {2}● Ran code-reviewer$/)
    expect(call).toBeGreaterThan(0)
    expect(running.lines[call + 1]).toBe("    │ ✉ Agent message · ↓ code-reviewer")
    expect(running.text).not.toContain("Executing")
    expect(running.text).toMatch(row(" ◆ 1 subagent  ·  0 shells"))
    expect(running.text).toMatch(/^ \S general gpt {2}code-reviewer {2}/m)
    expect(running.text).not.toContain("General finished")
    expect(running.text).not.toContain("reviewer approved")
    expect(cell(running, "◆ 1 subagent").fg).toBe(SUCCESS)
  }))

  test("All: a row per call with Prime's counts, the whole diff, output and the agent's reply", kept.test(() => {
    const all = frames.all
    expect(all.text).not.toContain("Ctrl+O to")
    const lines = [
      // A lone call is the group's line: what hangs under it has no rail.
      "  ✓ shell · printf 'test_net.py F\\n1 failed\\n' · ↑ 1 ↓ 2 lines · <t>",
      "    ╰─ test_net.py F",
      "       1 failed",
      // Each one-call step is its call's line alone; its body hangs with no rail.
      "  ✓ patch · src/net.py · ↑ 6 lines · <t>",
      "    ╰─ src/net.py +1 -1",
      "      6               backoff(i)",
      // The call's own answer is OpenCode's background-start note; the reviewer's answer is its completion notice.
      "  ✓ subagent · Review the diff in src/net.py. · ↑ 1 ↓ 4 lines · <t>",
      "    │ ✉ Agent message · ↓ code-reviewer",
      "  ● General finished · code-reviewer",
      "  └ Approved: the loop now makes every attempt.",
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
    const first = at[11]!
    const last = at[13]!
    for (const line of all.lines.slice(first, last + 1)) expect(line).toMatch(/^ {2}[├│└](?: |$)/)
    expect(all.lines[last + 1]).toBe("")
    // All opens the thought whole, hung under its node as a call's body hangs.
    const thought = indexOf(all, row("  └ thinking"))
    expect(all.lines.slice(thought - 1, thought + 2)).toEqual([
      "  ● Thought",
      "  └ thinking",
      "    Look at the test first, then spawn a reviewer.",
    ])
    // The subagent's result envelope never shows.
    expect(all.text).not.toContain("<subagent")
  }))

  test("Overview: each group is its header, plus a row per failure; no thinking, no diffs, no blank rows", kept.test(() => {
    const overview = frames.overview
    expect(overview.text).not.toContain("Ctrl+O to")
    expect(overview.text).not.toContain("Look at the test first")
    expect(overview.text).not.toContain("range(retries - 1)")
    const rows = [
      "  Reading the retry test and its helper.",
      "  ● Ran 1 command",
      "  The backoff loop exits one attempt early. Patching it.",
      // A header per step.
      "  ● Edited 1 file",
      "  ● Ran 1 agent",
      "  ● General finished · code-reviewer",
      "  ✗ Searched 1 pattern · read 1 file · 1 failed",
      // gent's failure row: what failed, its failure word, then the reason.
      "  └ Read out/traces.jsonl · failed · File not found: out/traces.jsonl",
      "  The fix is in. 1 file changed, reviewer approved.",
    ]
    const first = indexOf(overview, row(rows[0]!))
    expect(first).toBeGreaterThan(0)
    rows.forEach((line, index) => expect(overview.lines[first + index]).toMatch(row(line)))
  }))

  test("the splash stays on screen in every mode", kept.test(() => {
    for (const saved of Object.values(frames)) {
      expect(saved.text).toMatch(/^ {2}opencode \S+\n {2}model simulation\/gpt-sim-model\n {2}cwd \S+$/m)
    }
  }))

  test("key cells carry Prime's colours", kept.test(() => {
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
  }))
})
