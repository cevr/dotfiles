// What the pool alerts its owner to: a login that needs a sign-in again, and
// an outside store whose refreshes have all failed for a sustained while. The
// stores report what happened (Logins.refreshes); this decides what is an
// alert. Pure: the model hands it the time.
import type { RefreshCause } from "./status.ts"

/** How long every refresh from a store must fail before it is an outage, by default. */
export const OUTAGE_AFTER_MS = 10 * 60_000

/**
 * How an outside store's trades have gone since the token endpoint last
 * answered one: a run of failures from `failingSince` to `lastFailureAt`,
 * and the endpoint's last word. `pausedUntil` is when the endpoint said the
 * store may trade again (0 when it never did).
 */
export interface RefreshRecord {
  readonly failingSince?: number
  readonly lastFailureAt?: number
  readonly failures: number
  readonly cause?: RefreshCause
  readonly pausedUntil: number
}

/** A login of an outside store that needs a sign-in again, and its slot file. Never a token. */
export interface StoreLostLogin {
  readonly credentialID: string
  readonly label: string
  readonly since: number
  readonly slot: string
}

/** What one outside store of a pool reports: its lost logins and how its refreshes go. */
export interface StoreRefreshes {
  readonly dir: string
  readonly lost: ReadonlyArray<StoreLostLogin>
  readonly record: RefreshRecord
}

/** A run of failures long enough to alert on. */
export interface Outage {
  readonly since: number
  readonly lastAt: number
  readonly failures: number
  readonly cause?: RefreshCause
}

/**
 * Whether a store's refreshes are out at `now`: every trade has failed for at
 * least `thresholdMs`. A pause the endpoint asked for counts as failing while
 * it lasts, since nothing can go out. A run nothing has extended for as long
 * as the threshold (no trade went out since, and no pause holds) is stale: no
 * one knows it still fails, so it is no outage.
 */
export const outage = (record: RefreshRecord, now: number, thresholdMs: number = OUTAGE_AFTER_MS): Outage | undefined => {
  const { failingSince, lastFailureAt } = record
  if (failingSince === undefined || lastFailureAt === undefined) return undefined
  const through = Math.max(lastFailureAt, Math.min(now, record.pausedUntil))
  if (now - through > thresholdMs) return undefined
  if (through - failingSince < thresholdMs) return undefined
  return {
    since: failingSince,
    lastAt: lastFailureAt,
    failures: record.failures,
    ...(record.cause === undefined ? {} : { cause: record.cause }),
  }
}
