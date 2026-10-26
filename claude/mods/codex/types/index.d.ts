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
/** This session's threads as last read from the bridge, and when. */
export type View = { at: number; threads: Thread[] }
/** The thread and turn a start or send call's row shows, by its tool_use_id. */
export type Row = { thread: string; turn: number }

declare module 'claude-code' {
  interface PluginState {
    codex: { view: View; rows: Record<string, Row> }
  }
}
