// accept: one at a time (its scenario drives a real TUI and waits on its frames under a deadline).
// Runs scenarios/prime-panel.ts with the Prime look and the wake plugin against
// an OpenCode checkout: five background subagents, two background shells, an
// alarm, a monitor and two terminals, then the background-work panel (Down on
// an empty prompt) at 160 and at 80 columns. Each row of every tab says its
// name, what it last did and its state, and a time that moves on with the
// clock where one exists (a terminal has none: the PTY service keeps no start
// time), in columns the tab's rows share; the tab bar counts each tab and the
// footer words its keys as Prime's hint line does. The rows are asserted
// through `ROWS` in scenarios/prime-panel-rows.ts, which the scenario's waits
// read too. Needs OPENCODE_DEV, a fork with the `session.composer.panel.*`
// slots and a Terminals row's terminal in its input (panel-terminal-state).
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { panelOf as panel, ROWS, type Tab } from "../scenarios/prime-panel-rows.ts"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-panel.test.ts: skipped. Set OPENCODE_DEV to the fork to run it.")

/** OpenCode's start, a scripted turn and two walks of the panel: well past its usual 20 seconds. */
const SCENARIO_MS = 180_000
const LANES = [
  { role: "implementor", unit: "Corpus HP r1" },
  { role: "implementor", unit: "EX3 later clauses r1" },
  { role: "verifier", unit: "Corpus MD r2" },
  { role: "planner", unit: "port phase d r1" },
  { role: "general", unit: "Fold the MONO1 IR-G pass" },
]
const NAMES = ["subagents", "tick", "shell", "terminals", "wakes", "monitors"] as const
/** At 80 columns the scenario keeps no tick frame. */
const NARROW = ["subagents", "shell", "terminals", "wakes", "monitors"] as const
const OTHER_TABS: ReadonlyArray<Tab> = ["shell", "terminals", "wakes", "monitors"]

/** Runs the scenario and reads each tab's frame at each width. */
const scenario = async (dir: string) => {
  const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-panel.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, SCENARIO_OUT: dir, OPENCODE_DRIVE_MEDIA_DIR: join(dir, "media") },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = await new Response(run.stdout).text()
  const errors = await new Response(run.stderr).text()
  const code = await run.exited
  const last = join(dir, "panel-80-monitors.txt")
  expect({ code, ran: existsSync(last) }, `${output}${errors}`.slice(-4000)).toEqual({ code: 0, ran: true })
  const read = (name: string) => panel(readFileSync(join(dir, `panel-${name}.txt`), "utf8"))
  return {
    wide: Object.fromEntries(NAMES.map((name) => [name, read(`160-${name}`)])),
    narrow: Object.fromEntries(NARROW.map((name) => [name, read(`80-${name}`)])),
  }
}

/** A subagent's row: diamond, role, model, unit, what it last did, `working` and its time. */
const lane = (row: string) => /^[◆◇◈] (\S+) +(\S+) +(.+?) {2,}(\S.*?) +working +(\d+s)$/.exec(row)
const cellsOf = (line: string) => Array.from(line).length

type Panel = ReturnType<typeof panel>
type Shown = Readonly<Partial<Record<string, Panel>>>

