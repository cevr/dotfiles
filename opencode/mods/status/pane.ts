// What the /pool pane draws, as text: each pool account with its hold and its
// 5-hour and 7-day windows, each running agent with its role and what it was
// asked, and each run's units. The pane reads the pool's RPC
// (dotfiles-opencode.pool) and this mod's (status.ts) and draws these rows.
import { Schema } from "effect"
import type { AgentCall, Unit } from "./status.ts"

/**
 * One pool account, as much of the pool's status answer as the pane draws.
 * The pool's `AccountStatus` (`@dotfiles/opencode-pool/status`) carries these
 * fields and more; the pane reads only these, so it needs no import of the
 * pool's model.
 */
export const PaneAccount = Schema.Struct({
  credentialID: Schema.String,
  hold: Schema.optionalKey(Schema.Struct({ kind: Schema.String, until: Schema.Number })),
  reading: Schema.optionalKey(
    Schema.Struct({
      windows: Schema.Array(
        Schema.Struct({ name: Schema.String, utilization: Schema.Number, resetAt: Schema.optionalKey(Schema.Number) }),
      ),
    }),
  ),
})
export type PaneAccount = typeof PaneAccount.Type

/** The pool's status answer as the pane reads it: each pool's accounts, by integration id. */
export const PanePools = Schema.Record(Schema.String, Schema.Struct({ accounts: Schema.Array(PaneAccount) }))
export type PanePools = typeof PanePools.Type

/** An epoch-ms time as `YYYY-MM-DD HH:MMZ`, or `unknown`. */
export const stamp = (at?: number) => (at === undefined ? "unknown" : new Date(at).toISOString().slice(0, 16).replace("T", " ") + "Z")

/** The windows each account shows, whether or not it has a reading of them. */
const WINDOWS = ["5h", "7d"] as const

export interface AccountRow {
  readonly held: boolean
  /** `<pool> / <credential> · held (<kind>) until <time>`, or `· available`. */
  readonly title: string
  /** One line per window: `  5h 23% · reset <time>`. */
  readonly windows: ReadonlyArray<string>
}

/** Every pool's accounts, in the order the pool lists them. */
export const accountRows = (pools: PanePools): ReadonlyArray<AccountRow> =>
  Object.entries(pools).flatMap(([pool, entry]) =>
    entry.accounts.map((account) => ({
      held: account.hold !== undefined,
      title: `${pool} / ${account.credentialID} · ${account.hold ? `held (${account.hold.kind}) until ${stamp(account.hold.until)}` : "available"}`,
      windows: WINDOWS.map((name) => {
        const window = account.reading?.windows.find((item) => item.name === name)
        return `  ${name} ${window ? `${Math.round(window.utilization * 100)}%` : "unknown"} · reset ${stamp(window?.resetAt)}`
      }),
    })),
  )

/** A running child session of the pane's session, as OpenCode knows it. */
export interface RunningSession {
  readonly id: string
  readonly agent?: string
  readonly title?: string
}

export interface AgentRow {
  readonly id: string
  readonly role: string
  readonly description: string
}

/**
 * Each running child session, named by its agent and described by the call
 * that started it (the call log's description), else by its title, else its id.
 */
export const agentRows = (running: ReadonlyArray<RunningSession>, calls: ReadonlyArray<AgentCall>): ReadonlyArray<AgentRow> =>
  running.map((session) => {
    const call = calls.find((item) => item.child === session.id)
    return { id: session.id, role: session.agent ?? call?.agent ?? "agent", description: call?.description ?? session.title ?? session.id }
  })

/** A unit's line under its run. */
export const unitLine = (unit: Unit) => `  ${unit.unit} · ${unit.state} · r${unit.round || "?"} · ${unit.since}`

/** Which of the pane's two reads failed this time; the pane keeps the last reading of each. */
export const unavailable = (pool: boolean, status: boolean): ReadonlyArray<string> => [
  ...(pool ? ["Pool unavailable; keeping last reading"] : []),
  ...(status ? ["Agents and runs unavailable; keeping last reading"] : []),
]
