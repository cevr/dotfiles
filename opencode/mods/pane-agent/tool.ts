import { Schema } from "effect"
import { toolInput } from "@dotfiles/decider/tool-input"
import { Harness } from "./adapter.ts"

export const PANE_AGENT_TOOL = "pane_agent"

export const ACTIONS = ["start", "follow_up", "status", "list", "stop"] as const
export const Action = Schema.Literals(ACTIONS)
export type Action = typeof Action.Type

const RawInput = Schema.Struct({
  action: Action.annotate({
    description:
      'What to do: "start" a harness CLI in a right-split Rex pane, "follow_up" in the same pane, "status" of one worker, "list" this session\'s pane workers, or "stop" one.',
  }),
  harness: Schema.optionalKey(Harness).annotate({
    description: 'Start: external CLI harness to launch (currently "agy"). Never choose this by default; use only when the caller asks for that harness.',
  }),
  id: Schema.optionalKey(Schema.String).annotate({
    description: 'Follow-up, status, stop: the worker id returned by start (e.g. "pa_...").',
  }),
  description: Schema.optionalKey(Schema.String).annotate({
    description: 'Start: short role and unit label shown in the worker row (e.g. "implementor pane-agent r1").',
  }),
  prompt: Schema.optionalKey(Schema.String).annotate({
    description: "Start, follow_up: plain task brief to type into the pane (as a person would paste it; no system prompt).",
  }),
  resultFile: Schema.optionalKey(Schema.String).annotate({
    description: "Start (and optional on follow_up): file path where the worker should write its final answer for deterministic hand-back.",
  }),
  cwd: Schema.optionalKey(Schema.String).annotate({
    description: "Start: working directory for the new pane (defaults to this session's directory).",
  }),
  rexSession: Schema.optionalKey(Schema.String).annotate({
    description: "Start: optional Rex session id when not inferred from the active Rex TUI.",
  }),
  rexBlock: Schema.optionalKey(Schema.String).annotate({
    description: "Start: optional anchor Rex block id to split right beside when not inferred from the active Rex TUI.",
  }),
  blockId: Schema.optionalKey(Schema.String).annotate({
    description: "Start: optional existing Rex block id explicitly named by the caller; never pass a pane the caller did not name.",
  }),
  dangerousSkipPermissions: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Start: pass --dangerously-skip-permissions ONLY when the owner explicitly asks for it on this start (default false).",
  }),
  close: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Stop: when true, also close the Rex pane if this tool created it (default false).",
  }),
})

export const PaneAgentInput = toolInput(RawInput)
export type PaneAgentInput = typeof PaneAgentInput.Type

export const DESCRIPTION = [
  "Run another harness's unmodified interactive CLI (such as agy) in a Rex right-split pane as a worker.",
  "Use ONLY when the caller explicitly asks for that harness; never choose it by default instead of a normal subagent.",
  "A pane worker uses the other harness's own sign-in and quota (no OpenCode pool slot).",
  "Actions:",
  '- { action: "start", harness: "agy", description, prompt, resultFile, cwd?, blockId?, dangerousSkipPermissions? }: opens a right split beside your pane without stealing focus (or uses caller-named blockId), waits for input readiness, pastes the plain task brief naming the sender only as "the orchestrator" and requesting the answer in resultFile, and wakes you when the turn ends or needs human input.',
  '- { action: "follow_up", id, prompt, resultFile? }: sends a follow-up brief into the same pane and conversation.',
  '- { action: "status", id } / { action: "list" }: reads current state, block id, and last pane lines.',
  '- { action: "stop", id, close? }: sends Esc to interrupt the harness and marks the worker stopped (closing the pane only if close: true and this tool created it).',
  "Hard rules: never pass --dangerously-skip-permissions unless the owner explicitly asked per start; never type into a pane not created here unless the caller named its blockId; never poll in a sleep loop (completion and needs-input alerts arrive automatically as steered messages).",
].join("\n")
