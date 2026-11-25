import { Option } from "effect"

/**
 * The acceptance checks that are red at this lane's base, 44f5ed09, each with the finding it reproduces.
 * They are held as `test.failing` (the repo's red-first form, as in mods/pool/claim-rule.test.ts): the gate
 * passes while they stay red and fails the moment one turns green, so the pane-agent-shell unit removes an
 * entry here in the change that turns its check green. Only the orchestrator edits this list otherwise.
 */
export const KNOWN_RED_AT_BASE: ReadonlyArray<readonly [string, string]> = [
  ["scenario H-alive-never-answers", "H (diagnosis §3): one blocks.alive that never answers hangs follow_up and every later call on the worker"],
  ["scenario I-read-defect-in-watcher", "I (diagnosis §3): one defect in the pane-io fiber; the turn never settles, status says working forever"],
  ["scenario G-write-fails-during-idle-follow-up", "G (diagnosis §3): a failed write after Persist(typed); the call fails, the store says typed, the worker wedges"],
  ["scenario F1-changed-defect", "F1 (r3): one notifier.changed defect kills the actor; every later tool call hangs"],
  ["scenario Qa-conflict-reload-second-process", "Q-a reload (r3; diagnosis #9): a command conflict never reloads; the worker conflicts for good"],
  ["scenario usage-limit", "SPEC v2 usage-limit addition: no head recognises the quota frame; a limited turn is reported done"],
  ["batch crash", "diagnosis #5, #3, #8 and R1's class: a crash between split and persist orphans a pane; a crash after Persist(typed) reports a turn that never ran"],
  ["batch await:reattach", "W across commands: reattach during start spawns a second actor for the worker, which then conflicts for good"],
  ["batch await:second:follow_up", "two processes on one store (r3 §3, diagnosis §2): the first server's actor is stale and wedges"],
  ["batch await:second:steer", "two processes on one store: the first server's actor is stale and wedges"],
  ["batch await:second:stop", "two processes on one store: a stop from the second server leaves the first one's view false"],
  ["batch await:second:stop_close", "two processes on one store: queued turns lost across the two writers"],
  ["batch await:second:reattach", "two processes on one store: the second server's reattach wedges the first"],
  ["batch seeds", "the seeded generator: hangs (H, diagnosis #2, #11), writes into prompts on stop, lost and false wakes"],
  ["batch pairs", "one fault per (boundary, fault) pair: typed failures, defects and hangs at most boundaries break liveness or truth"],
]

export const knownRed = (name: string): Option.Option<string> =>
  Option.map(Option.fromUndefinedOr(KNOWN_RED_AT_BASE.find(([key]) => key === name)), ([, reason]) => reason)
