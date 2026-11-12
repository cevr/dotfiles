// What the /pool pane draws, as text: each pool account with its hold and its
// 5-hour and 7-day windows, each running agent with its role and what it was
// asked, each run's units, and the fleet: the agents this host and each of the
// owner's other hosts admitted that still count on the pace, and a host that
// cannot be read; and the rate-limit resets the pool works: a question waiting
// on the owner, a claim under way, the claims made. The pane reads the pool's RPC
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
      resets: Schema.optionalKey(
        Schema.Struct({
          available: Schema.Number,
          nextExpiresAt: Schema.optionalKey(Schema.Number),
          credits: Schema.optionalKey(
            Schema.Array(
              Schema.Struct({
                count: Schema.Number,
                usable: Schema.Boolean,
                expiresAt: Schema.optionalKey(Schema.Number),
                clears: Schema.optionalKey(Schema.Array(Schema.String)),
                kind: Schema.optionalKey(Schema.String),
                givesBack: Schema.optionalKey(Schema.Boolean),
                requiresLimit: Schema.optionalKey(Schema.Boolean),
                paused: Schema.optionalKey(Schema.Boolean),
              }),
            ),
          ),
        }),
      ),
    }),
  ),
})
export type PaneAccount = typeof PaneAccount.Type
type PaneCredit = NonNullable<NonNullable<NonNullable<PaneAccount["reading"]>["resets"]>["credits"]>[number]

/** A reset's kind as the row names it (the pool's resets.ts `KIND_LABEL`). */
const KINDS: Readonly<Record<string, string>> = {
  session: "5-hour reset",
  weekly: "weekly reset",
  fable: "Fable reset",
  full: "full reset",
  codex: "Codex reset",
}

/** A provider's window name as the row says it; Claude Code calls `seven_day_overage_included` the Fable limit. */
const CLEARS: Readonly<Record<string, string>> = {
  five_hour: "5h",
  seven_day: "weekly",
  seven_day_overage_included: "Fable week",
  seven_day_opus: "Opus week",
  seven_day_sonnet: "Sonnet week",
}

/**
 * One reset an account holds: `  Fable reset ×2 · until 2027-02-01 · clears 5h,
 * Fable week; gives back Fable's part of the weekly · needs a limit`. A Codex
 * credit restarts every window. A spent or expired one is left out.
 */
const creditLine = (pool: string, credit: PaneCredit, now: number): string | undefined => {
  if (credit.count <= 0 || (credit.expiresAt !== undefined && credit.expiresAt <= now)) return undefined
  const kind = credit.kind ?? (pool === "openai" ? "codex" : undefined)
  const name = kind === undefined ? "reset" : (KINDS[kind] ?? kind)
  const clears =
    kind === "codex"
      ? "clears every window"
      : `clears ${(credit.clears ?? []).map((window) => CLEARS[window] ?? window).join(", ") || "unread"}${credit.givesBack === true ? "; gives back Fable's part of the weekly" : ""}`
  const state = credit.paused === true ? " · paused" : credit.usable ? "" : credit.requiresLimit === true ? " · needs a limit" : " · not claimable now"
  return `  ${name}${credit.count > 1 ? ` ×${credit.count}` : ""}${credit.expiresAt === undefined ? "" : ` · until ${day(credit.expiresAt)}`} · ${clears}${state}`
}

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
   * window, `  Fable 7d 12% · reset <time>`; then each reset the account
   * holds, with its kind, expiry and what it clears (`creditLine`), or
   * `  resets 2 · until <date>` when only their count was read.
   */
  readonly windows: ReadonlyArray<string>
}

/** `YYYY-MM-DD` of an epoch-ms time. */
const day = (at: number) => stamp(at).slice(0, 10)

/** Every pool's accounts, in the order the pool lists them; `now` leaves out a reset already expired. */
export const accountRows = (pools: PanePools, now = Date.now()): ReadonlyArray<AccountRow> =>
  Object.entries(pools).flatMap(([pool, entry]) =>
    entry.accounts.map((account) => {
      const resets = account.reading?.resets
      const credits = (resets?.credits ?? []).flatMap((credit) => {
        const line = creditLine(pool, credit, now)
        return line === undefined ? [] : [line]
      })
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
          // Each reset listed, else the count when only the count was read.
          ...(credits.length > 0
            ? credits
            : resets !== undefined && resets.available > 0
              ? [`  resets ${resets.available}${resets.nextExpiresAt === undefined ? "" : ` · until ${day(resets.nextExpiresAt)}`}`]
              : []),
        ],
      }
    }),
  )

