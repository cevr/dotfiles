// Refresh tokens rotate when the token endpoint answers, so one token is sent
// at most once: concurrent refreshes of it share one request, a rotation is
// remembered a while after it lands, and a token whose refresh had an unclear
// outcome is never sent again.
import type { Deferred } from "effect"
import { sha256, sha256Base64url } from "./sha256.ts"
import { utf8Length } from "./utf8.ts"

export const MAX_TOKEN_KEY_BYTES = 8 * 1024
export const MAX_BLOCKED_REFRESH_TOKENS = 1024
const BLOCKED_REFRESH_FILTER_BYTES = 8 * 1024
const BLOCKED_REFRESH_FILTER_HASHES = 4
export const MAX_REFRESH_IN_FLIGHT = 256
export const MAX_REFRESH_CACHE_ENTRIES = 256
/** How long a location remembers a rotation after it lands, so a caller still holding the old token cannot resend it. */
export const REFRESH_CACHE_GRACE_MS = 30_000

/** A token's key: its SHA-256, when it is a non-empty token of at most 8 KiB. Never the token itself. */
export function tokenKey(token: string): string | undefined {
  if (token.length === 0 || token.length > MAX_TOKEN_KEY_BYTES) return undefined
  if (utf8Length(token) > MAX_TOKEN_KEY_BYTES) return undefined
  return sha256Base64url(token)
}

/**
 * Refresh tokens whose refresh had an unclear outcome. Past the exact set's
 * bound they go into a fixed-size filter that never forgets: forgetting one
 * could replay a token whose prior outcome was ambiguous. The filter fails
 * closed, so its false-positive rate grows over the process's life.
 */
export class BlockedRefreshTokens {
  private readonly exact = new Map<string, number>()
  private readonly filter = new Uint8Array(BLOCKED_REFRESH_FILTER_BYTES)

  private indexes(key: string): number[] {
    const digest = sha256(`blocked:${key}`)
    const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength)
    const bits = BLOCKED_REFRESH_FILTER_BYTES * 8
    return Array.from({ length: BLOCKED_REFRESH_FILTER_HASHES }, (_, index) => view.getUint32(index * 4) % bits)
  }

  private filterHas(key: string): boolean {
    return this.indexes(key).every((index) => ((this.filter[index >> 3] ?? 0) & (1 << (index & 7))) !== 0)
  }

  /** Never send the token `key` names again; `status` is the refresh's answer (0 for none). */
  block(key: string, status: number): void {
    if (this.exact.has(key) || this.filterHas(key)) return
    if (this.exact.size >= MAX_BLOCKED_REFRESH_TOKENS) {
      for (const index of this.indexes(key)) {
        const byteIndex = index >> 3
        this.filter[byteIndex] = (this.filter[byteIndex] ?? 0) | (1 << (index & 7))
      }
      return
    }
    this.exact.set(key, status)
  }

  /** Why the token `key` names may not be sent, if it may not. */
  blocked(key: string): string | undefined {
    const status = this.exact.get(key)
    if (status !== undefined) return `Anthropic token refresh blocked after ambiguous failure: ${status}`
    if (this.filterHas(key)) return "Anthropic token refresh blocked after an ambiguous failure"
    return undefined
  }
}

/**
 * The refreshes of the whole process: OpenCode sets the plugin up once per
 * location while its credential store is process-wide, so a rotation in
 * flight is shared across locations; a settled one stays location-local.
 */
export interface Refreshes<A, E> {
  readonly inFlight: Map<string, Deferred.Deferred<A, E>>
  readonly blocked: BlockedRefreshTokens
}

export const makeRefreshes = <A, E>(): Refreshes<A, E> => ({
  inFlight: new Map(),
  blocked: new BlockedRefreshTokens(),
})

/** A location's refresh of one token: shared while it runs, then remembered until `expiresAt`. */
export interface CachedRefresh<A, E> {
  readonly deferred: Deferred.Deferred<A, E>
  expiresAt: number | undefined
}

/** Drop the rotations `now` has passed the grace of. */
export function sweepRefreshCache<A, E>(cache: Map<string, CachedRefresh<A, E>>, now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt !== undefined && entry.expiresAt <= now) cache.delete(key)
  }
}
