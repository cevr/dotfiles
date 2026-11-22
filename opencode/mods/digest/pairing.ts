// Pairing a browser with the digest page, so it may answer: `bun cmd/digest/pair.ts` makes a one-use code (good for
// CODE_TTL_MS, kept only as its hash); the page exchanges it once at `/api/pair` for a token, which the answer
// carries in the response body to the page's own origin. The page keeps the token in localStorage, which is scoped
// to scheme, host and port, and sends it as TOKEN_HEADER on each write. Nothing ambient is used: no cookie. A cookie
// is not port-scoped, so another web server on 127.0.0.1 that the browser visits would receive it. The server
// keeps only each token's hash, beside the codes' hashes and the failed tries, in one file
// (filestore/pairing.ts, 0600).
//
// Who may do what, by listener and route, is one table (`ACCESS`). On loopback a read or a mark needs no token and an
// answer does. On any other listener (the tailnet, a later unit) everything needs one except the pairing itself.
import { Data, type Effect, type Option } from "effect"

/** How long a code may be exchanged. */
export const CODE_TTL_MS = 5 * 60_000
/** The request header that carries a paired browser's token; the only credential the listener reads. */
export const TOKEN_HEADER = "x-digest-token"
/** The cookie round 1 paired with, read by nothing now: a request that carries it alone is not paired. */
export const OLD_COOKIE = "digest_pair"
/** A code's alphabet: no 0/O, 1/I/L or U, so a code read aloud or retyped is not misread. */
export const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
/** A code's characters: 10 of 30, about 49 bits. */
export const CODE_LENGTH = 10
/** Failed exchanges allowed in one RATE_WINDOW_MS. Past them, every exchange is refused before any code is compared. */
export const RATE_FAILURES = 5
export const RATE_WINDOW_MS = 60_000
/** Browsers paired at once (his Mac's and his phone's, and a few more); a pairing past them unpairs the oldest. */
export const MAX_PAIRED = 8

/** A code as typed or pasted, compared: upper case, without spaces or dashes. */
export const normalizeCode = (code: string): string => code.toUpperCase().replace(/[\s-]/g, "")

/** A code as shown: two groups of five. */
export const showCode = (code: string): string => `${code.slice(0, 5)}-${code.slice(5)}`

/**
 * Why an exchange was refused: no such code (wrong, or used already), out of time, or too many failed tries in the
 * window (nothing was compared).
 */
export class PairRefused extends Data.TaggedError("PairRefused")<{ readonly reason: "unknown" | "expired" | "limited" }> {}

/** The pairing file cannot be read or written, or is of a version this build does not know. */
export class PairingUnavailable extends Data.TaggedError("PairingUnavailable")<{ readonly message: string }> {}

/** A paired browser: its id (shown by `pair --list`, named by `pair --revoke`), when, and what it said it was. */
export interface Paired {
  readonly id: string
  readonly created: number
  readonly label: string
}

/** The digest's pairing, as the page's listener and the pair command reach it. */
export interface Pairing {
  /** A new one-use code, good for CODE_TTL_MS from `now`. */
  readonly issue: (now: number) => Effect.Effect<string, PairingUnavailable>
  /**
   * `code` used up for a new token, for the browser `label`. It is atomic across fibers and processes: a code is
   * exchanged once, and a failed try is counted before the next one is compared.
   */
  readonly exchange: (code: string, now: number, label: string) => Effect.Effect<{ readonly id: string; readonly token: string }, PairRefused | PairingUnavailable>
  /** The paired browser `token` is, if it is one. */
  readonly verify: (token: string) => Effect.Effect<Option.Option<string>>
  /** The browsers paired now, oldest first. */
  readonly list: Effect.Effect<ReadonlyArray<Paired>, PairingUnavailable>
  /** Unpair one browser by its id, or every one; how many were unpaired. */
  readonly revoke: (which: { readonly id: string } | "all") => Effect.Effect<number, PairingUnavailable>
}

/** The failed tries kept for the rate limit: those in the window. */
export const failuresIn = (failures: ReadonlyArray<number>, now: number): ReadonlyArray<number> => failures.filter((t) => now - t < RATE_WINDOW_MS)

/** Whether another exchange may be tried now, given the failed tries kept. */
export const mayTry = (failures: ReadonlyArray<number>, now: number): boolean => failuresIn(failures, now).length < RATE_FAILURES

// ── Who may do what ──

/** The listener a request came in on: loopback (this unit's only one) or another address (the tailnet). */
export type Listener = "loopback" | "remote"

/** A route's kind: a read (the page, the view, whether paired), a mark (read, Later, a name), an answer, the pairing. */
export type RouteKind = "read" | "mark" | "answer" | "pair"

/** What a route needs on a listener: nothing but the page's own origin, or a paired browser. */
export type Need = "open" | "paired"

export const ACCESS: Readonly<Record<Listener, Readonly<Record<RouteKind, Need>>>> = {
  loopback: { read: "open", mark: "open", answer: "paired", pair: "open" },
  remote: { read: "paired", mark: "paired", answer: "paired", pair: "open" },
}

/** What `kind` needs on `listener`. */
export const needOf = (listener: Listener, kind: RouteKind): Need => ACCESS[listener][kind]
