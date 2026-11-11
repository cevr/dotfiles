// The ledger over a real JSONL file in a scratch directory: the laws, with a
// cut last line written as a crash mid-write leaves it.
import { afterAll, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CADENCE } from "../machine.ts"
import { ledgerLaws } from "../laws.ts"
import * as FileLedger from "./ledger.ts"

const scratch = mkdtempSync(join(tmpdir(), "ledger-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let n = 0

ledgerLaws("the JSONL file's Ledger", () => {
  n += 1
  const file = join(scratch, `nested-${n}/machine.jsonl`)
  return {
    open: (retention) => FileLedger.layer(file, DEFAULT_CADENCE, retention),
    size: () => (existsSync(file) ? statSync(file).size : 0),
    lines: () => FileLedger.linesIn(readFileSync(file, "utf8")) as ReadonlyArray<Record<string, unknown>>,
    cut: () => appendFileSync(file, '{"at":"2026-11-11T18:00:00.000Z","sessionID":"root","kind":"UnitHand'),
  }
})

test("lines that do not parse are passed over", () => {
  expect(FileLedger.linesIn('{"a":1}\nnot json\n\n{"b":2}\n{"c":')).toEqual([{ a: 1 }, { b: 2 }])
})
