// accept: one at a time (its scenario drives a real TUI and waits on its frames under a deadline).
// Public UI seam: real OpenCode with the Prime look and the queue plugin, the
// sidebar hidden, a scripted model that keeps the queue through the `queue`
// tool and answers in one line (scenarios/queue-panel.ts). The queue shows
// where the owner looks and nowhere in the transcript: the dock under the
// composer counts it (`4 queued, 1 needs you`), `/queue` opens the composer
// panel's Queue tab with the plan (each item with its state, a unit's
// outcomes, the verifier after it nested under it), Escape puts it away, and a
// click on the dock's count opens it again.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { REPLY } from "../scenarios/queue-panel.ts"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

/** The Queue tab's lines, in order. */
const PLAN = [
  "! Close old Claude panes · needs you",
  "● Money parsing r1 · running",
  "  on accepted ⇥ ○ Verify money parsing",
  "  on changes  ⇥ fix round 2",
  "│ ○ Verify money parsing · next",
  "│   on accepted ⇥ land + install",
  "○ Merge workers, run daily · next",
] as const

/** Every item's text: none is in the transcript. */
const TEXTS = ["Close old Claude panes", "Money parsing r1", "Verify money parsing", "Merge workers, run daily", "land + install"] as const

/** A frame's lines above the dock's rule: the transcript and the composer. */
const above = (frame: string) => frame.split("\n").slice(0, frame.split("\n").findIndex((line) => line.includes("────")))

/** The panel's lines, without its left bar. */
const panel = (frame: string) =>
  frame
    .split("\n")
    .filter((line) => line.startsWith(" ┃  "))
    .map((line) => line.slice(" ┃  ".length).trimEnd())

const ROOT = fileURLToPath(new URL("..", import.meta.url))

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/queue-panel.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("the Queue tab", () => {
  const kept = keptScratch(Boolean(fork), "queue-panel-")
  test("the dock counts the queue, /queue and a click on the count open the plan, and the transcript holds none of it", kept.test(async () => {
    const out = kept.dir("queue-panel-")
    const child = owned(["bunx", "opencode-drive", "run", "scenarios/queue-panel.ts"], {
      cwd: ROOT,
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = await new Response(child.stdout).text()
    const errors = await new Response(child.stderr).text()
    const code = await child.exited
    const timeouts = readdirSync(out)
      .filter((name) => name.endsWith(".timeout.txt"))
      .map((name) => readFileSync(join(out, name), "utf8"))
    expect(code, `${output}${errors}`.slice(-5000) + timeouts.join("\n")).toBe(0)
    const frame = (name: string) => readFileSync(join(out, `queue-panel-${name}.txt`), "utf8")

    const bar = frame("bar")
    expect(bar).toContain(REPLY)
    expect(bar).toMatch(/^ ◆ 0 subagents {2}· {2}0 shells {2}· {2}4 queued, 1 needs you$/m)
    for (const text of TEXTS) expect({ text, shown: above(bar).some((line) => line.includes(text)) }).toEqual({ text, shown: false })

    const tab = frame("tab")
    const lines = panel(tab)
    expect(lines.find((line) => line.startsWith("Subagents"))).toMatch(/· {2}Queue 4 +esc$/)
    const first = lines.indexOf(PLAN[0])
    expect(lines.slice(first, first + PLAN.length)).toEqual([...PLAN])
    expect(lines).toContain("Enter open · ←/→ tabs")
    // The transcript above the panel holds none of the queue.
    const transcript = tab.split("\n").slice(0, tab.split("\n").findIndex((line) => line.startsWith(" ┃  Subagents")))
    for (const text of TEXTS) expect({ text, shown: transcript.some((line) => line.includes(text)) }).toEqual({ text, shown: false })

    expect(frame("closed")).not.toContain("on accepted ⇥")
    expect(panel(frame("clicked"))).toContain(PLAN[2])
  }), 150_000)
})
