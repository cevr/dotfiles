// Orchestrate's call log as a JSONL file (orchestrate/call-line.ts
// writes it). Its `call` and `done` lines decode into the AgentCalls view's
// events; every other line, and a line that does not parse (a partial append
// the writer has not finished), is skipped.
import { readFile } from "node:fs/promises"
import { Effect, Layer } from "effect"
import type { Event } from "../domain/Agents/AgentCalls.view.ts"
import { AgentCalled, AgentReturned } from "../domain/Agents/AgentCalls.view.ts"
import { CallLog, CallLogUnreadable } from "../domain/Agents/CallLog.external.ts"

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const text = (value: unknown) => (typeof value === "string" ? value : undefined)

const parsed = (line: string): unknown => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** The line's event, if it is a call or a return naming its caller and call id. */
const eventOf = (row: unknown): ReadonlyArray<Event> => {
  if (!isRecord(row) || typeof row.sessionID !== "string" || typeof row.callID !== "string") return []
  const description = text(row.description)
  const child = text(row.child)
  const status = text(row.status)
  if (row.kind === "call" && typeof row.agent === "string")
    return [
      AgentCalled.make({
        sessionID: row.sessionID,
        callID: row.callID,
        agent: row.agent,
        ...(description === undefined ? {} : { description }),
        ...(child === undefined ? {} : { child }),
      }),
    ]
  if (row.kind === "done")
    return [
      AgentReturned.make({
        sessionID: row.sessionID,
        callID: row.callID,
        ...(child === undefined ? {} : { child }),
        ...(status === undefined ? {} : { status }),
      }),
    ]
  return []
}

/** The events a log's text records, in order. */
export const eventsOf = (log: string): ReadonlyArray<Event> => log.split("\n").flatMap((line) => eventOf(parsed(line)))

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
const isNotFound = (cause: unknown) => isRecord(cause) && cause.code === "ENOENT"

/** The log at `file`; no file yet is an empty log. */
export const layer = (file: string) =>
  Layer.succeed(CallLog, {
    events: Effect.tryPromise({ try: () => readFile(file, "utf8"), catch: (cause) => cause }).pipe(
      Effect.catch((cause) =>
        isNotFound(cause) ? Effect.succeed("") : Effect.fail(new CallLogUnreadable({ message: messageOf(cause) })),
      ),
      Effect.map(eventsOf),
      Effect.withSpan("CallLog.events"),
    ),
  })

/** The log in the test: its text (absent: no file yet), or the reason it cannot be read. Read again on every call. */
export interface TestLog {
  text?: string
  failure?: string
}

export const layerTest = (log: TestLog) =>
  Layer.succeed(CallLog, {
    events: Effect.suspend(() =>
      log.failure === undefined
        ? Effect.succeed(eventsOf(log.text ?? ""))
        : Effect.fail(new CallLogUnreadable({ message: log.failure })),
    ),
  })
