// accept: deep (36.0 s alone on a quiet host: 1-minute load 5.5–6.2 on 12 cores; it boots real OpenCode and drives its scenario through events that take that long)
// Real OpenCode with the Prime look and the real cache mod (cmd/cache), a
// scripted model priced like Sonnet whose cache lives 2s: scenarios/cache.ts
// runs one turn whose 4s shell call outlives the cache, so the second request
// writes back the 48k prefix the first one cached. The turn ends on a row that
// names the miss, its cost and its cause, the sidebar sums the session and
// names the cause that cost the most, and the server half's ledger holds a
// line per request, the second judged expired.
// Run again with the model's cache living an hour and the build agent asking
// for 2s of its own, the same miss is an expiry by the agent's lifetime.
// scenarios/cache-compaction.ts runs /compact between two turns: the summary
// request's miss sits under the compaction's row, not at the next turn's end.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { scratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/cache.test.ts: skipped. Set OPENCODE_DEV to the fork.")

type Rgba = readonly [number, number, number, number]
type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string; fg: Rgba }> }> }

/** Prime's `text.feedback.warning` and `text.muted`. */
const WARNING = "#f59e0b"
const MUTED = "#a1a1aa"

const hex = (rgba: Rgba) => `#${rgba.slice(0, 3).map((value) => value.toString(16).padStart(2, "0")).join("")}`

/** The foreground of the cell at column `x` of line `y`. */
const fgAt = (frame: Frame, y: number, x: number): string => {
  let start = 0
  for (const span of frame.lines[y]?.spans ?? []) {
    if (x < start + span.text.length) return hex(span.fg)
    start += span.text.length
  }
  return `no cell at ${y}:${x}`
}

/** The server half's ledger lines, by what the scenario decides: cause, lifetime, writes and the missed prefix. */
const ledgerOf = (out: string) => {
  const timeout = join(out, "ledger.timeout.txt")
  if (existsSync(timeout)) throw new Error(readFileSync(timeout, "utf8"))
  return readFileSync(join(out, "ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((raw) => {
      const line = JSON.parse(raw) as { cause: string; ttlMs: number; write: number; missed?: number }
      return { cause: line.cause, ttlMs: line.ttlMs, write: line.write, ...(line.missed === undefined ? {} : { missed: line.missed }) }
    })
}

