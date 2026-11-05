/**
 * gent's credential store as a source of pool accounts, read in place: the
 * store stays the one copy of each login, and this module reads and refreshes
 * it the way gent does, so gent and OpenCode always hold the same token.
 *
 * gent keeps each Claude account it signed in to as a JSON file, one per
 * label, at `<dir>/.slots/anthropic/<label>`, marked `metadata.owner: "gent"`.
 * Anthropic spends a refresh token when it is traded, so a copy of a login in
 * two stores breaks the other the first time one refreshes; here there is no
 * copy.
 *
 * A token is read from the file on every request. It is refreshed ahead of
 * time: once it expires within the refresh-ahead window (five minutes plus a
 * jitter of up to two minutes, fixed per label, so accounts signed in or
 * refreshed together drift apart instead of expiring in one burst), or when
 * the provider rejected it. The refresh runs as gent's does
 * (`makeCredentialCache` and `ownedStore` in gent's extensions): under gent's
 * lock for the provider (an exclusive SQLite transaction on
 * `<dir>/.locks/anthropic.lock.db`, taken by every gent process), the file is
 * read again, a token another writer refreshed meanwhile is served as it is,
 * and only a token still due is traded at the token endpoint. The answer is
 * written atomically, mode 0600, in gent's exact shape, keeping the sign-in's
 * `signedInAt` and `metadata`.
 *
 * A refresh ahead of time never costs a request its token. While the stored
 * token is still good for more than gent's last minute (`FRESH_ENOUGH_MS`) and
 * no provider rejected it, a refresh that cannot happen now (the endpoint
 * paused the store, the last trade was too recent, a 429, a 5xx, a timeout, a
 * lock held too long) serves the stored token, and a later request tries
 * again. Only a token in its last minute, or one a provider rejected, must be
 * refreshed before it is sent, and then such a failure fails the resolve.
 *
 * Trades are spaced: at least `REFRESH_GAP_MS` between two from one store in
 * this process, so a wave of due accounts cannot burst at the endpoint. A 429
 * pauses every trade from the store (`ENDPOINT_PAUSE_MS`). Each trade is
 * logged at info with its label and outcome, a pause once at warning with its
 * end; no token is ever logged.
 *
 * `peek` is the read that never trades: the stored token while it is good,
 * else nothing. The usage sweep reads through it, so a sweep never refreshes.
 *
 * A failed refresh writes nothing: the refresh token in the file is still the
 * one to retry with. A refresh that worked but whose write failed keeps the
 * new tokens in memory (gent's `PendingPersist`); the next resolve writes them
 * under the lock, but only while the file still holds the login they replace.
 *
 * Only accounts gent signed in to are listed. The default entry and linked
 * slots are Claude Code's own logins: gent refreshes those through Claude
 * Code's keychain or directory and its held rotations, so this source leaves
 * them alone.
 *
 * No token is ever logged or put in an error message.
 *
 * The store is worked in Effect (`listing`, `resolveEffect`). The provider's
 * auth plugin reads a source through a registry of plain functions shared by
 * every copy of a module in the process (`registerCredentialSource`), so
 * `list`, `resolve` and `peek` are that registry's synchronous and Promise
 * faces. `resolve` and `peek` log through the loggers given as `context`.
 *
 * @module
 */
