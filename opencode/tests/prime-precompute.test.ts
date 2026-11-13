// accept: one at a time (it bounds when the summary lands against the next turn).
// Runs scenarios/prime-precompute.ts with the Prime look against an OpenCode
// checkout, background compaction on, and asserts that an automatic
// compaction swaps in the summary the host wrote in the background: one
// summary request, sent as the first turn ended and before the next prompt,
// none at the compaction, which finishes at once and reads as one finished
// row with the background request's tokens. Needs OPENCODE_DEV, a fork with
// the `background_compaction` flag.
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Requests } from "../scenarios/prime-precompute.ts"
import { hintRow } from "./composer.ts"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-precompute.test.ts: skipped. Set OPENCODE_DEV to the fork to run it.")

const root = join(import.meta.dir, "..")
const names = ["held", "swapped"] as const
const frames = {} as Record<(typeof names)[number], ReadonlyArray<string>>
let seen: Requests = { requests: [], next: 0 }

/** The frame's transcript from the first prompt to Prime's hint line (tests/composer.ts), blank rows dropped. */
function transcript(frame: ReadonlyArray<string>): ReadonlyArray<string> {
  const start = frame.findIndex((line) => line.includes("┃ Check the build."))
  const end = hintRow(frame)
  return frame.slice(start, end < 0 ? undefined : end).filter((line) => line.trim() !== "")
}

describe.skipIf(!fork)("an automatic compaction swaps in the summary written in the background, in the Prime look (OPENCODE_DEV)", () => {
  const kept = keptScratch(Boolean(fork), "prime-precompute-")
  beforeAll(...kept.setup(async () => {
    const out = kept.dir("prime-precompute-")
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-precompute.ts"], {
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
    for (const name of names) frames[name] = readFileSync(join(out, `${name}.txt`), "utf8").split("\n")
    seen = JSON.parse(readFileSync(join(out, "requests.json"), "utf8")) as Requests
  }, 300_000))

  test("the summary is written once, in the background, as the first turn ends: no row shows it", kept.test(() => {
    const summaries = seen.requests.filter((request) => request.kind === "summary")
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.at).toBeLessThan(seen.next)
    expect(frames.held.join("\n")).not.toContain("compaction")
    expect(frames.held.join("\n")).not.toContain("Compacted")
  }))

  test("the automatic compaction swaps it in at once and reads as one finished row, the background request's tokens on it", kept.test(() => {
    // Every step of the second turn came after the prompt; no summary request did.
    expect(seen.requests.filter((request) => request.at >= seen.next).map((request) => request.kind)).toEqual(["step", "step"])
    const shown = transcript(frames.swapped)
    const row = shown.findIndex((line) => line.includes("◇ Compacted automatically"))
    // Instant: from the compaction's start to the step it resumes, under a second.
    expect(shown[row]).toMatch(/^ {2}◇ Compacted automatically · 88k → 500 tokens · \d+ms$/)
    expect(shown.slice(row + 1)).toEqual(["  Docs updated."])
    expect(frames.swapped.join("\n")).not.toContain("Automatic compaction")
    expect(frames.swapped.join("\n")).not.toContain("Compacting")
  }))
})
