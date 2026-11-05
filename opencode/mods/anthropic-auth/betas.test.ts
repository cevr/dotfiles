import { describe, expect, test } from 'bun:test'
import { BASE_BETAS, betaHeader, REQUIRED_BETAS } from './betas.ts'

// The old helper read the incoming header off a Headers value.
const mergeBetaHeaders = (headers: Headers, modelID?: string) => betaHeader(headers.get('anthropic-beta'), modelID)

describe('mergeBetaHeaders', () => {
  test('sends the Claude Code base betas when no incoming betas', () => {
    const headers = new Headers()
    const result = mergeBetaHeaders(headers)
    expect(result).toBe(BASE_BETAS.join(','))
    for (const beta of REQUIRED_BETAS) expect(result).toContain(beta)
  })

  test('drops interleaved thinking for a Haiku model, even when the request asks for it', () => {
    const headers = new Headers({
      'anthropic-beta': 'interleaved-thinking-2025-05-14, custom-beta',
    })
    const result = mergeBetaHeaders(headers, 'claude-haiku-4-5').split(',')
    expect(result).not.toContain('interleaved-thinking-2025-05-14')
    expect(result).toContain('custom-beta')
    for (const beta of REQUIRED_BETAS) expect(result).toContain(beta)
  })

  test('adds the effort beta for 4.6 and 4.7 models only', () => {
    const effort = 'effort-2025-11-24'
    expect(mergeBetaHeaders(new Headers(), 'claude-opus-4-6')).toContain(effort)
    expect(mergeBetaHeaders(new Headers(), 'claude-sonnet-4-7')).toContain(effort)
    expect(mergeBetaHeaders(new Headers(), 'claude-sonnet-4-5')).not.toContain(effort)
  })

  test('matches the first rule only: a Haiku 4.6 takes the Haiku rule', () => {
    const result = mergeBetaHeaders(new Headers(), 'claude-haiku-4-6')
    expect(result).not.toContain('effort-2025-11-24')
    expect(result).not.toContain('interleaved-thinking-2025-05-14')
  })

  test('merges incoming betas with required betas', () => {
    const headers = new Headers({ 'anthropic-beta': 'custom-beta-1' })
    const result = mergeBetaHeaders(headers)

    for (const beta of REQUIRED_BETAS) {
      expect(result).toContain(beta)
    }
    expect(result).toContain('custom-beta-1')
  })

  test('deduplicates betas', () => {
    const beta = REQUIRED_BETAS[0] ?? ''
    const headers = new Headers({
      'anthropic-beta': beta,
    })
    const result = mergeBetaHeaders(headers)
    const parts = result.split(',')
    const occurrences = parts.filter((p) => p === REQUIRED_BETAS[0])
    expect(occurrences).toHaveLength(1)
  })

  test('handles comma-separated incoming betas', () => {
    const headers = new Headers({
      'anthropic-beta': 'beta-a, beta-b',
    })
    const result = mergeBetaHeaders(headers)
    expect(result).toContain('beta-a')
    expect(result).toContain('beta-b')
  })
})
