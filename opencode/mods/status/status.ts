// The status mod's own RPC, which the /pool pane reads: the live agents from
// orchestrate's call log, each orchestrate run's units, and why either could
// not be read. The definition is the wire contract, kept byte for byte; the
// schemas below are the shape its one method answers with.
import { Schema } from "effect"

export const STATUS = {
  id: "dotfiles-opencode.status",
  methods: { status: { input: { type: "object" }, output: { type: "object" } } },
  events: {},
} as const

/** A subagent call the call log shows as still running: who called it, as which agent, and its child session once known. */
export const AgentCall = Schema.Struct({
  sessionID: Schema.String,
  callID: Schema.String,
  agent: Schema.String,
  description: Schema.optionalKey(Schema.String),
  child: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
})
export type AgentCall = typeof AgentCall.Type

/** One unit of an orchestrate run, as the orchestrate skill's status script derives it from the unit's log. */
export const Unit = Schema.Struct({
  unit: Schema.String,
  state: Schema.String,
  round: Schema.String,
  since: Schema.String,
  /** Its batch cadence (`3 ready or 30 min`), when the script prints one. */
  cadence: Schema.optionalKey(Schema.String),
})
export type Unit = typeof Unit.Type

/** An orchestrate run: its directory's name, its path when known, the session that owns it when the call log names one, its units, and its drift from the batch machine when a verdict recorded one. */
export const Run = Schema.Struct({
  name: Schema.String,
  dir: Schema.optionalKey(Schema.String),
  /** The session that started the latest step of one of its units (agent-calls.ts `runSession`): the run's orchestrator. */
  session: Schema.optionalKey(Schema.String),
  units: Schema.Array(Unit),
  /** The status script's drift line, after `Drift: ` (`35 after batch-n accepted (…): 1 unfolded land ×6, …`); 0 is a clean run. */
  drift: Schema.optionalKey(Schema.String),
})
export type Run = typeof Run.Type

/** The status method's answer. `errors` names each half that could not be read; that half is then empty. */
export const Snapshot = Schema.Struct({
  agents: Schema.Array(AgentCall),
  runs: Schema.Array(Run),
  errors: Schema.Array(Schema.String),
})
export type Snapshot = typeof Snapshot.Type
