/** What a thread's current or last turn does (bridge.ts `Live`). */
export type Live = {
  since: number
  running: Record<string, string>
  steps: { at: number; text: string; failed?: boolean }[]
  commands: number
  edits: number
  tools: number
  plan?: { step: string; status: string }[]
}
export type Usage = { tokens: number; context: number; window: number }
export type Thread = {
  id: string
  description: string
  model: string
  effort?: string
  status: string
  turns: number
  compactions: number
  final?: string
  usage?: Usage
  live?: Live
  updatedAt: number
}
/** A budget gate (bridge/budget.ts `Gate`): whether a call goes on; when held, why and from when (ms). */
export type Gate = { ok: boolean; reason?: string; until?: number }
/** The Codex budget as the bridge decides it (bridge/budget.ts `Budget`). */
export type Budget = { start: Gate; send: Gate; summary: string }
/** This session's threads and the Codex budget as last read from the bridge, and when. */
export type View = { at: number; threads: Thread[]; budget?: Budget }
/** The thread and turn a start or send call's row shows, by its tool_use_id. */
export type Row = { thread: string; turn: number }

declare module 'claude-code' {
  interface PluginState {
    codex: { view: View; rows: Record<string, Row> }
  }
}
