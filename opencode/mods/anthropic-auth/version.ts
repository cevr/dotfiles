// The Claude Code version the plugin reports to Anthropic, the override that
// replaces it, and the server's "version too old" rejection that raises it.
import { parseJson } from "./json.ts"

/**
 * The Claude Code version we report to Anthropic, via both the `user-agent`
 * header and the `cc_version` field of the billing header.
 *
 * Anthropic gates new models on this value server-side: requesting a model
 * newer than the reported client returns a 400 `claude_code_version_too_old`
 * (e.g. "Claude Code 2.1.87 does not support this model; version 2.1.251 or
 * newer is required"). Keep this at or above the latest published
 * `@anthropic-ai/claude-code` release, otherwise new models are unreachable.
 */
export const CLAUDE_CODE_VERSION = "2.1.280"
export const CLAUDE_CODE_ENTRYPOINT = "sdk-cli"

/**
 * Environment variable that overrides the reported Claude Code version.
 *
 * Anthropic gates model access on the reported version server-side, and that
 * gate moves on Anthropic's schedule rather than this plugin's release
 * schedule. The override lets users unblock a newly-gated model without
 * waiting for a published bump.
 */
export const ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR = "ANTHROPIC_CLAUDE_CODE_VERSION"

/**
 * Build the `user-agent` value for a reported Claude Code version.
 *
 * Both places we report the version (this header and the billing header's
 * `cc_version`) must agree, so callers pass the same resolved version to each
 * rather than reading a second, independently-derived constant.
 */
export function formatUserAgent(version: string): string {
  return `claude-cli/${version} (external, cli)`
}

export const USER_AGENT = formatUserAgent(CLAUDE_CODE_VERSION)

/**
 * Claude Code releases are `major.minor.patch` with numeric components.
 *
 * Leading zeros are rejected: `02.1.280` is not a release Anthropic publishes,
 * so accepting it would report a version string no server-side gate expects.
 */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const MAX_VERSION_LENGTH = 64

export function isValidClaudeCodeVersion(candidate: string): boolean {
  return candidate.length <= MAX_VERSION_LENGTH && VERSION_PATTERN.test(candidate)
}

/**
 * Compare two validated Claude Code releases.
 *
 * Components are compared numerically rather than lexically — `2.1.99` sorts
 * after `2.1.280` as a string but is the older release — and as `BigInt`, so a
 * large bounded component cannot silently lose precision the way `Number`
 * would. Invalid input has no ordering and returns `undefined`.
 */
export function compareClaudeCodeVersions(candidate: string, baseline: string): -1 | 0 | 1 | undefined {
  if (!isValidClaudeCodeVersion(candidate) || !isValidClaudeCodeVersion(baseline)) {
    return undefined
  }
  // The `0n` defaults are unreachable — `VERSION_PATTERN` guarantees exactly
  // three components — but they keep the destructuring free of assertions.
  const [major = 0n, minor = 0n, patch = 0n] = candidate.split(".").map((part) => BigInt(part))
  const [baseMajor = 0n, baseMinor = 0n, basePatch = 0n] = baseline.split(".").map((part) => BigInt(part))

  if (major !== baseMajor) return major < baseMajor ? -1 : 1
  if (minor !== baseMinor) return minor < baseMinor ? -1 : 1
  if (patch !== basePatch) return patch < basePatch ? -1 : 1
  return 0
}

/**
 * Outcome of reading the version override.
 *
 * The invalid arm carries no version: a malformed override must never reach
 * the request path, so callers cannot accidentally report one. The outdated
 * arm does carry one — an explicit older version is still honoured — but pairs
 * it with the warning explaining why reporting it is risky.
 */
export type ClaudeCodeVersionResolution =
  | { readonly type: "success"; readonly version: string }
  | {
      readonly type: "outdated"
      readonly version: string
      readonly warning: string
    }
  | { readonly type: "invalid"; readonly error: string }

/**
 * Resolve the Claude Code version to report to Anthropic from the override's
 * raw value (`ANTHROPIC_CLAUDE_CODE_VERSION`, read by the composition root).
 *
 * Returns the bundled version when the override is unset. A set override is
 * trimmed and must look like a Claude Code release; anything else resolves to
 * `invalid` with a message describing how to correct it. An override older
 * than the bundled version resolves to `outdated`: it is still reported, since
 * it was set deliberately, but it can lock the user out of newer models.
 */
