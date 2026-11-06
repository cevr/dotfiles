// Runs scenarios/prime-escape.ts with the Prime look against an OpenCode
// checkout and asserts what one Escape does on a busy session with an empty
// composer: at 1 s it cancels (the prompt leaves the transcript and is back in
// the composer), at 7 s it interrupts (the prompt and its partial answer stay).
// The Dock, which replaces the host's footer, says which. It needs
// OPENCODE_DEV, a fork whose Escape cancels within `escape_cancel_grace` and
// whose footer input carries `escape`.
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-escape.test.ts: skipped. Set OPENCODE_DEV to the fork with Escape-to-cancel to run it.")

const root = join(import.meta.dir, "..")
const names = ["cancel-hint", "cancelled", "interrupt-hint", "interrupted"] as const
const frames = {} as Record<(typeof names)[number], ReadonlyArray<string>>

/** The rows above the composer (the transcript, down to Prime's mode hint) and the composer's first row. */
function split(frame: ReadonlyArray<string>) {
  const hint = frame.findIndex((line) => /mode \(Ctrl\+O/.test(line))
  return { transcript: frame.slice(0, hint).filter((line) => line.trim() !== ""), composer: frame[hint + 1] ?? "" }
}
/** The Dock's top row. */
const dock = (frame: ReadonlyArray<string>) => frame.find((line) => line.includes("← manage")) ?? ""

describe.skipIf(!fork)("Escape cancels within the grace and interrupts after it, in the Prime look (OPENCODE_DEV)", () => {
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "prime-escape-"))
    const run = Bun.spawn(["bunx", "opencode-drive", "run", "scenarios/prime-escape.ts"], {
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

  test("just after sending, the Dock offers the cancel and counts it down", () => {
    expect(dock(frames["cancel-hint"])).toMatch(/^ ← manage {2}· {2}esc cancel and edit · [45]s /)
  })

  test("Escape at 1 s: the prompt leaves the transcript and is back in the composer", () => {
    const { transcript, composer } = split(frames.cancelled)
    expect(transcript.join("\n")).not.toContain("Rename the helper.")
    expect(transcript.join("\n")).not.toContain("Working on it")
    expect(composer).toBe(" ┃ Rename the helper.")
    // An idle session with an empty Escape: no hint.
    expect(dock(frames.cancelled)).not.toContain("esc ")
  })

  test("7 s after sending, the Dock offers the interrupt", () => {
    expect(dock(frames["interrupt-hint"])).toMatch(/^ ← manage {2}· {2}esc interrupt /)
  })

  test("Escape at 7 s interrupts: the prompt and its partial answer stay", () => {
    const { transcript, composer } = split(frames.interrupted)
    expect(transcript.slice(-3)).toEqual([" ┃ Rename the helper.", "  Working on it", "  ■ Interrupted"])
    expect(composer).toBe(" ┃")
  })
})
