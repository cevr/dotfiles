import { Option } from "effect"
import { PINS } from "./pins.ts"
import { type Fingerprint, formatInvariants } from "./property.ts"

/**
 * The acceptance checks red at this lane's base, 44f5ed09, pinned (SPEC v2 ruling 7). Each pin in `pins.ts`
 * is the exact red set of one check: the job names (scenarios, or the runs of a batch slice) with the
 * invariants each broke. A check passes only while its red set equals its pin, so a new red, a changed
 * invariant, a timeout or a pinned job that turned green fails the gate; the pane-agent-shell unit shrinks a
 * pin in the change that turns its jobs green. Only the orchestrator edits the pins otherwise.
 */
const REASONS: ReadonlyArray<readonly [string, string]> = [
  ["scenario H-", "H (diagnosis §3): one blocks.alive that never answers hangs follow_up and every later call on the worker"],
  ["scenario I-", "I (diagnosis §3): one defect in the pane-io fiber; the turn never settles, status says working forever"],
  ["scenario G-", "G (diagnosis §3): a failed write after Persist(typed); the call fails, the store says typed, the worker wedges"],
  ["scenario F1-", "F1 (r3): one notifier.changed defect kills the actor; every later tool call hangs"],
  ["scenario Qa-", "Q-a reload (r3; diagnosis #9): a command conflict never reloads; the worker conflicts for good"],
  ["scenario usage-limit", "SPEC v2 ruling 5: no head reports a limited turn or resumes it; a limited turn is reported done"],
  ["scenario D12-", "diagnosis #12: reattach walks the workers one by one; one hang leaves every later worker unattached"],
  ["scenario named-", "a pane the caller named"],
  ["batch crash", "diagnosis #5, #3, #8 and R1's class: a crash between split and persist orphans a pane; a crash after Persist(typed) reports a turn that never ran"],
  ["batch await:second:", "two processes on one store (r3 §3, diagnosis §2): the first server's actor is stale and wedges"],
  ["batch await:", "W across commands and workers: a command at an await point of another worker's step"],
  ["batch seeds", "the seeded generator: hangs (H, diagnosis #2, #11), writes into prompts on stop, lost and false wakes"],
  ["batch pairs", "one fault per (boundary, fault, call): typed failures, defects and hangs at most boundaries break liveness or truth"],
  ["scenario ", "a scenario red at the base"],
]

export const reasonOf = (key: string): string => Option.getOrElse(Option.fromUndefinedOr(REASONS.find(([prefix]) => key.startsWith(prefix))?.[1]), () => "red at the base")

/** The pinned red set of a check (empty when the check must be green). */
export const pinnedRed = (key: string): Fingerprint => Option.getOrElse(Option.fromUndefinedOr(PINS[key]), () => ({}))

export const isPinned = (key: string): boolean => Object.keys(pinnedRed(key)).length > 0

/** How an observed red set differs from its pin: new reds, changed invariants, pinned jobs now green. */
export const pinDiff = (pinned: Fingerprint, observed: Fingerprint): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const [job, ids] of Object.entries(observed)) {
    const want = Option.fromUndefinedOr(pinned[job])
    if (Option.isNone(want)) out.push(`new red: ${job} ${formatInvariants(ids)} (not in the pin)`)
    if (Option.exists(want, (w) => formatInvariants(w) !== formatInvariants(ids))) out.push(`changed: ${job} pinned ${formatInvariants(Option.getOrElse(want, () => []))}, now ${formatInvariants(ids)}`)
  }
  for (const [job, ids] of Object.entries(pinned)) {
    if (!(job in observed)) out.push(`turned green: ${job} (pinned ${formatInvariants(ids)}): shrink its pin in sim/pins.ts`)
  }
  return out
}
