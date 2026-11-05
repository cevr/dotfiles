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
})
export type Unit = typeof Unit.Type

/** An orchestrate run: its directory's name and its units. */
export const Run = Schema.Struct({
  name: Schema.String,
  units: Schema.Array(Unit),
})
export type Run = typeof Run.Type

/** The status method's answer. `errors` names each half that could not be read; that half is then empty. */
export const Snapshot = Schema.Struct({
  agents: Schema.Array(AgentCall),
  runs: Schema.Array(Run),
  errors: Schema.Array(Schema.String),
})
export type Snapshot = typeof Snapshot.Type
