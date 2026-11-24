// accept: deep (24.8 s alone on a quiet host: 1-minute load 12.3–17.3 on 12 cores; it boots real OpenCode and drives its scenario through events that take that long)
// Runs scenarios/prime-subagents.ts with the Prime look against an OpenCode
// checkout and asserts on its frames: a session's running subagents open by
// keyboard and by mouse, each reads like the main session, and Up, Left and
// Right move between them; on a phone-sized terminal the dock keeps its count
// line and draws no rows. It needs OPENCODE_DEV, the fork with the plugin hook points.
import { readScratchFileSync } from "./read-path.ts"
import { beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Array as Arr, Option } from "effect"
import { DOCK_COUNT, dockRow, workingRow } from "../scenarios/prime-subagents-rows.ts"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"
import { hangGuard } from "./hang-guard.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-subagents.test.ts: skipped. Set OPENCODE_DEV to the prime-look fork to run it.")

const root = join(import.meta.dir, "..")
const names = ["started", "clicked", "returned", "picker", "child", "sibling", "parent", "dock", "phone", "restored"] as const
const frames: Record<(typeof names)[number], ReadonlyArray<string>> = {} as never

const WORKERS = [
  { title: "Fix money parsing", brief: "Worker brief A." },
  { title: "Fix CSV quoting", brief: "Worker brief B." },
  { title: "Fix month padding", brief: "Worker brief C." },
]
const PARENT = "three workers"
const DOWN = "↓ subagents"
const INSIDE = "↑ back to parent · ←/→ other subagents"

/** The worker whose session a frame shows, by its top bar. */
const shown = (frame: ReadonlyArray<string>) => WORKERS.find((worker) => frame[0]?.includes(`${PARENT} › ${worker.title}`))
/** Prime's hint line, trimmed: the row above the composer's rail (the frame's last run of ` ┃` rows). */
const hint = (frame: ReadonlyArray<string>) => {
  let at = frame.findLastIndex((line) => line.startsWith(" ┃"))
  while (at > 0 && /^ ┃/.test(frame[at - 1] ?? "")) at--
  return frame[at - 1]?.trim()
}
/** The dock's first line, trimmed: the row right under the composer's rail. */
const under = (frame: ReadonlyArray<string>) => frame[frame.findLastIndex((line) => line.startsWith(" ┃")) + 1]?.trim()
/** The composer's last rail row. */
const railEnd = (frame: ReadonlyArray<string>) => frame.findLastIndex((line) => line.startsWith(" ┃"))

/** In the main session the way down sits under the composer, the model at the line's right, and the line above it holds no hint. */
function expectDownUnder(frame: ReadonlyArray<string>) {
  expect(under(frame)).toMatch(/^↓ subagents +gpt-sim-model$/)
  expect(hint(frame) ?? "").not.toContain(DOWN)
}

/** A subagent's frame reads like the main session's: its brief, its own steps, its loader, the way back. */
function expectSubagent(frame: ReadonlyArray<string>, worker: (typeof WORKERS)[number]) {
  const text = frame.join("\n")
  expect(text).toContain("You are a subagent spawned by another session.")
  expect(text).toContain(worker.brief)
  // Its thought is the first node of its step's tree, as in the main session.
  expect(text).toContain(`  ● Thought\n  └ thinking  Check ${worker.title.toLowerCase()} first.`)
  expect(text).toContain(`Looking at ${worker.title.toLowerCase()}.`)
  expect(text).toContain(`● Ran printf '${worker.brief}\\n'`)
  expect(text).toMatch(/Executing · \d+s/)
  expect(text).toContain("agent general")
  // The way back sits where the main session's way down does: under the composer, on the dock's first line.
  expect(under(frame)).toStartWith(INSIDE)
  expect(hint(frame) ?? "").not.toContain("back to parent")
}

