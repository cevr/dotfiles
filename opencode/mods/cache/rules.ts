// Our setup held against the six prompt-caching rules (ussumant/cache-audit,
// after Anthropic's "prompt caching is everything"), plus the lifetime fit.
// The facts are read from the source by `scripts/cache-audit.ts --static`; the
// ledger's audit (audit.ts) is the evidence: a rule the week's breaks broke
// fails, a rule a source fact puts at risk warns, the rest pass. Each finding
// names the file responsible.
import { formatTokens } from "./line.ts"
import type { Audit, Cause, CauseTally } from "./audit.ts"

export type Status = "pass" | "warn" | "fail"

export interface Finding {
  readonly status: Status
  readonly file: string
  readonly detail: string
}

export interface Rule {
  readonly id: number
  readonly name: string
  readonly status: Status
  readonly findings: ReadonlyArray<Finding>
}

/** What the probes read from the source and the config. `undefined`: the file was not found. */
export interface Facts {
  /** The fork's date and environment instructions are kept from the session's start and change only as a delta message. */
  readonly forkInstructionsFrozen?: boolean
  /** The fork renders a skill list change as a delta message, not a new system prompt. */
  readonly forkSkillsDelta?: boolean
  /** Our plugins that push into the system prompt, each with whether its block is fixed for the session. */
  readonly systemPushers: ReadonlyArray<{ readonly file: string; readonly frozen: boolean }>
  /**
   * The anthropic-auth billing stamp leads the system prompt and is drawn from
   * the first user message. Anthropic leaves it out of the cache key, so it
   * passes (fingerprint.ts, `BILLING_STAMP_PREFIX`).
   */
  readonly billingStampFirst?: boolean
  /** The kernel, as the runtime, describes every tool in its own description, rebuilt per request. */
  readonly kernelCatalogPerRequest?: boolean
  /** The MCP servers the config starts: their tools can join after a session began. */
  readonly mcpServers: ReadonlyArray<string>
  /** Plugin files that remove a tool in a tool transform. */
  readonly toolRemovers: ReadonlyArray<string>
  /** The model the config names for compaction, when it names one, and the main model. */
  readonly compactionModel?: string
  readonly mainModel?: string
  /** The memory digest's character cap. */
  readonly memoryDigestChars?: number
  /** The orchestrate compaction hook adds its keep-list as a message after the conversation. */
  readonly compactionKeepsPrefix?: boolean
  /** The orchestrate roles carry their own system prompt. */
  readonly rolesOwnSystem?: boolean
  /** The orchestrate roles' cache lifetime. */
  readonly roleCacheTtl?: string
}

/** Where each fact lives, relative to the dotfiles' `opencode/` or the fork. */
export const FILES = {
  forkInstructions: "<fork>/packages/core/src/instructions/builtins.ts",
  forkSkills: "<fork>/packages/core/src/skill/instructions.ts",
  billing: "mods/anthropic-auth/request-body.ts",
  kernel: "cmd/kernel/server.ts",
  config: "~/.config/opencode/opencode.json",
  memory: "mods/memory/digest.ts",
  orchestrate: "cmd/orchestrate/server.ts",
  roleTtl: "mods/orchestrate/role.ts",
} as const

/** A digest past this many characters is dynamic content worth trimming (about 2k tokens). */
export const DYNAMIC_CHARS_WARN = 8_000

const worst = (findings: ReadonlyArray<Finding>): Status =>
  findings.some((finding) => finding.status === "fail") ? "fail" : findings.some((finding) => finding.status === "warn") ? "warn" : "pass"

const tally = (audit: Audit, cause: Cause): CauseTally | undefined =>
  audit.breaks.byCause.find((entry) => entry.cause === cause) ?? audit.coldStarts.find((entry) => entry.cause === cause)

