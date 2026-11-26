import { Schema } from "effect"
import { toolInput } from "@dotfiles/decider/tool-input"
import { Harness } from "./adapter.ts"

export const PANE_AGENT_TOOL = "pane_agent"

export const ACTIONS = ["start", "follow_up", "steer", "restart", "status", "list", "stop"] as const
export const Action = Schema.Literals(ACTIONS)
export type Action = typeof Action.Type

const RawInput = Schema.Struct({
  action: Action.annotate({
    description:
      'What to do: "start" a harness CLI in a right-split Rex pane, "follow_up" to queue a message (Enter), "steer" to interrupt and send immediately (Alt+M), "restart" a pane_gone worker with --continue in the same folder, "status" of one worker, "list" this session\'s pane workers, or "stop" one.',
  }),
  harness: Schema.optionalKey(Harness).annotate({
    description: 'Start: external CLI harness to launch (currently "agy"). Never choose this by default; use only when the caller asks for that harness.',
  }),
  id: Schema.optionalKey(Schema.String).annotate({
    description: 'Follow-up, steer, restart, status, stop: the worker id returned by start (e.g. "pa_...").',
  }),
  description: Schema.optionalKey(Schema.String).annotate({
    description: 'Start: short role and unit label shown in the worker row (e.g. "implementor pane-agent r1").',
  }),
  prompt: Schema.optionalKey(Schema.String).annotate({
    description: "Start, follow_up, steer, optional on restart: plain task brief to type into the pane (as a person would paste it; no system prompt).",
  }),
  resultFile: Schema.optionalKey(Schema.String).annotate({
    description: "Start (and optional on follow_up, steer, restart): file path where the worker should write its final answer for deterministic hand-back.",
  }),
  cwd: Schema.optionalKey(Schema.String).annotate({
    description: "Start: working directory for the new pane (the worker's lane folder; defaults to this session's directory).",
  }),
  addDirs: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Start: outside folders the worker must write (passed via --add-dir; the resultFile's parent directory is also added automatically when outside cwd).",
  }),
  steer: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Follow-up: when true, sends immediately with Alt+M (same as action: 'steer'); default false queues with Enter.",
  }),
  rexSession: Schema.optionalKey(Schema.String).annotate({
    description: "Start, restart: optional Rex session id when not inferred from the active Rex TUI.",
  }),
  rexBlock: Schema.optionalKey(Schema.String).annotate({
    description: "Start, restart: optional anchor Rex block id to split right beside when not inferred from the active Rex TUI.",
  }),
  blockId: Schema.optionalKey(Schema.String).annotate({
    description: "Start: optional existing Rex block id explicitly named by the caller; never pass a pane the caller did not name.",
  }),
  skipPermissions: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Start: pass --dangerously-skip-permissions (default true for agy so approval prompts do not stall workers).",
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
  '- { action: "start", harness: "agy", description, prompt, resultFile, cwd?, addDirs?, blockId?, skipPermissions? }: opens a right split beside your pane without stealing focus (starting agy with --dangerously-skip-permissions by default and --add-dir for outside folders including resultFile\'s dir), waits for input readiness, pastes the plain task brief naming the sender only as "the orchestrator", and wakes you when the turn ends, needs human input, or if the pane disappears.',
  '- { action: "follow_up", id, prompt, resultFile?, steer? }: queues a follow-up in the same pane with Enter (or sends immediately with Alt+M when steer: true).',
  '- { action: "steer", id, prompt, resultFile? }: sends an immediate interrupt/steer into the same pane with Alt+M.',
  '- { action: "restart", id, prompt?, resultFile? }: resumes a pane_gone or stopped worker in a new right-split pane in the same cwd using agy --continue --dangerously-skip-permissions ... -i "<text>".',
  '- { action: "status", id } / { action: "list" }: reads current state (live-checked so a vanished pane surfaces as pane_gone), block id, and last pane lines.',
  '- { action: "stop", id, close? }: sends Esc to interrupt the harness and marks the worker stopped (closing the pane only if close: true and this tool created it).',
  "Hard rules: never type into a pane not created here unless the caller named its blockId; never poll in a sleep loop (completion, needs_input, and pane_gone alerts arrive automatically as steered messages).",
].join("\n")
