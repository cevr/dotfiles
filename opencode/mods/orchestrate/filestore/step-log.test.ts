// The step log over a real JSONL file in a scratch directory: the laws, with
// each world written as the call log writes its lines, and the lines it
// passes over.
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { stepLogLaws } from "../laws.ts"
import { StepLog } from "../service.ts"
import * as FileStepLog from "./step-log.ts"

const scratch = mkdtempSync(join(tmpdir(), "step-log-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let n = 0
const fileWith = (lines: ReadonlyArray<unknown>, tail = "") => {
  n += 1
  const file = join(scratch, `agents-${n}.jsonl`)
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join("") + tail)
  return file
}

stepLogLaws("the call log file's StepLog", (world) =>
  FileStepLog.layer(
    fileWith(
      Object.entries(world).flatMap(([sessionID, units]) =>
        units.map((unit, index) => ({ kind: "call", at: "2026-11-04T15:00:00.000Z", sessionID, callID: `call-${index}`, agent: "planner", description: `planner ${unit} r1` })),
      ),
    ),
  ),
)

const unitsOf = (file: string, sessionID = "root") => Effect.runPromise(StepLog.use((log) => log.units(sessionID)).pipe(Effect.provide(FileStepLog.layer(file))))

test("both step forms count, latched starts too; prose, other kinds, other sessions and broken lines do not", async () => {
  const file = fileWith(
    [
      { kind: "call", sessionID: "root", description: "implementor closure-flake r2" },
      { kind: "latched", sessionID: "root", description: "pkg-lower r1 verifier (Opus)" },
      { kind: "call", sessionID: "root", description: "Fix the verifier's timeout" },
      { kind: "call", sessionID: "root" },
      { kind: "done", sessionID: "root", description: "planner done-unit r1" },
      { kind: "denied", sessionID: "root", description: "planner denied-unit r1" },
      { kind: "call", sessionID: "other", description: "planner theirs r1" },
      "not a line",
    ],
    '{"kind":"call","sessionID":"root","descr',
  )
  expect(await unitsOf(file)).toEqual(["closure-flake", "pkg-lower"])
})

test("no log is no steps", async () => {
  expect(await unitsOf(join(scratch, "missing.jsonl"))).toEqual([])
})
