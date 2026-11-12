// Runs scenarios/tui-cpu.ts with the Prime look and our other TUI plugins, in
// a terminal wide enough for the host's sidebar, against an OpenCode checkout,
// and holds the TUI's CPU to a budget while a session with a long transcript
// (300 tool groups) streams its answer beside three streaming subagents.
// Before each subagent family read kept its message readings
// (mods/subagents/solid/reader.ts), every streamed token re-read every part
// of every message of the family in each computation that read it, and this
// TUI took 0.3 to 0.6 of a core here; with them it takes about 0.1. It needs
// OPENCODE_DEV.
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { scratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/tui-cpu.test.ts: skipped. Set OPENCODE_DEV to an OpenCode checkout to run it.")

const root = join(import.meta.dir, "..")
/** The TUI's share of one core it may take while the session works: well above the ~0.1 it takes, well below the 0.3 to 0.6 it took. */
const BUDGET = 0.25

type Result = { readonly idle: ReadonlyArray<{ readonly share: number }>; readonly busy: ReadonlyArray<{ readonly share: number }> }
let result: Result
let busy: string

describe.skipIf(!fork)("the TUI's CPU while a long session and its subagents stream (OPENCODE_DEV)", () => {
  beforeAll(async () => {
    using held = scratch("tui-cpu-")
    const out = held.path
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/tui-cpu.ts"], {
      cwd: root,
      env: {
        ...process.env,
        SCENARIO_OUT: out,
        OPENCODE_DRIVE_MEDIA_DIR: join(out, "media"),
        CPU_TUI_PLUGINS: "all",
        CPU_COLS: "160",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    result = JSON.parse(readFileSync(join(out, "cpu.json"), "utf8"))
    busy = readFileSync(join(out, "busy.txt"), "utf8")
  }, 300_000)

  test("the measured window is the working session: its answer streams and three subagent rows work", () => {
    expect(busy).toContain("main word")
    expect(busy.split("\n").filter((line) => /◆|◇/.test(line) && /Fix module \d/.test(line))).toHaveLength(3)
    expect(result.busy).toHaveLength(1)
  })

  test(`the TUI stays under ${BUDGET} of a core while it works`, () => {
    expect(result.busy[0]!.share).toBeLessThan(BUDGET)
  })
})