const evidence = (audit: Audit, cause: Cause, file: string, what: string, filter?: (segment: string) => boolean): ReadonlyArray<Finding> => {
  const found = tally(audit, cause)
  if (found === undefined) return []
  const segments = filter === undefined ? found.segments : found.segments.filter((entry) => filter(entry.segment))
  const count = filter === undefined ? found.count : segments.reduce((sum, entry) => sum + entry.count, 0)
  const wasted = filter === undefined ? found.wasted : segments.reduce((sum, entry) => sum + entry.wasted, 0)
  if (count === 0) return []
  const at = segments.slice(0, 3).map((entry) => `${entry.segment} ×${entry.count}`).join(", ")
  return [{ status: "fail", file, detail: `${count} ${what} in the window wrote ${formatTokens(wasted)} again (measured)${at === "" ? "" : `: ${at}`}` }]
}

const known = (fact: boolean | undefined, file: string, good: string, bad: string, badStatus: Status = "warn"): Finding =>
  fact === undefined
    ? { status: "warn", file, detail: "not found: check by hand" }
    : fact
      ? { status: "pass", file, detail: good }
      : { status: badStatus, file, detail: bad }

/** The billing stamp, as ledger lines written before the fingerprint left it out name it: no break of the system prompt. */
const isBilling = (segment: string) => segment === "system[0] ¶1"