describe.skipIf(!fork)("moving between subagents in the Prime look (OPENCODE_DEV)", () => {
  const kept = keptScratch(Boolean(fork), "prime-subagents-")
  beforeAll(kept.test(async () => {
    const out = kept.dir("prime-subagents-")
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-subagents.ts"], {
      cwd: root,
      env: { ...process.env, SCENARIO_OUT: out, SCENARIO_LABEL: "subagents", OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ])
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    for (const name of names) frames[name] = readScratchFileSync(join(out, `subagents-${name}.txt`), "utf8").split("\n")
  }), hangGuard("acceptance"))

  test("while subagents run, the main session says Down reaches them, under the composer", kept.test(() => {
    expect(frames.started[0]).not.toContain("›")
    expectDownUnder(frames.started)
    expect(frames.started.join("\n")).toContain(DOCK_COUNT)
  }))

  test("beneath the dock, each running subagent has a live row in the order they started", kept.test(() => {
    const dock = frames.started.findIndex((line) => line.includes(DOCK_COUNT))
    const rows = frames.started.slice(dock + 1, dock + 4).map((line) => line.trim())
    WORKERS.forEach((worker, index) => expect(rows[index]).toMatch(dockRow(worker.title)))
  }))

  test("inside a subagent the rows sit under the composer, on the main session's rows, and mark the one shown", kept.test(() => {
    const rowsAt = (frame: ReadonlyArray<string>) =>
      Arr.getSomes(frame.map((line, y) => Option.liftPredicate(y, (at: number) => at > railEnd(frame) && /^ (›| )? ?\S general gpt  /.test(line))))
    for (const frame of [frames.clicked, frames.child, frames.sibling]) {
      const worker = shown(frame)
      expect(railEnd(frame)).toBe(railEnd(frames.started))
      expect(rowsAt(frame)).toEqual(rowsAt(frames.started))
      const rows = frame.filter((line, y) => y > railEnd(frame) && /^ (›| ) \S general gpt  /.test(line))
      expect(rows).toHaveLength(WORKERS.length)
      expect(rows.filter((line) => line.startsWith(" › "))).toEqual([expect.stringContaining(`general gpt  ${worker?.title ?? "?"}`)])
    }
  }))

  test("a click on a subagent's Started row opens that subagent", kept.test(() => {
    expect(shown(frames.clicked)?.title).toBe("Fix money parsing")
    expectSubagent(frames.clicked, WORKERS[0]!)
  }))

  test("Up in a subagent returns to the main session", kept.test(() => {
    for (const frame of [frames.returned, frames.parent]) {
      expect(frame[0]).not.toContain("›")
      expect(frame).toContain("  ● Started 3 agents")
      expectDownUnder(frame)
    }
  }))

  test("Down on the empty prompt opens the Subagents picker, listing the running workers", kept.test(() => {
    const text = frames.picker.join("\n")
    expect(text).toContain("Subagents")
    for (const worker of WORKERS) expect(text).toMatch(workingRow(worker.title))
  }))

  test("Enter in the picker opens a subagent, with its brief and its loader", kept.test(() => {
    const worker = shown(frames.child)
    expect(worker).toBeDefined()
    if (worker) expectSubagent(frames.child, worker)
  }))

  test("Right in a subagent moves to the next running one, in the order they started", kept.test(() => {
    const from = shown(frames.child)
    const to = shown(frames.sibling)
    expect(from).toBeDefined()
    expect(to).toBeDefined()
    if (!from || !to) return
    expect(WORKERS.indexOf(to)).toBe((WORKERS.indexOf(from) + 1) % WORKERS.length)
    expectSubagent(frames.sibling, to)
  }))

  test("a click on the dock's subagent count opens the Subagents picker", kept.test(() => {
    const text = frames.dock.join("\n")
    expect(frames.dock[0]).not.toContain("›")
    for (const worker of WORKERS) expect(text).toMatch(workingRow(worker.title))
  }))

  test("on a phone-sized terminal the count line stays and no row is drawn under it; resized back, the rows return", kept.test(() => {
    const dock = frames.phone.findIndex((line) => line.includes(DOCK_COUNT))
    expect(dock).toBeGreaterThan(-1)
    for (const line of frames.phone) expect(line.trim()).not.toMatch(/^[◇◈◆] general gpt  /)
    for (const worker of WORKERS) expect(frames.phone.join("\n")).not.toContain(`general gpt  ${worker.title.slice(0, 8)}`)
    // The normal size is unchanged: the rows under the count, in the order the workers started.
    const back = frames.restored.findIndex((line) => line.includes(DOCK_COUNT))
    const rows = frames.restored.slice(back + 1, back + 4).map((line) => line.trim())
    WORKERS.forEach((worker, index) => expect(rows[index]).toMatch(dockRow(worker.title)))
  }))
})