import { Database } from "bun:sqlite"
import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { open, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { Context, Effect, Logger, Schema } from "effect"

/** The token endpoint Claude Code and the Anthropic auth plugin refresh at, and Claude Code's public client id. */
export const GENT_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
export const GENT_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
/**
 * The `user-agent` a trade names, Claude Code's own (the Anthropic auth
 * plugin's refresh sends it too). It is set outright: OpenCode's binary
 * compiles in a default `opencode/<channel>/<version>/cli`, and the token
 * endpoint's edge answers that agent, as it does `curl/*`, with a 429 every
 * time while it trades for any other.
 */
export const GENT_USER_AGENT = "axios/1.13.6"
/** The prefix of a gent account's credential id in the pool. */
export const GENT_PREFIX = "gent:"

const PROVIDER = "anthropic"
/** gent's `FRESH_ENOUGH_MS`: a token in its last minute is refreshed before it is sent. */
const FRESH_ENOUGH_MS = 60_000
/** gent's `OAUTH_TOKEN_TIMEOUT`. */
const TOKEN_TIMEOUT_MS = 15_000
/** gent's lock poll: every 20 ms, 1500 times (about 30 seconds). */
const LOCK_POLL_MS = 20
const LOCK_POLLS = 1500
/** gent's default token lifetime when the answer names none (`parseOAuthResponse`). */
const DEFAULT_EXPIRES_IN_S = 36_000
/** How soon a credential that failed for a passing reason is tried again. */
const RETRY_MS = 60_000
/**
 * How long a 429 from the token endpoint pauses every refresh from this store
 * when it names no retry-after. The limit is the endpoint's, not one account's:
 * retrying each account on its own kept a rate limit going for 40 minutes on
 * 2026-11-04.
 */
const ENDPOINT_PAUSE_MS = 5 * 60_000
/** How long before it expires a token is refreshed, before the label's jitter (teamclaude's `isTokenExpiringSoon`). */
export const REFRESH_AHEAD_MS = 5 * 60_000
/** The most a label's jitter adds to the refresh-ahead window. */
export const REFRESH_JITTER_MS = 120_000
/** The least time between two trades from one store in this process. */
export const REFRESH_GAP_MS = 3_000
/** gent's `CredentialSlot` pattern; `default` is the default entry, never a slot. */
const SLOT = /^[a-z0-9_-]{1,32}$/
const STAGING_TAG = ".gent-write-"

/** A stored gent OAuth sign-in, as gent's `AuthInfo` encodes it. */
export interface GentStoredOAuth {
  readonly _tag?: "Oauth"
  readonly type: "oauth"
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly accountId?: string | null
  readonly metadata?: Readonly<Record<string, string>>
  readonly signedInAt?: number
}

interface Tokens {
  readonly access: string
  readonly refresh: string
  readonly expires: number
}

/** Why a gent account cannot serve a request now. Never carries a token. */
export const GentFailureKind = Schema.Literals([
  /** The label holds no sign-in any more. */
  "signed-out",
  /** The label holds a sign-in gent does not own (Claude Code's), or a file that does not decode. */
  "not-owned",
  /** The token endpoint refused the refresh token: sign in again in gent. */
  "rejected",
  /** The token endpoint did not answer usefully (transport, timeout, 429, 5xx): try again shortly. */
  "unavailable",
  /** gent's lock stayed held for the whole wait. */
  "busy",
  /** The refresh worked but its write failed; the new tokens are held in memory. */
  "persist",
])
export type GentFailureKind = typeof GentFailureKind.Type

export class GentCredentialError extends Schema.TaggedError<GentCredentialError>()("GentCredentialError", {
  kind: GentFailureKind,
  message: Schema.String,
  /** When the account may be tried again (epoch ms); absent until the owner signs in again. */
  retryAt: Schema.optionalKey(Schema.Number),
}) {}

/** The store's files could not be read (not a missing file: a permission or a disk failure). */
export class GentStoreUnreadable extends Schema.TaggedError<GentStoreUnreadable>()("GentStoreUnreadable", {
  path: Schema.String,
  message: Schema.String,
}) {}

const failure = (kind: GentFailureKind, message: string, retryAt?: number) =>
  new GentCredentialError({ kind, message, ...(retryAt === undefined ? {} : { retryAt }) })

export interface GentSourceOptions {
  /** gent's auth directory; `~` is the home directory. */
  readonly dir: string
  /** The token endpoint; tests point it at a fake. */
  readonly tokenURL?: string
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
  readonly now?: () => number
  /** How many times a busy lock is polled before the refresh gives up. */
  readonly lockPolls?: number
  /** How a trade waits out the gap after the last one; tests move a fake clock. */
  readonly sleep?: (ms: number) => Promise<void>
  /** The least time between two trades from this store, ms. Default `REFRESH_GAP_MS`. */
  readonly refreshGapMs?: number
  /**
   * What `resolve` and `peek` run with: the host's loggers, from the plugin's
   * context. Default none, so the source logs nothing.
   */
  readonly context?: Context.Context<never>
}

/**
 * How much a label adds to the refresh-ahead window, ms in `[0, maxMs]`: the
 * same for a label every time, in every process, and spread across labels.
 */
export const refreshJitter = (label: string, maxMs: number = REFRESH_JITTER_MS): number =>
  maxMs <= 0 ? 0 : createHash("sha256").update(`gent-refresh:${label}`).digest().readUInt32BE(0) % (Math.floor(maxMs) + 1)

/** An account gent holds, or a label this source leaves alone and why. */
export interface GentListing {
  readonly accounts: ReadonlyArray<string>
  readonly skipped: ReadonlyArray<{ readonly label: string; readonly reason: string }>
}

const expandHome = (dir: string) => (dir === "~" || dir.startsWith("~/") ? join(homedir(), dir.slice(1)) : dir)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === "string")

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The JSON `text` holds, or none when it is not JSON. */
const parseJson = (text: string): { readonly value: unknown } | undefined => {
  try {
    return { value: JSON.parse(text) }
  } catch {
    return undefined
  }
}

/** A stored OAuth sign-in, checked field by field, or `undefined`. */
export const decodeGentOAuth = (text: string): GentStoredOAuth | undefined => {
  const value = parseJson(text)?.value
  if (!isRecord(value) || value.type !== "oauth") return undefined
  const { access, refresh, expires, accountId, metadata, signedInAt } = value
  if (typeof access !== "string" || typeof refresh !== "string" || !finite(expires)) return undefined
  if (metadata !== undefined && !isStringRecord(metadata)) return undefined
  if (signedInAt !== undefined && !finite(signedInAt)) return undefined
  return {
    ...(value._tag === "Oauth" ? { _tag: "Oauth" as const } : {}),
    type: "oauth",
    access,
    refresh,
    expires,
    ...(typeof accountId === "string" || accountId === null ? { accountId } : {}),
    ...(metadata === undefined ? {} : { metadata }),
    ...(signedInAt === undefined ? {} : { signedInAt }),
  }
}

