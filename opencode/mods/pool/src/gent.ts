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
 * A token is read from the file on every request. When it is stale (it
 * expires within a minute) or the provider rejected it, the refresh runs as
 * gent's does (`makeCredentialCache` and `ownedStore` in gent's extensions):
 * under gent's lock for the provider (an exclusive SQLite transaction on
 * `<dir>/.locks/anthropic.lock.db`, taken by every gent process), the file is
 * read again, a token another writer refreshed meanwhile is served as it is,
 * and only a token still stale is traded at the token endpoint. The answer is
 * written atomically, mode 0600, in gent's exact shape, keeping the sign-in's
 * `signedInAt` and `metadata`.
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
 * @module
 */
import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { open, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

/** The token endpoint Claude Code and the Anthropic auth plugin refresh at, and Claude Code's public client id. */
export const GENT_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
export const GENT_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
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
export type GentFailureKind =
  /** The label holds no sign-in any more. */
  | "signed-out"
  /** The label holds a sign-in gent does not own (Claude Code's), or a file that does not decode. */
  | "not-owned"
  /** The token endpoint refused the refresh token: sign in again in gent. */
  | "rejected"
  /** The token endpoint did not answer usefully (transport, timeout, 429, 5xx): try again shortly. */
  | "unavailable"
  /** gent's lock stayed held for the whole wait. */
  | "busy"
  /** The refresh worked but its write failed; the new tokens are held in memory. */
  | "persist"

export class GentCredentialError extends Error {
  override readonly name = "GentCredentialError"
  constructor(
    readonly kind: GentFailureKind,
    message: string,
    /** When the account may be tried again (epoch ms); absent until the owner signs in again. */
    readonly retryAt?: number,
  ) {
    super(message)
  }
}

export interface GentSourceOptions {
  /** gent's auth directory; `~` is the home directory. */
  readonly dir: string
  /** The token endpoint; tests point it at a fake. */
  readonly tokenURL?: string
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
  /** How many times a busy lock is polled before the refresh gives up. */
  readonly lockPolls?: number
}

/** An account gent holds, or a label this source leaves alone and why. */
export interface GentListing {
  readonly accounts: ReadonlyArray<string>
  readonly skipped: ReadonlyArray<{ readonly label: string; readonly reason: string }>
}

const expandHome = (dir: string) => (dir === "~" || dir.startsWith("~/") ? join(homedir(), dir.slice(1)) : dir)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === "string")

/** A stored OAuth sign-in, checked field by field, or `undefined`. */
export const decodeGentOAuth = (text: string): GentStoredOAuth | undefined => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value) || value.type !== "oauth") return undefined
  if (typeof value.access !== "string" || typeof value.refresh !== "string") return undefined
  if (typeof value.expires !== "number" || !Number.isFinite(value.expires)) return undefined
  if (value.metadata !== undefined && !isStringRecord(value.metadata)) return undefined
  if (value.signedInAt !== undefined && (typeof value.signedInAt !== "number" || !Number.isFinite(value.signedInAt)))
    return undefined
  return value as unknown as GentStoredOAuth
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

/**
 * gent's `writeFileAtomic` for a credential: a sibling staging file created
 * exclusively with mode 0600, synced, then renamed over the file a link at
 * `path` points to. A failed write removes its staging file.
 */
