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

/** SKILL.md's machine section, as agents.json holds it: what a root is told after its compaction (model.ts `Machines`). */
export const MACHINE_BLOCK: string = Schema.decodeUnknownSync(Schema.Struct({ machine: Schema.String }))(generated).machine

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
 * keeping its child's agent; `model-dropped` is a new role start that named
 * the role's own model, which runs as if it named none (tool-call.ts).
 */
export const Reason = Schema.Literals(["untyped", "general", "renamed", "kept", "described", "continued", "model-dropped"])
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

/** The effort a worker runs at only for mechanical work. */
export const WORKER_CEILING = "max"

/** A step the orchestrator marks as mechanical ends its description with this note, such as `rename sweep (mechanical)`. */
const MECHANICAL = /\(mechanical\)\s*$/i

/**
 * The model a call runs on with the worker's ceiling applied: a worker on a
 * model at `#max` runs on that model at its own default effort instead (the
 * variant dropped), unless its description ends `(mechanical)`; `lowered`
 * names the variant it dropped. Any other agent, model or variant is as asked.
 *
 * Lowered, not refused (dream 2026-11-06, candidate 2): a worker inherits
 * its parent's variant when the call names no model, so a root at max would
 * have every worker refused; and a refused call costs a turn and teaches the
 * parent to add `(mechanical)` to get through. The parent reads why in the
 * answer instead (cmd/orchestrate `effortNote`).
 */
export const capEffort = (
  agent: string,
  description: string | undefined,
  model: string | undefined,
): { readonly model: string | undefined; readonly lowered?: string } => {
  if (agent !== WORKER || model === undefined) return { model }
  const at = model.indexOf("#")
  if (at === -1 || model.slice(at + 1) !== WORKER_CEILING) return { model }
  if (description !== undefined && MECHANICAL.test(description)) return { model }
  return { model: model.slice(0, at), lowered: WORKER_CEILING }
}

/** The providers Codex runs on, whatever the plugin's `codex` option names. */
export const CODEX_PROVIDERS: ReadonlyArray<string> = ["openai"]

/**
 * Whether a model reference (`provider/model#variant`) is a Codex model: on
 * a Codex provider (`CODEX_PROVIDERS`, or one the `codex` option names), or
 * of a Codex family (`gpt-…`) on any provider. It reads no fallback setting:
 * Codex never implements, whether the fallback is on or off.
 */
export const isCodexModel = (ref: string, providers: ReadonlyArray<string> = []): boolean => {
  const at = ref.indexOf("/")
  const provider = at < 0 ? "" : ref.slice(0, at)
  const id = at < 0 ? ref : ref.slice(at + 1)
  return CODEX_PROVIDERS.includes(provider) || providers.includes(provider) || /^gpt-/i.test(id)
}

/**
 * The Codex model a held planner or verifier falls back to: the newest sol,
 * the verifier at medium and the planner at high. Codex never implements.
 */
export const codexFallback = (agent: string): { readonly family: string; readonly variant: string } => ({ family: "gpt-sol", variant: agent === "verifier" ? "medium" : "high" })
