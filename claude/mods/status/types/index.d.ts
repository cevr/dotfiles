export type Pool = { agents: number; cap: number; hosts: string[] }
export type Unit = { unit: string; state: string; round: number; since: string }
export type Run = { name: string; units: Unit[] }

// One Claude account as teamclaude reports it: use as a fraction of each
// window (1 is spent), the window's reset, and the weekly burn per hour.
export type Account = {
  label: string
  used5h: number
  usedWeek: number
  reset5h?: number
  resetWeek?: number
  weekPerHour: number
}
// A 5-hour reading of every account, to measure the 5-hour burn.
export type Sample = { at: number; used5h: number[] }
export type LimitWindow = '5h' | 'week'
// The first time the pool has no quota left at the current pace, and when an
// account frees again; none when the pool lasts past every reset ahead.
export type Outlook = {
  limitedAt?: number
  freeAt?: number
  window?: LimitWindow
  live: number
  total: number
  weekPerHour: number
  fiveHourPerHour?: number
}
export type Snapshot = {
  at: number
  accounts: Account[]
  samples: Sample[]
  outlook?: Outlook
  pool?: Pool
  runs: Run[]
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    status: { snapshot: Snapshot }
  }
}
