// accept: deep (21.7 s alone on a quiet host: 1-minute load 7.2–7.5 on 12 cores; it boots real OpenCode and drives its scenario through events that take that long)
// Runs scenarios/prime-kernel.ts with the Prime look and the real kernel (as
// the agent's runtime) against an OpenCode checkout, and asserts on the
// finished turn's frame: a cell that describes itself draws its description
// as the group's header, in the normal text colour, over the rows of the
// tools.* calls it made; cells without one draw as before. It needs
// OPENCODE_DEV, the fork with the plugin hook points.
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-kernel.test.ts: skipped. Set OPENCODE_DEV to the prime-look fork to run it.")

type Rgba = readonly [number, number, number, number]
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string; fg: Rgba }> }> }

const root = join(import.meta.dir, "..")
/** The theme's `text.base` and `text.muted`. */
const TEXT = "#f4f4f5"
const MUTED = "#a1a1aa"

let lines: ReadonlyArray<string> = []
let frame: Frame = { lines: [] }

/** The frame's transcript from the prompt to the answer, with the blank rows dropped. */
function transcript(): ReadonlyArray<string> {
  const start = lines.findIndex((line) => line.includes("┃ Merge the worker"))
  const end = lines.findIndex((line) => line.includes("the notes say ship it"))
  return lines.slice(start, end + 1).filter((line) => line.trim() !== "")
}

const hex = (rgba: Rgba) => `#${rgba.slice(0, 3).map((value) => value.toString(16).padStart(2, "0")).join("")}`

/** The foreground of the cell `offset` columns into the first line holding `needle`. */
function fg(needle: string, offset = 0) {
  const y = lines.findIndex((line) => line.includes(needle))
  if (y === -1) throw new Error(`no line contains ${JSON.stringify(needle)}:\n${lines.join("\n")}`)
  const x = lines[y]!.indexOf(needle) + offset
  let start = 0
  for (const span of frame.lines[y]!.spans) {
    if (x < start + span.text.length) return hex(span.fg)
    start += span.text.length
  }
  throw new Error(`no span at ${y}:${x}`)
}

describe.skipIf(!fork)("a kernel cell's description in the Prime look (OPENCODE_DEV)", () => {
  const kept = keptScratch(Boolean(fork), "prime-kernel-")
  beforeAll(...kept.setup(async () => {
    const out = kept.dir("prime-kernel-")
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-kernel.ts"], {
      cwd: root,
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    lines = readFileSync(join(out, "kernel.txt"), "utf8").split("\n")
    frame = JSON.parse(readFileSync(join(out, "kernel.json"), "utf8"))
  }, 300_000))

  test("Details: the described cell's header is its description over its nested rows; the others count what they ran", kept.test(() => {
    expect(transcript()).toEqual([
      " ┃ Merge the worker and check the notes.",
      "  ● Merge the skill-dollar worker",
      "  ├ Ran printf 'merged\\n', printf 'tests ok\\n'",
      "  │ │ tests ok",
      "  └ Read notes.md",
      "  ● Ran printf 'lint ok\\n', printf 'types ok\\n'",
      "    │ types ok",
      "  ● Ran printf 'clean\\n'",
      "    │ clean",
      "  Merged; the notes say ship it.",
    ])
  }))

  test("the description is in the normal text colour; the rows beneath stay muted", kept.test(() => {
    expect(fg("Merge the skill-dollar worker")).toBe(TEXT)
    expect(fg("├ Ran printf 'merged")).toBe(MUTED)
    expect(fg("└ Read notes.md")).toBe(MUTED)
    expect(fg("● Ran printf 'lint ok", 2)).toBe(MUTED)
  }))
})