/**
 * The pool's limits answer as the pane reads it: only its line, what each model
 * family costs in % of one account's limit per Mtok (the pool's limits.ts
 * `limitsLine`). No line until a window period has been read with tokens in it.
 */
export const PaneLimits = Schema.Struct({ line: Schema.optionalKey(Schema.String) })
export type PaneLimits = typeof PaneLimits.Type

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

/**
 * The pool's resets answer as the pane reads it: as much of the pool's
 * `ResetsStatus` (`@dotfiles/opencode-pool/status`) as the pane draws, each
 * reset being worked and each claim made, newest first.
 */
export const PaneResets = Schema.Struct({
  resets: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      label: Schema.String,
      stage: Schema.String,
      why: Schema.String,
      at: Schema.Number,
      outcome: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String),
      kind: Schema.optionalKey(Schema.String),
      told: Schema.optionalKey(Schema.String),
    }),
  ),
  claims: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      label: Schema.String,
      at: Schema.Number,
      outcome: Schema.String,
      message: Schema.optionalKey(Schema.String),
      weekly: Schema.String,
    }),
  ),
  /** Each pool's use-or-lose forecast and each push active on the host, as lines. */
  forecast: Schema.optionalKey(Schema.Array(Schema.String)),
  pushes: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type PaneResets = typeof PaneResets.Type

export interface ResetRow {
  /** One waiting on the owner: a question in the tray. */
  readonly asking: boolean
  readonly text: string
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = { claude: "Claude", codex: "Codex" }

/** What a reset's stage says on its row. */
const STAGES: Readonly<Record<string, string>> = {
  asked: "asked the owner, waiting for an answer",
  claiming: "claiming",
  failed: "claim did not go through, will retry",
  settled: "settled",
  declined: "the owner said no",
  withdrawn: "question withdrawn",
}

/** The weekly window after a claim, as the row says it. */
const WEEKLY: Readonly<Record<string, string>> = { moved: "weekly reset moved", kept: "weekly reset kept", unread: "weekly reset unread" }

/**
 * Each reset being worked (`Claude · Max 1 · asked the owner, waiting for an
 * answer · 2026-11-09 12:00Z`), then the claims made, newest first (`claimed
 * Codex · work · reset · weekly reset moved · <time>`). None when the pool
 * has worked none.
 */
const WHY: Readonly<Record<string, string>> = { expiring: " (expiring unused)", offer: " (offered on demand)", push: " (for a push)" }

/** A reset's provider and kind as its row names them: `Claude Fable reset`, or the provider alone when no kind was read. */
const resetName = (reset: { readonly provider: string; readonly kind?: string }) => {
  const provider = PROVIDER_NAMES[reset.provider] ?? reset.provider
  return reset.kind === undefined || reset.kind === "codex" ? provider : `${provider} ${KINDS[reset.kind] ?? reset.kind}`
}

export const resetRows = (resets: PaneResets): ReadonlyArray<ResetRow> => [
  // The pushes on, then the resets that would expire unused at this rate.
  ...(resets.pushes ?? []).map((text) => ({ asking: false, text })),
  ...(resets.forecast ?? []).map((text) => ({ asking: false, text })),
  ...resets.resets
    .filter((reset) => reset.stage === "asked" || reset.stage === "claiming" || reset.stage === "failed")
    .map((reset) => ({
      asking: reset.stage === "asked",
      text: `${resetName(reset)} · ${reset.label} · ${STAGES[reset.stage] ?? reset.stage}${WHY[reset.why] ?? ""} · ${stamp(reset.at)}`,
    })),
  // A reset claimed on its own, and what the owner was told.
  ...resets.resets
    .filter((reset) => reset.told !== undefined)
    .map((reset) => ({ asking: false, text: `${resetName(reset)} · ${reset.label} · ${reset.told} · ${stamp(reset.at)}` })),
  ...resets.claims.map((claim) => ({
    asking: false,
    text: `claimed ${PROVIDER_NAMES[claim.provider] ?? claim.provider} · ${claim.label} · ${claim.outcome}${claim.message === undefined ? "" : ` (${claim.message})`} · ${WEEKLY[claim.weekly] ?? claim.weekly} · ${stamp(claim.at)}`,
  })),
  ...resets.resets
    .filter((reset) => reset.stage === "declined" || reset.stage === "withdrawn")
    .map((reset) => ({
      asking: false,
      text: `${PROVIDER_NAMES[reset.provider] ?? reset.provider} · ${reset.label} · ${STAGES[reset.stage] ?? reset.stage}${reset.message === undefined || reset.stage !== "withdrawn" ? "" : ` (${reset.message})`} · ${stamp(reset.at)}`,
    })),
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
