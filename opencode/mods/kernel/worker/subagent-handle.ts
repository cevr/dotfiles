/**
 * A subagent inside a cell: `await tools.subagent({ agent, description,
 * prompt })` starts one in the background, as the subagent tool does, and
 * resolves to a live handle whose methods act on it through the `subagents`
 * tool (../opencode/subagents.ts): `.stop()`, `.read()`, `.refresh()`.
 * `tools.subagent.handle(sessionID)` builds one for a subagent of the
 * session, and `tools.subagent.list()` one for each. It has no wait: a
 * finished subagent's report arrives as the session's next message.
 *
 * A handle is `{ sessionID, description, agent, state, message, note, model? }`:
 * `state` is running, done, stopped or failed; `message` the subagent's last
 * message as the latest call read it (empty until a call reads it); `note`
 * what the latest call did when it says (a stop), and from the start what it
 * answered of where it runs (a fallback model, a lowered effort, a latch);
 * `model` what its start named, not an observed effective route;
 * `observation` describes lifecycle separately from notices and last words. Its
 * data fields are plain and enumerable, so it prints, serializes and survives
 * a kernel restart as data; its methods are not enumerable, so a restart
 * drops them, and `tools.subagent.handle(h.sessionID)` builds a live one again.
 *
 * Each method calls the subagents tool with the handle's sessionID, writes
 * the subagent it answers into this handle, and resolves to this handle.
 *
 * @module
 */
import { Option, Schema } from "effect"
import { Hold, Observation, Phase } from "../child-lifecycle.ts"
import type { Json } from "../frame.ts"
import { readLaunchStatus } from "../launch-status.ts"
import { observedState } from "../subagents.ts"

/** A subagent as the subagents tool answers it. */
export interface SubagentHandleData {
  readonly sessionID: string
  readonly description: string
  readonly agent: string
  readonly state: "running" | "done" | "stopped" | "failed"
  readonly message: string
  readonly note: string
  /** The model it runs on, when its start named one. */
  readonly model?: string
  readonly observation?: Observation
}

