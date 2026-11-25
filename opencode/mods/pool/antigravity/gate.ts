// Start gate and cross-host Gemini concurrency cap for agy panes and workers.
// The orchestrator's pane helper calls `checkStartGate` (pure) or the pool's
// `antigravity` tool/RPC (`action: "gate"`) before starting or resuming an agy
// pane or worker:
// - If the model's quota group is limited (from any host's pane limit or full
//   window in the merged record) -> Held with a finite retryAt (> now).
// - An unknown or absent window (or stale peer with no limit) NEVER blocks a
//   start by itself (nullable limits rule).
// - For Gemini, concurrent agents are counted ACROSS hosts from the fleet's
//   unsettled starts: default 4 per agent and 4 across the fleet (from Wed's
//   measurement: all panes together emptied Gemini's 5-hour window in ~4.5 h,
//   ~11% faster than the 5h window; capping at 4 per agent and 4 fleet-wide
//   lets one host burst to 4 when the other host is idle while preventing two
//   hosts from running 8 concurrent panes and draining the window in ~2.25 h).
//   The owner can adjust either cap in the pool's `antigravity.geminiCap` option.
// Pure: no clock, no I/O.
import { Array as Arr, Option, Schema } from "effect"
import { formatNotificationTime } from "@dotfiles/decider/notification-time"
import { type MergedRecord, openDecisionAt, OpenStatus, resolveGroup } from "./fleet.ts"
import { GEMINI } from "./quota.ts"
import { Answer } from "./state.ts"
import { openDecisionText } from "./text.ts"

/** Provider prefix recorded in the fleet's starts for concurrent Gemini panes/workers. */
export const GEMINI_START_PREFIX = "antigravity:gemini"

/** Fallback recheck delay when a cap holds without a future start expiry. */
export const CAP_RECHECK_MS = 2 * 60_000

/** Same clock-skew tolerance as mods/pool/fleet.ts `SKEW_MS`. */
const SKEW_MS = 60_000

/** Concurrency cap for Gemini agents: per agent (caller/role) and fleet-wide total across hosts. */
export const GeminiCap = Schema.Struct({
  perAgent: Schema.Int.check(Schema.isGreaterThan(0)),
  fleet: Schema.Int.check(Schema.isGreaterThan(0)),
})
export type GeminiCap = typeof GeminiCap.Type

/**
 * Default concurrency cap derived from Wed measurements (plan.md):
 * all panes together emptied Gemini's 5-hour window in ~4.5 h (~11% over
 * sustainable 5h pace). Capping at 4 per agent and 4 fleet total lets one host
 * run up to 4 when the other is quiet while preventing 2 hosts × 4 = 8 from
 * draining the 5-hour window in ~2.25 h.
 */
export const DEFAULT_GEMINI_CAP: GeminiCap = { perAgent: 4, fleet: 4 }

/** Provider string recorded in the fleet's starts for one Gemini agent start. */
export const geminiStartProvider = (agent?: string): string =>
  Option.match(
    Option.filter(Option.map(Option.fromUndefinedOr(agent), (name) => name.trim()), (name) => name !== ""),
    { onNone: () => GEMINI_START_PREFIX, onSome: (name) => `${GEMINI_START_PREFIX}:${name}` },
  )

/** Whether a fleet start's `providerID` is a Gemini Antigravity start. */
export const isGeminiStart = (providerID: string): boolean =>
  providerID === GEMINI_START_PREFIX || providerID.startsWith(`${GEMINI_START_PREFIX}:`)

/** The agent name carried by a Gemini start's `providerID`, if any. */
export const agentOfGeminiStart = (providerID: string): Option.Option<string> =>
  Option.map(
    Option.liftPredicate(providerID, (id) => id.startsWith(`${GEMINI_START_PREFIX}:`)),
    (id) => id.slice(GEMINI_START_PREFIX.length + 1),
  )

export interface FleetStart {
  readonly providerID: string
  readonly at: number
}

