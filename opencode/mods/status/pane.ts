// What the /pool pane draws, as text: each pool account with its hold and its
// 5-hour and 7-day windows, each running agent with its role and what it was
// asked, each run's units, and the fleet: the agents this host and each of the
// owner's other hosts admitted that still count on the pace, and a host that
// cannot be read. The pane reads the pool's RPC
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
      resets: Schema.optionalKey(Schema.Struct({ available: Schema.Number, nextExpiresAt: Schema.optionalKey(Schema.Number) })),
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
  /**
   * One line per window: `  5h 23% · reset <time>`; then each model's own
   * window, `  Fable 7d 12% · reset <time>`; then `  resets 2 · until <date>`
   * when the account holds resets it can claim.
   */
  readonly windows: ReadonlyArray<string>
}

/** `YYYY-MM-DD` of an epoch-ms time. */
const day = (at: number) => stamp(at).slice(0, 10)

/** Every pool's accounts, in the order the pool lists them. */
export const accountRows = (pools: PanePools): ReadonlyArray<AccountRow> =>
  Object.entries(pools).flatMap(([pool, entry]) =>
    entry.accounts.map((account) => {
      const resets = account.reading?.resets
      return {
        held: account.hold !== undefined,
        title: `${pool} / ${account.credentialID} · ${account.hold ? `held (${account.hold.kind}) until ${stamp(account.hold.until)}` : "available"}`,
        windows: [
          ...WINDOWS.map((name) => {
            const window = account.reading?.windows.find((item) => item.name === name)
            return `  ${name} ${window ? `${Math.round(window.utilization * 100)}%` : "unknown"} · reset ${stamp(window?.resetAt)}`
          }),
          ...(account.reading?.windows ?? []).flatMap((window) => {
            const at = window.name.indexOf(":")
            if (at < 0) return []
            return [`  ${window.name.slice(at + 1)} ${window.name.slice(0, at)} ${Math.round(window.utilization * 100)}% · reset ${stamp(window.resetAt)}`]
          }),
          ...(resets !== undefined && resets.available > 0
            ? [`  resets ${resets.available}${resets.nextExpiresAt === undefined ? "" : ` · until ${day(resets.nextExpiresAt)}`}`]
            : []),
        ],
      }
    }),
  )

/** The provider each pool's resets are known by. */
const RESET_NAMES: Readonly<Record<string, string>> = { anthropic: "Claude", openai: "Codex" }

/**
 * The resets every pool can claim, on one line: `resets: 2 (Claude, until
 * 2026-11-30) · 1 (Codex)`, each pool's total and its soonest expiry. None
 * when no account holds one.
 */
export const resetsLine = (pools: PanePools): string | undefined => {
  const parts = Object.entries(pools).flatMap(([pool, entry]) => {
    const held = entry.accounts.flatMap((account) => (account.reading?.resets === undefined ? [] : [account.reading.resets]))
    const available = held.reduce((total, resets) => total + resets.available, 0)
    if (available <= 0) return []
    const ends = held.flatMap((resets) => (resets.available > 0 && resets.nextExpiresAt !== undefined ? [resets.nextExpiresAt] : []))
    const name = RESET_NAMES[pool] ?? pool
    return [`${available} (${name}${ends.length === 0 ? "" : `, until ${day(Math.min(...ends))}`})`]
  })
  return parts.length === 0 ? undefined : `resets: ${parts.join(" · ")}`
}

/**
 * The pool's fleet answer as the pane reads it: the same fields as the pool's
 * `FleetStatus` (`@dotfiles/opencode-pool/status`), so it needs no import of
 * the pool's model.
 */
export const PaneFleet = Schema.Struct({
  host: Schema.String,
  starts: Schema.Number,
  settleMinutes: Schema.Number,
  peers: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      host: Schema.optionalKey(Schema.String),
      seenAt: Schema.optionalKey(Schema.Number),
      starts: Schema.Number,
      missed: Schema.optionalKey(Schema.Struct({ since: Schema.Number, message: Schema.String })),
    }),
  ),
})
export type PaneFleet = typeof PaneFleet.Type

export interface FleetRow {
  /** A host that cannot be read: the pace goes on without its new agents. */
  readonly down: boolean
  readonly text: string
}

const agentsCounting = (starts: number) => `${starts} new agent${starts === 1 ? "" : "s"} counting`

/** This host, then each peer: what it admitted that still counts on the pace, or since when it cannot be read and why. */
export const fleetRows = (fleet: PaneFleet): ReadonlyArray<FleetRow> => [
  { down: false, text: `${fleet.host} (this host) · ${agentsCounting(fleet.starts)} for ${fleet.settleMinutes} min` },
  ...fleet.peers.map((peer) =>
    peer.missed === undefined
      ? {
          down: false,
          text: `${peer.name}${peer.host === undefined || peer.host === peer.name ? "" : ` (${peer.host})`} · ${agentsCounting(peer.starts)} · read ${stamp(peer.seenAt)}`,
        }
      : { down: true, text: `${peer.name} · unreachable since ${stamp(peer.missed.since)}: ${peer.missed.message}; the pace goes on without it` },
  ),
  ...(fleet.peers.length === 0 ? [{ down: false, text: "No other hosts: the pace counts this one's new agents only." }] : []),
]

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