/** A live handle: the data, updated in place by each method. */
export interface SubagentHandle extends SubagentHandleData {
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

const METHODS = ["stop", "read", "refresh"]
const decodeObservation = Schema.decodeUnknownOption(Observation)

const observationOf = (raw: Json, child: string) => Option.filter(decodeObservation(raw), (observed) => observed.child === child)

const unknown = (child: string): Observation => ({ version: 1, child, phase: Phase.cases.Unknown.make({}) })
const revisionOf = (observation: Option.Option<Observation>) => Option.flatMap(observation, (current) => Option.fromUndefinedOr(current.revision))
const observationFields = (observed: Option.Option<Observation>) => {
  if (Option.isSome(observed)) return { observation: observed.value }
  return {}
}

const shouldReplace = (
  old: Option.Option<Observation>,
  next: Option.Option<Observation>,
  request: number,
  seen: number,
) => {
  const previous = revisionOf(old)
  if (Option.isNone(previous)) return request >= seen
  const current = revisionOf(next)
  if (Option.isNone(current) || current.value < previous.value) return false
  return current.value > previous.value || request >= seen
}

/** `data` as a live handle whose methods reach the subagents tool through `call`. */
export const makeSubagentHandle = (data: SubagentHandleData, call: CallTool): SubagentHandle => {
  const latestState = (view: SubagentHandleData): SubagentHandleData => {
    if (view.observation && Option.isSome(revisionOf(Option.some(view.observation)))) {
      return { ...view, state: observedState(view.observation) }
    }
    return view
  }
  let snapshot = latestState(data)
  let issued = 0
  let read = 0
  const render = (request: number) => {
    const observation = Option.fromUndefinedOr(snapshot.observation)
    const pendingTerminal = request < issued && Option.isSome(revisionOf(observation))
      && Option.exists(observation, ({ phase }) => phase._tag === "Settled")
    let shown = snapshot
    if (pendingTerminal) shown = { ...snapshot, state: "running", observation: unknown(data.sessionID) }
    // Plain enumerable data properties are required by the worker's snapshot codec.
    Object.defineProperties(handle, Object.getOwnPropertyDescriptors(shown))
  }
  const update = (input: JsonRecord) => {
    const request = ++issued
    render(read)
    return call("subagents", { ...input, sessionID: data.sessionID }).then((result) => {
      const view = recordOf(listedOf(result)[0])
      if (view.sessionID !== data.sessionID) return handle
      const next = observationOf(view.observation, data.sessionID)
      if (Option.isSome(Option.fromUndefinedOr(view.observation)) && Option.isNone(next)) return handle
      if (!shouldReplace(Option.fromUndefinedOr(snapshot.observation), next, request, read)) return handle
      const decoded = decodeView(view)
      if (Option.isNone(decoded)) return handle
      read = Math.max(read, request)
      snapshot = latestState({ ...snapshot, ...decoded.value, ...observationFields(next) })
      render(request)
      return handle
    })
  }
  const handle: SubagentHandle = {
    ...snapshot,
    stop: () => update({ action: "stop" }),
    read: () => update({ action: "get" }),
    refresh: () => update({ action: "get" }),
  }
  if (!data.observation)
    Object.defineProperty(handle, "observation", { value: unknown(data.sessionID), enumerable: false, configurable: true })
  for (const method of METHODS) Object.defineProperty(handle, method, { enumerable: false })
  return handle
}

const ViewFields = Schema.Struct({
  sessionID: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  state: Schema.Literals(["running", "done", "stopped", "failed"]),
  message: Schema.String,
  note: Schema.String,
})
const decodeView = Schema.decodeUnknownOption(ViewFields)
const requireView = Schema.decodeUnknownSync(ViewFields)

/** A live handle of one subagent as a subagents tool answer gives it. */
const handleOfView = (view: Json, call: CallTool): SubagentHandle => {
  const fields = recordOf(view)
  const data = requireView(fields)
  const observation = observationOf(fields.observation, data.sessionID)
  return makeSubagentHandle({ ...data, ...observationFields(observation) }, call)
}

/** What a start answers of where it runs, beside its session: the orchestrate plugin's fallback, effort or latch note, and its model. */
const Started = Schema.Struct({ note: Schema.optionalKey(Schema.String), model: Schema.optionalKey(Schema.String) })
const decodeStarted = Schema.decodeUnknownOption(Started)
const Latch = Schema.Struct({
  hold: Schema.optionalKey(Schema.Literals(["pace", "sabbath"])),
  opensAt: Schema.optionalKey(Schema.Finite),
  recheckAt: Schema.optionalKey(Schema.Finite),
})
const decodeLatch = Schema.decodeUnknownOption(Latch)

const latchOf = (raw: Json, child: string): Observation => {
  const latch = Option.getOrElse(decodeLatch(raw), () => Latch.make({}))
  const fields = (hold: Hold) => ({ ...latch, hold })
  const hold = (() => {
    if (latch.hold === "pace") return Hold.cases.Pace.make({})
    if (latch.hold === "sabbath") return Hold.cases.Sabbath.make({})
    return Hold.cases.Unknown.make({})
  })()
  return { version: 1, child, phase: Phase.cases.Latched.make(fields(hold)) }
}

/**
 * `tools.subagent(input)`: starts a subagent (or sends one more work, with its sessionID) and resolves to its live
 * handle, running.
 */
export const runSubagent = (input: Json, call: CallTool): Promise<SubagentHandle> =>
  call("subagent", input).then((result) => {
    const asked = recordOf(input)
    const started = recordOf(result)
    const child = String(started.sessionID)
    const observed = observationOf(started.observation, child)
    const observation = Option.orElse(observed, () =>
      Option.flatMap(readLaunchStatus(started.status), (status) => {
        switch (status) {
          case "latched": return Option.some(latchOf(started.latch, child))
          case "checking":
          case "unknown": return Option.some(unknown(child))
          case "running":
          case "completed": return Option.none()
        }
        return status satisfies never
      }),
    )
    return makeSubagentHandle(
      {
        sessionID: child,
        description: String(asked.description),
        agent: String(asked.agent),
        state: "running",
        message: "",
        note: "",
        ...Option.getOrElse(decodeStarted(result), () => ({})),
        ...observationFields(observation),
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
