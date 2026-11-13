// accept: deep (37.3 s alone on a quiet host: 1-minute load 7.3–7.8 on 12 cores; it boots real OpenCode and drives its scenario through events that take that long)
// Runs scenarios/prime-indent.ts with the Prime look, once per transcript
// verbosity, and asserts that every row of the turn starts in one column, the
// one Prime's `● Ran …` call rows use: each call row, the grouped run, the
// inline tool, the prose, a program's notice (`◈ rift land · accept passed`,
// drawn by the host) and, at low verbosity, the host's `+ N commands` summary
// row, folded and unfolded. The host draws its own rows at its layout
// `gutter`, which Prime sets to its own. It needs OPENCODE_DEV, the fork.
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-indent.test.ts: skipped. Set OPENCODE_DEV to the prime-look fork to run it.")

const root = join(import.meta.dir, "..")
const NOTICE = "rift land · accept passed"
const frames: Record<string, ReadonlyArray<string>> = {}
const kept = keptScratch(Boolean(fork), "prime-indent-")

const run = async (verbosity: "low" | "medium") => {
  const out = kept.dir(`prime-indent-${verbosity}-`)
  const child = owned(["bunx", "opencode-drive", "run", "scenarios/prime-indent.ts"], {
    cwd: root,
    env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media"), INDENT_VERBOSITY: verbosity },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`the ${verbosity} scenario exited ${code} (its frames and logs: ${out}):\n${(stdout + stderr).slice(-4000)}`)
  const names = verbosity === "low" ? [`indent-low-folded`, `indent-low`] : [`indent-medium`]
  for (const name of names) frames[name] = readFileSync(join(out, `${name}.txt`), "utf8").split("\n")
}

/** The column a row starts in: its first non-blank cell. */
const column = (line: string) => line.length - line.trimStart().length

/** The row of `frame` that starts with `start` (after its indent), and the column it starts in. */
function row(frame: ReadonlyArray<string>, start: string | RegExp): { line: string; column: number } {
  const line = frame.find((item) => (typeof start === "string" ? item.trimStart().startsWith(start) : start.test(item.trimStart())))
  if (line === undefined) throw new Error(`no row starts with ${start}:\n${frame.join("\n")}`)
  return { line, column: column(line) }
}

/** Each row kind of the turn, by the column it starts in. */
function columns(frame: ReadonlyArray<string>, kinds: Record<string, string | RegExp>) {
  return Object.fromEntries(Object.entries(kinds).map(([kind, start]) => [kind, row(frame, start).column]))
}

const TURN = {
  call: "● Ran echo one",
  grouped: "● Ran echo two, echo three",
  inline: "● Searched *.md",
  prose: "All rows drawn.",
  notice: `◈ ${NOTICE}`,
}

describe.skipIf(!fork)("every transcript row starts in one column in the Prime look (OPENCODE_DEV)", () => {
  beforeAll(...kept.setup(async () => {
    await run("medium")
    await run("low")
  }, 600_000))

  test("medium: each call, the grouped run, the inline tool, the prose and the notice start in the call rows' column", kept.test(() => {
    const frame = frames["indent-medium"]!
    const call = row(frame, TURN.call).column
    expect(columns(frame, TURN)).toEqual(Object.fromEntries(Object.keys(TURN).map((kind) => [kind, call])))
  }))

  test("low, folded: the host's `+ N commands` summary row and the notice start where the prose does", kept.test(() => {
    const frame = frames["indent-low-folded"]!
    const kinds = { summary: /^\+ \d+ commands?/, prose: TURN.prose, notice: TURN.notice }
    const prose = row(frame, TURN.prose).column
    expect(columns(frame, kinds)).toEqual({ summary: prose, prose, notice: prose })
  }))

  test("low, unfolded: the summary row, the calls it holds, the prose and the notice start in the call rows' column", kept.test(() => {
    const frame = frames["indent-low"]!
    const kinds = { summary: /^− \d+ commands?/, ...TURN }
    const call = row(frame, TURN.call).column
    expect(columns(frame, kinds)).toEqual(Object.fromEntries(Object.keys(kinds).map((kind) => [kind, call])))
  }))

  test("low, unfolded: the first call sits on the row right under `− N commands`, no blank row between (the owner's pick)", kept.test(() => {
    const frame = frames["indent-low"]!
    const summary = frame.indexOf(row(frame, /^− \d+ commands?/).line)
    expect(frame.slice(summary, summary + 2).map((line) => line.trim())).toEqual(["− 3 commands, 1 tool", TURN.call])
  }))

  test("low, unfolded: the calls it holds sit on medium's rails and gaps, row for row, up to the notice", kept.test(() => {
    expect(turn(frames["indent-low"]!)).toEqual(turn(frames["indent-medium"]!))
  }))
})

/** The turn's rows from its first call through the notice, blank rows included. */
function turn(frame: ReadonlyArray<string>) {
  const first = frame.indexOf(row(frame, TURN.call).line)
  const last = frame.indexOf(row(frame, TURN.notice).line)
  return frame.slice(first, last + 1).map((line) => line.trimEnd())
}
