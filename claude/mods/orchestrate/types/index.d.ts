export type TrackView = {
  track: string
  round: number
  label: string
  next: 'impl' | 'rev' | 'ver' | 'orch'
  workers: Partial<Record<'impl' | 'rev' | 'ver', 'idle' | 'working' | 'blocked' | 'done' | 'unknown'>>
  stall?: string
}

declare module 'claude-code' {
  interface PluginState {
    orchestrate: { tracks: TrackView[] }
  }
}
