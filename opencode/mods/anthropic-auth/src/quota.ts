/**
 * What an Anthropic subscription account has left, as its responses and the
 * usage endpoint report it, and the RPC protocol that hands it to another
 * plugin (an account pool, a status line).
 *
 * Every `/v1/messages` response carries the unified rate-limit headers:
 * the account's status, the window that limits it, and the utilization and
 * reset of its 5-hour and 7-day windows. Resets are epoch seconds on the
 * wire and epoch milliseconds here. A rejected window counts as full until
 * its reset.
 */

export type QuotaStatus = 'allowed' | 'allowed_warning' | 'rejected'

export type QuotaWindow = {
  /** `5h`, `7d`, or the usage endpoint's own name for a narrower window. */
  readonly name: string
  /** 0 to 1. */
  readonly utilization: number
  /** Epoch ms. */
  readonly resetAt?: number
}

/**
 * Why the account cannot take a request now, and until when (epoch ms).
 * Without `until`, until it signs in again.
 */
export type QuotaRefusal = {
  readonly kind: 'usage-limit' | 'rate-limit' | 'unauthorized' | 'signin'
  readonly until?: number
}

export type QuotaReading = {
  /** When it was read, epoch ms. */
  readonly at: number
  readonly status?: QuotaStatus
  readonly windows: readonly QuotaWindow[]
  readonly refusal?: QuotaRefusal
}

const STATUSES = new Set<string>(['allowed', 'allowed_warning', 'rejected'])

function epochSecondsToMs(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return Math.round(seconds * 1000)
}

function fraction(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return Math.min(parsed, 1)
}

const UNIFIED = 'anthropic-ratelimit-unified-'
const WINDOW_OF_CLAIM: Readonly<Record<string, string>> = {
  five_hour: '5h',
  seven_day: '7d',
}

/**
 * The reading the unified headers carry, or `undefined` when they carry no
 * window and no status (an API-key or non-Anthropic response).
 */
export function readUnifiedQuota(
  headers: Headers,
  now: number,
): QuotaReading | undefined {
  const rawStatus = headers.get(`${UNIFIED}status`)
  const status =
    rawStatus !== null && STATUSES.has(rawStatus)
      ? (rawStatus as QuotaStatus)
      : undefined
  const claim = headers.get(`${UNIFIED}representative-claim`)
  const claimed = claim === null ? undefined : WINDOW_OF_CLAIM[claim]
  const windows: QuotaWindow[] = []
  for (const name of ['5h', '7d']) {
    const utilization = fraction(headers.get(`${UNIFIED}${name}-utilization`))
    const resetAt = epochSecondsToMs(headers.get(`${UNIFIED}${name}-reset`))
    if (utilization === undefined && resetAt === undefined) continue
    // The window that rejected the account is full until it resets.
    const full = status === 'rejected' && claimed === name
    windows.push({
      name,
      utilization: full ? 1 : (utilization ?? 0),
      ...(resetAt === undefined ? {} : { resetAt }),
    })
  }
  if (status === undefined && windows.length === 0) return undefined
  return { at: now, ...(status ? { status } : {}), windows }
}

/** When a rejected account takes requests again: the claimed window's reset, else the overall one. */
export function rejectedUntil(
  headers: Headers,
  reading: QuotaReading | undefined,
): number | undefined {
  if (reading?.status !== 'rejected') return undefined
  const claim = headers.get(`${UNIFIED}representative-claim`)
  const claimed = claim === null ? undefined : WINDOW_OF_CLAIM[claim]
  const window = reading.windows.find((entry) => entry.name === claimed)
  return window?.resetAt ?? epochSecondsToMs(headers.get(`${UNIFIED}reset`))
}

/** `retry-after` as an epoch ms deadline: seconds, or an HTTP date. */
export function retryAfterUntil(
  headers: Headers,
  now: number,
): number | undefined {
  const raw = headers.get('retry-after')?.trim()
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0)
    return now + Math.ceil(seconds * 1000)
  const date = Date.parse(raw)
  return Number.isFinite(date) ? date : undefined
}

const USAGE_WINDOWS: Readonly<Record<string, string>> = {
  five_hour: '5h',
  seven_day: '7d',
}

/**
 * The usage endpoint's answer as a reading. It names each window with a
 * utilization in percent and an ISO reset; a window it reports as `null` is
 * left out. Windows beyond the 5-hour and 7-day ones keep their own names.
 */
export function readUsageBody(
  body: unknown,
  now: number,
): QuotaReading | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const windows: QuotaWindow[] = []
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== 'object' || value === null) continue
    const record = value as Record<string, unknown>
    if (typeof record.utilization !== 'number') continue
    if (!Number.isFinite(record.utilization)) continue
    const resetAt =
      typeof record.resets_at === 'string'
        ? Date.parse(record.resets_at)
        : Number.NaN
    windows.push({
      name: USAGE_WINDOWS[key] ?? key,
      utilization: Math.min(Math.max(record.utilization / 100, 0), 1),
      ...(Number.isFinite(resetAt) ? { resetAt } : {}),
    })
  }
  if (windows.length === 0) return undefined
  return { at: now, windows }
}

/**
 * The quota protocol an auth plugin serves for one integration, by RPC.
 * Every plugin that speaks it builds the same definition from the
 * integration id, so a pool needs no import from the auth plugin.
 *
 * - `reading`: the newest reading of one credential, from its responses.
 * - `usage`: read the provider's usage endpoint for one credential now.
 * - event `reading`: each new reading, as `{ credentialID, reading }`.
 */
export function quotaProtocol(integrationID: string) {
  const credential = {
    type: 'object',
    properties: { credentialID: { type: 'string' } },
    required: ['credentialID'],
  } as const
  const answer = {
    type: 'object',
    properties: { reading: {} },
  } as const
  return {
    id: `credential-quota.${integrationID}`,
    methods: {
      reading: { input: credential, output: answer },
      usage: { input: credential, output: answer },
    },
    events: {
      reading: {
        schema: {
          type: 'object',
          properties: { credentialID: { type: 'string' }, reading: {} },
          required: ['credentialID', 'reading'],
        },
      },
    },
  } as const
}
