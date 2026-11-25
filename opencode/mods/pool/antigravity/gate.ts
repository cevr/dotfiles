// Start gate and cross-host Gemini CONCURRENCY cap for agy panes and workers.
// The orchestrator's pane helper calls `checkStartGate` (pure) or the pool's
// `antigravity` tool/RPC (`action: "gate"`) before starting or resuming an agy
// pane or worker:
// - If the model's quota group is limited (from any host's pane limit or full
//   window in the merged record) -> Held with a finite retryAt (> now).
// - An unknown or absent window (or stale peer with no limit) NEVER blocks a
//   start by itself (nullable limits rule).
// - For Gemini, concurrent agents currently RUNNING are counted ACROSS hosts
//   from the fleet's busy set (this host's busy sessions/panes plus each peer's
//   last reported busy set while its report is within BUSY_FRESH_MS = 10 min,
//   the fleet's own staleness rule). Default cap: 4 per agent and 8 fleet total
//   across hosts (so perAgent 4 can bind on a multi-host fleet; the owner can
//   adjust either cap in the pool's `antigravity.geminiCap` option).
// - The gate always answers Admitted ("start") or Held ("hold until <finite time>").
// Pure: no clock, no I/O.
import { Array as Arr, Option, Schema } from "effect"
import { formatNotificationTime } from "@dotfiles/decider/notification-time"
import { BUSY_FRESH_MS } from "../fleet.ts"
import { type MergedRecord, openDecisionAt, OpenStatus, resolveGroup, stalePeersOf } from "./fleet.ts"
import { GEMINI } from "./quota.ts"
import { Answer } from "./state.ts"
import { openDecisionText } from "./text.ts"

/** Provider prefix recorded in the fleet's busy set for running Gemini panes/workers. */
export const GEMINI_START_PREFIX = "antigravity:gemini"

/** Fallback recheck delay when a concurrency cap holds. */
export const CAP_RECHECK_MS = 2 * 60_000

/** Concurrency cap for Gemini agents: per agent (caller/role) and fleet-wide total across hosts. */
export const GeminiCap = Schema.Struct({
  perAgent: Schema.Int.check(Schema.isGreaterThan(0)),
  fleet: Schema.Int.check(Schema.isGreaterThan(0)),
})
export type GeminiCap = typeof GeminiCap.Type

/**
 * Default concurrency cap: 4 concurrent Gemini agents per agent/role and 8
 * across the fleet (coherent so per-agent cap binds before the fleet total on a
 * two-host fleet, while still configurable by the owner in pool options).
 */
export const DEFAULT_GEMINI_CAP: GeminiCap = { perAgent: 4, fleet: 8 }

/** Provider string recorded in the fleet's busy set for one running Gemini agent. */
export const geminiStartProvider = (agent?: string): string =>
  Option.match(
    Option.filter(Option.map(Option.fromUndefinedOr(agent), (name) => name.trim()), (name) => name !== ""),
    { onNone: () => GEMINI_START_PREFIX, onSome: (name) => `${GEMINI_START_PREFIX}:${name}` },
  )

/** Whether a busy/start provider token represents a running Gemini Antigravity agent. */
export const isGeminiStart = (providerID: string): boolean =>
  providerID === GEMINI_START_PREFIX ||
  providerID.startsWith(`${GEMINI_START_PREFIX}:`) ||
  Option.contains(resolveGroup(providerID), GEMINI)

/** The agent name carried by a Gemini busy token, if any. */
export const agentOfGeminiStart = (providerID: string): Option.Option<string> =>
  Option.map(
    Option.liftPredicate(providerID, (id) => id.startsWith(`${GEMINI_START_PREFIX}:`)),
    (id) => id.slice(GEMINI_START_PREFIX.length + 1),
  )

/** One peer host's last reported busy set and when its report was seen (local clock). */
export interface PeerBusy {
  readonly host: string
  readonly busy: ReadonlyArray<string>
  readonly seenAt: number
}

export interface GateQuery {
  readonly model?: string
  readonly group?: string
  readonly agent?: string
  readonly paneId?: string
  readonly resume?: boolean
}

export const GateDecision = Schema.TaggedUnion({
  Admitted: {
    group: Schema.String,
    measured: Schema.Boolean,
    answer: Answer,
    geminiFleetCount: Schema.Finite,
    geminiAgentCount: Schema.Finite,
  },
  Held: {
    group: Schema.String,
    why: Schema.Literals(["limited", "gemini-cap-fleet", "gemini-cap-agent"]),
    retryAt: Schema.Finite,
    reason: Schema.String,
    answer: Answer,
    geminiFleetCount: Schema.Finite,
    geminiAgentCount: Schema.Finite,
  },
})
export type GateDecision = typeof GateDecision.Type

const isGeminiGroup = (group: string): boolean => group === GEMINI || group.startsWith(`${GEMINI}-`)

const capRetryAt = (
  contributingPeers: ReadonlyArray<PeerBusy>,
  staleHostNames: ReadonlySet<string>,
  now: number,
  busyFreshMs: number,
): number => {
  // If a stale peer is contributing to the count, its contribution expires at `seenAt + busyFreshMs`.
  const staleExpiries = contributingPeers
    .filter((peer) => staleHostNames.has(peer.host))
    .flatMap((peer) => Option.toArray(Option.filter(Option.some(peer.seenAt + busyFreshMs), (at) => at > now)))
  return Arr.match(staleExpiries, {
    onEmpty: () => now + CAP_RECHECK_MS,
    onNonEmpty: (future) => Math.min(now + CAP_RECHECK_MS, ...future),
  })
}

