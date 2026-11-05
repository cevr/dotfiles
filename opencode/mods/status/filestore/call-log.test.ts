// The call log as a JSONL file in a scratch directory, written as
// orchestrate writes it: the laws, then the lines it skips.
import { expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { Event } from "../agent-calls.ts"
import { callLogLaws } from "../laws.ts"
import { CallLog } from "../service.ts"
import * as FileCallLog from "./call-log.ts"

const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "status-call-log-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

/** An event as orchestrate's line for it: `call` or `done`. */
const lineOf = (event: Event) => {
  const { _tag, ...fields } = event
  return `${JSON.stringify({ kind: _tag === "AgentCalled" ? "call" : "done", ...fields })}\n`
}

callLogLaws(
  "the JSONL CallLog",
  Effect.map(scratch, (dir) => {
    const file = join(dir, "agents.jsonl")
    return {
      layer: FileCallLog.layer(file),
      record: (events) => Effect.sync(() => appendFileSync(file, events.map(lineOf).join(""))),
      // A directory where the log should be.
      spoil: Effect.sync(() => {
        rmSync(file, { force: true })
        mkdirSync(file)
      }),
    }
  }),
)

test("skips every line that is not a whole call or return, and a partial last line", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const file = join(yield* scratch, "agents.jsonl")
        const events = Effect.provide(CallLog.use((log) => log.events), FileCallLog.layer(file))
        writeFileSync(
          file,
          [
            '{"kind":"call","sessionID":"ses_1","callID":"a","agent":"worker","description":7,"child":"ses_a"}\n',
            "not json\n",
            '{"kind":"call","sessionID":"ses_1","callID":"b"}\n',
            '{"kind":"call","callID":"c","agent":"worker"}\n',
            '{"kind":"tool","sessionID":"ses_1","callID":"a"}\n',
            "null\n",
            '{"kind":"done","sessionID":"ses_1","callID":"a","status":"compl',
          ].join(""),
        )
        expect(yield* events).toEqual([{ _tag: "AgentCalled", sessionID: "ses_1", callID: "a", agent: "worker", child: "ses_a" }])
        appendFileSync(file, 'eted"}\n')
        expect((yield* events).length).toBe(2)
      }),
    ),
  ))
