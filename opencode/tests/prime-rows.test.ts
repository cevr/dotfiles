// Runs scenarios/prime-rows.ts with the Prime look and the orchestrate plugin
// against an OpenCode checkout and asserts on the live subagent rows beneath
// the composer: each says how it stands by its leading diamond's fill and
// colour (no state word), then its role, its model, its unit, what it does
// now and for how long; the update follows a worker from thinking to a shell
// command; a worker running a command that works turns, with the command's
// description, beside one polling a file, which waits, still, with what it
// polls; a finished worker reads done by a muted diamond, then its row drops.
// It needs OPENCODE_DEV, the fork with the plugin hook points.
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-rows.test.ts: skipped. Set OPENCODE_DEV to the prime-look fork to run it.")

const root = join(import.meta.dir, "..")
const names = ["thinking", "shell", "done", "dropped"] as const
const frames: Record<(typeof names)[number], ReadonlyArray<string>> = { thinking: [], shell: [], done: [], dropped: [] }

/** The row lines beneath the dock's count line, up to the first blank line. */
function rows(frame: ReadonlyArray<string>): ReadonlyArray<string> {
  const dock = frame.findIndex((line) => / ◆ \d+ subagents?  ·/.test(line))
  if (dock < 0) return []
  const after = frame.slice(dock + 1)
  const blank = after.findIndex((line) => !line.trim())
  return (blank < 0 ? after : after.slice(0, blank)).map((line) => line.trim())
}

/** A working row's diamond turns through these frames. */
const SPIN = "[◇◈◆]"
/** The state words a row never says. */
const WORDS = /(^|\s)(working|waiting|blocked|idle|cancelled|done|failed)(\s|$)/

type Rgba = readonly [number, number, number, number]
type Styled = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string; fg: Rgba }> }> }
const styled: { thinking?: Styled; shell?: Styled; done?: Styled } = {}
/** The theme's success, warning and muted colours. */
const SUCCESS = "#7da876"
const WARNING = "#f59e0b"
const MUTED = "#a1a1aa"
const hex = (rgba: Rgba) => `#${rgba.slice(0, 3).map((value) => value.toString(16).padStart(2, "0")).join("")}`

/** The foreground of the first cell of `needle` on the first row line that contains `line`. */
function colour(frame: Styled | undefined, line: string, needle: string): string {
  const texts = (frame?.lines ?? []).map((row) => row.spans.map((span) => span.text).join(""))
  const y = texts.findIndex((text) => text.includes(line))
  if (y < 0) throw new Error(`no line contains ${line}`)
  const x = (texts[y] ?? "").indexOf(needle, (texts[y] ?? "").indexOf(line))
  let start = 0
  for (const span of frame?.lines[y]?.spans ?? []) {
    if (x < start + span.text.length) return hex(span.fg)
    start += span.text.length
  }
  throw new Error(`no span at ${y}:${x}`)
}

/** The leading diamond of the row line that names `unit`, and its foreground. */
function lead(frame: Styled | undefined, unit: string): string {
  const line = (frame?.lines ?? []).map((row) => row.spans.map((span) => span.text).join("")).find((text) => text.includes(`gpt  ${unit}`)) ?? ""
  const diamond = line.trim().slice(0, 1)
  return `${diamond} ${colour(frame, `${diamond} worker gpt  ${unit}`, diamond)}`
}

describe.skipIf(!fork)("the live subagent rows in the Prime look (OPENCODE_DEV)", () => {
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "prime-rows-"))
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-rows.ts"], {
      cwd: root,
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ])
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    for (const name of names) frames[name] = readFileSync(join(out, `rows-${name}.txt`), "utf8").split("\n")
    for (const name of ["thinking", "shell", "done"] as const) styled[name] = JSON.parse(readFileSync(join(out, `rows-${name}.json`), "utf8"))
  }, 300_000)

  test("each working worker has a row: its turning diamond, its role from orchestrate, its model, its unit, its first thought and its time working; no state word", () => {
    const shown = rows(frames.thinking)
    expect(shown).toHaveLength(2)
    expect(shown[0]).toMatch(new RegExp(`^${SPIN} worker gpt  Fix money parsing  Check the money parser first\\. · \\d+s$`))
    expect(shown[1]).toMatch(new RegExp(`^${SPIN} worker gpt  Fix CSV quoting    Check the CSV writer first\\. · \\d+s$`))
    for (const line of shown) expect(line).not.toMatch(WORDS)
    // Working is told by the diamond's colour: whichever frame it is on, it is the success colour.
    expect(lead(styled.thinking, "Fix money parsing")).toMatch(new RegExp(`^${SPIN} ${SUCCESS}$`))
    expect(lead(styled.thinking, "Fix CSV quoting")).toMatch(new RegExp(`^${SPIN} ${SUCCESS}$`))
  })

  test("side by side: the worker running a command works, by the command's description; the one polling a file waits, still, by what it polls", () => {
    const shown = rows(frames.shell)
    expect(shown).toHaveLength(2)
    expect(shown[0]).toMatch(new RegExp(`^${SPIN} worker gpt  Fix money parsing  Run the money tests · \\d+s$`))
    expect(shown[1]).toMatch(/^◈ worker gpt  Fix CSV quoting    polling out\/csv\.done · \d+s$/)
    for (const line of shown) expect(line).not.toMatch(WORDS)
    // Never the one-liner itself.
    expect(frames.shell.join("\n")).not.toContain("[ -f out/csv.done ]")
  })

  test("the diamond's colour carries the state: working in the success colour, waiting a still ◈ in the warning colour, its words in neither", () => {
    expect(lead(styled.shell, "Fix money parsing")).toMatch(new RegExp(`^${SPIN} ${SUCCESS}$`))
    expect(lead(styled.shell, "Fix CSV quoting")).toBe(`◈ ${WARNING}`)
    expect(colour(styled.shell, "◈ worker gpt  Fix CSV", "polling")).not.toBe(WARNING)
  })

  test("a finished worker reads done by a muted ◆, with its steps, beside the one still going", () => {
    const shown = rows(frames.done)
    expect(shown).toContain("◆ worker gpt  Fix money parsing  2 steps")
    expect(lead(styled.done, "Fix money parsing")).toBe(`◆ ${MUTED}`)
    expect(shown.find((line) => line.includes("Fix CSV quoting"))).toMatch(new RegExp(`^${SPIN} worker gpt  Fix CSV quoting  .+ · \\d+s$`))
  })

  test("past its linger, the finished worker's row drops and the working one stays", () => {
    const shown = rows(frames.dropped)
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatch(new RegExp(`^${SPIN} worker gpt  Fix CSV quoting  .+ · \\d+s$`))
  })
})
