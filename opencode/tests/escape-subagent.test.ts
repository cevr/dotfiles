// Runs scenarios/escape-subagent.ts with the Prime look and the escape plugin
// against an OpenCode checkout, and asserts that Escape is layered in a running
// subagent's view: the first press only puts its Subagents picker away (the
// subagent keeps running, the prompt has the keyboard), a message sent from
// that prompt is the subagent's, and the next press, nothing open, interrupts
// the subagent as on any session. Needs OPENCODE_DEV, the fork.
import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/escape-subagent.test.ts: skipped. Set OPENCODE_DEV to the fork to run it.")

const root = join(import.meta.dir, "..")
let out = ""
const frame = (name: string) => readFileSync(join(out, `${name}.txt`), "utf8")
/** The picker's header row: the host's composer panel, its Subagents tab first. */
const picker = (name: string) => frame(name).split("\n").some((line) => /^\s*┃\s+Subagents(\s|$)/.test(line))
/** The composer's first row: the first bar row under Prime's mode hint (the dock's session row sits between). */
const composer = (name: string) => {
  const lines = frame(name).split("\n")
  const hint = lines.findIndex((line) => /mode \(Ctrl\+O/.test(line))
  return lines.slice(hint + 1).find((line) => line.startsWith(" ┃")) ?? ""
}

describe.skipIf(!fork)("Escape in a subagent's view closes its picker first and interrupts only with nothing open (OPENCODE_DEV)", () => {
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "escape-subagent-"))
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/escape-subagent.ts"], {
      cwd: root,
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
  }, 300_000)

  test("the subagent's view opens on its picker", () => {
    expect(picker("picker")).toBe(true)
    expect(frame("picker")).toContain("Reading the parser")
  })

  test("the first Escape puts the picker away, the subagent still running, and the prompt takes what is typed", () => {
    expect(picker("dismissed")).toBe(false)
    expect(frame("dismissed")).toContain("Reading the parser")
    expect(frame("dismissed")).not.toContain("Interrupted")
    expect(composer("typed")).toContain("Check the cents rounding too.")
  })

  test("a message sent from the subagent's prompt waits for it, the subagent still running", () => {
    expect(frame("steered")).not.toContain("Interrupted")
    expect(composer("steered")).not.toContain("Check the cents rounding too.")
  })

  test("the next Escape, nothing open, interrupts the subagent; its resume delivers the message to it", () => {
    expect(picker("interrupted")).toBe(false)
    expect(frame("interrupted")).toContain("Interrupted")
    expect(frame("answered")).toContain("Cents rounding checked.")
    // The message went as the subagent's own agent: sending it did not switch the subagent to a primary agent.
    expect(frame("answered")).not.toContain("Switched agent")
    expect(readFileSync(join(out, "requests.txt"), "utf8").trim().split("\n")).toEqual(["brief", "steer"])
  })
})
