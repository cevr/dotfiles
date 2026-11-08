// Runs scenarios/escape-states.ts once per case with the Prime look and the
// escape plugin against an OpenCode checkout, and asserts that one Escape on a
// busy session stops its run in every state, never drops the prompt the user
// sent while it ran, and says so when the server does not answer. Needs
// OPENCODE_DEV, the fork.
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/escape-states.test.ts: skipped. Set OPENCODE_DEV to the fork to run it.")

const root = join(import.meta.dir, "..")
const cases = ["steer", "queue", "tool", "draft", "offline"] as const
let out = ""
const frame = (name: string) => readFileSync(join(out, `${name}.txt`), "utf8")

/** The rows above the composer (the transcript, down to Prime's mode hint) and the composer's first row. */
function split(name: string) {
  const lines = frame(name).split("\n")
  const hint = lines.findIndex((line) => /mode \(Ctrl\+O/.test(line))
  return { transcript: lines.slice(0, hint).filter((line) => line.trim() !== ""), composer: lines[hint + 1] ?? "" }
}

describe.skipIf(!fork)("one Escape stops a busy session in every state (OPENCODE_DEV)", () => {
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "escape-states-"))
    for (const which of cases) {
      const run = owned(["bunx", "opencode-drive", "run", "scenarios/escape-states.ts"], {
        cwd: root,
        env: { ...process.env, CASE: which, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
      if (code !== 0) throw new Error(`the ${which} case exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    }
  }, 400_000)

  for (const which of ["steer", "queue"] as const)
    test(`a ${which === "steer" ? "steer" : "queued prompt"} sent while the model works: one Escape stops the run and puts the prompt back in the composer`, () => {
      expect(split(`${which}-before`).transcript.join("\n")).toContain("Executing")
      const { transcript, composer } = split(`${which}-after`)
      expect(transcript.slice(-3)).toEqual([" ┃ Rename the helper.", "  Working on it", "  ■ Interrupted"])
      expect(composer).toBe(" ┃ Also update the docs.")
      // The second Escape finds an idle session; the prompt stays in the composer.
      expect(split(`${which}-again`).composer).toBe(" ┃ Also update the docs.")
    })

  test("a running shell call: one Escape cancels it and interrupts", () => {
    expect(readFileSync(join(out, "tool-tool.txt"), "utf8")).toBe("interrupted")
    expect(split("tool-after").transcript.slice(-2)).toEqual(["  ● Ran sleep 60 · cancelled", "  ■ Interrupted"])
  })

  test("a draft in the composer: one Escape interrupts and the draft stays", () => {
    const { transcript, composer } = split("draft-after")
    expect(transcript.at(-1)).toBe("  ■ Interrupted")
    expect(composer).toBe(" ┃ half a thought")
  })

  test("the server does not answer: the TUI says so instead of doing nothing", () => {
    expect(frame("offline-before")).not.toContain("Still running")
    expect(frame("offline-after").replace(/\s*┃\s*/g, " ")).toContain("Still running 5 s after Escape: the server has not")
  })
})
