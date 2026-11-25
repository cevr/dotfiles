import { Option } from "effect"
import { PINS, type PinTable } from "./pins.ts"
import { type Fingerprint } from "./property.ts"

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

/**
 * The named signature classes (ruling 7, widened): one real fault, with its diagnosis or review reference, and the
 * signatures it shows as. Every pinned signature must belong to one (a unit test checks it).
 */
export const CLASSES: ReadonlyArray<{ readonly name: string; readonly reference: string; readonly pattern: RegExp }> = [
  {
    name: "StoreConflict wedge",
    reference: "Q-a reload (r3), diagnosis #9, two processes on one store (r3 §3): a stale actor's follow_up conflicts for good",
    pattern: /^I8 \S+: with faults off and the pane idle, a follow_up still fails \(StoreConflict\): the worker is wedged$/,
  },
  {
    name: "status disagrees with the store",
    reference: "Q-a reload (r3), review r2 grouping: a stale actor's view against another writer's row",
    pattern: /^I6 \S+: at quiescence status says \S+\/turn N but the store says \S+\/turn N$/,
  },
  { name: "call never answers", reference: "H and F1 (diagnosis §3, r3), diagnosis #2, #11 and #12: a tool call with no bound", pattern: /^I1 \S+#N \(\S+\) did not answer within N ms$/ },
  { name: "untyped defect reaches the caller", reference: "F1 (r3), diagnosis §3 I: a defect is not a typed error", pattern: /^I1 \S+#N \(\S+\) died with an untyped defect: Error: sim: defect injected at [a-z]+\.[A-Za-z]+ #N$/ },
  { name: "settled turn never woken", reference: "I, R1 and Q2 (diagnosis §3, r1, r2): a turn ends in the pane and no done wake carries it", pattern: /^I4 \S+ turn N \(<tok>\) ended in the pane, but no done wake ever carried its answer$/ },
  { name: "duplicate wake", reference: "I4 one wake per (turn, kind), diagnosis section 4", pattern: /^I4 \S+: N distinct wakes for \(turn, kind\) N:\S+$/ },
  { name: "done before the turn ended", reference: "B1 and R3 (r1), review r2 (await:second:reattach@10: a ready screen read as done)", pattern: /^I6 \S+: done wake for turn N \(<tok>\) at t=N, but that turn had not ended in the pane$/ },
  { name: "answer re-delivered for another turn", reference: "diagnosis #8: a crash after Persist(typed) reports a turn that never ran", pattern: /^I6 \S+: done wake for turn N at t=N carries the answer of turn N \(<tok>\), a turn already reported$/ },
  { name: "working with no typed turn", reference: "I and G (diagnosis §3): the store says working forever", pattern: /^I6 \S+: at quiescence the store says working, but no typed turn is open in the pane$/ },
  { name: "status says done too early", reference: "B3 (r1), I6 truth: a reply claims done before the turn ended", pattern: /^I6 \S+: status#N says done at t=N, but turn N \(<tok>\) has not ended in the pane$/ },
  { name: "orphan split", reference: "diagnosis #5, ruling (2): a split no record owns and no \"split result unknown\"", pattern: /^I2 \S+: pane <block> was split by the unit and is running, but no worker record owns it/ },
  { name: "store ahead of the caller", reference: "G (diagnosis §3, #7): the store records a turn the caller was refused", pattern: /^I2 \S+: the store records turn N, but the caller saw only N turn\(s\) accepted$/ },
  { name: "refused yet typed", reference: "review r2 grouping, G's class: a refused turn was typed", pattern: /^I2 \S+: <tok> was refused to the caller, yet typed Nx$/ },
  { name: "accepted turn never typed", reference: "E1 and Q1 (r2), ruling (3): no not_typed report", pattern: /^I3 \S+ turn N \(<tok>, \S+\) was accepted but never typed and never reported "not typed"$/ },
  { name: "write into a prompt", reference: "B2 (r1): bytes typed while a trust or permission prompt shows", pattern: /^I5 \S+: wrote .* into <block> while it showed a \S+ prompt \(t=N\)$/ },
  { name: "queued turn never typed", reference: "Q1 (r2), F1 (r3): a queued turn waits on an idle pane", pattern: /^I8 \S+: N queued turn\(s\) never typed though the pane is idle$/ },
  { name: "wake stuck in the outbox", reference: "R1 and Q2 (r1, r2), diagnosis #3: a pending wake never delivered", pattern: /^I8 \S+: N wake\(s\) still pending in the outbox at quiescence$/ },
  { name: "usage limit not handled", reference: "SPEC v2 addition and ruling (5): no limited wake, no resume", pattern: /^I9 \S+ turn N \(<tok>\) hit the usage limit at t=N(, but no "limited" wake reported it|; never resumed after its reset at t=N and never reported "not typed")$/ },
]

export const classOf = (signature: string): Option.Option<string> =>
  Option.map(Option.fromUndefinedOr(CLASSES.find((item) => item.pattern.test(signature))), (item) => item.name)

/** The pinned red set of a check (empty when the check must be green). */
export const pinnedRed = (key: string, table: PinTable = PINS): Fingerprint => Option.getOrElse(Option.fromUndefinedOr(table[key]), () => ({}))

export const isPinned = (key: string): boolean => Object.keys(pinnedRed(key)).length > 0

const counts = (signatures: ReadonlyArray<string>): ReadonlyMap<string, number> => {
  const out = new Map<string, number>()
  for (const signature of signatures) out.set(signature, Option.getOrElse(Option.fromUndefinedOr(out.get(signature)), () => 0) + 1)
  return out
}

/** How an observed red set differs from its pin, per job and signature counted as a multiset: extra, missing, or a job turned green. */
export const pinDiff = (pinned: Fingerprint, observed: Fingerprint): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const [job, signatures] of Object.entries(observed)) {
    const want = counts(Option.getOrElse(Option.fromUndefinedOr(pinned[job]), () => []))
    const seen = counts(signatures)
    for (const [signature, n] of seen) {
      const pinnedN = Option.getOrElse(Option.fromUndefinedOr(want.get(signature)), () => 0)
      if (n > pinnedN) out.push(`new violation: ${job}: ${signature} seen ${n}x, pinned ${pinnedN}x`)
    }
    for (const [signature, n] of want) {
      const seenN = Option.getOrElse(Option.fromUndefinedOr(seen.get(signature)), () => 0)
      if (seenN < n) out.push(`missing: ${job}: ${signature} pinned ${n}x, seen ${seenN}x: shrink its pin in sim/pins.ts`)
    }
  }
  for (const job of Object.keys(pinned)) {
    if (!(job in observed)) out.push(`turned green: ${job} (pinned with ${(pinned[job] ?? []).length} signature(s)): shrink its pin in sim/pins.ts`)
  }
  return out
}
