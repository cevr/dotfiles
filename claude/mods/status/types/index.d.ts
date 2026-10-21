export type Pool = { agents: number; cap: number; megaWeighted: number; hosts: string[] }
export type Unit = { unit: string; state: string; round: number; since: string }
export type Run = { name: string; units: Unit[] }
export type Snapshot = { at: number; pool?: Pool; runs: Run[]; error?: string }

declare module 'claude-code' {
  interface PluginState {
    status: { snapshot: Snapshot }
  }
}