/** The rules judged from the facts and the window's audit. */
export const judgeRules = (facts: Facts, audit: Audit): ReadonlyArray<Rule> => {
  const rule = (id: number, name: string, findings: ReadonlyArray<Finding>): Rule => ({ id, name, status: worst(findings), findings })
  const pushers = facts.systemPushers.map(
    (pusher): Finding =>
      pusher.frozen
        ? { status: "pass", file: pusher.file, detail: "pushes a block into the system prompt, fixed for the session" }
        : { status: "fail", file: pusher.file, detail: "pushes a block into the system prompt that can change mid-session" },
  )
  const subagents = tally(audit, "subagent-first")
  const trade = audit.shortLifetime
  return [
    rule(1, "ordering: no dynamic data in the system prompt", [
      known(facts.forkInstructionsFrozen, FILES.forkInstructions, "date and environment are read once per session; a change goes in as a message", "the date or environment is rebuilt into the system prompt"),
      ...pushers,
      ...(facts.billingStampFirst === true
        ? [
            {
              status: "pass" as const,
              file: FILES.billing,
              detail:
                "the billing stamp leads the system prompt as Claude Code sends it and changes with a compaction's first message, but Anthropic leaves it out of the cache key: the request after a compaction reads the system prompt past it (measured)",
            },
          ]
        : []),
      ...evidence(audit, "system-prompt", FILES.billing, "breaks at the system prompt", (segment) => !isBilling(segment)),
    ]),
    rule(2, "inject via messages, never edit the system prompt mid-session", [
      known(facts.forkSkillsDelta, FILES.forkSkills, "a skill list change goes in as a delta message", "a skill list change rewrites the system prompt"),
      ...evidence(audit, "message-edit", "(the session's messages)", "breaks at an earlier message"),
    ]),
    rule(3, "tool set stable mid-conversation", [
      ...(facts.kernelCatalogPerRequest === true
        ? [
            {
              status: "warn" as const,
              file: FILES.kernel,
              detail: `the kernel's description embeds every tool's and is rebuilt per request: a tool joining${facts.mcpServers.length === 0 ? "" : ` (MCP: ${facts.mcpServers.join(", ")})`}, leaving or rewording rewrites the first tool and the whole prefix; freeze the catalog per session`,
            },
          ]
        : facts.kernelCatalogPerRequest === false
          ? [{ status: "pass" as const, file: FILES.kernel, detail: "the kernel's tool catalog is fixed for the session" }]
          : []),
      ...(facts.mcpServers.length > 0 && facts.kernelCatalogPerRequest !== true
        ? [{ status: "warn" as const, file: FILES.config, detail: `MCP servers (${facts.mcpServers.join(", ")}) can connect after a session began and add tools` }]
        : []),
      ...facts.toolRemovers.map((file): Finding => ({ status: "warn", file, detail: "removes a tool in a tool transform: check it is fixed at start" })),
      ...evidence(audit, "tool-set", FILES.kernel, "breaks at a tool definition"),
      // Inferred, not measured: the server lost its reference at the restart, so the changed segment is unknown.
      ...evidence(audit, "restart", FILES.kernel, "requests after an OpenCode restart inside the lifetime").map(
        (finding): Finding => ({ ...finding, status: "warn", detail: `${finding.detail}; the rebuilt tools or system prompt differed (inferred)` }),
      ),
    ]),
    rule(4, "no model switching in a thread", [
      ...(facts.compactionModel !== undefined && facts.mainModel !== undefined && facts.compactionModel !== facts.mainModel
        ? [{ status: "warn" as const, file: FILES.config, detail: `compaction runs on ${facts.compactionModel}, the session on ${facts.mainModel}: the summary request reads none of the cache` }]
        : [{ status: "pass" as const, file: FILES.config, detail: "compaction runs on the session's model; the Codex fallback starts new sessions only" }]),
      ...evidence(audit, "model-switch", "(the session's model)", "model switches"),
    ]),
    rule(5, "dynamic content size", [
      facts.memoryDigestChars === undefined
        ? { status: "warn", file: FILES.memory, detail: "the digest's cap was not found" }
        : facts.memoryDigestChars > DYNAMIC_CHARS_WARN
          ? { status: "warn", file: FILES.memory, detail: `the memory digest takes up to ${facts.memoryDigestChars} chars per session` }
          : { status: "pass", file: FILES.memory, detail: `the memory digest is capped at ${facts.memoryDigestChars} chars (about ${Math.round(facts.memoryDigestChars / 4)} tokens)` },
    ]),
    rule(6, "fork safety: compaction and subagents share the parent's prefix", [
      known(facts.compactionKeepsPrefix, FILES.orchestrate, "the compaction request keeps the conversation's prefix; the keep-list follows it as a message", "the compaction hook adds to the system prompt and costs the whole cache"),
      ...(facts.rolesOwnSystem === true && subagents !== undefined && subagents.count > 0
        ? [
            {
              status: "warn" as const,
              file: FILES.orchestrate,
              detail: `each role has its own system prompt, so a subagent shares none of its parent's prefix: ${subagents.count} subagent starts wrote ${formatTokens(subagents.wasted)} (measured)`,
            },
          ]
        : []),
    ]),
    rule(7, "lifetime fits the gaps", [
      trade.savedAtHour > trade.extraAtHour
        ? {
            status: "warn",
            file: FILES.roleTtl,
            detail: `lifetimes under 1h (roles: ${facts.roleCacheTtl ?? "?"}) lost more than they saved: at 1h, +${formatTokens(trade.extraAtHour)} on writes, −${formatTokens(trade.savedAtHour)} on ${trade.expiriesInsideHour} expiries inside the hour (input-token equivalents, measured)`,
          }
        : {
            status: "pass",
            file: FILES.roleTtl,
            detail: `lifetimes under 1h (roles: ${facts.roleCacheTtl ?? "?"}) save ${formatTokens(trade.extraAtHour - trade.savedAtHour)} input-token equivalents over 1h (measured)`,
          },
    ]),
  ]
}

const MARK: Readonly<Record<Status, string>> = { pass: "PASS", warn: "WARN", fail: "FAIL" }

export const renderRules = (rules: ReadonlyArray<Rule>): string =>
  rules
    .flatMap((rule) => [
      `${MARK[rule.status]}  ${rule.id}. ${rule.name}`,
      ...rule.findings.map((finding) => `      ${MARK[finding.status].toLowerCase()} ${finding.file}: ${finding.detail}`),
    ])
    .join("\n")