/**
 * Start gate for starting or resuming an agy pane or worker:
 * 1. Check the model/group's merged Antigravity status: limited -> Held with finite reset/retry time.
 *    An unknown or absent window (or stale peer without a limit) NEVER blocks by itself.
 * 2. For Gemini, enforce true cross-host concurrency caps (`perAgent` and `fleet`) from the fleet's
 *    busy set (own running agents + each peer's last reported running agents while `seenAt > now - busyFreshMs`).
 */
export const checkStartGate = (input: {
  readonly merged: MergedRecord
  readonly ownBusy: ReadonlyArray<string>
  readonly peerBusy: ReadonlyArray<PeerBusy>
  readonly busyFreshMs?: number
  readonly cap?: GeminiCap
  readonly now: number
  readonly query: GateQuery
}): GateDecision => {
  const cap = Option.getOrElse(Option.fromUndefinedOr(input.cap), () => DEFAULT_GEMINI_CAP)
  const busyFreshMs = Option.getOrElse(Option.fromUndefinedOr(input.busyFreshMs), () => BUSY_FRESH_MS)
  const rawTarget = Option.orElse(Option.fromUndefinedOr(input.query.group), () => Option.fromUndefinedOr(input.query.model))
  const group = Option.getOrElse(
    Option.map(rawTarget, (name) => Option.getOrElse(resolveGroup(name), () => name)),
    () => GEMINI,
  )

  const ownGemini = input.ownBusy.filter(isGeminiStart)
  const freshPeers = input.peerBusy.filter((peer) => peer.seenAt > input.now - busyFreshMs)
  const fleetGemini = [...ownGemini, ...freshPeers.flatMap((peer) => peer.busy.filter(isGeminiStart))]
  const agent = Option.filter(Option.map(Option.fromUndefinedOr(input.query.agent), (name) => name.trim()), (name) => name !== "")
  const agentGemini = Option.match(agent, {
    onSome: (named) => fleetGemini.filter((entry) => Option.contains(agentOfGeminiStart(entry), named)),
    onNone: () => ownGemini,
  })
  const geminiFleetCount = fleetGemini.length
  const geminiAgentCount = agentGemini.length

  const status = openDecisionAt(input.merged, input.now, group)
  if (status._tag === "NotNow") {
    return GateDecision.cases.Held.make({
      group,
      why: "limited",
      retryAt: status.until,
      reason: `antigravity ${group} is ${openDecisionText(status)}`,
      answer: status.answer,
      geminiFleetCount,
      geminiAgentCount,
    })
  }

  if (isGeminiGroup(group)) {
    const staleHostNames = new Set(stalePeersOf(input.merged).map((peer) => peer.host))
    const contributingPeers = freshPeers.filter((peer) => peer.busy.some(isGeminiStart))
    if (geminiFleetCount >= cap.fleet) {
      const retryAt = capRetryAt(contributingPeers, staleHostNames, input.now, busyFreshMs)
      return GateDecision.cases.Held.make({
        group,
        why: "gemini-cap-fleet",
        retryAt,
        reason: `gemini fleet concurrency cap reached (${geminiFleetCount}/${cap.fleet} running across hosts); retry at ${formatNotificationTime(retryAt)}`,
        answer: status.answer,
        geminiFleetCount,
        geminiAgentCount,
      })
    }
    if (geminiAgentCount >= cap.perAgent) {
      const agentPeers = Option.match(agent, {
        onNone: () => Arr.empty<PeerBusy>(),
        onSome: (named) => freshPeers.filter((peer) => peer.busy.some((entry) => Option.contains(agentOfGeminiStart(entry), named))),
      })
      const retryAt = capRetryAt(agentPeers, staleHostNames, input.now, busyFreshMs)
      const scope = Option.match(agent, { onNone: () => "this host", onSome: (name) => `agent ${name}` })
      return GateDecision.cases.Held.make({
        group,
        why: "gemini-cap-agent",
        retryAt,
        reason: `gemini concurrency cap reached for ${scope} (${geminiAgentCount}/${cap.perAgent} running); retry at ${formatNotificationTime(retryAt)}`,
        answer: status.answer,
        geminiFleetCount,
        geminiAgentCount,
      })
    }
  }

  return GateDecision.cases.Admitted.make({
    group,
    measured: status.measured,
    answer: status.answer,
    geminiFleetCount,
    geminiAgentCount,
  })
}

/** Concise human-readable gate decision for the tool and RPC. */
export const gateText = (decision: GateDecision): string =>
  GateDecision.match(decision, {
    Admitted: ({ group, measured, answer, geminiFleetCount }) =>
      `admitted (${group}): ${openDecisionText(OpenStatus.cases.Now.make({ measured, answer }))} · gemini running ${geminiFleetCount}`,
    Held: ({ group, reason, retryAt }) => `held (${group}) until ${formatNotificationTime(retryAt)}: ${reason}`,
  })
