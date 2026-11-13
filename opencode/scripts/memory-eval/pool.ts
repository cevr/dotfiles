// The eval's way to Anthropic: the pool's Claude accounts, each request sent
// as OpenCode's Anthropic auth plugin sends it. Nothing here re-implements the
// pool or the plugin; it drives their modules from a script.
//
// - Accounts: the Claude accounts signed in to the login store (mods/pool/store/store.ts),
//   read and refreshed in place under the store's lock, as the pool plugin reads
//   them. OpenCode's own logins are left alone: the server refreshes those, and
//   a refresh token is spent when it is traded, so a second refresher would
//   sign the server out.
// - Placement: a local AccountPool (mods/pool/account-pool.ts) decides each
//   request's account, as the plugin's does. It is seeded from the live
//   pool's `status` (holds, readings, each account's load and live sessions),
//   so the eval lands where the owner's sessions are not and leaves an account
//   the live pool holds alone. An eval session is pinned to its account, so its
//   prompt cache stays there.
// - Pace: before each episode `pace()` asks the live pool's `pace` and the
//   local pool's (mods/pool/pace.ts, over the accounts the eval may use). Either
//   saying no stops the run: the eval never spends what the owner's live
//   sessions need.
// - A 401 or 429 holds its account as the plugin's refusal does
//   (`refusalOf` over the response's quota headers) and fails over to another
//   account when the pool says to (`shouldFailOver`); with none left the
//   request throws `PoolLimit`.
// - The request shape: the plugin's body rewrite (billing stamp, Claude Code's
//   identity, tool names under their `mcp_` aliases), its OAuth headers and
//   session header; a response's tool names are turned back.
//
// The live pool is the OpenCode server's RPC on loopback, reached as the
// fleet report reaches it (mods/pool/ssh/report.ts): the URL and password of
// its service file, never printed. No token is ever printed or written.
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Result } from "./effect.ts"
import { fold } from "../../decider/decider.ts"
import { OFFICIAL_API } from "../../mods/anthropic-auth/endpoint.ts"
import { setOAuthHeaders } from "../../mods/anthropic-auth/fetch/request.ts"
import { readUnifiedQuota, refusalOf } from "../../mods/anthropic-auth/quota.ts"
import { classifyRateLimit } from "../../mods/anthropic-auth/rate-limit.ts"
import { rewriteRequestBody } from "../../mods/anthropic-auth/request-body.ts"
import { CLAUDE_CODE_SESSION_HEADER, claudeCodeSessionID } from "../../mods/anthropic-auth/session-header.ts"
import { stripToolPrefix, ToolNameAliasTable } from "../../mods/anthropic-auth/tool-alias.ts"
import { CLAUDE_CODE_VERSION, compareClaudeCodeVersions, parseClaudeCodeVersionRejection } from "../../mods/anthropic-auth/version.ts"
import { AccountPool, type AccountPoolState, type Command, empty } from "../../mods/pool/account-pool.ts"
import { DEFAULT_RULES, held, type Mark, placedOn, type Rules, shouldFailOver, status, type Step } from "../../mods/pool/accounts.ts"
import { StoreSource } from "../../mods/pool/store/store.ts"
import { type Pace, poolPace } from "../../mods/pool/pace.ts"
import type { QuotaReading } from "../../mods/pool/quota.ts"
import type { AccountStatus, Hold } from "../../mods/pool/status.ts"

/** The login store the owner's pool plugin reads (its `sources` option in ~/.config/opencode/opencode.json). */
export const STORE_DIR = join(homedir(), ".local/share/opencode-prime/pool-auth")
/** The live pool's integration. */
export const POOL = "anthropic"
/** The prefix of the sessions seeded from the live pool, so they are never the eval's. */
const LIVE = "live:"

/** Where the accounts' tokens come from: the login store, or a fake in tests. */
export interface Source {
  readonly list: () => ReadonlyArray<string>
  readonly resolve: (credentialID: string) => Promise<{ readonly access: string; readonly expires: number }>
  /** A token the provider rejected: the source refreshes it before it serves it again. */
  readonly rejected?: (credentialID: string, access: string) => void
}

