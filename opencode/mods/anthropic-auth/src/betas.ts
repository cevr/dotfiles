/**
 * The `anthropic-beta` set an OAuth request carries, per model.
 *
 * Claude Code sends a base set on every request and adjusts it per model
 * family. A model id matches the first rule whose pattern it contains
 * (lower-cased), in table order.
 */
export const OAUTH_BETA = 'oauth-2025-04-20'

export const BASE_BETAS: readonly string[] = [
  'claude-code-20250219',
  OAUTH_BETA,
  'interleaved-thinking-2025-05-14',
  'prompt-caching-scope-2026-01-05',
  'context-management-2025-06-27',
]

export type BetaRule = {
  readonly pattern: string
  readonly exclude?: readonly string[]
  readonly add?: readonly string[]
}

/** First match wins. Haiku has no interleaved thinking; 4.6 and 4.7 take an effort level. */
export const MODEL_BETA_RULES: readonly BetaRule[] = [
  { pattern: 'haiku', exclude: ['interleaved-thinking-2025-05-14'] },
  { pattern: '4-6', add: ['effort-2025-11-24'] },
  { pattern: '4-7', add: ['effort-2025-11-24'] },
]

function ruleFor(modelID: string): BetaRule | undefined {
  const lower = modelID.toLowerCase()
  return MODEL_BETA_RULES.find((rule) => lower.includes(rule.pattern))
}

/**
 * The betas to send for `modelID`, merged with the ones the request already
 * carries. A rule's exclusions apply to the merged set, so a beta the model
 * cannot take never reaches Anthropic. Without a model id, the base set.
 */
export function betasFor(
  modelID: string | undefined,
  incoming: readonly string[] = [],
): string[] {
  const rule = modelID === undefined ? undefined : ruleFor(modelID)
  const excluded = new Set(rule?.exclude ?? [])
  return [
    ...new Set([...BASE_BETAS, ...(rule?.add ?? []), ...incoming]),
  ].filter((beta) => !excluded.has(beta))
}
