// Public UI seam: real OpenCode, the real queue plugin (and the real kernel),
// a scripted model that starts two background subagents, keeps the queue
// through the `queue` tool directly or from a kernel cell, and later marks an
// item done. The sidebar's Queue section is read off the frame: only the
// queue's items, one line each; the subagents are Prime's rows beneath the
// composer, shown with the sidebar open.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** The rows the sidebar shows after the set, in its order: grouped, the linked item running, no row for the unnamed worker. */
const SET_ROWS = [
  "! Close old Claude panes",
  "● Money parsing worker",
  "… manna brainstorm · wC:p6",
  /◷ [A-Z][a-z]{2} \d{1,2} 09:30 pool-token check/,
  "○ Merge workers, run daily",
  "✓ Missing-folder fix",
] as const

/** The sidebar's column of a frame: every line from where its `Queue` heading starts. */
const sidebar = (frame: string): ReadonlyArray<string> => {
  const lines = frame.split("\n")
  const heading = lines.find((line) => / {2}Queue$/.test(line))
  const column = heading === undefined ? -1 : heading.lastIndexOf("Queue")
  return column < 0 ? [] : lines.map((line) => line.slice(column).trimEnd())
}

/** The line under the sidebar's `row`. */
const under = (column: ReadonlyArray<string>, row: string) => column[column.indexOf(row) + 1]

const position = (frame: string, row: string | RegExp) => (typeof row === "string" ? frame.indexOf(row) : (row.exec(frame)?.index ?? -1))

interface Message {
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly name?: string }> | string
}

/** The tool parts of the root sessions' messages, by name. */
const toolNames = (transcript: ReadonlyArray<ReadonlyArray<Message>>): ReadonlyArray<string> =>
  transcript.flat().flatMap((message) =>
    Array.isArray(message.content) ? message.content.flatMap((part) => (part.type === "tool" && part.name !== undefined ? [part.name] : [])) : [],
  )

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/queue.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("the Queue section of the sidebar", () => {
  for (const via of ["direct", "kernel"] as const)
    test(`shows the queue kept ${via === "direct" ? "through the queue tool" : "from a kernel cell"}, a linked item's live state, and follows a patch`, async () => {
      const out = mkdtempSync(join(tmpdir(), `queue-${via}-`))
      const child = Bun.spawn(["bunx", "opencode-drive", "run", "scenarios/queue.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, SCENARIO_OUT: out, QUEUE_VIA: via, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      const timeout = join(out, `queue-${via}-timeout.txt`)
      if (code !== 0) throw new Error(`queue scenario (${via}) exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(timeout) ? readFileSync(timeout, "utf8") : ""}`)

      const set = readFileSync(join(out, `queue-${via}-set.txt`), "utf8")
      expect(set).toContain("Queue")
      const positions = SET_ROWS.map((row) => position(set, row))
      for (const [index, at] of positions.entries()) expect({ row: String(SET_ROWS[index]), at: at >= 0 }).toEqual({ row: String(SET_ROWS[index]), at: true })
      expect(positions).toEqual(positions.toSorted((left, right) => left - right))
      // Linked to a running subagent, the item shows running, not the `next` it was written with.
      expect(set).not.toContain("○ Money parsing worker")
      // The sidebar is the queue's items only: no row for the worker no item names, no role or update line under the linked one.
      const column = sidebar(set)
      expect(column).toContain("● Money parsing worker")
      expect(under(column, "● Money parsing worker")).toBe("… manna brainstorm · wC:p6")
      expect(column.some((line) => line.includes("Forgotten worker"))).toBe(false)
      expect(column.every((line) => [...line].length <= 37)).toBe(true)
      // Both subagents are Prime's rows beneath the composer, with the sidebar open.
      expect(set).toMatch(/^ ◆ implementor +Fix money parsing /m)
      expect(set).toMatch(/^ ◆ worker +Forgotten worker /m)

      const patched = readFileSync(join(out, `queue-${via}-patched.txt`), "utf8")
      expect(patched).toContain("✓ Close old Claude panes")
      expect(patched).not.toContain("! Close old Claude panes")
      expect(position(patched, "✓ Close old Claude panes")).toBeLessThan(position(patched, "✓ Missing-folder fix"))
      expect(patched).toContain("● Money parsing worker")
      expect(under(sidebar(patched), "● Money parsing worker")).toBe("… manna brainstorm · wC:p6")

      // A call from a kernel cell leaves no queue tool part: only the cell's.
      const tools = toolNames(JSON.parse(readFileSync(join(out, `queue-${via}-transcript.json`), "utf8")))
      if (via === "kernel") {
        expect(tools).not.toContain("queue")
        expect(tools).toContain("kernel")
      } else expect(tools.filter((name) => name === "queue")).toHaveLength(2)
      console.log(`Queue (${via}) artifacts: ${out}`)
    }, 150_000)
})
