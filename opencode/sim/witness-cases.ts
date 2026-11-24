/** Required coverage domains. This file declares laws, not simulator fixtures. */
export const GUARD_CALLS = ["reset", "rm-home", "rm-repo", "kill-server", "kill-other", "sleep", "harmless", "heavy"] as const
export const GUARD_FORMS = ["shell", "bash", "shell-text", "bash-text"] as const
export const GUARD_FAULTS = ["kill-other", "heavy"] as const
export const GUARD_ROLES = [false, true] as const
export const GUARD_STATES = [true, false] as const
export const GUARD_RESTART = "guard reloads its copy on the restarted world"
export const MEMORY_ANSWERS = ["saved", "updated", "corrected", "found", "none found", "forgot", "not found", "subagent", "store failed", "held digest"] as const
export const RECORD_CASES = ["six promises", "follow-up", "deferral", "decision"] as const
export const HELD_CASES = ["matching caller", "mismatching caller"] as const
export const FORM_CASES = ["opened form", "submitted form"] as const
export const YIELD_CASES = [
  "interrupted file stays owed",
  "deep run starts waiting",
  "deep run takes the lock",
  "file starts with the lock held",
  "waiting land leaves a mark",
  "deep run yields the lock",
  "land holds the lock",
  "land ends and releases the lock",
  "deep run retakes the lock after land",
  "resumed run records the failed and passed files",
  "play finishes only once the other run has died",
  "deep run ends after settling all files",
] as const

// These literals are mirrored at the domain fences; the source guard checks their values against this file.
export const RENDER_BOUNDS = [0, 199] as const
export const NEXT_BOUNDS = [0, 10] as const
export const NEXT_ACTIONS = ["land", "verify"] as const
export const POOL_CLAIM_BOUNDS = [0, 20] as const
export const POOL_WAIT_BOUNDS = [0, 100] as const
export const POOL_CLAIMS = ["forecast", "expiry"] as const
export const POOL_WAITS = ["room", "exhaustion"] as const
export const BUILD_CASES = ["an unreferenced tree build and its tree go", "a recorded tree build and its tree stay"] as const
export const UPDATE_CASES = [
  "both handoffs are proven",
  "both handoffs roll back",
  "both handoffs give up",
  "both handoffs reject listed plugins before writes",
  "cannot roll back to an untreed good build",
  "make tree aborts before handoff",
  "stage aborts before handoff",
  "crash replaces the old service and opens a competing TUI before the explicit restart",
] as const

/** The mapping from witness test to the independent declarations its cases must satisfy. */
export const coverage = [
  ["cmd/guard/guard-faults.sim.test.ts", "W: every call in every form is judged in a root and subagent, with both faults on after a restart and with faults off", { GUARD_CALLS, GUARD_FORMS, GUARD_FAULTS, GUARD_ROLES, GUARD_STATES, GUARD_RESTART }],
  ["cmd/memory/memory-faults.sim.test.ts", "W: deliberate histories meet every named answer and a failed write", { MEMORY_ANSWERS }],
  ["cmd/orchestrate/record-model.sim.test.ts", "W: six promised commitments and a reason for each successful follow-up, deferral and decision survive a restart", { RECORD_CASES }],
  ["cmd/questions/questions-held.sim.test.ts", "W: the holder answers; a different session receives NotHeld", { HELD_CASES }],
  ["mods/questions/opencode/form.test.ts", "W: a released open lists the pending form; answered keys do not return on reopen", { FORM_CASES }],
  ["scripts/accept-yield.test.ts", "W: a stopped file stays owed, the land takes the lock, and the resumed run records every verdict", { YIELD_CASES }],
  ["mods/orchestrate/tools.test.ts", "W: every render emits eight land calls and its missing-purpose hint", { RENDER_BOUNDS }],
  ["mods/orchestrate/tools.test.ts", "W: every next case recommends its ready land or due verify", { NEXT_BOUNDS, NEXT_ACTIONS }],
  ["mods/pool/claim-rule.test.ts", "W: all forecast, expiry, room, and exhaustion decisions", { POOL_CLAIM_BOUNDS, POOL_WAIT_BOUNDS, POOL_CLAIMS, POOL_WAITS }],
  ["mods/update/builds.test.ts", "W: prune and keep use the installed build", { BUILD_CASES }],
  ["mods/update/model.test.ts", "W: A4 crash, handoff, rollback, and build outcomes", { UPDATE_CASES }],
] as const
