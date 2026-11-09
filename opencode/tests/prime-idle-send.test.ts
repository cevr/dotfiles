// Runs scenarios/prime-idle-send.ts with the Prime look against an OpenCode
// checkout and asserts, frame by frame, that a prompt sent to an idle session
// never shows as a queued row: it enters the transcript as the reader's
// message, both for a new session's first prompt and for a prompt sent after
// a turn ended. While a turn runs, a steer and a prompt sent to the queue
// still show as rows, and when the runner takes them each moves from its row
// to the transcript without a frame that shows it in both.
// Needs OPENCODE_DEV, a fork whose layout rule sees the row's message and
// which publishes the `session.composer.queued` slot (`prime-look`).
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-idle-send.test.ts: skipped. Set OPENCODE_DEV to the fork to run it.")

const root = join(import.meta.dir, "..")
const FIRST = "Check the build."
const SECOND = "Now run the linter."
const STEER = "Also update the docs."
const LATER = "Afterwards tag the release."
const ROW = /◌ (queued|after the turn) · /
const names = ["first", "second", "busy"] as const
const frames = {} as Record<(typeof names)[number], ReadonlyArray<string>>

/** The rows above Prime's mode hint: the transcript, then the queued rows (the composer, with its own `┃` rail, is below). */
const above = (frame: string) => {
  const lines = frame.split("\n")
  const hint = lines.findIndex((line) => /mode \(Ctrl\+O/.test(line))
  return hint < 0 ? lines : lines.slice(0, hint)
}

/** Whether the frame shows the prompt as a queued row, and as the reader's message in the transcript. */
const where = (frame: string, prompt: string) => {
  const lines = above(frame)
  return {
    row: lines.some((line) => ROW.test(line) && line.includes(prompt)),
    transcript: lines.some((line) => line === ` ┃ ${prompt}`),
  }
}

/** The queued rows a frame shows, for a readable failure. */
const rows = (frame: string) => frame.split("\n").filter((line) => ROW.test(line))

describe.skipIf(!fork)("a prompt sent to an idle session is no queued prompt, in the Prime look (OPENCODE_DEV)", () => {
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "prime-idle-send-"))
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-idle-send.ts"], {
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
    for (const name of names) frames[name] = JSON.parse(readFileSync(join(out, `${name}.json`), "utf8"))
  }, 300_000)

  test.each([
    ["first", FIRST],
    ["second", SECOND],
  ] as const)("the %s prompt: no queued row in any frame, and in the transcript from its first frame on", (name, prompt) => {
    const shown = frames[name]
    expect(shown.length).toBeGreaterThan(1)
    expect(shown.flatMap(rows)).toEqual([])
    const at = shown.findIndex((frame) => where(frame, prompt).transcript)
    expect(at).toBeGreaterThanOrEqual(0)
    // Once it shows, it stays: no frame after drops it.
    expect(shown.slice(at).every((frame) => where(frame, prompt).transcript)).toBe(true)
  })

  test("while a turn runs a steer and a queued prompt show as rows, and each moves to the transcript without a frame in both", () => {
    const shown = frames.busy
    for (const prompt of [STEER, LATER]) {
      const states = shown.map((frame) => where(frame, prompt))
      expect(states.some((state) => state.row)).toBe(true)
      expect(states.filter((state) => state.row && state.transcript)).toEqual([])
      const first = states.findIndex((state) => state.row)
      const entered = states.findIndex((state) => state.transcript)
      expect(entered).toBeGreaterThan(first)
      expect(states.slice(entered).every((state) => state.transcript && !state.row)).toBe(true)
    }
    expect(shown.at(-1)).not.toMatch(ROW)
  })
})
