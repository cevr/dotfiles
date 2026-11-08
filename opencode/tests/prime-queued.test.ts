// Runs scenarios/prime-queued.ts with the Prime look against an OpenCode
// checkout and asserts how a prompt sent during an automatic compaction reads:
// until the runner takes it, it is not in the transcript, a queued row above
// the composer shows it and the loader says `Compacting`; once taken, it is in
// the transcript, the row is gone and the loader says `Executing`, timed from
// the turn's start rather than from the prompt. Needs OPENCODE_DEV, the fork.
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-queued.test.ts: skipped. Set OPENCODE_DEV to the fork to run it.")

const root = join(import.meta.dir, "..")
const names = ["queued", "taken"] as const
const frames = {} as Record<(typeof names)[number], ReadonlyArray<string>>

/** The rows above Prime's mode hint (the transcript, then the queued rows), blank rows dropped. */
const above = (frame: ReadonlyArray<string>) =>
  frame.slice(0, frame.findIndex((line) => /mode \(Ctrl\+O/.test(line))).filter((line) => line.trim() !== "")
const LOADER = (label: string) => new RegExp(`^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] ${label} · (\\d+)s$`)

describe.skipIf(!fork)("a prompt sent during a compaction waits above the composer, in the Prime look (OPENCODE_DEV)", () => {
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "prime-queued-"))
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-queued.ts"], {
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
  }, 300_000)

  test("while the compaction runs: no prompt in the transcript, a queued row, and `Compacting`", () => {
    const shown = above(frames.queued)
    expect(shown.slice(-5)).toEqual([
      "  ● Ran true",
      "    │ (no output)",
      expect.stringMatching(/^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Automatic compaction$/),
      expect.stringMatching(LOADER("Compacting")),
      "  ◌ queued · Also update the docs.",
    ])
    // One blank row between the compaction and the loader: the hidden prompt's row adds none.
    const loader = frames.queued.findIndex((line) => LOADER("Compacting").test(line))
    expect(frames.queued[loader - 1]?.trim()).toBe("")
    expect(frames.queued[loader - 2]).toMatch(/Automatic compaction$/)
    expect(shown.some((line) => line.includes("┃ Also update the docs."))).toBe(false)
    expect(frames.queued.join("\n")).not.toContain("Executing")
  })

  test("once the runner takes it: the prompt in the transcript, no queued row, and `Executing` from the turn's start", () => {
    const shown = above(frames.taken)
    const at = shown.indexOf(" ┃ Also update the docs.")
    expect(at).toBeGreaterThan(shown.findIndex((line) => line.includes("◇ Compacted automatically")))
    expect(shown.slice(at + 1)).toEqual(["  Updating", expect.stringMatching(LOADER("Executing"))])
    expect(frames.taken.join("\n")).not.toContain("◌ queued")
    // The turn started before the six-second compaction; the prompt that waited behind it does not restart the clock.
    const seconds = Number(LOADER("Executing").exec(shown.at(-1) ?? "")?.[1])
    expect(seconds).toBeGreaterThanOrEqual(5)
  })
})
