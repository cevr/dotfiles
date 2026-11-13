// accept: one at a time (its scenario waits on second-scale answer and summary timers).
// Runs scenarios/prime-queued.ts with the Prime look against an OpenCode
// checkout and asserts how prompts sent during an automatic compaction read:
// two steers and one prompt sent to the queue wait in one list above the
// composer, oldest first, in place of the host's `N queued · …` box, out of
// the transcript with no blank row left there, while the compaction's own
// row spins and counts (`Automatic compaction · 4s`) with no loader beside
// it; the steers enter the transcript in the order sent under
// `Executing`, timed from the turn's start, the queued prompt still listed;
// once that turn ends the queued prompt enters too and the list is empty.
// Needs OPENCODE_DEV, a fork whose layout rule sees the row's message and
// which publishes the `session.composer.queued` slot (`prime-look`).
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-queued.test.ts: skipped. Set OPENCODE_DEV to the fork to run it.")

const root = join(import.meta.dir, "..")
const names = ["queued", "taken", "after"] as const
const frames = {} as Record<(typeof names)[number], ReadonlyArray<string>>

/** The hint line's index: the row right above the composer's rail, the frame's last run of ` ┃` rows. */
const hintAt = (frame: ReadonlyArray<string>) => {
  let at = frame.findLastIndex((line) => line.startsWith(" ┃"))
  while (at > 0 && frame[at - 1]?.startsWith(" ┃")) at--
  return at - 1
}
/** The rows above Prime's hint line (the transcript, then the queued rows), blank rows dropped. */
const above = (frame: ReadonlyArray<string>) => frame.slice(0, hintAt(frame)).filter((line) => line.trim() !== "")
const LOADER = (label: string) => new RegExp(`^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] ${label} · (\\d+)s$`)
const LATER = "  ◌ after the turn · Afterwards tag the release."

describe.skipIf(!fork)("prompts sent during a compaction wait above the composer as one list, in the Prime look (OPENCODE_DEV)", () => {
  const kept = keptScratch(Boolean(fork), "prime-queued-")
  beforeAll(...kept.setup(async () => {
    const out = kept.dir("prime-queued-")
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
  }, 300_000))

  test("while the compaction runs: no prompt in the transcript, one list of all three, and the compaction's one timed row", kept.test(() => {
    const shown = above(frames.queued)
    expect(shown.slice(-6)).toEqual([
      "  ● Ran true",
      "    │ (no output)",
      expect.stringMatching(LOADER("Automatic compaction")),
      "  ◌ queued · Also update the docs.",
      "  ◌ queued · Then bump the version.",
      LATER,
    ])
    // The compaction's row is the wait's only one: no loader row beside it.
    const row = frames.queued.findIndex((line) => LOADER("Automatic compaction").test(line))
    expect(Number(LOADER("Automatic compaction").exec(frames.queued[row] ?? "")?.[1])).toBeGreaterThanOrEqual(1)
    expect(frames.queued.join("\n")).not.toContain("Compacting")
    expect(frames.queued.join("\n")).not.toContain("Executing")
    // One blank row above the compaction, its own gap: the hidden prompts' rows add none.
    expect(frames.queued[row - 1]?.trim()).toBe("")
    expect(frames.queued[row - 2]).toBe("    │ (no output)")
    for (const prompt of ["Also update the docs.", "Then bump the version.", "Afterwards tag the release."])
      expect(shown.some((line) => line.includes(`┃ ${prompt}`))).toBe(false)
    // The host's own queued box is replaced, not drawn beside the list.
    expect(frames.queued.join("\n")).not.toMatch(/\d+ queued/)
  }))

  test("once the runner takes the steers: both in the transcript in order under `Executing` from the turn's start, the queued prompt still listed", kept.test(() => {
    const shown = above(frames.taken)
    const at = shown.indexOf(" ┃ Also update the docs.")
    expect(at).toBeGreaterThan(shown.findIndex((line) => line.includes("◇ Compacted automatically")))
    expect(shown.slice(at + 1)).toEqual([
      " ┃ Then bump the version.",
      "  Updating",
      expect.stringMatching(LOADER("Executing")),
      LATER,
    ])
    expect(frames.taken.join("\n")).not.toContain("◌ queued")
    expect(frames.taken.join("\n")).not.toMatch(/\d+ queued/)
    // The turn started before the nine-second compaction; the prompts that waited behind it do not restart the clock.
    const seconds = Number(LOADER("Executing").exec(shown.at(-2) ?? "")?.[1])
    expect(seconds).toBeGreaterThanOrEqual(5)
  }))

  test("once that turn ends: the queued prompt in the transcript after the steers, and the list empty", kept.test(() => {
    const shown = above(frames.after)
    const order = ["Also update the docs.", "Then bump the version.", "Afterwards tag the release."].map((prompt) =>
      shown.indexOf(` ┃ ${prompt}`),
    )
    expect(order.every((index) => index >= 0)).toBe(true)
    expect(order).toEqual(order.toSorted((a, b) => a - b))
    expect(shown.slice(order[2]! + 1)[0]).toBe("  Release tagged.")
    expect(frames.after.join("\n")).not.toContain("◌")
  }))
})