/** Subagents: the role, the model, the unit, what it last did, `working` and its time, each lane once, in shared columns. */
function expectSubagents(wide: Shown, narrow: Shown) {
  const rows = wide.subagents?.rows ?? []
  for (const { role, unit } of LANES) {
    const row = rows.find((each) => each.includes(unit)) ?? ""
    expect(lane(row)?.slice(1, 4), row).toEqual([role, "gpt", unit])
    expect(lane(row)?.[4], row).toStartWith("Porting ")
  }
  // The columns line up: every unit starts, and every time ends, in one column.
  expect(new Set(LANES.map(({ unit }) => (rows.find((each) => each.includes(unit)) ?? "").indexOf(unit))).size).toBe(1)
  expect(new Set(rows.map(cellsOf)).size).toBe(1)
  // The time moves on with the clock, the row redrawn in place.
  const time = (frame?: Panel) => lane(frame?.rows.find((each) => each.includes("Corpus HP")) ?? "")?.[5] ?? ""
  expect(time(wide.subagents)).toMatch(/^\d+s$/)
  expect(time(wide.tick)).toMatch(/^\d+s$/)
  expect(Number.parseInt(time(wide.tick), 10)).toBeGreaterThan(Number.parseInt(time(wide.subagents), 10))
  // At 80 columns what each did is cut first; the name and the time stay.
  for (const row of narrow.subagents?.rows ?? []) {
    expect(cellsOf(row)).toBeLessThanOrEqual(76)
    expect(row).toMatch(/ working +\d+s$/)
  }
  for (const { unit } of LANES) expect(narrow.subagents?.rows.join("\n")).toContain(unit.slice(0, 12))
}

/**
 * The closed panel's frame: `↓ subagents` is the dock's first line, right
 * under the composer's rail with the model at its right, and the line above
 * the composer no longer holds it.
 */
function expectDownUnder(frame: string) {
  const lines = frame.split("\n")
  const rail = lines.findLastIndex((line) => line.startsWith(" ┃"))
  const first = lines.findIndex((line) => line.startsWith(" ┃"))
  expect(lines[rail + 1]?.trim()).toMatch(/^↓ subagents +gpt-sim-model(?: {2}|$)/)
  expect(lines[first - 1]?.trim()).toBe("")
  expect(lines.filter((line) => line.includes("↓ subagents"))).toHaveLength(1)
  expect(lines[rail + 3]?.trim()).toStartWith("◆ 5 subagents  ·  2 shells")
}

/**
 * Shell, Terminals, Wakes and Monitors at one width: each tab's rows as ROWS
 * has them (the scenario kept the frame on the same rows). Shell: the command,
 * its last output line, `running` and how long. Terminals: the title, what runs
 * in it, `running` or `exited 3`. Wakes: the note, mode and repeat, `pending`
 * and how long until due. Monitors: the command, its newest output,
 * `watching`, how long, and when it last checked.
 */
function expectOtherTabs(shown: Shown) {
  for (const tab of OTHER_TABS) expect(shown[tab]?.rows, tab).toEqual(ROWS[tab].map((row) => expect.stringMatching(row)))
  expect(shown.shell?.footer).toBe("Enter output · Ctrl+D kill · ←/→ tabs")
  // The Terminals rows line their columns up: the commands start in one column.
  const terminals = shown.terminals?.rows.slice(0, 2) ?? []
  expect(new Set(terminals.map((row) => row.indexOf("sh -c"))).size).toBe(1)
}

describe.skipIf(!fork)("the background-work panel in the Prime look (OPENCODE_DEV)", () => {
  const kept = keptScratch(Boolean(fork), "prime-panel-")

  test(
    "every row says its name, what it last did, its state and a time that moves on, in shared columns, at 160 and 80 columns",
    kept.test(async () => {
      const dir = kept.dir("prime-panel-")
      const { wide, narrow } = await scenario(dir)
      for (const cols of [160, 80]) expectDownUnder(readFileSync(join(dir, `panel-${cols}-dock.txt`), "utf8"))
      for (const shown of [wide, narrow]) {
        expect(shown.subagents?.bar).toMatch(/^Subagents 5 {2}· {2}Shell 2 {2}· {2}Terminals {2}· {2}Wakes 1 {2}· {2}Monitors 1 +esc$/)
        expect(shown.subagents?.footer).toBe("Ctrl+D interrupt · Ctrl+A show inactive · ←/→ tabs")
        expect(shown.subagents?.rows).toHaveLength(5)
        expectOtherTabs(shown)
      }
      expectSubagents(wide, narrow)
    }),
    SCENARIO_MS,
  )
})