export const storeSource = (dir: string = STORE_DIR): Source => {
  const source = new StoreSource({ dir })
  return {
    list: () => source.list().accounts,
    resolve: (credentialID) => source.resolve(credentialID),
    rejected: (credentialID, access) => source.rejected(credentialID, access),
  }
}

/** The live pool, as the OpenCode server's pool plugin answers; undefined when it does not answer. */
export interface Live {
  readonly status: () => Promise<ReadonlyArray<AccountStatus> | undefined>
  readonly pace: () => Promise<Pace | undefined>
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** The pool plugin's RPC on the local OpenCode server, through its service file. */
export const liveServer = (
  serviceFile: string = process.env["OPENCODE_SERVICE_FILE"] ?? join(homedir(), ".local/state/opencode/service.json"),
  fetcher: typeof fetch = fetch,
): Live => {
  const call = async (method: string, input: Record<string, unknown>): Promise<unknown> => {
    const service: unknown = await Bun.file(serviceFile)
      .json()
      .catch(() => undefined)
    if (!isRecord(service) || typeof service["url"] !== "string" || typeof service["password"] !== "string") return undefined
    const response = await fetcher(new URL(`/api/rpc/dotfiles-opencode.pool/${method}`, service["url"]), {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`opencode:${service["password"]}`)}`, "content-type": "application/json" },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(8_000),
    }).catch(() => undefined)
    if (response === undefined || !response.ok) return undefined
    const body: unknown = await response.json().catch(() => undefined)
    return isRecord(body) ? body["output"] : undefined
  }
  return {
    status: async () => {
      const output = await call("status", {})
      const entry = isRecord(output) ? output[POOL] : undefined
      return isRecord(entry) && Array.isArray(entry["accounts"]) ? (entry["accounts"] as ReadonlyArray<AccountStatus>) : undefined
    },
    pace: async () => {
      const output = await call("pace", { providerID: POOL })
      return isRecord(output) && typeof output["ok"] === "boolean" ? (output as Pace) : undefined
    },
  }
}

/** The pool has no account the eval may use now: every one is held, or the pace says to wait. */
export class PoolLimit extends Error {
  constructor(
    readonly reason: string,
    readonly retryAt?: number,
  ) {
    super(`pool: ${reason}${retryAt === undefined ? "" : ` (until ${new Date(retryAt).toISOString()})`}`)
  }
}

/**
 * The account whose weekly reading rose most since `start`, when it rose more than `limit` points, else undefined.
 * An account with no reading at either end is skipped: nothing is known of it. The readings include the owner's own
 * sessions, so a run stops on their use too.
 */
export const weeklyDrift = (
  start: Record<string, number | undefined>,
  now: Record<string, number | undefined>,
  limit: number,
): { readonly credentialID: string; readonly points: number } | undefined => {
  let most: { credentialID: string; points: number } | undefined
  for (const [credentialID, after] of Object.entries(now)) {
    const before = start[credentialID]
    if (before === undefined || after === undefined) continue
    // A rise only: a fall is the week's window resetting, which spends nothing.
    const points = after - before
    if (points > limit && (most === undefined || points > most.points)) most = { credentialID, points }
  }
  return most
}

/** One answer of Anthropic, its tool names turned back. */
export interface Sent {
  readonly status: number
  readonly text: string
  readonly credentialID: string
}

export interface PoolOptions {
  readonly source: Source
  readonly live?: Live
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly rules?: Rules
  readonly baseUrl?: string
}

/** The newer of two readings of an account. */
const newer = (left: QuotaReading | undefined, right: QuotaReading | undefined) =>
  left === undefined ? right : right === undefined || left.at >= right.at ? left : right

/** The longer of two holds of an account. */
const longer = (left: Hold | undefined, right: Hold | undefined) =>
  left === undefined ? right : right === undefined || left.until >= right.until ? left : right

export class Pool {
  private readonly model: ReturnType<typeof AccountPool>
  private state: AccountPoolState = empty
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private readonly rules: Rules
  private readonly url: string
  private version = CLAUDE_CODE_VERSION

  constructor(private readonly options: PoolOptions) {
    this.rules = options.rules ?? DEFAULT_RULES
    this.model = AccountPool(this.rules)
    this.fetcher = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.url = new URL("/v1/messages", options.baseUrl ?? OFFICIAL_API).toString()
  }

  private apply(command: Command): void {
    const decided = Effect.runSync(Effect.result(this.model.decide(this.state, command, this.now())))
    if (Result.isFailure(decided)) {
      const rejection = decided.failure
      if (rejection._tag === "AccountsHeld") throw new PoolLimit("every eval account is held", rejection.retryAt)
      throw new PoolLimit(`no account to place ${command._tag} on: the login store lists none`)
    }
    this.state = fold(this.model, decided.success, this.state)
  }

  /** The accounts the eval may use, in pool order. */
  get accounts(): ReadonlyArray<string> {
    return this.state.credentials
  }

  /**
   * Read the accounts and the live pool again: the store's accounts are the pool's,
   * and each one's live holds, readings, load and sessions join the local
   * state (the newer reading, the longer hold). A live pool that does not
   * answer leaves the local state as it is.
   */
  async refresh(): Promise<void> {
    this.apply({ _tag: "ListLogins", credentials: this.options.source.list() })
    this.apply({ _tag: "PruneLedger" })
    const live = await this.options.live?.status()
    if (live === undefined) return
    const now = this.now()
    const ours = new Set(this.state.credentials)
    const accounts = live.filter((account) => ours.has(account.credentialID))
    const holds = { ...this.state.holds }
    const readings = { ...this.state.readings }
    // The live pool's load and sessions, as steps and cache marks of sessions that are never the eval's.
    const steps: Array<Step> = this.state.steps.filter((step) => !step.sessionID.startsWith(LIVE))
    const recent: Record<string, Mark> = Object.fromEntries(Object.entries(this.state.recent).filter(([sessionID]) => !sessionID.startsWith(LIVE)))
    for (const account of accounts) {
      const id = account.credentialID
      const hold = longer(holds[id], account.hold !== undefined && account.hold.until > now ? account.hold : undefined)
      if (hold !== undefined) holds[id] = hold
      const reading = newer(readings[id], account.reading)
      if (reading !== undefined) readings[id] = reading
      if (account.load > 0) steps.push({ at: now, sessionID: `${LIVE}${id}`, credentialID: id, cost: account.load })
      for (let index = 0; index < account.live; index++) recent[`${LIVE}${id}:${index}`] = { credentialID: id, at: now }
    }
    this.state = { ...this.state, holds, readings, steps: steps.sort((left, right) => left.at - right.at), recent }
  }

  /** Whether the eval may start another episode: the live pool's pace, then the local one over the eval's accounts. */
  async pace(): Promise<Pace> {
    await this.refresh()
    const live = await this.options.live?.pace()
    if (live !== undefined && !live.ok) return { ...live, reason: `live pool: ${live.reason}` }
    const local = poolPace(status(this.state, this.now(), this.rules), this.now())
    return local.ok || this.state.credentials.length === 0 ? local : { ...local, reason: `eval accounts: ${local.reason}` }
  }

  /** One account's status as the pool reports it, for the run's log. No secrets. */
  line(): string {
    return status(this.state, this.now(), this.rules)
      .map((account) => {
        const week = account.reading?.windows.find((window) => window.name === "7d")
        const five = account.reading?.windows.find((window) => window.name === "5h")
        const pct = (value: number | undefined) => (value === undefined ? "?" : `${Math.round(value * 100)}%`)
        return `${account.credentialID} 5h ${pct(five?.utilization)} 7d ${pct(week?.utilization)}${account.hold === undefined ? "" : ` held (${account.hold.kind})`}`
      })
      .join(" · ")
  }

  /** Each eval account's 7-day utilization in points (0–100), as last read; undefined with no reading. */
  weekly(): Record<string, number | undefined> {
    return Object.fromEntries(
      status(this.state, this.now(), this.rules).map((account) => {
        const week = account.reading?.windows.find((window) => window.name === "7d")
        return [account.credentialID, week === undefined ? undefined : week.utilization * 100]
      }),
    )
  }

  /** The step a session's request cost, on the account it went out on. */
  record(sessionID: string, cost: number): void {
    this.apply({ _tag: "RecordStep", sessionID, cost })
  }

  /**
   * Send one Messages body for `sessionID` on the account the pool places it
   * on. A 401 or 429 holds that account and goes again on another one while
   * the pool fails over; with none left it throws `PoolLimit`. Any other
   * answer, success or not, comes back.
   */
  async send(sessionID: string, model: string, body: Record<string, unknown>): Promise<Sent> {
    if (this.state.credentials.length === 0) await this.refresh()
    let recovered = false
    for (;;) {
      this.apply({ _tag: "PlaceRequest", sessionID, kind: "primary" })
      // Every account held: the placement above threw `PoolLimit` with when the first opens.
      const credentialID = placedOn(this.state, sessionID, "primary")!
      const login = await this.options.source.resolve(credentialID)
      const aliases = new ToolNameAliasTable()
      const rewritten = rewriteRequestBody(JSON.stringify(body), this.version, aliases)
      if (Result.isFailure(rewritten)) throw new Error(rewritten.failure.message)
      const headers = setOAuthHeaders(new Headers({ "content-type": "application/json", "anthropic-version": "2023-06-01" }), login.access, this.version, model)
      headers.set(CLAUDE_CODE_SESSION_HEADER, claudeCodeSessionID(sessionID))
      const response = await this.fetcher(this.url, { method: "POST", headers, body: rewritten.success, redirect: "error" })
      const now = this.now()
      const text = await response.text()
      const quota = readUnifiedQuota(response.headers, now)
      if (response.ok) {
        if (quota !== undefined) this.apply({ _tag: "TakeReading", credentialID, reading: quota })
        return { status: response.status, text: stripToolPrefix(text, aliases), credentialID }
      }
      if (response.status === 400 && !recovered) {
        // Anthropic gates a model on the Claude Code version: the plugin reports the one it asks for, once.
        const rejection = parseClaudeCodeVersionRejection(text, this.version)
        if (rejection !== undefined && compareClaudeCodeVersions(rejection.requiredVersion, this.version) === 1) {
          this.version = rejection.requiredVersion
          recovered = true
          continue
        }
      }
      if (response.status !== 401 && response.status !== 429) return { status: response.status, text, credentialID }
      if (response.status === 401) this.options.source.rejected?.(credentialID, login.access)
      const error = (() => {
        try {
          const parsed: unknown = JSON.parse(text)
          return isRecord(parsed) && isRecord(parsed["error"]) ? parsed["error"] : undefined
        } catch {
          return undefined
        }
      })()
      const category = response.status === 429 ? classifyRateLimit(String(error?.["message"] ?? ""), error?.["type"]) : undefined
      const refusal = refusalOf({ status: response.status, category, headers: response.headers, quota, now, expires: login.expires })
      if (refusal !== undefined)
        this.apply({
          _tag: "TakeReading",
          credentialID,
          reading: { ...(quota ?? { at: now, windows: this.state.readings[credentialID]?.windows ?? [] }), refusal },
        })
      this.apply({ _tag: "RefuseRequest", credentialID, status: response.status })
      if (!shouldFailOver(this.state, sessionID, this.now())) {
        const untils = this.state.credentials.flatMap((id) => (held(this.state, id, this.now()) ? [this.state.holds[id]!.until] : []))
        throw new PoolLimit(`${response.status} on ${credentialID} and no other eval account is free`, untils.length === 0 ? undefined : Math.min(...untils))
      }
    }
  }
}
