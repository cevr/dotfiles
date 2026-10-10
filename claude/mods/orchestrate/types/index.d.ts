export type TrackView = {
  track: string
  unit: string
  step: string
  holder: string
  round: number
  failures: number
  since: number
  agents: { role: string; name: string; status: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    orchestrate: { tracks: TrackView[] }
  }
}
