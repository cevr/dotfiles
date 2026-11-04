import { describe, expect, test } from 'bun:test'
import {
  quotaProtocol,
  readUnifiedQuota,
  readUsageBody,
  rejectedUntil,
  retryAfterUntil,
} from '../src/quota'

const NOW = 1_800_000_000_000

describe('readUnifiedQuota', () => {
  test('reads both windows, in fractions and epoch ms', () => {
    const reading = readUnifiedQuota(
      new Headers({
        'anthropic-ratelimit-unified-status': 'allowed_warning',
        'anthropic-ratelimit-unified-5h-utilization': '0.81',
        'anthropic-ratelimit-unified-5h-reset': '1800003600',
        'anthropic-ratelimit-unified-7d-utilization': '0.4',
        'anthropic-ratelimit-unified-7d-reset': '1800200000',
      }),
      NOW,
    )

    expect(reading).toEqual({
      at: NOW,
      status: 'allowed_warning',
      windows: [
        { name: '5h', utilization: 0.81, resetAt: 1_800_003_600_000 },
        { name: '7d', utilization: 0.4, resetAt: 1_800_200_000_000 },
      ],
    })
  })

  test('counts the claimed window of a rejected account as full', () => {
    const reading = readUnifiedQuota(
      new Headers({
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'seven_day',
        'anthropic-ratelimit-unified-5h-utilization': '0.2',
        'anthropic-ratelimit-unified-7d-utilization': '0.93',
        'anthropic-ratelimit-unified-7d-reset': '1800200000',
      }),
      NOW,
    )

    expect(reading?.windows).toEqual([
      { name: '5h', utilization: 0.2 },
      { name: '7d', utilization: 1, resetAt: 1_800_200_000_000 },
    ])
  })

  test('caps utilization at 1 and drops values that are not numbers', () => {
    const reading = readUnifiedQuota(
      new Headers({
        'anthropic-ratelimit-unified-5h-utilization': '1.4',
        'anthropic-ratelimit-unified-7d-utilization': 'soon',
        'anthropic-ratelimit-unified-7d-reset': '-3',
      }),
      NOW,
    )

    expect(reading?.windows).toEqual([{ name: '5h', utilization: 1 }])
  })

  test('is undefined for a response without the unified headers', () => {
    expect(readUnifiedQuota(new Headers({ 'retry-after': '3' }), NOW)).toBe(
      undefined,
    )
  })
})

describe('rejectedUntil', () => {
  test("is the claimed window's reset, else the overall reset", () => {
    const claimed = new Headers({
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-reset': '1800009999',
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '1800003600',
    })
    expect(rejectedUntil(claimed, readUnifiedQuota(claimed, NOW))).toBe(
      1_800_003_600_000,
    )

    const overall = new Headers({
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': '1800009999',
    })
    expect(rejectedUntil(overall, readUnifiedQuota(overall, NOW))).toBe(
      1_800_009_999_000,
    )
  })

  test('is undefined while the account is allowed', () => {
    const headers = new Headers({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-reset': '1800009999',
    })
    expect(rejectedUntil(headers, readUnifiedQuota(headers, NOW))).toBe(
      undefined,
    )
  })
})

describe('retryAfterUntil', () => {
  test('reads seconds and HTTP dates', () => {
    expect(retryAfterUntil(new Headers({ 'retry-after': '1.2' }), NOW)).toBe(
      NOW + 1200,
    )
    const date = new Date(NOW + 90_000).toUTCString()
    expect(retryAfterUntil(new Headers({ 'retry-after': date }), NOW)).toBe(
      Date.parse(date),
    )
    expect(retryAfterUntil(new Headers({ 'retry-after': 'later' }), NOW)).toBe(
      undefined,
    )
    expect(retryAfterUntil(new Headers(), NOW)).toBe(undefined)
  })
})

describe('readUsageBody', () => {
  test('turns percents into fractions and keeps other windows by name', () => {
    const reading = readUsageBody(
      {
        five_hour: { utilization: 37, resets_at: '2027-01-15T10:00:00Z' },
        seven_day: { utilization: 120, resets_at: null },
        seven_day_opus: { utilization: 5, resets_at: '2027-01-20T00:00:00Z' },
        seven_day_oauth_apps: null,
        extra_usage: { is_enabled: false },
      },
      NOW,
    )

    expect(reading).toEqual({
      at: NOW,
      windows: [
        {
          name: '5h',
          utilization: 0.37,
          resetAt: Date.parse('2027-01-15T10:00:00Z'),
        },
        { name: '7d', utilization: 1 },
        {
          name: 'seven_day_opus',
          utilization: 0.05,
          resetAt: Date.parse('2027-01-20T00:00:00Z'),
        },
      ],
    })
  })

  test('is undefined for a body without windows', () => {
    expect(readUsageBody({ error: 'nope' }, NOW)).toBe(undefined)
    expect(readUsageBody('text', NOW)).toBe(undefined)
  })
})

describe('quotaProtocol', () => {
  test('derives its id from the integration, so a pool needs no import', () => {
    const protocol = quotaProtocol('anthropic')
    expect(protocol.id).toBe('credential-quota.anthropic')
    expect(Object.keys(protocol.methods)).toEqual(['reading', 'usage'])
    expect(Object.keys(protocol.events)).toEqual(['reading'])
  })
})
