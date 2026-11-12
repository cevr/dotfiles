// A run dir's skill records as real files in a scratch run dir.
import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { RunRecords } from "../service.ts"
import { SEEN_FILE } from "../skill-drift.ts"
import * as FileRunRecords from "./run-records.ts"

const scratch = mkdtempSync(join(tmpdir(), "orchestrate-run-records-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const records = RunRecords.pipe(Effect.provide(FileRunRecords.layer), Effect.runSync)
const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

test("a run never seen has no version; once seen, it reads back from the run dir's skill-version", async () => {
  const dir = join(scratch, "p5")
  mkdirSync(dir)
  expect(await run(records.seen(dir))).toBeUndefined()
  await run(records.see(dir, "abc123"))
  expect(readFileSync(join(dir, SEEN_FILE), "utf8")).toBe("abc123\n")
  expect(await run(records.seen(dir))).toBe("abc123")
})

test("seeing into a run dir that is gone does not fail", async () => {
  await run(records.see(join(scratch, "gone"), "abc123"))
  expect(await run(records.seen(join(scratch, "gone")))).toBeUndefined()
})

test("the departures are the run's own Markdown lines that depart, by file and line; unit dirs and other files are not the run's", async () => {
  const dir = join(scratch, "wf10")
  mkdirSync(join(dir, "lexer"), { recursive: true })
  writeFileSync(join(dir, "common.md"), "# rules\n- Run Go with GOMEMLIMIT=6GiB.\n- Departs from Heavy checks fit the machine: benchmarks need a quiet host.\n")
  writeFileSync(join(dir, "plan.md"), "| Unit |\n**Departs from** Batch cadence: one unit lands at a time.\n")
  writeFileSync(join(dir, "lexer", "state.md"), "Departs from everything\n")
  writeFileSync(join(dir, "notes.txt"), "Departs from nothing\n")
  expect(await run(records.departures(dir))).toEqual([
    "common.md:3: - Departs from Heavy checks fit the machine: benchmarks need a quiet host.",
    "plan.md:2: **Departs from** Batch cadence: one unit lands at a time.",
  ])
  expect(await run(records.departures(join(scratch, "gone")))).toEqual([])
})

test("a verdict's line goes to the run's own log.md: by a batch report in the run dir, a unit's report in its unit dir, or a relative path", async () => {
  const dir = join(scratch, "p9")
  mkdirSync(join(dir, "lexer"), { recursive: true })
  writeFileSync(join(dir, "lexer", "spec.md"), "# lexer\n")
  writeFileSync(join(dir, "log.md"), "no newline")
  await run(records.log({ near: join(dir, "batch-1-findings.md"), line: "one" }))
  await run(records.log({ near: join(dir, "lexer", "round-1-findings.md"), line: "two" }))
  await run(records.log({ near: "p9/batch-2-findings.md", line: "three", directory: scratch }))
  expect(readFileSync(join(dir, "log.md"), "utf8")).toBe("no newline\none\ntwo\nthree\n")
  expect(existsSync(join(dir, "lexer", "log.md"))).toBe(false)
  // A path that names no run dir, or a relative one with no directory to read it from, writes nothing.
  await run(records.log({ near: join(scratch, "gone", "batch-1-findings.md"), line: "lost" }))
  await run(records.log({ near: "p9/batch-3-findings.md", line: "lost" }))
  expect(existsSync(join(scratch, "gone"))).toBe(false)
  expect(readFileSync(join(dir, "log.md"), "utf8")).not.toContain("lost")
})
