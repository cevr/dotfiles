// The orchestrate roles as OpenCode agents, and which one a subagent call runs
// as. agents.json, written by scripts/agents.ts from the orchestrate skill,
// holds each role's agent fields and reasoning effort; it is decoded here once.
import { Schema } from "effect"
import generated from "./agents.json"
import { described, STEPS } from "./described.ts"

export const WORKER = "worker"
export const ROLES = [...STEPS, WORKER] as const
export type Role = (typeof ROLES)[number]

/**
 * The prompt-cache lifetime each role runs with (the per-agent `request.settings.cacheTTL`, which the anthropic-auth `http.request` hook writes over the provider-configured lifetime). A role works
 * in one burst and then stops, so a five-minute write (1.25x input) beats the main session's one-hour write (2x):
 * a role rarely comes back to a prefix after five idle minutes. One that does (a long shell command or wait, a
 * resumed role) has outlived it: the pool asks for the provider's lifetime from its next request on
 * (`requestCache` in `@dotfiles/opencode-pool/accounts`). The main session keeps the provider's lifetime.
 */
export const ROLE_CACHE_TTL = "5m"

export const isRole = (name: string): name is Role => (ROLES as readonly string[]).includes(name)

/** A role as OpenCode agent fields, and the reasoning effort it runs at. */
export const Definition = Schema.Struct({
  description: Schema.String,
  mode: Schema.Literal("subagent"),
  permissions: Schema.Array(
    Schema.Struct({ action: Schema.String, resource: Schema.String, effect: Schema.Literals(["allow", "deny", "ask"]) }),
  ),
  system: Schema.String,
  effort: Schema.optional(Schema.String),
})
export interface Definition extends Schema.Schema.Type<typeof Definition> {}

const Generated = Schema.Struct({
  agents: Schema.Struct({ planner: Definition, implementor: Definition, verifier: Definition, worker: Definition }),
})

/** Each role's definition. agents.json is checked by `bun run agents -- --check`, so a bad file fails at load. */
export const definitions: Readonly<Record<Role, Definition>> = Schema.decodeUnknownSync(Generated)(generated).agents

/** A role's reasoning effort, a model variant id such as `high`. The worker runs at the model's own. */
export const effort = (role: Role): string | undefined => definitions[role].effort

/**
 * Agents that load everything: OpenCode's general agent, and Claude Code's
 * names for it. An untyped call is one too.
 */
const FULL = new Set(["", "general", "general-purpose", "claude"])

/** Former agent names → current: the roles dropped their orchestrate- prefix; the reviewer is the verifier's former name. */
export const RENAMED: Readonly<Record<string, Role>> = {
  "orchestrate-worker": "worker",
  "orchestrate-planner": "planner",
  "orchestrate-implementor": "implementor",
  "orchestrate-verifier": "verifier",
  "orchestrate-reviewer": "verifier",
}

/**
 * Why a call runs as the agent it does; `described` is role work asked of the
 * worker, run as the role its description names; `continued` is a follow-up
 * keeping its child's agent.
 */
export const Reason = Schema.Literals(["untyped", "general", "renamed", "kept", "described", "continued"])
export type Reason = typeof Reason.Type

/**
 * Whether a call names no particular agent: it is untyped, asks for a general
 * one, or for the worker. Such a call would run as the worker, so its
 * description may name the role it is (`route`), and as a follow-up it keeps
 * its child's agent (tool-call.ts).
 */
export const unspecific = (requested: unknown): boolean => {
  if (requested === undefined || requested === null) return true
  const bare = String(requested).replace(/^status:/, "")
  return FULL.has(bare) || bare === WORKER
}

const named = (requested: unknown, full: boolean): { readonly agent: string; readonly reason: Exclude<Reason, "described" | "continued"> } => {
  if (requested === undefined || requested === null || requested === "")
    return full ? { agent: "general", reason: "kept" } : { agent: WORKER, reason: "untyped" }
  const asked = String(requested)
  const bare = asked.replace(/^status:/, "")
  if (FULL.has(bare)) return full ? { agent: asked, reason: "kept" } : { agent: WORKER, reason: "general" }
  const role = RENAMED[bare]
  if (role) return { agent: role, reason: "renamed" }
  return { agent: asked, reason: "kept" }
}

/**
 * The agent a subagent call asking for `requested` runs as. An untyped or
 * general call runs as the lean worker unless `full`; a former role name runs
 * as the role; anything else runs as asked. A call that would run as the
 * worker and whose `description` names an orchestrate step in the skill's
 * form (`verifier <unit> r1`, `<unit> implementor`; described.ts) runs as that
 * role: the orchestrator meant the role, and the role agent carries the
 * protocol, its effort and its cache lifetime. A role or another agent asked
 * by name stays as asked.
 */
export const route = (
  requested: unknown,
  full = false,
  description?: string,
): { readonly agent: string; readonly reason: Exclude<Reason, "continued"> } => {
  const routed = named(requested, full)
  const step = routed.agent === WORKER ? described(description) : undefined
  return step ? { agent: step.role, reason: "described" } : routed
}

/** A step the orchestrator marks as plain work ends its description with one of these notes, such as `pkg-lower implementor (mechanical)`. */
const LIGHT = /\((?:light|direct|mechanical)\)\s*$/i

/**
 * The Codex model a new agent falls back to when the pace holds its first
 * model: a model family and the effort to run it at. Light, direct or
 * mechanical work (its description's last note) runs on luna at max; the rest
 * on sol, the verifier at medium and everything else at high.
 */
export const codexFallback = (agent: string, description: string | undefined): { readonly family: string; readonly variant: string } =>
  description !== undefined && LIGHT.test(description)
    ? { family: "gpt-luna", variant: "max" }
    : { family: "gpt-sol", variant: agent === "verifier" ? "medium" : "high" }
