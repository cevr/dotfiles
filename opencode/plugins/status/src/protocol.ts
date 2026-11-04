export const STATUS = {
  id: "opencode-gent.status",
  methods: { status: { input: { type: "object" }, output: { type: "object" } } },
  events: {},
} as const
export interface AgentCall {
  readonly sessionID: string
  readonly callID: string
  readonly agent: string
  readonly description?: string
  readonly child?: string
  readonly status?: string
}
export interface Unit { readonly unit: string; readonly state: string; readonly round: string; readonly since: string }
export interface Run { readonly name: string; readonly units: readonly Unit[] }
export interface Snapshot { readonly agents: readonly AgentCall[]; readonly runs: readonly Run[]; readonly errors: readonly string[] }