/** gent's `isGentOwned`: an account gent signed in to itself. */
export const isGentOwned = (stored: GentStoredOAuth) => stored.metadata?.owner === "gent"

/**
 * The file gent writes after a refresh of an account it owns: its `AuthInfo`
 * encoding, compact, in the schema's field order. The Anthropic driver drops
 * `accountId` (`toStoredClaude`), which encodes as `null`; the store keeps the
 * sign-in's `metadata` and `signedInAt`.
 */
export const encodeGentRefresh = (stored: GentStoredOAuth, next: Tokens): string =>
  JSON.stringify({
    _tag: "Oauth",
    type: "oauth",
    access: next.access,
    refresh: next.refresh,
    expires: next.expires,
    accountId: null,
    ...(stored.metadata === undefined ? {} : { metadata: stored.metadata }),
    ...(stored.signedInAt === undefined ? {} : { signedInAt: stored.signedInAt }),
  })

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: (cause) => cause })

/**
 * gent's `writeFileAtomic` for a credential: a sibling staging file created
 * exclusively with mode 0600, synced, then renamed over the file a link at
 * `path` points to. A failed write removes its staging file.
 */
export const writeGentFileAtomic = (path: string, content: string): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const target = yield* Effect.try({ try: () => realpathSync(path), catch: () => path }).pipe(Effect.orElseSucceed(() => path))
    const staging = join(dirname(target), `.${basename(target)}${STAGING_TAG}${randomBytes(4).toString("hex")}`)
    const handle = yield* attempt(() => open(staging, "wx", 0o600))
    yield* Effect.gen(function* () {
      const written = yield* Effect.exit(
        attempt(() => handle.chmod(0o600)).pipe(
          Effect.andThen(attempt(() => handle.writeFile(content))),
          Effect.andThen(attempt(() => handle.sync())),
        ),
      )
      yield* attempt(() => handle.close())
      yield* written
      yield* attempt(() => rename(staging, target))
    }).pipe(Effect.tapError(() => attempt(() => rm(staging, { force: true })).pipe(Effect.ignore)))
  })

const isBusy = (error: unknown) => isRecord(error) && error.code === "SQLITE_BUSY"

const BUSY = Symbol("busy")

/** One try at gent's lock: the open connection holding it, or BUSY while another holds it. */
const begin = (file: string): Effect.Effect<Database | typeof BUSY> =>
  Effect.try({ try: () => new Database(file, { create: true }), catch: (cause) => cause }).pipe(
    Effect.flatMap((db) =>
      Effect.try({
        try: () => {
          db.exec("PRAGMA busy_timeout = 0")
          db.exec("BEGIN EXCLUSIVE")
          return db
        },
        catch: (cause) => {
          db.close()
          return cause
        },
      }),
    ),
    Effect.catch((cause) => (isBusy(cause) ? Effect.succeed(BUSY) : Effect.die(cause))),
  )

/**
 * Run `use` while holding gent's lock for the provider: an exclusive SQLite
 * transaction on `<dir>/.locks/<provider>.lock.db`, opened with no busy
 * timeout and polled while another connection holds it, as gent's
 * `fileProviderLock` does. Closing the connection ends the transaction and
 * frees the lock; the OS frees it if the process dies.
 */
export const withGentLock = <A, E, R>(
  dir: string,
  use: Effect.Effect<A, E, R>,
  polls: number = LOCK_POLLS,
): Effect.Effect<A, E | GentCredentialError, R> => {
  const locks = join(dir, ".locks")
  const file = join(locks, `${encodeURIComponent(PROVIDER)}.lock.db`)
  const take = (poll: number): Effect.Effect<Database, GentCredentialError> =>
    begin(file).pipe(
      Effect.flatMap((db) => {
        if (db !== BUSY) return Effect.succeed(db)
        if (poll >= polls)
          return Effect.fail(
            failure(
              "busy",
              "gent's credential store is busy: its Anthropic lock stayed held for the whole wait",
              Date.now() + RETRY_MS,
            ),
          )
        return Effect.sleep(LOCK_POLL_MS).pipe(Effect.andThen(take(poll + 1)))
      }),
    )
  return Effect.try({ try: () => mkdirSync(locks, { recursive: true }), catch: (cause) => cause }).pipe(
    Effect.orDie,
    Effect.andThen(
      Effect.acquireUseRelease(
        take(0),
        () => use,
        (db) => Effect.sync(() => db.close()),
      ),
    ),
  )
}

