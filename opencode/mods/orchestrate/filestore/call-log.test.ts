// The call log as a JSONL file in a scratch directory: the laws, the file's
// exact bytes (the status pane reads them), and a line it cannot write.
import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { CallLine } from "../call-line.ts"
import { callLogLaws } from "../laws.ts"
import { CallLog } from "../service.ts"
import * as FileCallLog from "./call-log.ts"

const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "orchestrate-call-log-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

const readLines = (file: string) =>
  Effect.sync(() =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line): unknown => JSON.parse(line))
      : [],
  )

callLogLaws(
  "the JSONL CallLog",
  Effect.map(scratch, (dir) => {
    // A directory that does not exist yet: the log makes it.
    const file = join(dir, "cache/orchestrate/agents.jsonl")
    return { layer: FileCallLog.layer(file), written: readLines(file) }
  }),
)

const line: CallLine = { kind: "done", at: "2026-11-04T15:01:00.000Z", sessionID: "ses_a", callID: "call-1", status: "completed" }

test("each line is its JSON, keys in the line's order, ending in a newline", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const file = join(yield* scratch, "agents.jsonl")
        yield* Effect.provide(CallLog.use((log) => log.append(line)), FileCallLog.layer(file))
        expect(readFileSync(file, "utf8")).toBe(
          '{"kind":"done","at":"2026-11-04T15:01:00.000Z","sessionID":"ses_a","callID":"call-1","status":"completed"}\n',
        )
      }),
    ),
  ))

test("a line it cannot write is dropped without failing", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* scratch
        // A file where the log's directory should be.
        writeFileSync(join(dir, "blocked"), "")
        const file = join(dir, "blocked/agents.jsonl")
        yield* Effect.provide(CallLog.use((log) => log.append(line)), FileCallLog.layer(file))
        expect(existsSync(file)).toBe(false)
      }),
    ),
  ))
