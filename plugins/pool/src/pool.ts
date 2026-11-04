/**
 * One provider's accounts as one pool: where each run goes, which accounts
 * are held, and the ledger placement reads.
 *
 * - A run (a session from its first request until it goes idle) is pinned
 *   to one account. It leaves that account only when the account is held.
 * - A new run is placed by `rankPlacement`: held accounts last, accounts at
 *   their share after those with room, then by recorded load and live
 *   sessions, and equal accounts by the soonest weekly reset. The account
 *   where the session's cache still lives is kept within one session.
 * - An account is held until the time its refusal names: a plan limit until
 *   its window resets, a rate limit for its `retry-after`, a rejected token
 *   until the host refreshes it, a failed sign-in for as long as the
 *   provider says. A window read as exhausted holds it until that reset.
 *
 * Everything the next process needs (holds, readings, priced steps) goes to
 * the `Store` as it changes. Pins and live sessions are this process's own.
 */
import { rankPlacement, type PlacementSlot } from "./rank.ts"
import type { QuotaReading, QuotaRefusal } from "./quota.ts"

const MINUTE = 60_000

/** The window load and sessions are counted over. */
export const WINDOW_MS = 7 * 24 * 60 * MINUTE
/** How long a session's prompt cache lives on the account it last used. */
export const CACHE_LIFE_MS = 5 * MINUTE
/** A pin with no request for this long belongs to a run that stopped without going idle. */
export const PIN_IDLE_MS = 30 * MINUTE
/** A refusal without a time, or a refused response without a reading, holds the account this long. */
export const DEFAULT_HOLD_MS = 5 * MINUTE
/** The share of an account's 5-hour window a pool spends before the account has no room. */
export const FIVE_HOUR_SHARE = 0.9
/** The share of any other window a pool spends before the account has no room. */
export const OTHER_WINDOW_SHARE = 0.95

export type HoldKind = QuotaRefusal["kind"]

export interface Hold {
  readonly kind: HoldKind
  /** Epoch ms. */
  readonly until: number
  /** When it was set, epoch ms. */
  readonly at: number
}

/** One priced step of a run, as the ledger records it. */
export interface Step {
  readonly at: number
  readonly sessionID: string
  readonly credentialID: string
  /** USD. */
  readonly cost: number
}

/** Where the pool writes its ledger. Values are plain JSON. */
export interface Store {
  readonly put: (key: string, value: unknown) => void
  readonly remove: (key: string) => void
}

export type RequestKind = "primary" | "compaction" | "title" | "generate"

interface Mark {
  readonly credentialID: string
  at: number
}

/** One account as the status RPC reports it. */
export interface AccountStatus {
  readonly credentialID: string
  readonly hold?: Hold
  readonly reading?: QuotaReading
  /** USD recorded on it in the window. */
  readonly load: number
  /** Sessions whose run or cache is on it now. */
  readonly live: number
  readonly noRoom: boolean
}

export const holdKey = (credentialID: string) => `hold/${credentialID}`
export const readingKey = (credentialID: string) => `reading/${credentialID}`
export const stepKey = (step: Step) => `step/${String(step.at).padStart(15, "0")}/${step.sessionID}`

const shareOf = (window: string) => (window === "5h" ? FIVE_HOUR_SHARE : OTHER_WINDOW_SHARE)

export class AccountPool {
  /** Accounts in pool order: the provider's logins, as its integration lists them. */
  private credentials: ReadonlyArray<string> = []
  private readonly holds = new Map<string, Hold>()
  private readonly readings = new Map<string, QuotaReading>()
  private steps: Step[] = []
  /** The pin of each running session. */
  private readonly runs = new Map<string, Mark>()
  /** Where each session last sent a request: its cache lives there for a while. */
  private readonly recent = new Map<string, Mark>()
  /** The account each session's newest request of each kind went out on. */
  private readonly placed = new Map<string, string>()