/**
 * What a 429 says about who limited the request, for the log: the `server` header (an edge such
 * as Cloudflare, or Anthropic), `retry-after`, and the error's type and message from a JSON body,
 * or the start of any other body with markup dropped. A 429 body carries no token.
 */
export function limitDetail(server: string | null, retryAfter: string | null, body: string): string {
  const parsed = parseJson(body)
  const value = parsed?.value
  const error = isRecord(value) && isRecord(value.error) ? value.error : isRecord(value) ? value : {}
  const said = parsed !== undefined
    ? [error.type, error.message, error.error, error.error_description]
        .filter((part): part is string => typeof part === "string" && part !== "")
        .join(": ")
    : body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
  return [
    `server ${server ?? "unnamed"}`,
    `retry-after ${retryAfter ?? "none"}`,
    said === "" ? "empty body" : `"${said.slice(0, 160)}"`,
  ].join("; ")
}

/** A 429's `retry-after` (seconds or an HTTP date) as a wait in ms; ENDPOINT_PAUSE_MS when it names none. */
function pauseFor(retryAfter: string | null, now: number): number {
  if (retryAfter === null || retryAfter.trim() === "") return ENDPOINT_PAUSE_MS
  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(retryAfter)
  return Number.isFinite(at) && at > now ? at - now : ENDPOINT_PAUSE_MS
}

/** What the token endpoint said when it last failed a trade from a store: never a token. */
export interface GentRefreshCause {
  /** Its HTTP status; none when it did not answer (transport, timeout). */
  readonly status?: number
  /** Its `server` header: the edge (Cloudflare) or Anthropic. */
  readonly server?: string
  /** Its `retry-after` header, as sent. */
  readonly retryAfter?: string
}

/**
 * How a store's trades have gone since the last one the endpoint answered: a
 * run of `unavailable` trades (a 429, a 5xx, no answer, a pause) from
 * `failingSince` to `lastFailureAt`, and the cause of the last one that went
 * out. A refresh, or a refusal (the endpoint answered), ends the run.
 */
export interface GentRefreshRecord {
  readonly failingSince?: number
  readonly lastFailureAt?: number
  readonly failures: number
  readonly cause?: GentRefreshCause
  /** Until when (epoch ms) the endpoint asked the store to wait; 0 when it never did. */
  readonly pausedUntil: number
}

/** A login whose refresh token the token endpoint refused, still in its file: it needs a sign-in in gent. */
export interface GentLostLogin {
  readonly credentialID: string
  readonly label: string
  /** When (epoch ms) the endpoint first refused that refresh token. */
  readonly since: number
  /** The command that signs it in again in gent, for this store. */
  readonly command: string
}

/** gent's own auth directory, when `GENT_AUTH_DIRECTORY` names none. */
const GENT_DEFAULT_DIR = "~/.gent/auth"

/** `dir` as the owner types it: `~` for the home directory. */
const tildeOf = (dir: string) => {
  const home = homedir()
  return dir === home ? "~" : dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir
}

