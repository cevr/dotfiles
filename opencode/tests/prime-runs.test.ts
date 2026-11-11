// Runs scenarios/prime-runs.ts with the Prime look against an OpenCode checkout
// and asserts where a run of calls breaks: each model step is a group of its
// own, so a step's parallel calls share one header, the next step opens its
// own line even with nothing drawn between, and the assistant's text or a
// message the reader sent while the turn ran ends a group too; a long command
// running is the newest row. It needs OPENCODE_DEV, the fork
// with the plugin hook points.
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-runs.test.ts: skipped. Set OPENCODE_DEV to the prime-look fork to run it.")

const root = join(import.meta.dir, "..")
const names = ["running", "details", "all", "overview"] as const
const frames: Record<(typeof names)[number], ReadonlyArray<string>> = { running: [], details: [], all: [], overview: [] }
const files = { running: "runs-running", details: "runs", all: "runs-all", overview: "runs-overview" }

/** The hint line's index: the row right above the composer's rail, the frame's last run of ` ┃` rows. */
function hintAt(frame: ReadonlyArray<string>) {
  let at = frame.findLastIndex((line) => line.startsWith(" ┃"))
  while (at > 0 && frame[at - 1]?.startsWith(" ┃")) at--
  return at - 1
}

/** The frame's transcript from the prompt on, up to Prime's hint line, with the blank rows dropped. */
function transcript(frame: ReadonlyArray<string>): ReadonlyArray<string> {
  const start = frame.findIndex((line) => line.includes("┃ Check the build"))
  const end = hintAt(frame)
  return frame.slice(start, end > start ? end : undefined).filter((line) => line.trim() !== "")
}

/** A row's exact line; `<t>` stands for a duration such as `12ms` or `6.0s`. */
const row = (line: string) =>
  new RegExp(
    `^${line
      .split("<t>")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("(?:\\d+m )?\\d+(?:\\.\\d+)?m?s")}$`,
  )

describe.skipIf(!fork)("a message between two calls starts a new group in the Prime look (OPENCODE_DEV)", () => {
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "prime-runs-"))
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-runs.ts"], {
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

  test("while it runs, the long command after the text is its own row, the newest in the transcript", () => {
    const shown = transcript(frames.running)
    const at = shown.findIndex((line) => line.includes("Running sleep 6"))
    expect(shown[at]).toMatch(/^ {2}[○●] Running sleep 6; printf 'suite ok\\n'$/)
    expect(shown[at - 1]).toBe("  Both builds pass. Running the long suite.")
    // No tree connector: it hangs under no earlier group, and only the loader follows it.
    expect(shown.slice(at + 1).every((line) => /Executing/.test(line))).toBe(true)
    expect(frames.running.join("\n")).not.toMatch(/[├└] Running sleep 6/)
  })

  test("Details: a step's two parallel calls share a group; the next step, the text and the reader's message each start one", () => {
    expect(transcript(frames.details)).toEqual([
      " ┃ Check the build, then run the long suite.",
      "  ● Ran printf 'build a ok\\n', printf 'build b ok\\n'",
      "    │ build b ok",
      "  ● Ran printf 'lint ok\\n'",
      "    │ lint ok",
      "  Both builds pass. Running the long suite.",
      "  ● Ran sleep 6; printf 'suite ok\\n'",
      "    │ suite ok",
      " ┃ Also read the notes file.",
      "  ● Read notes.md",
      "  Suite passed; the notes say ship it.",
    ])
  })

  test("All: the first group keeps its header and tree; each call after a message is the group's line alone", () => {
    const shown = transcript(frames.all)
    const lines = [
      "  ● Ran 2 commands",
      "  ├ ✓ shell · printf 'build a ok\\n' · ↑ 1 ↓ 1 lines · <t>",
      "  └ ✓ shell · printf 'build b ok\\n' · ↑ 1 ↓ 1 lines · <t>",
      "  ✓ shell · printf 'lint ok\\n' · ↑ 1 ↓ 1 lines · <t>",
      "  Both builds pass. Running the long suite.",
      "  ✓ shell · sleep 6; printf 'suite ok\\n' · ↑ 1 ↓ 1 lines · <t>",
      " ┃ Also read the notes file.",
      "  ✓ read · notes.md · ↑ 1 ↓ 2 lines · <t>",
    ]
    const at = lines.map((line) => shown.findIndex((item) => row(line).test(item)))
    expect(at.every((index) => index >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
  })

  test("Overview: a header per group, between the messages that end them", () => {
    expect(transcript(frames.overview)).toEqual([
      " ┃ Check the build, then run the long suite.",
      "  ● Ran 2 commands",
      "  ● Ran 1 command",
      "  Both builds pass. Running the long suite.",
      "  ● Ran 1 command",
      " ┃ Also read the notes file.",
      "  ● Read 1 file",
      "  Suite passed; the notes say ship it.",
    ])
  })
})
