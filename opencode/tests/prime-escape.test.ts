// Runs scenarios/prime-escape.ts with the Prime look against an OpenCode
// checkout and asserts what one Escape does on a busy session with an empty
// composer: at 1 s it cancels (the prompt leaves the transcript and is back in
// the composer), at 7 s it interrupts (the prompt and its partial answer stay).
// The Dock, which replaces the host's footer, shows no Escape hint. The
// escape plugin (cmd/escape), loaded beside Prime, does the cancelling; it
// needs OPENCODE_DEV, the fork.
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { hintRow } from "./composer.ts"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-escape.test.ts: skipped. Set OPENCODE_DEV to the fork to run it.")

const root = join(import.meta.dir, "..")
const names = ["cancel-hint", "cancelled", "interrupt-hint", "interrupted"] as const
const frames = {} as Record<(typeof names)[number], ReadonlyArray<string>>

/** The rows above the composer (the transcript, down to Prime's hint line; tests/composer.ts) and the composer's first row. */
function split(frame: ReadonlyArray<string>) {
  const hint = hintRow(frame)
  return { transcript: frame.slice(0, hint).filter((line) => line.trim() !== ""), composer: frame[hint + 1] ?? "" }
}
/** The Dock's top row: the tray, right above its rule (the activity counts under it show only while something is active). */
const dock = (frame: ReadonlyArray<string>) => {
  const rule = frame.findLastIndex((line) => /^ ─{20,}$/.test(line))
  return rule >= 1 ? (frame[rule - 1] ?? "") : ""
}

describe.skipIf(!fork)("Escape cancels within the grace and interrupts after it, in the Prime look (OPENCODE_DEV)", () => {
  const kept = keptScratch(Boolean(fork), "prime-escape-")
  beforeAll(...kept.setup(async () => {
    const out = kept.dir("prime-escape-")
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-escape.ts"], {
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

  test("just after sending, the Dock shows no Escape hint", kept.test(() => {
    // The Dock is drawn (its tray row is there), and its top row carries no hint.
    expect(dock(frames["cancel-hint"])).toMatch(/\S/)
    expect(dock(frames["cancel-hint"])).not.toContain("esc ")
  }))

  test("Escape at 1 s: the prompt leaves the transcript and is back in the composer", kept.test(() => {
    const { transcript, composer } = split(frames.cancelled)
    expect(transcript.join("\n")).not.toContain("Rename the helper.")
    expect(transcript.join("\n")).not.toContain("Working on it")
    expect(composer).toBe(" ┃ Rename the helper.")
    // An idle session with an empty Escape: no hint.
    expect(dock(frames.cancelled)).not.toContain("esc ")
  }))

  test("7 s after sending, the Dock still shows no Escape hint", kept.test(() => {
    expect(dock(frames["interrupt-hint"])).not.toContain("esc ")
  }))

  test("Escape at 7 s interrupts: the prompt and its partial answer stay", kept.test(() => {
    const { transcript, composer } = split(frames.interrupted)
    expect(transcript.slice(-3)).toEqual([" ┃ Rename the helper.", "  Working on it", "  ■ Interrupted"])
    expect(composer).toBe(" ┃")
  }))
})
