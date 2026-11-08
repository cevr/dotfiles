// Runs scenarios/prime-workers.ts with the Prime look against an OpenCode checkout
// and asserts on its frames: three background workers started in three steps
// read as one group, and their completion notices, landing together, as one group.
// It needs OPENCODE_DEV, the fork with the plugin hook points.
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/workers.test.ts: skipped. Set OPENCODE_DEV to the prime-look fork to run it.")

const root = join(import.meta.dir, "..")
const frames: Record<"started" | "finished", ReadonlyArray<string>> = {} as never

describe.skipIf(!fork)("background workers in the Prime look (OPENCODE_DEV)", () => {
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "prime-workers-"))
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-workers.ts"], {
      cwd: root,
      env: { ...process.env, SCENARIO_OUT: out, SCENARIO_LABEL: "workers", OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ])
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    const lines = (name: string) => readFileSync(join(out, `${name}.txt`), "utf8").split("\n")
    frames.started = lines("workers-started")
    frames.finished = lines("workers")
  }, 300_000)

  test("three steps that each start a worker, a moment apart, read as one group with a row per worker", () => {
    const at = frames.started.indexOf("  ● Started 3 agents")
    expect(at).toBeGreaterThan(-1)
    expect(frames.started.slice(at, at + 4)).toEqual([
      "  ● Started 3 agents",
      "  ├ Started Fix money parsing",
      "  ├ Started Fix CSV quoting",
      "  └ Started Fix month padding",
    ])
  })

  test("workers that finish together read as one group, a node per worker, in the order they finished", () => {
    const done = frames.finished.filter((line) => line.includes("finished"))
    expect(done).toEqual(["  ● 3 agents finished"])
    const at = frames.finished.indexOf(done[0]!)
    const nodes = frames.finished.slice(at + 1, at + 4)
    expect(nodes.map((line) => line.slice(0, 4))).toEqual(["  ├ ", "  ├ ", "  └ "])
    // Each node is its task, then its answer's first line.
    for (const line of nodes) expect(line).toMatch(/^ {2}[├└] (Fix money parsing|Fix CSV quoting|Fix month padding) · \1: done\.$/)
    for (const task of ["Fix money parsing", "Fix CSV quoting", "Fix month padding"]) expect(nodes.join("\n")).toContain(task)
    // The folded notices draw nothing and add no blank rows: the parent's reply is one blank row below.
    expect(frames.finished.slice(at + 4, at + 6)).toEqual(["", "  Noted."])
  })
})
