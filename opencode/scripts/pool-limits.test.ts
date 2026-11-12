// The limit tally's CLI view on a recorded fixture: both hosts' dumps of
// 2026-11-12 (pool-limits-dump.ts), cut to the Anthropic weeks, logins
// renamed, each host's tokens per login and model in the login's week summed.
// Fable ran on 6 of 7 accounts at about 1.4% of the weighted tokens, and every
// reading of Fable's own week (`7d:Fable`) said its part of the weekly window.
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emptyState, limitsLine, observe, recount, tally, weeklyRatios } from "../mods/pool/limits.ts"
import recorded from "./fixtures/pool-limits-2026-11-12.json"
import { fromDumps, notes } from "./pool-limits.ts"

const computed = fromDumps(Object.entries(recorded) as Parameters<typeof fromDumps>[0])
const family = (window: string, name: string) => computed.recent.find((w) => w.pool === "anthropic" && w.window === window)?.families.find((f) => f.family === name)

test("Fable's rate on the weekly window is its reported part, not the 0 the shared fit gave it", () => {
  const fable = family("7d", "Fable")!
  expect(fable).toMatchObject({ n: 6, reported: true })
  expect(fable.weighted.rate).toBeCloseTo(1.01, 2)
  expect(fable.weighted.low!).toBeGreaterThan(0.8)
  expect(fable.weighted.high!).toBeLessThan(1.2)
  // Opus carries the rest of the rise.
  expect(family("7d", "Opus")!.weighted.rate).toBeCloseTo(0.193, 2)
})

test("Fable's own week has its rate, and the weekly points one own-week point costs", () => {
  expect(family("7d:Fable", "Fable")!.weighted.rate).toBeCloseTo(1.86, 2)
  // Every reading's weekly part is the own week's use × 0.5 (`ofWeekly`), rounded half up: dividing
  // the two fits would give 0.54, the rounding's +0.04 and no measurement. The ratio is the provider's share.
  expect(family("7d", "Fable")!.share).toBe(0.5)
  expect(weeklyRatios(computed, "anthropic")["7d:Fable"]).toEqual({ rate: 0.5, source: "api" })
})

test("the line and the view show Fable on both weeks and the ratio as the provider's share", () => {
  expect(limitsLine(computed)).toBe(
    "limit/Mtok 7d: Fable 1.0% 0.88–1.1 n 6 (own week 1.9% 1.6–2.2 n 6; weekly/own 0.50 provider's share) · Opus 0.19% 0.16–0.22 n 7 (last 7 days)",
  )
  expect(notes(computed)).toEqual([
    "  anthropic 7d:Fable: 0.500 weekly points per own-week point, the provider's allowance share: every reported weekly part is the own week's use times it, rounded half up",
  ])
})

const scratch = mkdtempSync(join(tmpdir(), "pool-limits-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const cli = (...args: ReadonlyArray<string>) => {
  const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "pool-limits.ts"), ...args], { stdout: "pipe", stderr: "pipe" })
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() }
}

test("--file: the view fits the file's rows again, not the tally a running pool of an older fit stored beside them", () => {
  const now = Date.now()
  const hour = 3_600_000
  let state = observe(emptyState(now - 10 * 24 * hour), "anthropic", "a", { at: now - hour, windows: [{ name: "7d", utilization: 0.04, resetAt: now + 24 * hour }] })
  state = recount(state, [{ at: now - 2 * hour, pool: "anthropic", credentialID: "a", model: "claude-opus-5-5", tokens: { input: 2e6, output: 0, cacheRead: 0, cacheWrite: 0 } }], now)
  const path = join(scratch, "limits.json")
  // The stored tally and line are stale: an older fit wrote them, with no row fitted.
  writeFileSync(path, JSON.stringify({ version: 1, line: "limit/Mtok 7d: stale", tally: tally(emptyState(now), now), state }))
  const answer = cli("--file", path, "--json")
  expect(answer.code).toBe(0)
  const parsed = JSON.parse(answer.out) as { line?: string; tally: ReturnType<typeof tally> }
  expect(parsed.line).toBe("limit/Mtok 7d: Opus 2.0% n 1 (last 7 days)")
  expect(parsed.tally.recent.map((w) => w.window)).toEqual(["7d"])
  // The text view leads with the same line.
  expect(cli("--file", path).out.split("\n")[0]).toBe("limit/Mtok 7d: Opus 2.0% n 1 (last 7 days)")
})

test("--file: a file with no tally state is an error that names the path", () => {
  const path = join(scratch, "missing.json")
  const answer = cli("--file", path)
  expect(answer.code).toBe(1)
  expect(answer.err).toContain(`no limit tally at ${path}`)
})
