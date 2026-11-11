// Runs scenarios/prime-compaction.ts with the Prime look against an OpenCode
// checkout and asserts how a compaction reads: one line below All, with the
// compaction request's prompt and summary tokens and how long it took, and
// at All (Ctrl+O) the host's whole block, its rule and the summary. It needs
// OPENCODE_DEV, a fork with the `session.message.compaction` slot.
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hintRow } from "./composer.ts"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-compaction.test.ts: skipped. Set OPENCODE_DEV to the fork with the compaction slot to run it.")

const root = join(import.meta.dir, "..")
const names = ["details", "all", "overview"] as const
const frames: Record<(typeof names)[number], ReadonlyArray<string>> = { details: [], all: [], overview: [] }
const files = { details: "compaction", all: "compaction-all", overview: "compaction-overview" }

/** The frame's transcript from the prompt on, with the blank rows dropped. */
function transcript(frame: ReadonlyArray<string>): ReadonlyArray<string> {
  const start = frame.findIndex((line) => line.includes("┃ Check the build."))
  const end = hintRow(frame)
  return frame.slice(start, end < 0 ? undefined : end).filter((line) => line.trim() !== "")
}

/** The one line: manual, the 171k prompt to the 6k summary, and the second the scripted summary took. */
const LINE = /^ {2}◇ Compacted · 171k → 6k tokens · 1\.\ds$/

describe.skipIf(!fork)("a compaction is one line in the Prime look, and the host's block at All (OPENCODE_DEV)", () => {
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "prime-compaction-"))
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-compaction.ts"], {
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
    for (const name of names) frames[name] = readFileSync(join(out, `${files[name]}.txt`), "utf8").split("\n")
  }, 300_000)

  test("Details: the compaction is one line, without its summary", () => {
    const shown = transcript(frames.details)
    expect(shown.slice(0, 2)).toEqual([" ┃ Check the build.", "  The build passes."])
    expect(shown[2]).toMatch(LINE)
    expect(shown).toHaveLength(3)
    expect(frames.details.join("\n")).not.toContain("Resume from the passing build.")
  })

  test("Overview: the same one line", () => {
    const shown = transcript(frames.overview)
    expect(shown[2]).toMatch(LINE)
    expect(shown).toHaveLength(3)
  })

  test("All: the host's block, its rule with the request's usage and then the summary", () => {
    const shown = transcript(frames.all)
    expect(shown.slice(0, 2)).toEqual([" ┃ Check the build.", "  The build passes."])
    expect(shown[2]).toMatch(/^ ─+ Compaction · 171\.0K in · 6\.0K out ─+$/)
    expect(shown.slice(3)).toEqual(["    Objective", "    Resume from the passing build."])
    expect(frames.all.join("\n")).not.toContain("◇ Compacted")
  })
})
