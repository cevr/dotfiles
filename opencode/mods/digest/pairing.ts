// Pairing a browser with the digest page, so it may answer: `bun cmd/digest/pair.ts` makes a one-use code (good for
// CODE_TTL, kept only as its hash), the page exchanges it once at `/api/pair` for a cookie (HttpOnly,
// SameSite=Strict) signed with the digest's secret, and each answer carries that cookie. The secret and the codes
// live in one file beside the log (filestore/pairing.ts, 0600). Who may do what, by listener and route, is one
// table (`ACCESS`): on loopback a read or a mark needs no cookie and an answer does; on any other listener (the
// tailnet, a later unit) everything does but the pairing itself.
import { Array as Arr, Data, type Effect, Option } from "effect"

/** How long a code may be exchanged. */
export const CODE_TTL_MS = 5 * 60_000
/** How long a paired browser stays paired. */
export const COOKIE_TTL_S = 30 * 24 * 60 * 60
/** The cookie's name. */
export const COOKIE = "digest_pair"
/** A code's alphabet: no 0/O, 1/I/L or U, so a code read aloud or retyped is not misread. */
export const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
/** A code's characters: 10 of 30, about 49 bits. */
export const CODE_LENGTH = 10
/** Failed exchanges allowed in one RATE_WINDOW_MS; past them every exchange is refused until the window moves on. */
export const RATE_FAILURES = 5
export const RATE_WINDOW_MS = 60_000

/** A code as typed or pasted, compared: upper case, without spaces or dashes. */
export const normalizeCode = (code: string): string => code.toUpperCase().replace(/[\s-]/g, "")

/** A code as shown: two groups of five. */
export const showCode = (code: string): string => `${code.slice(0, 5)}-${code.slice(5)}`

/** Why an exchange was refused: no such code (wrong, or used already) or out of time. */
export class PairRefused extends Data.TaggedError("PairRefused")<{ readonly reason: "unknown" | "expired" }> {}

/** The pairing file cannot be read or written, or is of a version this build does not know. */
export class PairingUnavailable extends Data.TaggedError("PairingUnavailable")<{ readonly message: string }> {}

/** The digest's pairing, as the page's listener and the pair command reach it. */
export interface Pairing {
  /** A new one-use code, good for CODE_TTL_MS from `now`. */
  readonly issue: (now: number) => Effect.Effect<string, PairingUnavailable>
  /** Use `code` up (once, whatever comes of it) for a new cookie value. */
  readonly exchange: (code: string, now: number) => Effect.Effect<string, PairRefused | PairingUnavailable>
  /** Whether `cookie` is one this digest signed. */
  readonly verify: (cookie: string) => Effect.Effect<boolean>
}

/** The failed exchanges kept for the rate limit: the times of those in the window. */
export const failuresIn = (failures: ReadonlyArray<number>, now: number): ReadonlyArray<number> => failures.filter((t) => now - t < RATE_WINDOW_MS)

/** Whether another exchange may be tried now, given the failures kept. */
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

/** The cookie a request carries under COOKIE, if any. */
export const cookieOf = (header: string): Option.Option<string> =>
  Option.map(
    Arr.findFirst(
      header.split(";").map((part) => part.trim()),
      (part) => part.startsWith(`${COOKIE}=`),
    ),
    (part) => part.slice(COOKIE.length + 1),
  )

/** The Set-Cookie header of a pairing: HttpOnly and SameSite=Strict, for the whole page. */
export const setCookie = (value: string): string => `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_TTL_S}`