const shellQuote = (text: string) => (/^[\w@%+=:,./~-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`)

/**
 * The command that signs `label` in again in gent, over the store at `dir`
 * (absolute): gent's sign-in to a Claude account into that slot
 * (gent's apps/tui/docs/cli.md), naming the store unless it is gent's own.
 */
export const gentSignInCommand = (dir: string, label: string): string => {
  const store = resolve(expandHome(dir)) === resolve(expandHome(GENT_DEFAULT_DIR)) ? "" : `GENT_AUTH_DIRECTORY=${shellQuote(tildeOf(dir))} `
  return `${store}gent auth login anthropic --method "Sign in to a Claude account" --slot ${label}`
}

/** One store's state in this process: refreshes held for a write, and tokens a provider rejected. */
interface StoreState {
  /** Per label: tokens a refresh got whose write failed, and the refresh token they replace. */
  readonly pending: Map<string, { readonly next: Tokens; readonly replaces: string }>
  /** Per label: the refresh token of the login whose access token a provider rejected. */
  readonly rejected: Map<string, string>
  /** Per label: the refresh token the token endpoint refused, and since when; it stands while the file holds it. */
  readonly refused: Map<string, { readonly refresh: string; readonly since: number }>
  /** The run of failed trades this store is in, if any, and the last cause the endpoint gave. */
  failingSince: number | undefined
  lastFailureAt: number | undefined
  failures: number
  cause: GentRefreshCause | undefined
  /** The tail of this process's queue for the lock: one refresh at a time per store. */
  queue: Promise<unknown>
  /** Until when (epoch ms) the token endpoint asked this store to wait; no refresh goes out before. */
  pausedUntil: number
  /** When (epoch ms) this store's last trade went out; the next waits `REFRESH_GAP_MS` after it. */
  lastTradeAt: number
}

/** Shared by every setup in the process, whichever copy of this module it loaded. */
const STATES = Symbol.for("dotfiles-opencode.pool.gent-stores")

const freshState = (): StoreState => ({
  pending: new Map(),
  rejected: new Map(),
  refused: new Map(),
  failingSince: undefined,
  lastFailureAt: undefined,
  failures: 0,
  cause: undefined,
  queue: Promise.resolve(),
  pausedUntil: 0,
  lastTradeAt: -Infinity,
})

/**
 * The store's state in this process. It outlives a hot reload, so a state an
 * older copy of this module made may lack fields this copy added: those are
 * filled in, and what the older copy kept (its queue, pause, pending writes)
 * stays.
 */
const stateOf = (dir: string): StoreState => {
  const global = globalThis as unknown as Record<symbol, Map<string, Partial<StoreState>> | undefined>
  const states = (global[STATES] ??= new Map())
  const kept = states.get(dir)
  if (kept === undefined) {
    const state = freshState()
    states.set(dir, state)
    return state
  }
  const defaults = freshState() as unknown as Record<string, unknown>
  const target = kept as Record<string, unknown>
  for (const key of Object.keys(defaults)) if (!(key in target)) target[key] = defaults[key]
  return kept as StoreState
}

/**
 * One refresh at a time per store in this process, whichever copy of this
 * module (or of Effect) runs it; gent's lock orders them across processes. A
 * Promise is the queue because it is what every copy shares.
 */
const serialized = <A, E>(state: StoreState, run: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    const before = state.queue
    const done = Promise.withResolvers<void>()
    state.queue = before.then(() => done.promise)
    return Effect.promise(() => before).pipe(
      Effect.andThen(run),
      Effect.ensuring(Effect.sync(() => done.resolve())),
    )
  })

/** A label's sign-in: `null` when the label holds none, `undefined` when its file does not decode. */
type Stored = GentStoredOAuth | undefined | null

/** A gent store's Anthropic accounts, read and refreshed in place. */
export class GentSource {
  readonly dir: string
  private readonly slots: string
  private readonly tokenURL: string
  private readonly fetch: (url: string, init: RequestInit) => Promise<Response>
  private readonly now: () => number
  private readonly lockPolls: number
  private readonly sleep: (ms: number) => Effect.Effect<void>
  private readonly gapMs: number
  private readonly context: Context.Context<never>
  private readonly state: StoreState

  constructor(options: GentSourceOptions) {
    this.dir = resolve(expandHome(options.dir))
    this.slots = join(this.dir, ".slots", encodeURIComponent(PROVIDER))
    this.tokenURL = options.tokenURL ?? GENT_TOKEN_URL
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.lockPolls = options.lockPolls ?? LOCK_POLLS
    const sleep = options.sleep
    this.sleep = sleep === undefined ? (ms) => Effect.sleep(ms) : (ms) => Effect.promise(() => sleep(ms))
    this.gapMs = options.refreshGapMs ?? REFRESH_GAP_MS
    this.context = options.context ?? Context.make(Logger.CurrentLoggers, new Set())
    this.state = stateOf(this.dir)
  }

  /** The pool's credential id of a label. */
  static id(label: string) {
    return `${GENT_PREFIX}${label}`
  }

  owns(credentialID: string) {
    return this.labelOf(credentialID) !== undefined
  }

  /** The slot label of one of this store's credential ids (`gent:<label>`); none for another id. */
  label(credentialID: string): string | undefined {
    return this.labelOf(credentialID)
  }

  /** The accounts gent signed in to, by label, and the labels this source leaves alone. */
  readonly listing: Effect.Effect<GentListing, GentStoreUnreadable> = Effect.suspend(() => {
    const names = this.names()
    if (names === undefined) return Effect.succeed({ accounts: [], skipped: [] })
    return Effect.gen({ self: this }, function* (this: GentSource) {
      const accounts: Array<string> = []
      const skipped: Array<{ label: string; reason: string }> = []
      for (const name of names.sort()) {
        if (name.startsWith(".")) continue
        const label = this.decodeName(name)
        if (label === undefined || !SLOT.test(label) || label === "default") continue
        const stored = yield* this.read(label)
        if (stored === null) continue
        if (stored === undefined) skipped.push({ label, reason: "does not decode as an OAuth sign-in" })
        else if (!isGentOwned(stored)) skipped.push({ label, reason: "a linked Claude Code login, which gent refreshes itself" })
        else accounts.push(GentSource.id(label))
      }
      return { accounts, skipped }
    })
  })

  /** `listing`, for a caller outside Effect. An unreadable store throws, as a failed read does. */
  list(): GentListing {
    return Effect.runSync(this.listing)
  }

  /** The token to send now for `credentialID`, refreshed under gent's lock when it must be. */
  resolveEffect(credentialID: string): Effect.Effect<{ access: string; expires: number }, GentCredentialError | GentStoreUnreadable> {
    return Effect.gen({ self: this }, function* (this: GentSource) {
      const label = this.labelOf(credentialID)
      if (label === undefined) return yield* failure("signed-out", "Not a gent account")
      const stored = yield* this.owned(label, yield* this.read(label))
      const served = { access: stored.access, expires: stored.expires }
      const settled = !this.state.pending.has(label) && this.state.rejected.get(label) !== stored.refresh
      if (settled && !this.due(label, stored.expires)) return served
      // A token still good past its last minute can wait for its refresh: a
      // trade that cannot happen now serves it, and a later request tries again.
      const usable = settled && this.fresh(stored.expires)
      if (usable && this.held() !== undefined) return served
      // Under the lock the file is read again and a failed trade serves what it holds; a lock
      // held for the whole wait serves the token read here.
      return yield* serialized(this.state, withGentLock(this.dir, this.refreshLocked(label), this.lockPolls)).pipe(
        Effect.catchIf(
          (error) => usable && error._tag === "GentCredentialError" && error.kind === "busy",
          () => Effect.succeed(served),
        ),
      )
    })
  }

  /** `resolveEffect`, as the credential registry calls it: a failure rejects with its error. */
  resolve(credentialID: string): Promise<{ access: string; expires: number }> {
    return Effect.runPromiseWith(this.context)(this.resolveEffect(credentialID))
  }

  /**
   * The stored token for `credentialID` while it is good past its last minute
   * and nothing asks to replace it (a provider's rejection, a held write);
   * else nothing. Never trades, never takes the lock.
   */
  peekEffect(credentialID: string): Effect.Effect<{ access: string; expires: number } | undefined> {
    return Effect.gen({ self: this }, function* (this: GentSource) {
      const label = this.labelOf(credentialID)
      if (label === undefined) return undefined
      const stored = yield* this.read(label).pipe(Effect.orElseSucceed((): Stored => null))
      if (!stored || !isGentOwned(stored)) return undefined
      if (this.state.pending.has(label) || this.state.rejected.get(label) === stored.refresh || !this.fresh(stored.expires))
        return undefined
      return { access: stored.access, expires: stored.expires }
    })
  }

  /** `peekEffect`, as the credential registry calls it. */
  peek(credentialID: string): Promise<{ access: string; expires: number } | undefined> {
    return Effect.runPromiseWith(this.context)(this.peekEffect(credentialID))
  }

  /**
   * A provider rejected `access`. When the store still holds it, the next
   * resolve refreshes the login whatever its expiry says, as gent's
   * `invalidate` does; a token the store already replaced changes nothing.
   * A store that cannot be read changes nothing either.
   */
  rejected(credentialID: string, access: string): void {
    const label = this.labelOf(credentialID)
    if (label === undefined) return
    const stored = Effect.runSync(this.read(label).pipe(Effect.orElseSucceed(() => null)))
    if (stored && stored.access === access) this.state.rejected.set(label, stored.refresh)
  }

  /**
   * The logins that need a sign-in in gent: each whose file still holds the
   * refresh token the token endpoint refused. One whose file holds another
   * login now (refreshed here or by gent, or signed in again) or none is
   * forgotten; one whose file cannot be read stays.
   */
  readonly lost: Effect.Effect<ReadonlyArray<GentLostLogin>> = Effect.suspend(() =>
    Effect.gen({ self: this }, function* (this: GentSource) {
      const lost: Array<GentLostLogin> = []
      for (const [label, refused] of [...this.state.refused].sort(([a], [b]) => a.localeCompare(b))) {
        const stored = yield* this.read(label).pipe(Effect.orElseSucceed((): Stored | "unread" => "unread"))
        if (stored !== "unread" && stored?.refresh !== refused.refresh) {
          this.state.refused.delete(label)
          continue
        }
        lost.push({ credentialID: GentSource.id(label), label, since: refused.since, command: gentSignInCommand(this.dir, label) })
      }
      return lost
    }),
  )

  /** How this store's trades have gone since the endpoint last answered one. */
  readonly refreshes: Effect.Effect<GentRefreshRecord> = Effect.sync(() => ({
    ...(this.state.failingSince === undefined ? {} : { failingSince: this.state.failingSince }),
    ...(this.state.lastFailureAt === undefined ? {} : { lastFailureAt: this.state.lastFailureAt }),
    failures: this.state.failures,
    ...(this.state.cause === undefined ? {} : { cause: this.state.cause }),
    pausedUntil: this.state.pausedUntil,
  }))

  private labelOf(credentialID: string): string | undefined {
    if (!credentialID.startsWith(GENT_PREFIX)) return undefined
    const label = credentialID.slice(GENT_PREFIX.length)
    return SLOT.test(label) && label !== "default" ? label : undefined
  }

  private file(label: string) {
    return join(this.slots, encodeURIComponent(label))
  }

  /** The slot directory's entries, or none when it cannot be read. */
  private names(): Array<string> | undefined {
    try {
      return readdirSync(this.slots)
    } catch {
      return undefined
    }
  }

  private decodeName(name: string): string | undefined {
    try {
      return decodeURIComponent(name)
    } catch {
      return undefined
    }
  }

  /** The label's sign-in, `null` when the label holds none, `undefined` when its file does not decode. */
  private read(label: string): Effect.Effect<Stored, GentStoreUnreadable> {
    const path = this.file(label)
    return Effect.try({ try: () => readFileSync(path, "utf8"), catch: (cause) => cause }).pipe(
      Effect.map((text): Stored => decodeGentOAuth(text)),
      Effect.catch((cause) =>
        isRecord(cause) && cause.code === "ENOENT"
          ? Effect.succeed(null)
          : Effect.fail(new GentStoreUnreadable({ path, message: messageOf(cause) })),
      ),
    )
  }

  private owned(label: string, stored: Stored): Effect.Effect<GentStoredOAuth, GentCredentialError> {
    if (stored === null) return Effect.fail(failure("signed-out", `The gent account "${label}" was removed. Sign in again in gent.`))
    if (stored === undefined || !isGentOwned(stored))
      return Effect.fail(
        failure("not-owned", `The gent label "${label}" holds no account gent signed in to; the pool leaves it alone`),
      )
    return Effect.succeed(stored)
  }

  private fresh(expires: number) {
    return expires > this.now() + FRESH_ENOUGH_MS
  }

  /** Whether a token expiring at `expires` is due a refresh: inside the refresh-ahead window plus the label's jitter. */
  private due(label: string, expires: number) {
    return expires <= this.now() + REFRESH_AHEAD_MS + refreshJitter(label)
  }

  /** Until when (epoch ms) no trade may go out from this store now, the later of a pause and the gap; none when one may. */
  private held(): number | undefined {
    const until = Math.max(this.state.pausedUntil, this.state.lastTradeAt + this.gapMs)
    return this.now() < until ? until : undefined
  }

  /**
   * Under gent's lock: settle a held write, then serve the stored token or
   * refresh it. A stored token still good past its last minute is served when
   * the trade cannot happen now; one that is not waits out the gap after the
   * last trade, and fails on a pause or a failed trade.
   */
  private refreshLocked(label: string): Effect.Effect<{ access: string; expires: number }, GentCredentialError | GentStoreUnreadable> {
    return Effect.gen({ self: this }, function* (this: GentSource) {
      const stored = yield* this.owned(label, yield* this.read(label))
      const served = { access: stored.access, expires: stored.expires }

      const pending = this.state.pending.get(label)
      if (pending !== undefined) {
        // The held rotation lands only over the login it replaced; any other
        // writer's login wins and the held one is dropped.
        if (stored.refresh === pending.replaces) {
          yield* this.write(label, stored, pending.next, pending.replaces)
          this.state.pending.delete(label)
          this.state.rejected.delete(label)
          return { access: pending.next.access, expires: pending.next.expires }
        }
        this.state.pending.delete(label)
      }

      const rejected = this.state.rejected.get(label) === stored.refresh
      if (!rejected && !this.due(label, stored.expires)) return served
      const usable = !rejected && this.fresh(stored.expires)

      const held = this.held()
      if (held !== undefined) {
        if (usable) return served
        // Only the gap holds a pause-free store: wait it out. A pause fails the trade below.
        if (this.now() >= this.state.pausedUntil) yield* this.sleep(held - this.now())
      }
      const next = yield* this.trade(label, stored.refresh).pipe(
        Effect.map((tokens): Tokens | undefined => tokens),
        Effect.catchIf(
          (error) => usable && error.kind === "unavailable",
          () => Effect.succeed(undefined),
        ),
      )
      if (next === undefined) return served
      yield* this.write(label, stored, next, stored.refresh)
      this.state.rejected.delete(label)
      return { access: next.access, expires: next.expires }
    })
  }

  private write(label: string, stored: GentStoredOAuth, next: Tokens, replaces: string): Effect.Effect<void, GentCredentialError> {
    return writeGentFileAtomic(this.file(label), encodeGentRefresh(stored, next)).pipe(
      Effect.catch(() =>
        Effect.suspend(() => {
          this.state.pending.set(label, { next, replaces })
          return Effect.fail(
            failure(
              "persist",
              `The gent account "${label}" refreshed but its file could not be written; the next request writes it again`,
              this.now() + RETRY_MS,
            ),
          )
        }),
      ),
    )
  }

  /**
   * gent's `refreshViaOAuthClient`: a form POST that trades the refresh token.
   * Logged at info with the label and the outcome, never a token.
   */
  private trade(label: string, refreshToken: string): Effect.Effect<Tokens, GentCredentialError> {
    return Effect.suspend(() => {
      const paused = this.state.pausedUntil
      if (this.now() < paused)
        return Effect.fail(
          failure(
            "unavailable",
            `The gent account "${label}" could not refresh: the token endpoint asked to wait until ${new Date(paused).toISOString()}`,
            paused,
          ),
        )
      return this.post(label, refreshToken).pipe(
        Effect.tap((next) => Effect.logInfo(`gent refresh "${label}": refreshed, expires ${new Date(next.expires).toISOString()}`)),
        Effect.tapError((error) => Effect.logInfo(`gent refresh "${label}": ${error.kind}: ${error.message}`)),
      )
    }).pipe(
      Effect.tap(() => Effect.sync(() => this.answered(label, undefined))),
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error.kind === "unavailable") this.failed()
          else if (error.kind === "rejected") this.answered(label, refreshToken)
        }),
      ),
    )
  }

  /** A trade the endpoint answered ends the store's run of failures; a refusal marks the login lost until its file changes. */
  private answered(label: string, refused: string | undefined) {
    const state = this.state
    state.failingSince = undefined
    state.lastFailureAt = undefined
    state.failures = 0
    state.cause = undefined
    if (refused === undefined) state.refused.delete(label)
    else if (state.refused.get(label)?.refresh !== refused) state.refused.set(label, { refresh: refused, since: this.now() })
  }

  /** A trade that could not happen now extends the store's run of failures. */
  private failed() {
    const state = this.state
    const now = this.now()
    state.failingSince ??= now
    state.lastFailureAt = now
    state.failures += 1
  }

  /** What the endpoint said when it failed the trade that just went out. */
  private caused(cause: GentRefreshCause) {
    this.state.cause = cause
  }

  private post(label: string, refreshToken: string): Effect.Effect<Tokens, GentCredentialError> {
    return Effect.gen({ self: this }, function* (this: GentSource) {
      const unavailable = (why: string) =>
        failure("unavailable", `The gent account "${label}" could not refresh: ${why}`, this.now() + RETRY_MS)
      this.state.lastTradeAt = this.now()
      const { status, body, retryAfter, server } = yield* Effect.tryPromise({
        try: async () => {
          const response = await this.fetch(this.tokenURL, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": GENT_USER_AGENT },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              client_id: GENT_CLIENT_ID,
              refresh_token: refreshToken,
            }).toString(),
            redirect: "error",
            signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
          })
          return {
            status: response.status,
            retryAfter: response.headers.get("retry-after"),
            server: response.headers.get("server"),
            body: await response.text(),
          }
        },
        catch: () => {
          this.caused({})
          return unavailable("the token endpoint did not answer")
        },
      })
      if (status === 429 || status >= 500)
        this.caused({
          status,
          ...(server === null ? {} : { server }),
          ...(retryAfter === null ? {} : { retryAfter }),
        })
      if (status === 429) {
        // A rate limit holds the whole store, so the other accounts do not keep it going.
        const before = this.state.pausedUntil
        this.state.pausedUntil = Math.max(before, this.now() + pauseFor(retryAfter, this.now()))
        if (before <= this.now())
          yield* Effect.logWarning(
            `gent refresh: the token endpoint answered 429; every refresh from ${this.dir} waits until ${new Date(this.state.pausedUntil).toISOString()}`,
          )
        return yield* failure(
          "unavailable",
          `The gent account "${label}" could not refresh: the token endpoint answered 429 (${limitDetail(server, retryAfter, body)})`,
          this.state.pausedUntil,
        )
      }
      if (status >= 500) return yield* unavailable(`the token endpoint answered ${status}`)
      if (status >= 400)
        return yield* failure("rejected", `The gent account "${label}" could not refresh (${status}). Sign in to it again in gent.`)
      const parsed = parseJson(body)?.value
      if (!isRecord(parsed) || typeof parsed.access_token !== "string" || parsed.access_token === "")
        return yield* failure("rejected", `The gent account "${label}" refresh answered without an access token`)
      const expiresIn = finite(parsed.expires_in) ? parsed.expires_in : DEFAULT_EXPIRES_IN_S
      return {
        access: parsed.access_token,
        refresh: typeof parsed.refresh_token === "string" && parsed.refresh_token !== "" ? parsed.refresh_token : refreshToken,
        expires: this.now() + expiresIn * 1000,
      }
    })
  }
}

/**
 * The registry the provider's auth plugin reads a credential's token from
 * when OpenCode's store does not keep it: integration id to sources, in the
 * process, never over RPC.
 */
export const CREDENTIAL_SOURCES = Symbol.for("opencode.credential-sources")

export interface CredentialSource {
  readonly owns: (credentialID: string) => boolean
  readonly resolve: (credentialID: string) => Promise<{ access: string; expires: number }>
  readonly rejected?: (credentialID: string, access: string) => void
  /** The stored token while it is good, else none; never refreshes. */
  readonly peek?: (credentialID: string) => Promise<{ access: string; expires: number } | undefined>
}

/** Register `source` for `integrationID`; the returned function removes it. */
export const registerCredentialSource = (integrationID: string, source: CredentialSource): (() => void) => {
  const global = globalThis as unknown as Record<symbol, Map<string, Set<CredentialSource>> | undefined>
  const registry = (global[CREDENTIAL_SOURCES] ??= new Map())
  let sources = registry.get(integrationID)
  if (sources === undefined) {
    sources = new Set()
    registry.set(integrationID, sources)
  }
  sources.add(source)
  return () => {
    sources.delete(source)
  }
}
