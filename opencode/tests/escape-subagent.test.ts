// Runs scenarios/escape-subagent.ts with the Prime look and the escape plugin
// against an OpenCode checkout, and asserts that Escape is layered in a running
// subagent's view: the first press only puts its Subagents picker away (the
// subagent keeps running, the prompt has the keyboard), a message sent from
// that prompt is the subagent's, and the next press, nothing open, goes back
// to the parent's view and never interrupts the subagent: its turn runs to its
// end and the message reaches it then, the parent on screen. Ctrl+Enter in the
// subagent's view is what interrupts it, and sends at once. Needs OPENCODE_DEV,
// the fork.
import { beforeAll, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { composerRow } from "./composer.ts"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/escape-subagent.test.ts: skipped. Set OPENCODE_DEV to the fork to run it.")

const root = join(import.meta.dir, "..")
/** The scenario's text files (frames, requests), by name, read before its scratch directory goes. */
const saved = new Map<string, string>()
const frame = (name: string) => `${saved.get(`${name}.txt`)}`
/** The picker's header row: the host's composer panel, its Subagents tab first. */
const picker = (name: string) => frame(name).split("\n").some((line) => /^\s*┃\s+Subagents(\s|$)/.test(line))
/** The composer's first row (tests/composer.ts; the dock's session row sits above it). */
const composer = (name: string) => {
  const lines = frame(name).split("\n")
  return lines[composerRow(lines)] ?? ""
}
const requests = () => frame("requests").trim().split("\n")
/** The parent's own prompt, which only its view shows. */
const ASK = "Fix the money parsing in a worker."

describe.skipIf(!fork)("Escape in a subagent's view closes its picker first, then goes back to the parent, never interrupting (OPENCODE_DEV)", () => {
  const kept = keptScratch(Boolean(fork), "escape-subagent-")
  beforeAll(...kept.setup(async () => {
    const out = kept.dir("escape-subagent-")
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/escape-subagent.ts"], {
      cwd: root,
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    for (const name of readdirSync(out)) if (name.endsWith(".txt")) saved.set(name, readFileSync(join(out, name), "utf8"))
  }, 300_000))

  test("the subagent's view opens on its picker", kept.test(() => {
    expect(picker("picker")).toBe(true)
    expect(frame("picker")).toContain("Reading the parser")
  }))

  test("the first Escape puts the picker away, the subagent still running, and the prompt takes what is typed", kept.test(() => {
    expect(picker("dismissed")).toBe(false)
    expect(frame("dismissed")).toContain("Reading the parser")
    expect(frame("dismissed")).not.toContain("Interrupted")
    expect(composer("typed")).toContain("Check the cents rounding too.")
  }))

  test("a message sent from the subagent's prompt waits for it, the subagent still running", kept.test(() => {
    expect(frame("steered")).not.toContain("Interrupted")
    expect(composer("steered")).not.toContain("Check the cents rounding too.")
  }))

  test("the next Escape, nothing open, shows the parent's view, the subagent still running", kept.test(() => {
    expect(frame("parent")).toContain(ASK)
    expect(frame("parent")).toContain("The worker is on it.")
    // A subagent's view says ↑ goes back to its parent; the parent's does not.
    expect(frame("parent")).not.toContain("back to parent")
    expect(picker("parent")).toBe(false)
    // The dock counts the subagent and its row still works on its first answer.
    expect(frame("parent")).toContain("1 subagent")
    expect(frame("parent")).toMatch(/general gpt\s+Fix money parsing\s+Reading the parser/)
  }))

  test("the message reaches the subagent once its turn ends, the parent still on screen", kept.test(() => {
    expect(frame("parent-steered")).toContain(ASK)
    expect(frame("parent-steered")).not.toContain("back to parent")
    // The parent's dock row already shows the subagent answering the message.
    expect(frame("parent-steered")).toMatch(/general gpt\s+Fix money parsing\s+Cents rounding checked/)
    expect(requests().slice(0, 2)).toEqual(["brief", "steer"])
  }))

  test("the subagent was never interrupted: its first answer ran to its end, then it took the message and answered it", kept.test(() => {
    const back = frame("back")
    expect(back).toContain("Reading the parser and done.")
    expect(back.indexOf("Check the cents rounding too.")).toBeGreaterThan(back.indexOf("Reading the parser and done."))
    expect(back).toContain("Cents rounding checked")
    expect(back).not.toContain("Interrupted")
  }))

  test("Ctrl+Enter in the subagent's view interrupts it and sends the draft at once", kept.test(() => {
    expect(composer("drafted")).toContain("Stop and ship the fix now.")
    expect(frame("sent")).toContain("Interrupted")
    // The answer to the steer stalled: the interrupt cut it before its end.
    expect(frame("answered")).not.toContain("Cents rounding checked and done.")
    expect(frame("answered")).toContain("Shipped the fix.")
    // The messages went as the subagent's own agent: sending them did not switch the subagent to a primary agent.
    expect(frame("answered")).not.toContain("Switched agent")
    expect(requests()).toEqual(["brief", "steer", "now"])
  }))
})
