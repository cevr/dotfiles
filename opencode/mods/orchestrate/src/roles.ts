// The orchestrate roles as OpenCode agents, and which one a subagent call runs
// as. agents.json, written by scripts/agents.ts from the orchestrate skill,
// holds each role's agent fields and reasoning effort.
import generated from "./agents.json"

export const WORKER = "worker"
export const ROLES = ["planner", "implementor", "verifier", WORKER] as const
export type Role = (typeof ROLES)[number]

export const isRole = (name: string): name is Role => (ROLES as readonly string[]).includes(name)

/** A role as OpenCode agent fields, and the reasoning effort it runs at. */
export interface Definition {
  readonly description: string
  readonly mode: "subagent"
  readonly permissions: ReadonlyArray<{ readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" | "ask" }>
  readonly system: string
  readonly effort?: string
}

export const definitions = generated.agents as Readonly<Record<Role, Definition>>

/** A role's reasoning effort, a model variant id such as `high`. The worker runs at the model's own. */
export const effort = (role: Role): string | undefined => definitions[role].effort

/**
 * Agents that load everything: OpenCode's general agent, and Claude Code's
 * names for it. An untyped call is one too.
 */
const FULL = new Set(["", "general", "general-purpose", "claude"])

/** Former agent names → current: the roles dropped their orchestrate- prefix; the reviewer is the verifier's former name. */
const RENAMED: Readonly<Record<string, Role>> = {
  "orchestrate-worker": "worker",
  "orchestrate-planner": "planner",
  "orchestrate-implementor": "implementor",
  "orchestrate-verifier": "verifier",
  "orchestrate-reviewer": "verifier",
}

export type Reason = "untyped" | "general" | "renamed" | "kept"

/**
 * The agent a subagent call asking for `requested` runs as. An untyped or
 * general call runs as the lean worker unless `full`; a former role name runs
 * as the role; anything else runs as asked.
 */
export const route = (requested: unknown, full = false): { readonly agent: string; readonly reason: Reason } => {
  if (requested === undefined || requested === null || requested === "")
    return full ? { agent: "general", reason: "kept" } : { agent: WORKER, reason: "untyped" }
  const asked = String(requested)
  const bare = asked.replace(/^status:/, "")
  if (FULL.has(bare)) return full ? { agent: asked, reason: "kept" } : { agent: WORKER, reason: "general" }
  const role = RENAMED[bare]
  if (role) return { agent: role, reason: "renamed" }
  return { agent: asked, reason: "kept" }
}