  constructor(
    readonly integrationID: string,
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {}

  /** Load the ledger a previous process wrote. */
  load(entries: ReadonlyArray<{ readonly key: string; readonly value: unknown }>) {
    for (const { key, value } of entries) {
      const [kind, id] = key.split("/", 2)
      if (id === undefined || typeof value !== "object" || value === null) continue
      if (kind === "hold") this.holds.set(id, value as Hold)
      else if (kind === "reading") this.readings.set(id, value as QuotaReading)
      else if (kind === "step") this.steps.push(value as Step)
    }
    this.steps.sort((left, right) => left.at - right.at)
    this.prune()
  }

  setCredentials(credentials: ReadonlyArray<string>) {
    this.credentials = [...credentials]
  }

  accounts(): ReadonlyArray<string> {
    return this.credentials
  }

  held(credentialID: string): boolean {
    const hold = this.holds.get(credentialID)
    return hold !== undefined && hold.until > this.now()
  }

  /**
   * The account a session's request goes out on: the run's pin while it is
   * not held, else the first of a new placement. `undefined` with no account.
   */
  place(sessionID: string, kind: RequestKind): string | undefined {
    const now = this.now()
    if (this.credentials.length === 0) return undefined
    const pin = this.runs.get(sessionID)
    const pinned =
      pin !== undefined &&
      now - pin.at < PIN_IDLE_MS &&
      this.credentials.includes(pin.credentialID) &&
      !this.held(pin.credentialID)
        ? pin.credentialID
        : undefined
    const choice = pinned ?? this.rank(sessionID)[0]
    this.runs.set(sessionID, { credentialID: choice, at: now })
    this.recent.set(sessionID, { credentialID: choice, at: now })
    this.placed.set(`${sessionID}:${kind}`, choice)
    return choice
  }

  /** The accounts in placement order for a new run of `sessionID`. */
  rank(sessionID: string): readonly [string, ...string[]] {
    const now = this.now()
    const [first, ...others] = this.credentials
    if (first === undefined) throw new Error(`the ${this.integrationID} pool has no account`)
    const steps = this.steps.filter((step) => now - step.at < WINDOW_MS)
    const spent = steps.reduce((total, step) => total + step.cost, 0)
    const sessions = new Set(steps.filter((step) => step.cost > 0).map((step) => step.sessionID)).size
    const where = this.liveSessions(now)
    const slot = (credentialID: string): PlacementSlot<string> => {
      const reading = this.freshReading(credentialID, now)
      const weekly = reading?.windows.find((window) => window.name === "7d")
      return {
        slot: credentialID,
        load: steps.filter((step) => step.credentialID === credentialID).reduce((total, step) => total + step.cost, 0),
        live: [...where].filter(([session, account]) => session !== sessionID && account === credentialID).length,
        held: this.held(credentialID),
        noRoom: this.noRoom(reading),
        ...(weekly?.resetAt === undefined ? {} : { weeklyResetAt: weekly.resetAt }),
      }
    }
    const cache = this.recent.get(sessionID)
    const preferred = cache !== undefined && now - cache.at < CACHE_LIFE_MS ? cache.credentialID : undefined
    return rankPlacement({
      slots: [slot(first), ...others.map(slot)],
      spent,
      sessions,
      ...(preferred === undefined ? {} : { preferred }),
    })
  }

  /** When the session last sent a request through this pool, epoch ms. */
  lastPlacedAt(sessionID: string): number | undefined {
    return this.recent.get(sessionID)?.at ?? this.runs.get(sessionID)?.at
  }

  /** The account the session's newest request of `kind` went out on. */
  placedOn(sessionID: string, kind: RequestKind): string | undefined {
    return this.placed.get(`${sessionID}:${kind}`)
  }

  /**
   * Whether a failed primary request of `sessionID` should go again at once:
   * its account is now held and another account is not.
   */
  shouldFailOver(sessionID: string): boolean {
    const account = this.placedOn(sessionID, "primary")
    if (account === undefined || !this.held(account)) return false
    return this.credentials.some((credentialID) => credentialID !== account && !this.held(credentialID))
  }

  /**
   * Take in a reading of one account. A live refusal holds it until the
   * refusal's time; a window read as exhausted holds it until that window
   * resets. Returns the hold it set, if any.
   */
  observe(credentialID: string, reading: QuotaReading): Hold | undefined {
    const now = this.now()
    this.readings.set(credentialID, reading)
    this.store.put(readingKey(credentialID), reading)
    const refusal = reading.refusal
    const refused =
      refusal !== undefined && (refusal.until === undefined || refusal.until > now)
        ? { kind: refusal.kind, until: refusal.until ?? now + DEFAULT_HOLD_MS }
        : undefined
    const exhausted = reading.windows
      .filter((window) => window.utilization >= 1 && window.resetAt !== undefined && window.resetAt > now)
      .reduce<number | undefined>((latest, window) => Math.max(latest ?? 0, window.resetAt ?? 0), undefined)
    const until = Math.max(refused?.until ?? 0, exhausted ?? 0)
    if (until <= now) return undefined
    return this.hold(credentialID, refused?.kind ?? "usage-limit", until)
  }

  /** A request on the account was refused (401 or 429) and no reading said for how long. */
  refused(credentialID: string, status: number): Hold | undefined {
    if (this.held(credentialID)) return undefined
    const kind: HoldKind = status === 401 ? "unauthorized" : "rate-limit"
    return this.hold(credentialID, kind, this.now() + DEFAULT_HOLD_MS)
  }

  /** Record a priced step of a session's run on the account its primary request went out on. */
  step(sessionID: string, cost: number): Step | undefined {
    const credentialID = this.placedOn(sessionID, "primary") ?? this.runs.get(sessionID)?.credentialID
    if (credentialID === undefined || !Number.isFinite(cost) || cost < 0) return undefined
    const now = this.now()
    const step: Step = { at: now, sessionID, credentialID, cost }
    this.steps.push(step)
    this.store.put(stepKey(step), step)
    this.recent.set(sessionID, { credentialID, at: now })
    return step
  }

  /** The session's run ended: its next request is placed afresh, near its cache. */
  release(sessionID: string) {
    this.runs.delete(sessionID)
  }

  /** Forget what has expired: steps out of the window, past holds, stale pins and caches. */
  prune() {
    const now = this.now()
    const kept: Step[] = []
    for (const step of this.steps) {
      if (now - step.at < WINDOW_MS) kept.push(step)
      else this.store.remove(stepKey(step))
    }
    this.steps = kept
    for (const [credentialID, hold] of this.holds) {
      if (hold.until > now) continue
      this.holds.delete(credentialID)
      this.store.remove(holdKey(credentialID))
    }
    for (const [sessionID, mark] of this.runs) if (now - mark.at >= PIN_IDLE_MS) this.runs.delete(sessionID)
    for (const [sessionID, mark] of this.recent) if (now - mark.at >= CACHE_LIFE_MS) this.recent.delete(sessionID)
  }

  status(): ReadonlyArray<AccountStatus> {
    const now = this.now()
    const where = this.liveSessions(now)
    return this.credentials.map((credentialID) => {
      const hold = this.holds.get(credentialID)
      const reading = this.readings.get(credentialID)
      return {
        credentialID,
        ...(hold !== undefined && hold.until > now ? { hold } : {}),
        ...(reading === undefined ? {} : { reading }),
        load: this.steps
          .filter((step) => step.credentialID === credentialID && now - step.at < WINDOW_MS)
          .reduce((total, step) => total + step.cost, 0),
        live: [...where.values()].filter((account) => account === credentialID).length,
        noRoom: this.noRoom(this.freshReading(credentialID, now)),
      }
    })
  }

  private hold(credentialID: string, kind: HoldKind, until: number): Hold {
    const current = this.holds.get(credentialID)
    // A hold only grows: a shorter refusal never frees an account a longer one holds.
    if (current !== undefined && current.until >= until) return current
    const hold: Hold = { kind, until, at: this.now() }
    this.holds.set(credentialID, hold)
    this.store.put(holdKey(credentialID), hold)
    return hold
  }

  /** The newest reading, with each window that has since reset read as empty. */
  private freshReading(credentialID: string, now: number): QuotaReading | undefined {
    const reading = this.readings.get(credentialID)
    if (reading === undefined) return undefined
    return {
      ...reading,
      windows: reading.windows.map((window) =>
        window.resetAt !== undefined && window.resetAt <= now ? { ...window, utilization: 0 } : window,
      ),
    }
  }

  /** At its share: a window spent to the pool's share of it. */
  private noRoom(reading: QuotaReading | undefined): boolean {
    if (reading === undefined) return false
    return reading.windows.some((window) => window.utilization >= shareOf(window.name))
  }

  /** Each session whose run, or cache, is on an account now. */
  private liveSessions(now: number): Map<string, string> {
    const where = new Map<string, string>()
    for (const [sessionID, mark] of this.recent) if (now - mark.at < CACHE_LIFE_MS) where.set(sessionID, mark.credentialID)
    for (const [sessionID, mark] of this.runs) if (now - mark.at < PIN_IDLE_MS) where.set(sessionID, mark.credentialID)
    return where
  }
}