export const writeGentFileAtomic = async (path: string, content: string): Promise<void> => {
  let target = path
  try {
    target = realpathSync(path)
  } catch {}
  const staging = join(dirname(target), `.${basename(target)}${STAGING_TAG}${randomBytes(4).toString("hex")}`)
  let created = false
  try {
    const handle = await open(staging, "wx", 0o600)
    created = true
    try {
      await handle.chmod(0o600)
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(staging, target)
  } catch (error) {
    if (created) await rm(staging, { force: true }).catch(() => undefined)
    throw error
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

const isBusy = (error: unknown) => isRecord(error) && error.code === "SQLITE_BUSY"

/**
 * Run `use` while holding gent's lock for the provider: an exclusive SQLite
 * transaction on `<dir>/.locks/<provider>.lock.db`, opened with no busy
 * timeout and polled while another connection holds it, as gent's
 * `fileProviderLock` does. Closing the connection ends the transaction and
 * frees the lock; the OS frees it if the process dies.
 */
export const withGentLock = async <A>(
  dir: string,
  use: () => Promise<A>,
  polls: number = LOCK_POLLS,
): Promise<A> => {
  const locks = join(dir, ".locks")
  mkdirSync(locks, { recursive: true })
  const file = join(locks, `${encodeURIComponent(PROVIDER)}.lock.db`)
  for (let attempt = 0; ; attempt += 1) {
    const db = new Database(file, { create: true })
    try {
      db.exec("PRAGMA busy_timeout = 0")
      db.exec("BEGIN EXCLUSIVE")
    } catch (error) {
      db.close()
      if (!isBusy(error)) throw error
      if (attempt >= polls) {
        throw new GentCredentialError(
          "busy",
          "gent's credential store is busy: its Anthropic lock stayed held for the whole wait",
          Date.now() + RETRY_MS,
        )
      }
      await sleep(LOCK_POLL_MS)
      continue
    }
    try {
      return await use()
    } finally {
      db.close()
    }
  }
}

/**
 * What a 429 says about who limited the request, for the log: the `server` header (an edge such
 * as Cloudflare, or Anthropic), `retry-after`, and the error's type and message from a JSON body,
 * or the start of any other body with markup dropped. A 429 body carries no token.
 */
export function limitDetail(server: string | null, retryAfter: string | null, body: string): string {
  let said = ""
  try {
    const parsed: unknown = JSON.parse(body)
    const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : isRecord(parsed) ? parsed : {}
    said = [error.type, error.message, error.error, error.error_description]
      .filter((part): part is string => typeof part === "string" && part !== "")
      .join(": ")
  } catch {
    said = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
  }
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

/** One store's state in this process: refreshes held for a write, and tokens a provider rejected. */
interface StoreState {
  /** Per label: tokens a refresh got whose write failed, and the refresh token they replace. */
  readonly pending: Map<string, { readonly next: Tokens; readonly replaces: string }>
  /** Per label: the refresh token of the login whose access token a provider rejected. */
  readonly rejected: Map<string, string>
  /** The tail of this process's queue for the lock: one refresh at a time per store. */
  queue: Promise<unknown>
  /** Until when (epoch ms) the token endpoint asked this store to wait; no refresh goes out before. */
  pausedUntil: number
}

/** Shared by every setup in the process, whichever copy of this module it loaded. */
const STATES = Symbol.for("dotfiles-opencode.pool.gent-stores")

const stateOf = (dir: string): StoreState => {
  const global = globalThis as unknown as Record<symbol, Map<string, StoreState> | undefined>
  const states = (global[STATES] ??= new Map())
  let state = states.get(dir)
  if (state === undefined) {
    state = { pending: new Map(), rejected: new Map(), queue: Promise.resolve(), pausedUntil: 0 }
    states.set(dir, state)
  }
  return state
}

/** A gent store's Anthropic accounts, read and refreshed in place. */
export class GentSource {
  readonly dir: string
  private readonly slots: string
  private readonly tokenURL: string
  private readonly fetch: typeof globalThis.fetch
  private readonly now: () => number
  private readonly lockPolls: number
  private readonly state: StoreState

  constructor(options: GentSourceOptions) {
    this.dir = resolve(expandHome(options.dir))
    this.slots = join(this.dir, ".slots", encodeURIComponent(PROVIDER))
    this.tokenURL = options.tokenURL ?? GENT_TOKEN_URL
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.lockPolls = options.lockPolls ?? LOCK_POLLS
    this.state = stateOf(this.dir)
  }

  /** The pool's credential id of a label. */
  static id(label: string) {
    return `${GENT_PREFIX}${label}`
  }

  owns(credentialID: string) {
    return this.labelOf(credentialID) !== undefined
  }

  /** The accounts gent signed in to, by label, and the labels this source leaves alone. */
  list(): GentListing {
    let names: string[]
    try {
      names = readdirSync(this.slots)
    } catch {
      return { accounts: [], skipped: [] }
    }
    const accounts: string[] = []
    const skipped: Array<{ label: string; reason: string }> = []
    for (const name of names.sort()) {
      if (name.startsWith(".")) continue
      let label: string
      try {
        label = decodeURIComponent(name)
      } catch {
        continue
      }
      if (!SLOT.test(label) || label === "default") continue
      const stored = this.read(label)
      if (stored === null) continue
      if (stored === undefined) skipped.push({ label, reason: "does not decode as an OAuth sign-in" })
      else if (!isGentOwned(stored)) skipped.push({ label, reason: "a linked Claude Code login, which gent refreshes itself" })
      else accounts.push(GentSource.id(label))
    }
    return { accounts, skipped }
  }

  /** The token to send now for `credentialID`, refreshed under gent's lock when it must be. */
  async resolve(credentialID: string): Promise<{ access: string; expires: number }> {
    const label = this.labelOf(credentialID)
    if (label === undefined) throw new GentCredentialError("signed-out", "Not a gent account")
    const stored = this.owned(label, this.read(label))
    if (
      !this.state.pending.has(label) &&
      this.state.rejected.get(label) !== stored.refresh &&
      this.fresh(stored.expires)
    ) {
      return { access: stored.access, expires: stored.expires }
    }
    return this.serialized(() => withGentLock(this.dir, () => this.refreshLocked(label), this.lockPolls))
  }

  /**
   * A provider rejected `access`. When the store still holds it, the next
   * resolve refreshes the login whatever its expiry says, as gent's
   * `invalidate` does; a token the store already replaced changes nothing.
   */
  rejected(credentialID: string, access: string): void {
    const label = this.labelOf(credentialID)
    if (label === undefined) return
    const stored = this.read(label)
    if (stored && stored.access === access) this.state.rejected.set(label, stored.refresh)
  }

  private labelOf(credentialID: string): string | undefined {
    if (!credentialID.startsWith(GENT_PREFIX)) return undefined
    const label = credentialID.slice(GENT_PREFIX.length)
    return SLOT.test(label) && label !== "default" ? label : undefined
  }

  private file(label: string) {
    return join(this.slots, encodeURIComponent(label))
  }

  /** The label's sign-in, `null` when the label holds none, `undefined` when its file does not decode. */
  private read(label: string): GentStoredOAuth | undefined | null {
    let text: string
    try {
      text = readFileSync(this.file(label), "utf8")
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return null
      throw error
    }
    return decodeGentOAuth(text)
  }

  private owned(label: string, stored: GentStoredOAuth | undefined | null): GentStoredOAuth {
    if (stored === null) {
      throw new GentCredentialError("signed-out", `The gent account "${label}" was removed. Sign in again in gent.`)
    }
    if (stored === undefined || !isGentOwned(stored)) {
      throw new GentCredentialError(
        "not-owned",
        `The gent label "${label}" holds no account gent signed in to; the pool leaves it alone`,
      )
    }
    return stored
  }

  private fresh(expires: number) {
    return expires > this.now() + FRESH_ENOUGH_MS
  }

  /** One refresh at a time per store in this process; gent's lock orders them across processes. */
  private serialized<A>(run: () => Promise<A>): Promise<A> {
    const next = this.state.queue.then(run, run)
    this.state.queue = next.catch(() => undefined)
    return next
  }

  /** Under gent's lock: settle a held write, then serve the stored token or refresh it. */
  private async refreshLocked(label: string): Promise<{ access: string; expires: number }> {
    let stored = this.owned(label, this.read(label))

    const pending = this.state.pending.get(label)
    if (pending !== undefined) {
      // The held rotation lands only over the login it replaced; any other
      // writer's login wins and the held one is dropped.
      if (stored.refresh === pending.replaces) {
        await this.write(label, stored, pending.next, pending.replaces)
        this.state.pending.delete(label)
        this.state.rejected.delete(label)
        return { access: pending.next.access, expires: pending.next.expires }
      }
      this.state.pending.delete(label)
    }

    const rejected = this.state.rejected.get(label) === stored.refresh
    if (!rejected && this.fresh(stored.expires)) return { access: stored.access, expires: stored.expires }

    const next = await this.trade(label, stored.refresh)
    await this.write(label, stored, next, stored.refresh)
    this.state.rejected.delete(label)
    stored = { ...stored, ...next }
    return { access: stored.access, expires: stored.expires }
  }

  private async write(label: string, stored: GentStoredOAuth, next: Tokens, replaces: string): Promise<void> {
    try {
      await writeGentFileAtomic(this.file(label), encodeGentRefresh(stored, next))
    } catch {
      this.state.pending.set(label, { next, replaces })
      throw new GentCredentialError(
        "persist",
        `The gent account "${label}" refreshed but its file could not be written; the next request writes it again`,
        this.now() + RETRY_MS,
      )
    }
  }

  /** gent's `refreshViaOAuthClient`: a form POST that trades the refresh token. */
  private async trade(label: string, refreshToken: string): Promise<Tokens> {
    const unavailable = (why: string) =>
      new GentCredentialError(
        "unavailable",
        `The gent account "${label}" could not refresh: ${why}`,
        this.now() + RETRY_MS,
      )
    const paused = this.state.pausedUntil
    if (this.now() < paused) {
      throw new GentCredentialError(
        "unavailable",
        `The gent account "${label}" could not refresh: the token endpoint asked to wait until ${new Date(paused).toISOString()}`,
        paused,
      )
    }
    let status: number
    let body: string
    let retryAfter: string | null = null
    let server: string | null = null
    try {
      const response = await this.fetch(this.tokenURL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: GENT_CLIENT_ID,
          refresh_token: refreshToken,
        }).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      })
      status = response.status
      retryAfter = response.headers.get("retry-after")
      server = response.headers.get("server")
      body = await response.text()
    } catch {
      throw unavailable("the token endpoint did not answer")
    }
    if (status === 429) {
      // A rate limit holds the whole store, so the other accounts do not keep it going.
      this.state.pausedUntil = Math.max(this.state.pausedUntil, this.now() + pauseFor(retryAfter, this.now()))
      throw new GentCredentialError(
        "unavailable",
        `The gent account "${label}" could not refresh: the token endpoint answered 429 (${limitDetail(server, retryAfter, body)})`,
        this.state.pausedUntil,
      )
    }
    if (status >= 500) throw unavailable(`the token endpoint answered ${status}`)
    if (status >= 400) {
      throw new GentCredentialError(
        "rejected",
        `The gent account "${label}" could not refresh (${status}). Sign in to it again in gent.`,
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = undefined
    }
    if (!isRecord(parsed) || typeof parsed.access_token !== "string" || parsed.access_token === "") {
      throw new GentCredentialError("rejected", `The gent account "${label}" refresh answered without an access token`)
    }
    const expiresIn =
      typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in)
        ? parsed.expires_in
        : DEFAULT_EXPIRES_IN_S
    return {
      access: parsed.access_token,
      refresh:
        typeof parsed.refresh_token === "string" && parsed.refresh_token !== "" ? parsed.refresh_token : refreshToken,
      expires: this.now() + expiresIn * 1000,
    }
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
