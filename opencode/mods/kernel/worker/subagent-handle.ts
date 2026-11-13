/**
 * A subagent inside a cell: `await tools.subagent({ agent, description,
 * prompt })` starts one in the background, as the subagent tool does, and
 * resolves to a live handle whose methods act on it through the `subagents`
 * tool (../opencode/subagents.ts): `.wait(ms?)`, `.stop()`, `.read()`,
 * `.refresh()`. `tools.subagent.handle(sessionID)` builds one for a subagent
 * of the session, and `tools.subagent.list()` one for each.
 *
 * A handle is `{ sessionID, description, agent, state, message, note }`:
 * `state` is running, done, stopped or failed; `message` the subagent's last
 * message as the latest call read it (empty until a call reads it); `note`
 * what the latest call did when it says (a stop, a wait that timed out). Its
 * data fields are plain and enumerable, so it prints, serializes and survives
 * a kernel restart as data; its methods are not enumerable, so a restart
 * drops them, and `tools.subagent.handle(h.sessionID)` builds a live one again.
 *
 * Each method calls the subagents tool with the handle's sessionID, writes
 * the subagent it answers into this handle, and resolves to this handle.
 *
 * @module
 */
import type { Json } from "../frame.ts"

/** How long `wait()` without a limit waits: the subagents tool's own default. */
export const DEFAULT_WAIT_MS = 10 * 60 * 1_000

/** A subagent as the subagents tool answers it. */
export interface SubagentHandleData {
  readonly sessionID: string
  readonly description: string
  readonly agent: string
  readonly state: "running" | "done" | "stopped" | "failed"
  readonly message: string
  readonly note: string
}

/** A live handle: the data, updated in place by each method. */
export interface SubagentHandle extends SubagentHandleData {
  /** Waits up to `ms` for it to go idle; its `message` is then its final message. */
  wait(ms?: number): Promise<SubagentHandle>
  /** Stops it: its turn and its own running subagents end; its parent hears once that it was cancelled. */
  stop(): Promise<SubagentHandle>
  /** Its state now and its last message. */
  read(): Promise<SubagentHandle>
  /** Its state now and its last message. */
  refresh(): Promise<SubagentHandle>
}

/** Calls a host tool with a JSON input and resolves to its result. */
export type CallTool = (id: string, input: Json) => Promise<Json>

type JsonRecord = { readonly [key: string]: Json }

const isRecord = (value: Json): value is JsonRecord => value instanceof Object && !Array.isArray(value)

/** The value as a JSON object, or an empty one when it is not one. */
const recordOf = (value: Json): JsonRecord => {
  if (isRecord(value)) return value
  return {}
}

/** The subagents a subagents tool answer carries. */
const listedOf = (result: Json): ReadonlyArray<Json> => {
  const listed = recordOf(result).subagents
  if (Array.isArray(listed)) return listed
  return []
}

const METHODS = ["wait", "stop", "read", "refresh"]

/** `data` as a live handle whose methods reach the subagents tool through `call`. */
export const makeSubagentHandle = (data: SubagentHandleData, call: CallTool): SubagentHandle => {
  const update = (input: JsonRecord) =>
    call("subagents", { ...input, sessionID: handle.sessionID }).then((result) => {
      for (const view of listedOf(result).slice(0, 1)) Object.assign(handle, recordOf(view))
      return handle
    })
  const handle: SubagentHandle = {
    ...data,
    wait: (ms = DEFAULT_WAIT_MS) => update({ action: "wait", ms }),
    stop: () => update({ action: "stop" }),
    read: () => update({ action: "get" }),
    refresh: () => update({ action: "get" }),
  }
  for (const method of METHODS) Object.defineProperty(handle, method, { enumerable: false })
  return handle
}

/** A live handle of one subagent as a subagents tool answer gives it. */
const handleOfView = (view: Json, call: CallTool): SubagentHandle => {
  const fields = recordOf(view)
  return makeSubagentHandle(
    {
      sessionID: String(fields.sessionID),
      description: String(fields.description),
      agent: String(fields.agent),
      state: stateOf(fields.state),
      message: String(fields.message),
      note: String(fields.note),
    },
    call,
  )
}

const STATES: ReadonlyArray<SubagentHandleData["state"]> = ["running", "done", "stopped", "failed"]
const stateOf = (value: Json): SubagentHandleData["state"] => STATES.find((state) => state === value) || "running"

/**
 * `tools.subagent(input)`: starts a subagent (or sends one more work, with its sessionID) and resolves to its live
 * handle, running.
 */
export const runSubagent = (input: Json, call: CallTool): Promise<SubagentHandle> =>
  call("subagent", input).then((result) => {
    const asked = recordOf(input)
    return makeSubagentHandle(
      {
        sessionID: String(recordOf(result).sessionID),
        description: String(asked.description),
        agent: String(asked.agent),
        state: "running",
        message: "",
        note: "",
      },
      call,
    )
  })

/** `tools.subagent.handle(sessionID)`: a live handle for one of the session's subagents, rebuilt by reading it. */
export const subagentHandleOf = (sessionID: Json, call: CallTool): Promise<SubagentHandle> =>
  // The tool refuses a session that is not one of this session's subagents, so a `get` that answers names one.
  call("subagents", { action: "get", sessionID }).then((result) => {
    const [view = {}] = listedOf(result)
    return handleOfView(view, call)
  })

/** `tools.subagent.list()`: a live handle for each of the session's subagents, from one list call; their messages are empty. */
export const listSubagents = (call: CallTool): Promise<ReadonlyArray<SubagentHandle>> =>
  call("subagents", { action: "list" }).then((result) => listedOf(result).map((view) => handleOfView(view, call)))
