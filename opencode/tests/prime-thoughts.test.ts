// Runs scenarios/prime-thoughts.ts with the Prime look against an OpenCode checkout
// and asserts on its frames: a step's thought is the first `thinking` node of
// that step's tree, a thought-only step is a one-node tree, and a finished
// worker's notice is a tool-call group beside an ordinary one.
// It needs OPENCODE_DEV, the fork with the plugin hook points.
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-thoughts.test.ts: skipped. Set OPENCODE_DEV to the prime-look fork to run it.")

type Rgba = readonly [number, number, number, number]
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string; fg: Rgba }> }> }
type Saved = { lines: ReadonlyArray<string>; frame: Frame }

const root = join(import.meta.dir, "..")
// The scenario's scripted texts (scenarios/prime-thoughts.ts).
const SETTLED = "The worker has the CSV fix; nothing else needs me now."
const STARTED = "A worker is on the CSV quoting."
const NOTED = "Noted: the CSV fix is in."
const NOTICE = "  ● General finished · Fix CSV quoting"
/** The worker's whole answer under the notice's header. */
const BODY = [
  "  └ CSV quoting fixed.",
  "    Quoted fields keep their commas.",
  "    Escaped quotes stay doubled.",
  "    Empty fields stay empty.",
  "    Newlines in a field keep their quotes.",
  "    The writer and the reader agree.",
  "    All 12 tests pass.",
]
const frames: Record<"streaming" | "details" | "all" | "overview" | "opened" | "closed" | "reopenedAll", Saved> = {} as never

/** The theme's `text.muted` and `text.faint`. */
const MUTED = "#a1a1aa"
const FAINT = "#71717a"
const ACCENT = "#7c6faf"

const hex = (rgba: Rgba) => `#${rgba
  .slice(0, 3)
  .map((value) => value.toString(16).padStart(2, "0"))
  .join("")}`

/** The foreground of the cell `offset` columns into the first line equal to `line`. */
function fg(saved: Saved, line: string, offset: number) {
  const y = saved.lines.indexOf(line)
  if (y === -1) throw new Error(`no line is ${JSON.stringify(line)}:\n${saved.lines.join("\n")}`)
  let start = 0
  for (const span of saved.frame.lines[y]!.spans) {
    if (offset < start + span.text.length) return hex(span.fg)
    start += span.text.length
  }
  throw new Error(`no span at ${y}:${offset}`)
}

/** The `count` lines from the first line equal to `first`. */
function slice(saved: Saved, first: string, count: number) {
  const at = saved.lines.indexOf(first)
  if (at === -1) throw new Error(`no line is ${JSON.stringify(first)}:\n${saved.lines.join("\n")}`)
  return saved.lines.slice(at, at + count)
}