export interface GateQuery {
  readonly model?: string
  readonly group?: string
  readonly agent?: string
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

const unsettledGemini = (starts: ReadonlyArray<FleetStart>, now: number, settleMs: number): ReadonlyArray<FleetStart> =>
  starts.filter((start) => isGeminiStart(start.providerID) && start.at > now - settleMs && start.at <= now + SKEW_MS)

const capRetryAt = (starts: ReadonlyArray<FleetStart>, now: number, settleMs: number): number => {
  const expiries = starts.flatMap((start) => Option.toArray(Option.filter(Option.some(start.at + settleMs), (at) => at > now)))
  return Arr.match(expiries, {
    onEmpty: () => now + CAP_RECHECK_MS,
    onNonEmpty: (future) => Math.min(...future),
  })
}

/**
 * Start gate for starting or resuming an agy pane or worker:
 * 1. Check the model/group's merged Antigravity status: limited -> Held with finite reset/retry time.
 *    An unknown or absent window (or stale peer without a limit) NEVER blocks by itself.
 * 2. For Gemini, enforce the cross-host fleet concurrency cap and per-agent cap from the fleet's starts.
 */
export const checkStartGate = (input: {
  readonly merged: MergedRecord
  readonly fleetStarts: ReadonlyArray<FleetStart>
  readonly ownStarts?: ReadonlyArray<FleetStart>
  readonly settleMs: number
  readonly cap?: GeminiCap
  readonly now: number
  readonly query: GateQuery
}): GateDecision => {
  const cap = Option.getOrElse(Option.fromUndefinedOr(input.cap), () => DEFAULT_GEMINI_CAP)
  const rawTarget = Option.orElse(Option.fromUndefinedOr(input.query.group), () => Option.fromUndefinedOr(input.query.model))
  const group = Option.getOrElse(
    Option.map(rawTarget, (name) => Option.getOrElse(resolveGroup(name), () => name)),
    () => GEMINI,
  )
  const fleetGemini = unsettledGemini(input.fleetStarts, input.now, input.settleMs)
  const agent = Option.filter(Option.map(Option.fromUndefinedOr(input.query.agent), (name) => name.trim()), (name) => name !== "")
  const agentGemini = Option.match(agent, {
    onSome: (named) => fleetGemini.filter((start) => Option.contains(agentOfGeminiStart(start.providerID), named)),
    onNone: () => unsettledGemini(Option.getOrElse(Option.fromUndefinedOr(input.ownStarts), () => input.fleetStarts), input.now, input.settleMs),
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
    if (geminiFleetCount >= cap.fleet) {
      const retryAt = capRetryAt(fleetGemini, input.now, input.settleMs)
      return GateDecision.cases.Held.make({
        group,
        why: "gemini-cap-fleet",
        retryAt,
        reason: `gemini fleet concurrency cap reached (${geminiFleetCount}/${cap.fleet} across hosts); retry at ${formatNotificationTime(retryAt)}`,
        answer: status.answer,
        geminiFleetCount,
        geminiAgentCount,
      })
    }
    if (geminiAgentCount >= cap.perAgent) {
      const retryAt = capRetryAt(agentGemini, input.now, input.settleMs)
      const scope = Option.match(agent, { onNone: () => "this host", onSome: (name) => `agent ${name}` })
      return GateDecision.cases.Held.make({
        group,
        why: "gemini-cap-agent",
        retryAt,
        reason: `gemini concurrency cap reached for ${scope} (${geminiAgentCount}/${cap.perAgent}); retry at ${formatNotificationTime(retryAt)}`,
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
      `admitted (${group}): ${openDecisionText(OpenStatus.cases.Now.make({ measured, answer }))} · gemini fleet ${geminiFleetCount}`,
    Held: ({ group, reason, retryAt }) => `held (${group}) until ${formatNotificationTime(retryAt)}: ${reason}`,
  })
