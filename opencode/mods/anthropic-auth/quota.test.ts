import { describe, expect, test } from 'bun:test'
import {
  quotaProtocol,
  readUnifiedQuota,
  readUsageBody,
  rejectedUntil,
  retryAfterUntil,
} from './quota.ts'

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

  test('reads model-scoped weekly windows by their model: the limits list as measured, and model_scoped', () => {
    // The shape /api/oauth/usage answered on 2026-11-09 (ids left out): Fable's
    // weekly window is a `weekly_scoped` entry of `limits`, scoped to its model.
    const measured = {
      five_hour: { utilization: 1, resets_at: '2026-11-10T02:30:00.291433+00:00' },
      seven_day: { utilization: 9, resets_at: '2026-11-16T09:00:00.291455+00:00' },
      seven_day_opus: null,
      limits: [
        { kind: 'session', group: 'session', percent: 1, resets_at: '2026-11-10T02:30:00+00:00', scope: null, is_active: false },
        { kind: 'weekly_all', group: 'weekly', percent: 9, resets_at: '2026-11-16T09:00:00+00:00', scope: null, is_active: true },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 12,
          resets_at: '2026-11-16T09:00:00+00:00',
          scope: { model: { id: null, display_name: 'Fable' }, surface: null },
          is_active: false,
        },
      ],
      weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 0, allowance_percent_of_weekly: 50 }],
    }
    expect(readUsageBody(measured, NOW)?.windows).toEqual([
      { name: '5h', utilization: 0.01, resetAt: Date.parse('2026-11-10T02:30:00.291433+00:00') },
      { name: '7d', utilization: 0.09, resetAt: Date.parse('2026-11-16T09:00:00.291455+00:00') },
      // `weekly_scoped_shares` names Fable's entry (index 2): its whole allowance is half the weekly window.
      { name: '7d:Fable', utilization: 0.12, resetAt: Date.parse('2026-11-16T09:00:00+00:00'), ofWeekly: 0.5 },
    ])
    // The CLI's `model_scoped` form (T3 Code's claudeUsageLimits.ts) reads the
    // same, and one model's window is read once whichever form carries it.
    const scoped = readUsageBody(
      {
        seven_day: { utilization: 40, resets_at: '2026-11-16T09:00:00Z' },
        model_scoped: [
          { display_name: 'Fable', utilization: 100, resets_at: '2026-11-16T09:00:00Z' },
          { display_name: 'Unread', utilization: null, resets_at: null },
        ],
        limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 99, scope: { model: { display_name: 'Fable' } } }],
      },
      NOW,
    )
    expect(scoped?.windows).toEqual([
      { name: '7d', utilization: 0.4, resetAt: Date.parse('2026-11-16T09:00:00Z') },
      { name: '7d:Fable', utilization: 1, resetAt: Date.parse('2026-11-16T09:00:00Z') },
    ])
  })

  test("reads the reset grants cedar_ember lists: resets left on usable grants, and the soonest end", () => {
    const grant = (id: string, left: number, endsAt: string | null, more: Record<string, unknown> = {}) => ({
      id,
      resets_left: left,
      ends_at: endsAt,
      paused: false,
      usable_now: true,
      ...more,
    })
    const reading = readUsageBody(
      {
        seven_day: { utilization: 100, resets_at: '2027-01-20T00:00:00Z' },
        cedar_ember: {
          eligible: true,
          grants: [
            // As measured on 2026-11-09 (claude-cli 2.1.280), less its label and figures.
            grant('g-1', 2, '2027-02-01T00:00:00Z', {
              resets_total: 2,
              starts_at: '2026-11-09T18:00:00+00:00',
              clears: ['five_hour', 'seven_day_overage_included'],
              use_requires_limit: false,
              type: 'full',
              gives_back_weekly: true,
            }),
            grant('g-2', 1, '2027-01-25T00:00:00Z', { paused: true }),
            grant('g-3', 1, '2027-01-28T00:00:00Z'),
            grant('g-old', 3, '2020-01-01T00:00:00Z'),
            { id: 'malformed', resets_left: -1 },
          ],
          next_grant_id: 'g-1',
        },
      },
      NOW,
    )
    expect(reading?.resets).toEqual({
      available: 3,
      nextExpiresAt: Date.parse('2027-01-28T00:00:00Z'),
      credits: [
        // The measured grant gives back to the weekly window: a Fable reset by Claude Code's rule, whatever its `type`.
        {
          id: 'g-1',
          count: 2,
          usable: true,
          expiresAt: Date.parse('2027-02-01T00:00:00Z'),
          clears: ['five_hour', 'seven_day_overage_included'],
          kind: 'fable',
          givesBack: true,
          requiresLimit: false,
        },
        { id: 'g-2', count: 1, usable: false, expiresAt: Date.parse('2027-01-25T00:00:00Z'), kind: 'full', requiresLimit: true, paused: true },
        { id: 'g-3', count: 1, usable: true, expiresAt: Date.parse('2027-01-28T00:00:00Z'), kind: 'full', requiresLimit: true },
        { id: 'g-old', count: 3, usable: false, expiresAt: Date.parse('2020-01-01T00:00:00Z'), kind: 'full', requiresLimit: true },
      ],
    })
    // As measured on 2026-11-09 with an old claude-cli user agent: ineligible, no grant. That is a reading of none.
    const ineligible = { eligible: false, ineligible_reason: 'cli_version', grants: [], next_grant_id: null }
    expect(readUsageBody({ seven_day: { utilization: 9, resets_at: null }, cedar_ember: ineligible }, NOW)?.resets).toEqual({
      available: 0,
      credits: [],
    })
    // A body without the block (the plain endpoint) says nothing of resets.
    expect(readUsageBody({ seven_day: { utilization: 9, resets_at: null }, cedar_ember: null }, NOW)?.resets).toBe(undefined)
  })

  test("names each grant's kind as Claude Code 2.1.318 does: a give-back is fable, else its type, else by what it clears", () => {
    const kinds = (grants: ReadonlyArray<Record<string, unknown>>) =>
      readUsageBody(
        {
          seven_day: { utilization: 9, resets_at: null },
          cedar_ember: { eligible: true, grants: grants.map((grant, at) => ({ id: `g-${at}`, resets_left: 1, usable_now: true, ...grant })) },
        },
        NOW,
      )?.resets?.credits.map((credit) => credit.kind)
    expect(
      kinds([
        { clears: ['five_hour'] },
        { clears: ['seven_day'] },
        { clears: ['five_hour', 'seven_day'] },
        { clears: ['five_hour'], type: 'weekly' },
        { clears: ['five_hour', 'seven_day_overage_included'], type: 'full', gives_back_weekly: true },
      ]),
    ).toEqual(['session', 'weekly', 'full', 'weekly', 'fable'])
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
    expect(Object.keys(protocol.methods)).toEqual(['reading', 'usage', 'claim'])
    expect(Object.keys(protocol.events)).toEqual(['reading'])
  })
})
