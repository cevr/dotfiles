// A run dir's skill records as real files in a scratch run dir.
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