describe.skipIf(!fork)("the cache mod in a real TUI", () => {
  test("a shell call that outlives the cache ends its turn on a priced miss row, and the sidebar sums it", async () => {
    const out = scratch("cache-scenario-").path
    try {
      const child = owned(["bunx", "opencode-drive", "run", "scenarios/cache.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      const timeout = join(out, "cache.timeout.txt")
      if (code !== 0)
        throw new Error(`the cache scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(timeout) ? readFileSync(timeout, "utf8") : ""}`)
      const text = readFileSync(join(out, "cache.txt"), "utf8")
      const frame: Frame = JSON.parse(readFileSync(join(out, "cache.json"), "utf8"))
      const lines = text.split("\n")

      // One miss: the first request had nothing cached before it. 48k missed
      // tokens, all re-written: 48,000 × ($3.75 − $0.30) / 1M = $0.1656.
      const rows = lines.flatMap((line, y) => (line.includes("cache miss") ? [y] : []))
      expect(rows, text).toHaveLength(1)
      const [y = -1] = rows
      expect(lines[y], text).toMatch(/^ {2}◌ cache miss · 48k tokens · \$0\.17 · expired during a [45]s shell call(?: {2,}.*)?$/)
      // It closes the turn: under the final answer.
      expect(y, text).toBeGreaterThan(lines.findIndex((line) => line.includes("The check passed.")))
      const glyph = (lines[y] ?? "").indexOf("◌")
      expect(fgAt(frame, y, glyph)).toBe(WARNING)
      expect(fgAt(frame, y, glyph + 2)).toBe(MUTED)

      // The sidebar: nothing read back from the cache, $0.17 lost, all of it to an expiry.
      const sidebar = lines.findIndex((line) => line.trimEnd().endsWith("Cache 0% · missed $0.17 · expired"))
      expect(sidebar, text).toBeGreaterThan(-1)
      expect(fgAt(frame, sidebar, (lines[sidebar] ?? "").indexOf("Cache 0%"))).toBe(MUTED)

      // The server half's ledger: the first request, then the second, past the 2s cache, an expiry.
      expect(ledgerOf(out), text).toEqual([
        { cause: "first", ttlMs: 2_000, write: 48_000 },
        { cause: "expired", ttlMs: 2_000, write: 50_000, missed: 48_000 },
      ])
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }, 150_000)

  test("an agent's own 2s cache lifetime expires the prefix its model would keep an hour", async () => {
    const out = scratch("cache-role-scenario-").path
    try {
      const child = owned(["bunx", "opencode-drive", "run", "scenarios/cache.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, CACHE_ROLE_TTL: "2s", SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      const timeout = join(out, "cache.timeout.txt")
      if (code !== 0)
        throw new Error(`the cache scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(timeout) ? readFileSync(timeout, "utf8") : ""}`)
      const text = readFileSync(join(out, "cache.txt"), "utf8")
      const lines = text.split("\n")
      // By the model's hour the miss would read "prefix changed"; by the agent's 2s it expired.
      const rows = lines.filter((line) => line.includes("cache miss"))
      expect(rows, text).toHaveLength(1)
      expect(rows[0], text).toMatch(/^ {2}◌ cache miss · 48k tokens · \$0\.17 · expired during a [45]s shell call(?: {2,}.*)?$/)
      expect(lines.some((line) => line.trimEnd().endsWith("Cache 0% · missed $0.17 · expired")), text).toBe(true)
      // The server judges by what the request asked for: here the model's hour (only the auth plugin writes an
      // agent's lifetime into an Anthropic body), so the unchanged prompt the cache lost reads `unchanged`, and the
      // TUI's expiry stands: the server refines only a changed prefix.
      expect(ledgerOf(out), text).toEqual([
        { cause: "first", ttlMs: 3_600_000, write: 48_000 },
        { cause: "unchanged", ttlMs: 3_600_000, write: 50_000, missed: 48_000 },
      ])
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }, 150_000)

  test("a compaction's miss sits under the compaction, not under the turn after it", async () => {
    const out = scratch("cache-compaction-scenario-").path
    try {
      const child = owned(["bunx", "opencode-drive", "run", "scenarios/cache-compaction.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      const timeout = join(out, "cache-compaction.timeout.txt")
      if (code !== 0)
        throw new Error(`the cache compaction scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(timeout) ? readFileSync(timeout, "utf8") : ""}`)
      const text = readFileSync(join(out, "cache-compaction.txt"), "utf8")
      const frame: Frame = JSON.parse(readFileSync(join(out, "cache-compaction.json"), "utf8"))
      const lines = text.split("\n")

      // One row: the summary request read none of the 48k the first turn cached, inside the hour.
      const rows = lines.flatMap((line, y) => (line.includes("cache miss") ? [y] : []))
      expect(rows, text).toHaveLength(1)
      const [y = -1] = rows
      expect(lines[y], text).toMatch(/^ {2}◌ cache miss · 48k tokens · \$0\.17 · the compaction request missed the cached prefix(?: {2,}.*)?$/)
      // Under the compaction's row and above the next turn's prompt, not at that turn's end.
      expect(y, text).toBeGreaterThan(lines.findIndex((line) => line.includes("◇ Compacted")))
      expect(y, text).toBeLessThan(lines.findIndex((line) => line.includes("Check it again.")))
      const glyph = (lines[y] ?? "").indexOf("◌")
      expect(fgAt(frame, y, glyph)).toBe(WARNING)
      expect(fgAt(frame, y, glyph + 2)).toBe(MUTED)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }, 150_000)
})