describe.skipIf(!fork)("thoughts and worker notices as tool-call trees (OPENCODE_DEV)", () => {
  const kept = keptScratch(Boolean(fork), "prime-thoughts-")
  beforeAll(...kept.setup(async () => {
    const out = kept.dir("prime-thoughts-")
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-thoughts.ts"], {
      cwd: root,
      env: { ...process.env, SCENARIO_OUT: out, SCENARIO_LABEL: "thoughts", OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ])
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    const load = (name: string): Saved => ({
      lines: readFileSync(join(out, `${name}.txt`), "utf8")
        .split("\n")
        .map((line) => line.trimEnd()),
      frame: JSON.parse(readFileSync(join(out, `${name}.json`), "utf8")),
    })
    frames.streaming = load("thoughts-streaming")
    frames.details = load("thoughts")
    frames.all = load("thoughts-all")
    frames.overview = load("thoughts-overview")
    frames.opened = load("thoughts-opened")
    frames.closed = load("thoughts-closed")
    frames.reopenedAll = load("thoughts-reopened-all")
  }, 300_000))

  test("a streaming thought is a one-node group headed Thinking, its glyph in the accent", kept.test(() => {
    // The glyph blinks ● / ○; the frame may catch either.
    const lead = frames.streaming.lines.some((line) => line.startsWith("  ○ Thinking")) ? "  ○ Thinking" : "  ● Thinking"
    expect(slice(frames.streaming, lead, 2)).toEqual([lead, "  └ thinking  Planning the check"])
    expect(fg(frames.streaming, lead, 2)).toBe(ACCENT)
  }))

  test("a step that thinks, then makes two calls, is one tree: the thought is its first node", kept.test(() => {
    expect(slice(frames.details, "  ● Read 1 file · ran 1 command", 5)).toEqual([
      "  ● Read 1 file · ran 1 command",
      "  ├ thinking  Planning the check",
      "  ├ Read money.py",
      "  └ Ran printf '1 passed\\n'",
      "    │ 1 passed",
    ])
    // The label is a tool name's colour; the thought itself is faint.
    const node = "  ├ thinking  Planning the check"
    expect(fg(frames.details, node, 4)).toBe(MUTED)
    expect(fg(frames.details, node, 14)).toBe(FAINT)
  }))

  test("a step that only thinks is a one-node tree headed Thought, then its answer", kept.test(() => {
    expect(slice(frames.details, "  ● Thought", 4)).toEqual([
      "  ● Thought",
      `  └ thinking  ${SETTLED}`,
      "",
      `  ${STARTED}`,
    ])
    expect(fg(frames.details, "  ● Thought", 2)).toBe(MUTED)
  }))

  test("a finished worker's notice is a group like the ordinary tool group below it, its header alone by default", kept.test(() => {
    // The owner's scrawl of 2026-11-12: the answer under the header shows only on Ctrl+O or a click.
    expect(slice(frames.details, NOTICE, 5)).toEqual([
      NOTICE,
      "",
      "  ● Ran printf 'csv ok\\n'",
      "    │ csv ok",
      "",
    ])
    expect(frames.details.lines.join("\n")).not.toContain("CSV quoting fixed.")
    expect(frames.details.lines.join("\n")).not.toContain("lines (ctrl+o)")
    expect(frames.details.lines).toContain(`  ${NOTED}`)
    // Both headers share the glyph's colour and column.
    const ran = "  ● Ran printf 'csv ok\\n'"
    expect(fg(frames.details, NOTICE, 2)).toBe(MUTED)
    expect(fg(frames.details, NOTICE, 2)).toBe(fg(frames.details, ran, 2))
    // The old `↳` line is gone.
    expect(frames.details.lines.join("\n")).not.toContain("↳")
  }))

  test("Ctrl+O from the default shows the notice's whole answer, muted like a reply", kept.test(() => {
    expect(frames.details.lines.join("\n")).not.toContain("CSV quoting fixed.")
    expect(slice(frames.all, NOTICE, 8)).toEqual([NOTICE, ...BODY])
    expect(fg(frames.all, "  └ CSV quoting fixed.", 4)).toBe(MUTED)
  }))

  test("a click on the notice opens its whole answer in place, and a second click closes it", kept.test(() => {
    // Still the parent session: no ` › ` crumb of a subagent, the same top line, the parent's own rows.
    expect(frames.opened.lines[0]).toBe(frames.details.lines[0])
    expect(frames.opened.lines[0]).not.toContain(" › ")
    expect(frames.opened.lines).toContain(`  ${NOTED}`)
    // Every line of the answer, no head and no count.
    expect(slice(frames.opened, NOTICE, 8)).toEqual([NOTICE, ...BODY])
    expect(frames.opened.lines.join("\n")).not.toContain("lines (ctrl+o)")
    expect(frames.closed.lines[0]).toBe(frames.details.lines[0])
    expect(slice(frames.closed, NOTICE, 3)).toEqual([NOTICE, "", "  ● Ran printf 'csv ok\\n'"])
    expect(frames.closed.lines.join("\n")).not.toContain("CSV quoting fixed.")
  }))

  test("a notice clicked open, then Ctrl+O to All, still shows its whole answer, as every notice does at All", kept.test(() => {
    expect(slice(frames.reopenedAll, NOTICE, 8)).toEqual([NOTICE, ...BODY])
  }))

  test("at All the whole thought hangs under its node, and the notice keeps its group", kept.test(() => {
    expect(slice(frames.all, "  ● Read 1 file · ran 1 command", 6)).toEqual([
      "  ● Read 1 file · ran 1 command",
      "  ├ thinking",
      "  │ **Planning the check**",
      "  │",
      "  │ Read money.py first, then run its test.",
      "  │ The CSV fix goes to a worker.",
    ])
    expect(slice(frames.all, "  ● Thought", 3)).toEqual(["  ● Thought", "  └ thinking", `    ${SETTLED}`])
    expect(slice(frames.all, NOTICE, 8)).toEqual([NOTICE, ...BODY])
  }))

  test("the Overview shows no thoughts: a thought-only step draws nothing, a notice only its header", kept.test(() => {
    const text = frames.overview.lines.join("\n")
    expect(text).not.toContain("thinking")
    expect(text).not.toContain("Thought")
    expect(text).not.toContain("CSV quoting fixed.")
    const at = frames.overview.lines.indexOf("  ● Read 1 file · ran 1 command")
    expect(frames.overview.lines.slice(at, at + 6)).toEqual([
      "  ● Read 1 file · ran 1 command",
      "  ● Started 1 agent",
      `  ${STARTED}`,
      "  ● General finished · Fix CSV quoting",
      "  ● Ran 1 command",
      `  ${NOTED}`,
    ])
  }))
})