export function resolveClaudeCodeVersion(raw: string | undefined): ClaudeCodeVersionResolution {
  if (raw === undefined) {
    return { type: "success", version: CLAUDE_CODE_VERSION }
  }

  const trimmed = raw.length <= MAX_VERSION_LENGTH ? raw.trim() : ""
  if (!isValidClaudeCodeVersion(trimmed)) {
    return {
      type: "invalid",
      error:
        `${ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR} is not a valid Claude Code version. ` +
        `Expected major.minor.patch (for example, ${CLAUDE_CODE_VERSION}). ` +
        `Reporting the bundled version ${CLAUDE_CODE_VERSION} instead; correct or unset ` +
        `${ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR} and restart OpenCode to use the override.`,
    }
  }

  if (compareClaudeCodeVersions(trimmed, CLAUDE_CODE_VERSION) === -1) {
    return {
      type: "outdated",
      version: trimmed,
      warning:
        `${ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR} is set to ${JSON.stringify(trimmed)}, which is older ` +
        `than the bundled Claude Code version ${CLAUDE_CODE_VERSION}. Anthropic gates model access on ` +
        `the reported version, so reporting an older one can make newer models reject the request. ` +
        `Set ${ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR} to ${CLAUDE_CODE_VERSION} or newer — or unset it ` +
        `to use the bundled version — and restart OpenCode.`,
    }
  }

  return { type: "success", version: trimmed }
}

/** The exact Claude Code version a plugin-owned request's `user-agent` carries. */
export function sentClaudeCodeVersion(userAgent: string | null): string | undefined {
  if (!userAgent?.startsWith("claude-cli/")) return undefined

  const suffix = " (external, cli)"
  if (!userAgent.endsWith(suffix)) return undefined
  const version = userAgent.slice("claude-cli/".length, -suffix.length)
  return isValidClaudeCodeVersion(version) && formatUserAgent(version) === userAgent ? version : undefined
}

const VERSION_TOO_OLD_CODE = "claude_code_version_too_old"
/** The longest version rejection body read. */
export const MAX_REJECTION_BODY_BYTES = 16 * 1024
const MAX_REJECTION_MESSAGE_LENGTH = 1024
const VERSION_REJECTION_PATTERN =
  /^Claude Code ([0-9.]{1,64}) does not support this model; version ([0-9.]{1,64}) or newer is required\./

export interface ClaudeCodeVersionRejection {
  readonly rejectedVersion: string
  readonly requiredVersion: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Parse only Anthropic's structured minimum-version rejection.
 *
 * The error code is authoritative; the bounded message supplies the versions.
 * Requiring the rejected version to equal what this setup actually sent keeps
 * an unrelated or stale response from changing later requests.
 */
export function parseClaudeCodeVersionRejection(
  body: string,
  reportedVersion: string,
): ClaudeCodeVersionRejection | undefined {
  if (body.length > MAX_REJECTION_BODY_BYTES) return undefined

  const decoded = parseJson(body)
  if (!isRecord(decoded) || decoded.type !== "error") return undefined

  const error = decoded.error
  if (!isRecord(error) || error.type !== "invalid_request_error") {
    return undefined
  }
  const details = error.details
  if (!isRecord(details) || details.error_code !== VERSION_TOO_OLD_CODE) {
    return undefined
  }
  if (typeof error.message !== "string" || error.message.length > MAX_REJECTION_MESSAGE_LENGTH) {
    return undefined
  }

  const match = VERSION_REJECTION_PATTERN.exec(error.message)
  if (!match) return undefined
  const rejectedVersion = match[1]
  const requiredVersion = match[2]
  if (
    !rejectedVersion ||
    !requiredVersion ||
    !isValidClaudeCodeVersion(rejectedVersion) ||
    !isValidClaudeCodeVersion(requiredVersion) ||
    rejectedVersion !== reportedVersion ||
    compareClaudeCodeVersions(requiredVersion, reportedVersion) !== 1
  ) {
    return undefined
  }

  return { rejectedVersion, requiredVersion }
}
