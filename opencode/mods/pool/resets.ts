// Automatic usage resets under standing owner approval: redeem and notify.
// Measured exhaustion with work waiting (a start held, or running work no
// account of the pool has room for) authorizes an ordinary refill; expiring
// credits get first choice. Anthropic preserves the weekly deadline, Codex
// restarts it. Fable clears its own quota and subtracts only its reported
// contribution from the shared week. See claim-rule.ts for exact boundaries.
//
// Spending is guarded at three levels:
// - Here, the decision: a claim rests only on the account's fields read
//   within FRESH_MS and after its last claim, each by its own read time
//   (`freshView`: a window carried over from an older reading is unread). An
//   account is its credential, whichever pool lists it; it takes one claim at
//   a time, and nothing more is claimed on it until a reading newer than the
//   claim shows what it did (`settling`). A claim is keyed by account, window
//   and period (`expiringKey`), with a fresh inventory generation for each
//   subsequent redemption; unchanged stock and retries retain their identity. `Review.auto: false` (the owner's kill switch) claims nothing on its
//   own; a push's approved resets still go.
// - The model, the send: one claim at a time per provider on the host, each
//   judged again on a reading taken right before it (`staleReason`): the
//   provider is the authority, so a claim made since from any pool or host
//   shows there, and what no longer pays is recorded unsent.
// - The fleet: no host is the master. A claim the pool decided on its own is
//   sent only once every peer the fleet knows of granted the provider's lease
//   (lease.ts); while a peer cannot be reached it is not sent (`NoAgreement`),
//   since that peer may be claiming too, and goes again later as any claim
//   that did not go through. A push's claim passes over such a peer: the
//   owner approved it with the push (`Reset.yes`). The request id
//   (`claimRequestID`) stays the one the claim was decided with; no provider
//   is relied on to dedupe it.
//
// The Resets aggregate keeps, across every pool of the host, the newest start
// each pool's pace held (a latch asks again every two minutes, so a wait
// older than WAIT_MS has gone), each claim as it is worked (claiming,
// settled, failed) under its key, and the claims made with what they did to
// the windows. The claim's request id comes from the key, so a claim sent
// again (a restart, a retry) is the same claim to the provider.
//
// `Review` is the decision: it reads every pool's accounts as the pool holds
// them now and records what is due. The model (model.ts) carries it out.
import { Array as Arr, Effect, Match, Option, Result, Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"
import { formatNotificationTime } from "@dotfiles/decider/notification-time"
import { periodBurn } from "./burn.ts"
import { type AccountLoad, type ClaimOption, type ClaimSituation, type ClaimStep, decideClaim, EXPIRING_MS, LAST_CALL_MS, MIN_RESTORE, NATURAL_MS, STEP_TEXT, plural } from "./claim-rule.ts"
import { windowMs } from "./limits.ts"
import { hasRoom, type PacePlan, roomLeft, SHORT_5H, TARGET } from "./pace.ts"
import { accountWide, accountWindow, ClaimOutcome, grantKind, limitsModel, QuotaWindow, type ResetCredit, ResetKind, scopeOf } from "./quota.ts"
import type { AccountStatus } from "./status.ts"
import { percent, used } from "./usage-text.ts"

export { ClaimOutcome } from "./quota.ts"
export { EXPIRING_MS, LAST_CALL_MS, MIN_RESTORE, NATURAL_MS, NOT_WORTH_MS, WORTH_SHARE } from "./claim-rule.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A held start older than this no longer waits: its latch would have asked again. */
export const WAIT_MS = 5 * MINUTE
/** A claim that did not go through is sent again (under the same request id) after this. */
export const RETRY_MS = 10 * MINUTE
/** A claim is tried this many times at most. */
export const MAX_ATTEMPTS = 3
/** A finished reset is forgotten this long after its hold lifted. */
export const KEEP_MS = 7 * DAY
/** The claims kept, newest last. */
export const MAX_CLAIMS = 20
/** A hold's reset time is bucketed this coarsely in its key, so a reading's jitter keeps the key. */
const KEY_BUCKET_MS = 30 * MINUTE
/** A window at least this long is week-long, not the 5-hour one. */
const LONG_WINDOW_MS = DAY
/**
 * A claim the pool decides on its own is made only on evidence this fresh: the account's
 * windows and its resets read within it (the sweep reads every 10 minutes by
 * default), and after the account's last claim. Older data is shown, never spent on.
 */
export const FRESH_MS = 15 * MINUTE
/**
 * How long after a claim is sent a reading may not show it yet: the
 * provider's lag and the request's time, assumed below it. No claim is sent
 * on a reading taken earlier than this after another of the provider's
 * (`claimOut`, and the fleet's leases, lease.ts), each host measuring it on
 * its own clock, so the hosts' clocks may differ by any amount.
 */
export const SETTLE_MS = 5 * MINUTE
/**
 * How long after a claim that went through (`reset`) a reading may still show
 * its own recovery (`recoveryIn`): the provider's reporting can lag the
 * claim's answer, so a fresh reading that shows the window it was for
 * unchanged leaves the claim pending, never spent and never claimed again,
 * until a reading shows that window lower (the week in the same period) or
 * this passes. A few sweeps' worth: a quiet
 * provider never keeps a claim pending, nor its account settling, for longer.
 */
export const OBSERVE_MS = 30 * MINUTE

/** Whose resets a pool holds: Claude grants or Codex credits. */
export const ResetProvider = Schema.Literals(["claude", "codex"])
export type ResetProvider = typeof ResetProvider.Type

/**
 * A start the pace held: when, and the session that made the call, if the
 * pace was told. `hard`: held for lack of quota, not by the spend-evenly
 * target alone; `root`: the root of the session's tree, which a push's scope
 * names; `model`: the model the start asked for, whose own window may hold it.
 */
export const Wait = Schema.Struct({
  at: Schema.Number,
  sessionID: Schema.optionalKey(Schema.String),
  hard: Schema.optionalKey(Schema.Boolean),
  root: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
})
export type Wait = typeof Wait.Type

/** The outcomes worth sending the same claim again for, later. */
export const retryable = (outcome: ClaimOutcome): boolean =>
  outcome === "cooldown" || outcome === "rate-limited" || outcome === "unconfirmed" || outcome === "failed"

/**
 * Why a reset is worked: measured exhaustion (`forecast`, its persisted
 * legacy name), a
 * reset about to expire unused, or a push the owner approved spends one of
 * its resets on a start held for lack of quota (push.ts). `held` (held work
 * no fresh account could take) and `offer` are older pools', read back only.
 */
export const ResetWhy = Schema.Literals(["held", "expiring", "forecast", "offer", "push"])
export type ResetWhy = typeof ResetWhy.Type

/** A reset's stage. `asked`, `declined` and `withdrawn` are an older pool's questions, read back only: none is worked, and each is forgotten in time. */
export const Stage = Schema.Literals(["asked", "claiming", "failed", "settled", "declined", "withdrawn"])
export type Stage = typeof Stage.Type

/** One hold's reset as the pool works it. */
export const Reset = Schema.Struct({
  key: Schema.String,
  pool: Schema.String,
  provider: ResetProvider,
  credentialID: Schema.String,
  /** The account's name as its store lists it, never a secret. */
  label: Schema.String,
  creditID: Schema.String,
  /** The claim's idempotency key (`claimRequestID`): the account, the kind and its period, the same on every host. */
  requestID: Schema.String,
  why: ResetWhy,
  stage: Stage,
  /** When it entered its stage (epoch ms). */
  at: Schema.Number,
  /** Claims sent so far. */
  attempts: Schema.Number,
  outcome: Schema.optionalKey(ClaimOutcome),
  message: Schema.optionalKey(Schema.String),
  /** The reset's kind. */
  kind: Schema.optionalKey(ResetKind),
  /** What it gives back, as the owner reads it. */
  buys: Schema.optionalKey(Schema.String),
  /** Why the rule claimed it, in one clause (claim-rule.ts), and the resets left on the account after it, with the soonest expiry among them. */
  reason: Schema.optionalKey(Schema.String),
  left: Schema.optionalKey(Schema.Number),
  nextExpires: Schema.optionalKey(Schema.Number),
  /** What the owner was told after it was claimed on its own. */
  told: Schema.optionalKey(Schema.String),
  /** A push approved it (`pushDue`): the claim rests on the owner, and is sent past a peer that cannot be reached (lease.ts `verdict`). */
  yes: Schema.optionalKey(Schema.Boolean),
  /** When its claim was last sent, recorded right before the send: a restart remembers it (`claimOut`). */
  sentAt: Schema.optionalKey(Schema.Number),
  /** The push whose approved reset it spends (push.ts), for a reset claimed for one. */
  push: Schema.optionalKey(Schema.String),
  /** The windows it is claimed for, by name as read (`5h`, `7d`, `7d:Fable`): a reading showing one of them back observes it (`recovered`). */
  judged: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type Reset = typeof Reset.Type

/** Whether the weekly window's reset moved with a claim: the open question about Claude's grants. */
export const WeeklyMove = Schema.Literals(["moved", "kept", "unread"])
export type WeeklyMove = typeof WeeklyMove.Type

/** A claim made, and the account's windows just before and just after it. */
export const Claim = Schema.Struct({
  key: Schema.String,
  pool: Schema.String,
  provider: ResetProvider,
  credentialID: Schema.String,
  label: Schema.String,
  creditID: Schema.String,
  requestID: Schema.String,
  at: Schema.Number,
  outcome: ClaimOutcome,
  message: Schema.optionalKey(Schema.String),
  before: Schema.Array(QuotaWindow),
  after: Schema.optionalKey(Schema.Array(QuotaWindow)),
  weekly: WeeklyMove,
  /** How the fleet agreed to it (lease.ts): the peers that granted the lease, or the fallback taken when some did not answer. */
  lease: Schema.optionalKey(Schema.String),
  /**
   * For a claim that went through (`reset`) whose reading after it could not be taken (`after` unread): the
   * account's windows as first read after the claim, recorded once (`ObserveClaim`), so a delayed reading of
   * the claim's own effect is its observation, never a later one another actor's spend or refund moved.
   */
  observed: Schema.optionalKey(Schema.Array(QuotaWindow)),
  /** The windows it was claimed for (`Reset.judged`); a claim recorded without them is judged on the week. */
  judged: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type Claim = typeof Claim.Type

/**
 * One request admitted on the room a claim gave back (`PacePlan.rebase`): a
 * fixed share of the account's week reserved at its dispatch, before it went
 * out, against that claim. It stays charged until a reading shows the week
 * risen past it (`lineOf`'s caller reads it as `from + spent`), and goes with
 * the claim's record: a restart, or another instance on the host, reads it.
 */
export const Spend = Schema.Struct({
  id: Schema.String,
  /** The claim's key. */
  claim: Schema.String,
  credentialID: Schema.String,
  at: Schema.Number,
  /** The share of the account's week reserved, 0 to 1. */
  cost: Schema.Number,
})
export type Spend = typeof Spend.Type

export const ResetsState = Schema.Struct({
  /** The newest held start of each pool. */
  waits: Schema.Record(Schema.String, Wait),
  /** Each hold's reset, by its key. */
  resets: Schema.Record(Schema.String, Reset),
  /** The claims made, oldest first, at most MAX_CLAIMS. */
  claims: Schema.Array(Claim),
  /** The requests admitted on a claim's room, oldest first; none kept for a claim no longer kept. */
  spends: Schema.optionalKey(Schema.Array(Spend)),
})
export type ResetsState = typeof ResetsState.Type

export const empty: ResetsState = { waits: {}, resets: {}, claims: [] }

// ── What an account's quota says ──

/** A window that holds an account: the 5-hour or the weekly one, spent until it resets. */
const spentWindows = (account: AccountStatus, now: number): ReadonlyArray<QuotaWindow> =>
  (account.reading?.windows ?? []).filter(
    (window) =>
      accountWide(window) &&
      (window.name === "5h" || window.name === "7d") &&
      window.utilization >= 1 &&
      window.resetAt !== undefined &&
      window.resetAt > now,
  )

/**
 * Until when the account is held by a spent window: the latest reset of its
 * spent windows, or its usage-limit hold when no reading says which window.
 * None when no spent window holds it (a rate limit or a sign-in is not one).
 */
export const spentUntil = (account: AccountStatus, now: number): number | undefined => {
  const spent = spentWindows(account, now)
  if (spent.length > 0) return Math.max(...spent.map((window) => window.resetAt ?? 0))
  const hold = account.hold
  return hold !== undefined && hold.kind === "usage-limit" && hold.until > now ? hold.until : undefined
}

/** The account's weekly window, as read. */
const weekly = (account: AccountStatus): QuotaWindow | undefined =>
  account.reading?.windows.find((window) => window.name === "7d" && accountWide(window))

const weekAbsent = (account: AccountStatus): boolean => accountWindow(account, "7d")._tag === "Absent"

/** The credits an account can claim now, soonest to expire first (one with no expiry last). */
export const usableCredits = (account: AccountStatus, now: number): ReadonlyArray<ResetCredit> =>
  (account.reading?.resets?.credits ?? [])
    .filter((credit) => credit.usable && credit.count > 0 && (credit.expiresAt === undefined || credit.expiresAt > now))
    .toSorted((left, right) => (left.expiresAt ?? Number.POSITIVE_INFINITY) - (right.expiresAt ?? Number.POSITIVE_INFINITY))

// ── Kinds, and what a reset gives back ──

/** A reset's kind: a Codex credit's is `codex`; a Claude grant's as read, else by Claude Code's rule. */
export const kindOf = (provider: ResetProvider, credit: ResetCredit): ResetKind =>
  provider === "codex" ? "codex" : (credit.kind ?? grantKind({ clears: credit.clears ?? [], givesBack: credit.givesBack === true }))

/** A kind as the owner reads it (Claude Code's words). */
export const KIND_LABEL: Readonly<Record<ResetKind, string>> = {
  session: "5-hour reset",
  weekly: "weekly reset",
  fable: "Fable reset",
  full: "full reset",
  codex: "Codex reset",
}

/**
 * Claude's window names as the pool names them. Claude Code calls
 * `seven_day_overage_included` the "Fable limit": Fable's own week, which the
 * usage endpoint lists as `7d:Fable`.
 */
const CLAUDE_WINDOWS: Readonly<Record<string, string>> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_overage_included: "7d:Fable",
  seven_day_opus: "7d:Opus",
  seven_day_sonnet: "7d:Sonnet",
}

/** Weekly points per point of a model's own week, and where the figure comes from. */
export interface Ratio {
  readonly rate: number
  readonly low?: number
  readonly high?: number
  readonly source: "tally" | "api"
}

/**
 * The weekly use a model's own week took. The usage endpoint's own figure
 * when it reports one (`used_percent_of_weekly`): exact. Else estimated, the
 * week's use times a ratio (weekly points per own-week point): the limit
 * tally's, when it has fitted the model on both windows (its 95% range from
 * the fit's), else the endpoint's allowance share (the own week's whole
 * allowance as a share of the weekly: exact only if every own-week point
 * costs the weekly the same, which no reading has confirmed). Else unread:
 * none counted.
 */
export interface Share {
  readonly points: number
  readonly low: number
  readonly high: number
  readonly source: "reported" | "tally" | "api" | "unread"
}

export const shareOf = (scoped: QuotaWindow, weekly: QuotaWindow | undefined, ratio: Ratio | undefined): Share => {
  const cap = weekly?.utilization ?? 0
  if (scoped.weeklyUsed !== undefined) {
    const points = Math.min(Math.max(scoped.weeklyUsed, 0), cap)
    return { points, low: points, high: points, source: "reported" }
  }
  const found: Ratio | undefined = ratio ?? (scoped.ofWeekly === undefined ? undefined : { rate: scoped.ofWeekly, source: "api" })
  if (found === undefined) return { points: 0, low: 0, high: 0, source: "unread" }
  const clamp = (value: number) => Math.min(Math.max(value, 0), cap)
  return {
    points: clamp(found.rate * scoped.utilization),
    low: clamp((found.low ?? found.rate) * scoped.utilization),
    high: clamp((found.high ?? found.rate) * scoped.utilization),
    source: found.source,
  }
}

/** One window a reset gives back: its use before and after, its natural reset, and for a give-back, the share it rests on. */
export interface Giveback {
  readonly window: string
  readonly from: number
  readonly to: number
  readonly resetAt?: number
  readonly share?: Share
}

/**
 * What claiming `credit` on `account` gives back now. A Codex credit empties
 * every window of the account. A Claude grant empties each window it clears
 * that the account reads, and one that gives back (a Fable reset) takes off the
 * weekly window the use its model's own week took of it (`shareOf`).
 */
export const effectOf = (
  provider: ResetProvider,
  account: AccountStatus,
  credit: ResetCredit,
  ratios: Readonly<Record<string, Ratio>> = {},
): ReadonlyArray<Giveback> => {
  const windows = account.reading?.windows ?? []
  const emptied = (window: QuotaWindow): Giveback => ({
    window: window.name,
    from: window.utilization,
    to: 0,
    ...(window.resetAt === undefined ? {} : { resetAt: window.resetAt }),
  })
  if (provider === "codex") return windows.filter(accountWide).map(emptied)
  const cleared = new Set((credit.clears ?? []).map((name) => CLAUDE_WINDOWS[name] ?? name))
  const gives = windows.filter((window) => cleared.has(window.name)).map(emptied)
  if (credit.givesBack !== true) return gives
  const weekly = windows.find((window) => window.name === "7d")
  const scoped = windows.filter((window) => cleared.has(window.name) && window.name.startsWith("7d:"))
  if (weekly === undefined || scoped.length === 0) return gives
  const shares = scoped.map((window) => shareOf(window, weekly, ratios[window.name]))
  const sum = (pick: (share: Share) => number) => Math.min(shares.reduce((total, share) => total + pick(share), 0), weekly.utilization)
  const share: Share = {
    points: sum((share) => share.points),
    low: sum((share) => share.low),
    high: sum((share) => share.high),
    // The weakest source among the windows names the sum's.
    source: (["unread", "api", "tally", "reported"] as const).find((source) => shares.some((share) => share.source === source)) ?? "unread",
  }
  return [
    ...gives.filter((give) => give.window !== "7d"),
    { window: "7d", from: weekly.utilization, to: weekly.utilization - share.points, ...(weekly.resetAt === undefined ? {} : { resetAt: weekly.resetAt }), share },
  ]
}

const windowLabel = (name: string) => (name === "5h" ? "5h" : name === "7d" ? "weekly" : `${scopeOf(name) ?? name} week`)

const SOURCES: Readonly<Record<Share["source"], string>> = {
  reported: "as the usage endpoint reports it",
  tally: "by the limit tally",
  api: "by the usage endpoint's allowance share",
  unread: "",
}

const shareText = (share: Share) =>
  share.source === "unread"
    ? "Fable's part unread, none counted"
    : `Fable's part ${percent(share.points)} of the week${share.low === share.high ? "" : ` (${percent(share.low)}–${percent(share.high)})`} ${SOURCES[share.source]}`

/** A week-long window's own reset, which a claim does not move: `, next reset Nov 18, 2026, 7:00:00 AM EST`; none for the 5-hour window, which starts again. */
const resetsText = (give: Giveback) =>
  Option.match(Option.filter(Option.fromUndefinedOr(give.resetAt), () => give.window !== "5h"), { onNone: () => "", onSome: (at) => `, next reset ${formatNotificationTime(at)}` })

/**
 * What a reset gives back, as the owner reads it, each window's use before
 * and after: `5h 100% used of 100% → 0% used, Fable week 80% used of 100% →
 * 0% used, next reset <time>, weekly 45% used of 100% → ~39% used, next reset <time>
 * (Fable's part 6% of the week (4%–8%) by the limit tally)`.
 */
export const buysOf = (gives: ReadonlyArray<Giveback>): string =>
  gives.length === 0
    ? "nothing the account reads"
    : gives
        .map((give) =>
          give.share === undefined
            ? `${windowLabel(give.window)} ${used(give.from)} → ${percent(give.to)} used${resetsText(give)}`
            : `${windowLabel(give.window)} ${used(give.from)} → ~${percent(give.to)} used${resetsText(give)} (${shareText(give.share)})`,
        )
        .join(", ")

/**
 * The key of a reset the pool claims on its own: the account (its
 * credential, whichever pool lists it), the window the claim is judged on,
 * and that window's period; not the credit. So a window period takes one
 * claim on its own, whichever credit or pool serves it, and the claim sent
 * again (a retry, a restart) has the same request id.
 */
export const expiringKey = (provider: ResetProvider, credentialID: string, window: string, resetAt: number) =>
  `${provider}-expiring:${credentialID}:${window}:${Math.floor(resetAt / KEY_BUCKET_MS)}`

/** FNV-1a, 32 bits, as 8 hex digits. */
const fnv = (text: string) => {
  let hash = 0x811c9dc5
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

/**
 * A claim's request id from its key: the same key, the same id, so a claim
 * sent again is the same claim. Letters, digits and `-` only, as Claude's
 * endpoint takes (`[A-Za-z0-9_-]{1,64}`).
 */
export const requestIdOf = (key: string) => `pool-${fnv(key)}${fnv(`${key}#`)}${fnv(`#${key}`)}`

/**
 * The ids of the resets a reading lists (usable or spent), which the
 * provider gives that account alone: the account in a claim's request id
 * and its lease's record. Two hosts' lists of one account may differ (one
 * lags), so the fleet's lease is the provider's, not these ids'.
 */
export const grantsOf = (account: Pick<AccountStatus, "reading">): ReadonlyArray<string> =>
  [...new Set((account.reading?.resets?.credits ?? []).map((credit) => credit.id))].toSorted()

/**
 * A claim's request id, the provider's idempotency key, from what every host
 * reading the account sees alike: the account (`grantsOf`, its first id),
 * the reset's kind, the period it serves (the 5-hour window's for a 5-hour
 * reset, the hold's for a Codex credit, else the week) and how many resets of
 * the kind are left. Never the window a host ranked first, the grant it
 * picked, the pool or the host. A provider's dedupe of it is a bonus, never
 * the guard: hosts whose lists of the grants differ decide other ids, and
 * the fleet's lease (lease.ts) is what keeps a claim to one.
 * The resets left set apart a second claim of the kind in the period once
 * the first shows in a reading. A claim sent again keeps the id it was
 * decided with (`Reset.requestID`).
 */
export const claimRequestID = (provider: ResetProvider, account: AccountStatus, credit: ResetCredit, now: number): string => {
  const kind = kindOf(provider, credit)
  const windowOf = (name: string) => account.reading?.windows.find((window) => window.name === name && accountWide(window))?.resetAt
  const period = (kind === "session" ? windowOf("5h") : provider === "codex" ? spentUntil(account, now) : undefined) ?? windowOf("7d") ?? credit.expiresAt ?? 0
  const left = Option.getOrElse(Option.fromUndefinedOr(account.reading?.resets?.credits), () => [])
    .filter((item) => inHand(item, now) && kindOf(provider, item) === kind)
    .reduce((total, item) => total + item.count, 0)
  return requestIdOf(`${provider}:${grantsOf(account)[0] ?? account.credentialID}:${kind}:${Math.floor(period / KEY_BUCKET_MS)}:${left}`)
}

// ── Words ──

/** A span as the owner reads it: days to one decimal from a day on, else hours. */
export const spanOf = (ms: number) => (ms >= DAY ? `${(ms / DAY).toFixed(1)} days` : `${Math.max(1, Math.round(ms / HOUR))} h`)

// ── Commands and events ──

/** One pool as the review reads it: whose resets it holds, its accounts now, and each account's label. */
export interface PoolView {
  readonly id: string
  readonly provider: ResetProvider
  readonly accounts: ReadonlyArray<AccountStatus>
  readonly labels: Readonly<Record<string, string>>
  /** Points of the weekly window per point of a model's own week, by that window's name (`7d:Fable`); `weeklyRatios`. */
  readonly ratios?: Readonly<Record<string, Ratio>>
  /** The agents of the pool's provider running across the fleet (its sessions busy now, this host's and its peers'), and the hosts they run on. */
  readonly running?: number
  readonly hosts?: number
  /** Each account's burn per window now, by credential and window name (burn.ts `burnsOf`); a window left out burns its period's average. */
  readonly burns?: Readonly<Record<string, Readonly<Record<string, number>>>>
  /** Each account's open windows whose burn is the period's average, not measured (burn.ts `averagedOf`): after a restart, say. */
  readonly averaged?: Readonly<Record<string, ReadonlyArray<string>>>
}

/** A window's burn on an account now: as measured, else its period's average. */
const burnOn = (view: PoolView, account: AccountStatus, window: QuotaWindow, now: number): number =>
  view.burns?.[account.credentialID]?.[window.name] ?? periodBurn(window, now)

/** Whether a window's burn on an account is its period's average for want of a measure. */
const averagedOn = (view: PoolView, account: AccountStatus, window: QuotaWindow): boolean =>
  (view.averaged?.[account.credentialID] ?? []).includes(window.name)

/** Each account of the pool as the forecast reads it: its windows still running, and until when a spent window or a usage-limit hold keeps it. */
const loadsOf = (view: PoolView, now: number): ReadonlyArray<AccountLoad> =>
  view.accounts.map((account) => ({
    credentialID: account.credentialID,
    windows: (account.reading?.windows ?? []).flatMap((window) =>
      Option.toArray(
        Option.map(
          Option.filter(Option.fromUndefinedOr(window.resetAt), (at) => at > now),
          (resetAt) => ({
            name: window.name,
            used: window.utilization,
            resetAt,
            burn: burnOn(view, account, window, now),
            averaged: averagedOn(view, account, window),
          }),
        ),
      ),
    ),
    freeAt: Option.fromUndefinedOr(spentUntil(account, now)),
  }))

/**
 * A start on the pool was held by its pace, from the session `sessionID` when
 * the pace was told; `hard` when for lack of quota, with the session's tree
 * root and the model it asked for (`Wait`).
 */
export const NoteWait = Schema.TaggedStruct("NoteWait", {
  pool: Schema.String,
  sessionID: Schema.optionalKey(Schema.String),
  hard: Schema.optionalKey(Schema.Boolean),
  root: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
})
export interface NoteWait extends Schema.Schema.Type<typeof NoteWait> {}

/**
 * A push active on this host now, as a review reads it (push.ts `Push`): the
 * root session its scope names (none: the whole host), and the resets the
 * owner approved: at most `max`, of `kinds` and on `accounts` (a login's id
 * or label) when named.
 */
export interface PushGrant {
  readonly id: string
  readonly goal: string
  readonly root?: string
  readonly max: number
  readonly kinds?: ReadonlyArray<ResetKind>
  readonly accounts?: ReadonlyArray<string>
}

/**
 * Decide what is due, on every pool's accounts as the pool holds them now.
 * `auto: false` (the owner's kill switch) claims nothing on its own, and
 * retries none of those; a push's approved resets still go. `pushes`: the
 * pushes active on this host.
 */
export interface Review {
  readonly _tag: "Review"
  readonly pools: ReadonlyArray<PoolView>
  readonly auto?: boolean
  readonly pushes?: ReadonlyArray<PushGrant>
}
export const Review = {
  make: (input: { readonly pools: ReadonlyArray<PoolView>; readonly auto?: boolean; readonly pushes?: ReadonlyArray<PushGrant> }): Review => ({
    _tag: "Review",
    ...input,
  }),
}

/** A claim came back, with the account's windows before it and as read again after it. */
export const SettleClaim = Schema.TaggedStruct("SettleClaim", {
  key: Schema.String,
  outcome: ClaimOutcome,
  message: Schema.optionalKey(Schema.String),
  before: Schema.Array(QuotaWindow),
  after: Schema.optionalKey(Schema.Array(QuotaWindow)),
  /** How the fleet agreed to the claim (`Claim.lease`). */
  lease: Schema.optionalKey(Schema.String),
})
export interface SettleClaim extends Schema.Schema.Type<typeof SettleClaim> {}

/** A claim is about to be sent: recorded first, so a restart mid-send still knows of it. */
export const NoteSend = Schema.TaggedStruct("NoteSend", { key: Schema.String })
export interface NoteSend extends Schema.Schema.Type<typeof NoteSend> {}

/**
 * The account was read at `at` after a claim that went through and whose
 * recovery no reading has shown yet (`awaitingObservation`): the reading's
 * windows become the claim's observation, once, only when they show the
 * claim's own recovery (`recoveryIn`) and while no newer claim on the account
 * was made.
 */
export const ObserveClaim = Schema.TaggedStruct("ObserveClaim", {
  pool: Schema.String,
  provider: ResetProvider,
  credentialID: Schema.String,
  windows: Schema.Array(QuotaWindow),
  at: Schema.Number,
})
export interface ObserveClaim extends Schema.Schema.Type<typeof ObserveClaim> {}

/** Reserve a request's share of a claim's room at its dispatch (`Spend`). */
export const ReserveSpend = Schema.TaggedStruct("ReserveSpend", { spend: Spend })
export interface ReserveSpend extends Schema.Schema.Type<typeof ReserveSpend> {}

/** Take back a reservation that did not fit once every instance's reservations were read: its request is held, not sent. */
export const WithdrawSpend = Schema.TaggedStruct("WithdrawSpend", { id: Schema.String })
export interface WithdrawSpend extends Schema.Schema.Type<typeof WithdrawSpend> {}

export type Command = NoteWait | Review | SettleClaim | NoteSend | ObserveClaim | ReserveSpend | WithdrawSpend

export const ClaimObserved = Schema.TaggedStruct("ClaimObserved", { key: Schema.String, windows: Schema.Array(QuotaWindow) })
export interface ClaimObserved extends Schema.Schema.Type<typeof ClaimObserved> {}

export const SpendReserved = Schema.TaggedStruct("SpendReserved", { spend: Spend })
export interface SpendReserved extends Schema.Schema.Type<typeof SpendReserved> {}

export const SpendWithdrawn = Schema.TaggedStruct("SpendWithdrawn", { spend: Spend })
export interface SpendWithdrawn extends Schema.Schema.Type<typeof SpendWithdrawn> {}

export const WaitNoted = Schema.TaggedStruct("WaitNoted", { pool: Schema.String, wait: Wait })
export interface WaitNoted extends Schema.Schema.Type<typeof WaitNoted> {}

/** A claim is due: the model sends it. */
export const ClaimDue = Schema.TaggedStruct("ClaimDue", { reset: Reset })
export interface ClaimDue extends Schema.Schema.Type<typeof ClaimDue> {}

/**
 * The rule weighed a pool and claimed nothing: the step that stopped it, if
 * one did, and the reason for each no. Only the log reads it; it changes no state.
 */
export const ClaimWeighed = Schema.TaggedStruct("ClaimWeighed", {
  pool: Schema.String,
  step: Schema.optionalKey(Schema.String),
  reasons: Schema.Array(Schema.String),
})
export interface ClaimWeighed extends Schema.Schema.Type<typeof ClaimWeighed> {}

export const ClaimSettled = Schema.TaggedStruct("ClaimSettled", { claim: Claim, stage: Stage })
export interface ClaimSettled extends Schema.Schema.Type<typeof ClaimSettled> {}

/** Finished resets whose hold lifted long ago. */
export const ResetsForgotten = Schema.TaggedStruct("ResetsForgotten", { keys: Schema.Array(Schema.String) })
export interface ResetsForgotten extends Schema.Schema.Type<typeof ResetsForgotten> {}

/**
 * A reset claimed on its own went through: the owner is told, in the newest
 * waiting session's tray when one is known (the model tells under
 * `toldKey(key)`), and the pane shows it.
 */
export const OwnerTold = Schema.TaggedStruct("OwnerTold", {
  key: Schema.String,
  at: Schema.Number,
  text: Schema.String,
  sessionID: Schema.optionalKey(Schema.String),
})
export interface OwnerTold extends Schema.Schema.Type<typeof OwnerTold> {}

/** The key a notice of a claim made on its own is told under. */
export const toldKey = (key: string) => `told:${key}`
/** A notice's one choice. */
export const SEEN = "OK"
export const SEEN_ASSUME = "Nothing to do: the pool claimed it"

/** A claim is being sent now. */
export const ClaimSent = Schema.TaggedStruct("ClaimSent", { key: Schema.String, at: Schema.Number })
export interface ClaimSent extends Schema.Schema.Type<typeof ClaimSent> {}

export type Event = WaitNoted | ClaimDue | ClaimWeighed | ClaimSettled | ResetsForgotten | OwnerTold | ClaimSent | ClaimObserved | SpendReserved | SpendWithdrawn

/**
 * Why no claim of `provider` goes on at `now`, this host's clock: a claim of
 * it this host sent (any pool, before a restart too) less than SETTLE_MS
 * before, which a reading may not show yet. The claim goes on only on a
 * reading taken after this, so it does. On this host's own account
 * (`credentialID`, its login) only its claims count; for a peer's ask, whose
 * login names no account here, every claim of the provider. Never another
 * host's time: clocks differ. None when there is none.
 */
export const claimOut = (state: ResetsState, provider: ResetProvider, now: number, credentialID?: string): string | undefined => {
  const out = Object.values(state.resets).find(
    (reset) =>
      reset.provider === provider &&
      (credentialID === undefined || onAccount(reset, credentialID)) &&
      reset.sentAt !== undefined &&
      now < reset.sentAt + SETTLE_MS,
  )
  return out?.sentAt === undefined ? undefined : `a claim sent on ${out.label} at ${formatNotificationTime(out.sentAt)} may not show yet in a reading`
}

// ── Review ──

/** The newest held start of the pool, while it still waits. */
/**
 * The start the pace held on `pool` within WAIT_MS, and after each claim on the pool that went
 * through within OBSERVE_MS and the claimed account's reading after it (`accounts`, as the pool holds them now): a
 * start held before that claim, or judged on the account's reading from before it, was the claim's
 * to answer; once the claim freed the account the start may go there, so it is no work waiting for
 * another claim. Nor is a start held before a reading of a login that takes its work now: a claim
 * another host made, which this host's claims do not list, frees work the same way.
 */
const waiting = (state: ResetsState, pool: string, now: number, accounts: ReadonlyArray<AccountStatus>): Wait | undefined =>
  Option.fromUndefinedOr(state.waits[pool]).pipe(
    Option.filter((wait) => now - wait.at < WAIT_MS),
    Option.filter(
      (wait) =>
        !state.claims.some((claim) => {
          if (claim.pool !== pool || (claim.outcome !== "reset" && claim.outcome !== "already-redeemed") || now - claim.at > OBSERVE_MS) return false
          const read = Option.getOrElse(Option.flatMap(Arr.findFirst(accounts, (account) => account.credentialID === claim.credentialID), (account) => Option.fromUndefinedOr(readAt(account))), () => claim.at)
          return Math.max(claim.at, read) >= wait.at
        }),
    ),
    // A login read after the wait that takes its work now (`hasRoom`, for its model): the start, asked again, goes
    // there, whichever host's claim freed it; it is no work waiting.
    Option.filter((wait) => !accounts.some((account) => Option.exists(Option.fromUndefinedOr(readAt(account)), (read) => read > wait.at) && hasRoom(account, now, wait.model))),
    Option.getOrUndefined,
  )

/** Whether every account the pool can use is held by a spent window; false for a pool with none. */
const allSpent = (accounts: ReadonlyArray<AccountStatus>, now: number) =>
  accounts.length > 0 && accounts.every((account) => spentUntil(account, now) !== undefined)

/**
 * Whether a claim goes again, the same claim, while its hold lasts and it
 * has tries left: one that did not go through, or one sent that never came
 * back (a stop mid-claim) once RETRY_MS has passed.
 */
const retries = (reset: Reset, current: ReadonlySet<string>) =>
  (reset.stage === "failed" || reset.stage === "claiming") && reset.attempts < MAX_ATTEMPTS && current.has(reset.key)

/** Whether the pool claims a reset on its own: every claim but a push's, which the owner approved with the push. */
const automatic = (reset: Pick<Reset, "yes">) => reset.yes !== true

/**
 * Whether a reset is on an account. An account is its credential, the same
 * in every pool of the host, never a pool's: two pools that list one
 * credential hold one account, and spend it once.
 */
const onAccount = (reset: Pick<Reset, "credentialID">, credentialID: string) => reset.credentialID === credentialID

/** When a claim was last sent on an account, or came back, through any pool: none when none was. */
const lastClaimAt = (state: ResetsState, credentialID: string): number | undefined => {
  const times = [
    ...state.claims.filter((claim) => onAccount(claim, credentialID)).map((claim) => claim.at),
    ...Object.values(state.resets)
      .filter((reset) => onAccount(reset, credentialID) && reset.attempts > 0)
      .map((reset) => reset.at),
  ]
  return times.length === 0 ? undefined : Math.max(...times)
}

/** When an account was read: its windows, and its resets (`at`, when carried from an older reading), the older. */
const readAt = (account: AccountStatus): number | undefined =>
  account.reading === undefined ? undefined : Math.min(account.reading.at, account.reading.resets?.at ?? account.reading.at)

/**
 * Whether an account is settling a claim: one is in flight or will be sent
 * again, its reading predates the last claim, so it cannot say what that
 * claim did, or that claim went through and no reading has shown its recovery
 * yet, within OBSERVE_MS (`awaitingObservation`): a quiet reading is not a
 * reason to claim again. A settling account takes no other claim, offer or question: one
 * claim at a time per account, each judged on a reading that shows the last.
 */
const settling = (state: ResetsState, current: ReadonlySet<string>, account: AccountStatus, now: number): boolean => {
  const busy = Object.values(state.resets).some(
    (reset) => onAccount(reset, account.credentialID) && ((reset.stage === "claiming" && now - reset.at < RETRY_MS) || retries(reset, current)),
  )
  if (busy || awaitingOn(state, account.credentialID, now)) return true
  const last = lastClaimAt(state, account.credentialID)
  const read = readAt(account)
  return last !== undefined && (read === undefined || read <= last)
}

/**
 * Whether a claim on the account may yet free it: one is in flight, the
 * account was read only before its last claim, or that claim's recovery is
 * still to show (`awaitingObservation`). Such an account may take the
 * work once its reading shows the claim, so the pool's forecast waits for it
 * and no other is claimed meanwhile.
 */
const freeing = (state: ResetsState, account: AccountStatus, now: number): boolean => {
  const inFlight = Object.values(state.resets).some((reset) => onAccount(reset, account.credentialID) && reset.stage === "claiming" && now - reset.at < RETRY_MS)
  const last = lastClaimAt(state, account.credentialID)
  const read = readAt(account)
  return inFlight || awaitingOn(state, account.credentialID, now) || (last !== undefined && (read === undefined || read <= last))
}

/**
 * The account as evidence for a claim no one asked for: only the fields read
 * within FRESH_MS and after its last claim, each by its own read time. A
 * window carried over from an older reading keeps that reading's time
 * (quota.ts `carryOver`), so a fresh reading around it never makes it fresh:
 * it is left out, as if unread, and its shares with it. The resets likewise.
 * None when no window or no reset is fresh: nothing to spend on.
 */
export const freshView = (state: ResetsState, account: AccountStatus, now: number): AccountStatus | undefined => {
  const reading = account.reading
  if (reading === undefined) return undefined
  const last = lastClaimAt(state, account.credentialID)
  const fresh = (at: number) => now - at < FRESH_MS && (last === undefined || at > last)
  const windows = reading.windows.filter((window) => fresh(window.at ?? reading.at))
  const resets = reading.resets
  if (windows.length === 0 || resets === undefined || !fresh(resets.at ?? reading.at)) return undefined
  return { ...account, reading: { ...reading, windows } }
}

/** A reset's fields from its hold. */
const resetOf = (
  view: PoolView,
  account: AccountStatus,
  credit: ResetCredit,
  key: string,
  why: ResetWhy,
  stage: Stage,
  now: number,
): Reset => ({
  key,
  pool: view.id,
  provider: view.provider,
  credentialID: account.credentialID,
  label: view.labels[account.credentialID] ?? account.credentialID,
  creditID: credit.id,
  requestID: claimRequestID(view.provider, account, credit, now),
  why,
  stage,
  at: now,
  attempts: 0,
  kind: kindOf(view.provider, credit),
})

/**
 * Whether a reset's reason is still current: its key is among the window
 * periods still running that the pools give now (`expiringKey`).
 */
const currentKeys = (pools: ReadonlyArray<PoolView>, now: number): ReadonlySet<string> =>
  new Set(
    pools.flatMap((view) =>
      view.accounts.flatMap((account) =>
        (account.reading?.windows ?? []).flatMap((window) =>
          window.resetAt === undefined || window.resetAt <= now ? [] : [expiringKey(view.provider, account.credentialID, window.name, window.resetAt)],
        ),
      ),
    ),
  )

// ── The standing allowance ──

/** The held work a pool weighs: its newest held start, and the model that start asked for. */
interface HeldWork {
  readonly wait: Wait
  readonly model?: string
}

/**
 * The work held on a pool: its own newest held start, or for a Codex pool,
 * a Claude pool's while every Claude account is spent (Codex takes that work,
 * on no Claude model's window).
 */
const heldWork = (state: ResetsState, view: PoolView, pools: ReadonlyArray<PoolView>, now: number): HeldWork | undefined => {
  const own = waiting(state, view.id, now, view.accounts)
  if (own !== undefined) return { wait: own, ...(own.model === undefined ? {} : { model: own.model }) }
  if (view.provider !== "codex") return undefined
  const claude = pools
    .filter((other) => other.provider === "claude" && allSpent(other.accounts, now))
    .flatMap((other) => Option.toArray(Option.fromUndefinedOr(waiting(state, other.id, now, other.accounts))))[0]
  return claude === undefined ? undefined : { wait: claude }
}


/** One reset the rule may claim, with what the claim is made of. */
interface Candidate {
  readonly option: ClaimOption
  readonly account: AccountStatus
  readonly credit: ResetCredit
  readonly key: string
  readonly gives: ReadonlyArray<Giveback>
}

const restoredOf = (give: Giveback) => give.from - give.to

/**
 * What a give-back surely restores: all of an emptied window; of the week a
 * Fable reset gives back, the part its model's week is known to have taken,
 * as the endpoint reports it, else the low end of the limit tally's fit.
 * Never the allowance share alone (the most the model may take, not what it
 * took) and never an unread part.
 */
const sureRestored = (give: Giveback): number =>
  Option.match(Option.fromUndefinedOr(give.share), {
    onNone: () => restoredOf(give),
    onSome: (share) =>
      Match.value(share.source).pipe(
        Match.when("reported", () => share.points),
        Match.when("tally", () => share.low),
        Match.orElse(() => 0),
      ),
  })

/**
 * The give-back a candidate reset is judged on: the one it gives back most of
 * (the fullest on a tie), of those whose window still has its reset ahead.
 * For a start held for lack of quota (`held`), by what each surely restores,
 * and of those, first the ones relieving a window that holds the start.
 */
const judgedGive = (weighedGives: ReadonlyArray<Giveback>, held: boolean, blocking: ReadonlyArray<QuotaWindow>, now: number): Option.Option<Giveback> => {
  const open = weighedGives.filter((give) => Option.exists(Option.fromUndefinedOr(give.resetAt), (at) => at > now))
  const most = (gives: ReadonlyArray<Giveback>) => Arr.head(gives.toSorted((left, right) => restoredOf(right) - restoredOf(left) || right.from - left.from))
  if (!held) {
    const exhausted = open.filter((give) => restoredOf(give) > 0 && give.from >= Match.value(give.window).pipe(Match.when("7d", () => 0.99), Match.orElse(() => 1)))
    return Option.orElse(most(exhausted), () => most(open))
  }
  const relieving = open.filter((give) => restoredOf(give) > 0 && blocking.some((window) => window.name === give.window))
  if (relieving.length > 0) return most(relieving)
  return most(open)
}

/** What a candidate reset frees, as it is weighed: held, what it surely gives back; else its estimate, as the forecast weighs it. */
const weighed = (estimated: ReadonlyArray<Giveback>, held: boolean): ReadonlyArray<Giveback> => {
  if (!held) return estimated
  return estimated.map((give) => ({ ...give, to: give.from - sureRestored(give) }))
}

/**
 * The resets the rule weighs on a pool: each usable reset on an account read
 * fresh (`freshView`), not settling a claim nor claimed on in this review,
 * judged on the window it gives back most of (the fullest on a tie), and
 * only while that window's period has had no claim (`expiringKey`). For a
 * start held for lack of quota (`held`), a reset that surely relieves a
 * window holding the start is judged on that window instead (`sureRestored`):
 * a Fable reset on an account whose shared week holds it is judged on the
 * week it gives back, not on Fable's own week, which holds nothing.
 */
const candidatesOf = (
  state: ResetsState,
  view: PoolView,
  current: ReadonlySet<string>,
  now: number,
  claiming: ReadonlySet<string>,
  model?: string,
  held = false,
): ReadonlyArray<Candidate> =>
  view.accounts.flatMap((read) => {
    const account = freshView(state, read, now)
    if (account === undefined || weekAbsent(account) || claiming.has(account.credentialID) || settling(state, current, account, now)) return []
    const credits = usableCredits(account, now)
    const week = weekly(account)
    const blocking = blockingOf(account, now, model)
    return credits.flatMap((credit) => {
      const estimated = effectOf(view.provider, account, credit, view.ratios)
      const gives = weighed(estimated, held)
      const best = Option.getOrUndefined(judgedGive(gives, held, blocking, now))
      if (best?.resetAt === undefined) return []
      const key = expiringKey(view.provider, account.credentialID, best.window, best.resetAt)
      const requestID = claimRequestID(view.provider, account, credit, now)
      if (state.claims.some((claim) => claim.requestID === requestID && (claim.outcome === "reset" || claim.outcome === "already-redeemed"))) return []
      // A lower observed credit count identifies a subsequent redemption in
      // this same cadence; a replay retains its original request and key.
      const previous = Option.filter(Option.fromUndefinedOr(state.resets[key]), (previous) => previous.requestID !== requestID)
      const generation = Option.match(previous, { onNone: () => key, onSome: () => `${key}:${requestID}` })
      if (state.resets[generation] !== undefined) return []
      const length = windowMs(best.window) ?? LONG_WINDOW_MS
      const judged = (account.reading?.windows ?? []).find((window) => window.name === best.window)
      const option: ClaimOption = {
        credentialID: account.credentialID,
        creditID: credit.id,
        label: view.labels[account.credentialID] ?? account.credentialID,
        window: windowLabel(best.window),
        long: length >= LONG_WINDOW_MS,
        forecast: best.window,
        from: best.from,
        restored: restoredOf(best),
        resetAt: best.resetAt,
        burn: Option.match(Option.fromUndefinedOr(judged), { onNone: () => 0, onSome: (read) => burnOn(view, account, read, now) }),
        expiresAt: Option.fromUndefinedOr(credit.expiresAt),
        frees: blocking.every((held) => !stillBlocks(held.name, gives.find((give) => give.window === held.name)?.to ?? held.utilization)),
        weekUsed: week?.utilization ?? 0,
        weekResetAt: Option.fromUndefinedOr(week?.resetAt),
        preservesWeekly: view.provider === "claude",
      }
      // The owner reads what it is estimated to give back, with the estimate's range.
      return [{ option, account, credit, key: generation, gives: estimated }]
    })
  })

/** The resets left on the account once `credit` is claimed, and the soonest expiry among them. */
const leftAfter = (account: AccountStatus, credit: ResetCredit, now: number): Pick<Reset, "left" | "nextExpires"> => {
  const counts = usableCredits(account, now).flatMap((item) => Array.from({ length: item.id === credit.id ? item.count - 1 : item.count }, () => item.expiresAt))
  const expiries = counts.flatMap((at) => Option.toArray(Option.fromUndefinedOr(at)))
  const left = { left: counts.length }
  return Arr.match(expiries, { onEmpty: () => left, onNonEmpty: (all) => ({ ...left, nextExpires: Math.min(...all) }) })
}

/** The claim the rule chose, as the model sends it. */
const ruleClaim = (view: PoolView, chosen: Candidate, step: ClaimStep, reason: string, now: number): ClaimDue => {
  const reset = resetOf(view, chosen.account, chosen.credit, chosen.key, step === "expiring" ? "expiring" : "forecast", "claiming", now)
  return ClaimDue.make({
    reset: { ...reset, buys: buysOf(chosen.gives), reason: `${STEP_TEXT[step]}: ${reason}`, judged: [chosen.option.forecast], ...leftAfter(chosen.account, chosen.credit, now) },
  })
}

/**
 * What the standing allowance decides on a pool (claim-rule.ts
 * `decideClaim`): a reset about to expire goes before a push's, a push's
 * approved reset covers the work it scopes, and only then a reset for the
 * forecast. A pool weighed with the forecast running out, or a start held,
 * and no claim says why (`ClaimWeighed`).
 */
const poolDue = (
  state: ResetsState,
  command: Review,
  view: PoolView,
  current: ReadonlySet<string>,
  now: number,
  claiming: ReadonlySet<string>,
): ReadonlyArray<Event> => {
  const auto = command.auto !== false
  const pushes = command.pushes ?? []
  const work = heldWork(state, view, command.pools, now)
  const candidates = auto ? candidatesOf(state, view, current, now, claiming, work?.model, work?.wait.hard === true) : []
  const situation: ClaimSituation = {
    now,
    held: work === undefined ? 0 : 1,
    running: view.running ?? 0,
    hosts: view.hosts ?? 1,
    accounts: loadsOf(view, now),
    settling: view.accounts.some((account) => freeing(state, account, now)),
    pushed: work !== undefined && pushFor(state, work.wait, pushes) !== undefined,
    room: view.accounts.some((account) => hasRoom(account, now)),
  }
  const verdict = decideClaim(situation, candidates.map((candidate) => candidate.option))
  const chosen = verdict._tag === "Claim" ? candidates.find((candidate) => candidate.option === verdict.option) : undefined
  if (verdict._tag === "Claim" && verdict.step === "expiring" && chosen !== undefined) return [ruleClaim(view, chosen, verdict.step, verdict.reason, now)]
  const pushed = pushDue(state, view, pushes, current, now, claiming)
  if (pushed.length > 0) return pushed
  if (verdict._tag === "Claim" && chosen !== undefined) return [ruleClaim(view, chosen, verdict.step, verdict.reason, now)]
  // Weighed aloud only when there is work to weigh: the pool runs out, or a start is held.
  const weighs = work !== undefined || (verdict._tag === "NoClaim" && Option.contains(verdict.step, "reset"))
  if (!auto || !weighs || verdict._tag === "Claim") return []
  return [ClaimWeighed.make({ pool: view.id, ...Option.match(verdict.step, { onNone: () => ({}), onSome: (step) => ({ step }) }), reasons: verdict.reasons })]
}

// ── The pace's line ──

/** Whether a credit can serve this week: left, not paused or expired, and claimable now or once the account is at a limit it clears. */
const inHand = (credit: ResetCredit, now: number) =>
  credit.count > 0 && credit.paused !== true && (credit.expiresAt === undefined || credit.expiresAt > now) && (credit.usable || credit.requiresLimit === true)

/** The share of a spent week a credit gives back: all of it for a Codex credit or a grant that clears the weekly window, a model's part for a Fable reset. */
const spareOf = (provider: ResetProvider, account: AccountStatus, credit: ResetCredit, ratios: Readonly<Record<string, Ratio>>): number => {
  if (provider === "codex") return TARGET_WEEK
  const cleared = (credit.clears ?? []).map((name) => CLAUDE_WINDOWS[name] ?? name)
  if (cleared.includes("7d")) return TARGET_WEEK
  if (credit.givesBack !== true) return 0
  const scoped = (account.reading?.windows ?? []).filter((window) => cleared.includes(window.name) && window.name.startsWith("7d:"))
  return Math.min(
    TARGET_WEEK,
    scoped.reduce((total, window) => total + (ratios[window.name]?.rate ?? window.ofWeekly ?? 0), 0),
  )
}

/** The spend-evenly target pace.ts paces a week to. */
const TARGET_WEEK = 0.99

/** Each reset in hand on an account (a credit's every count) that gives back some of a spent week: its spare and its expiry. */
export const sparesOf = (
  provider: ResetProvider,
  account: AccountStatus,
  now: number,
  ratios: Readonly<Record<string, Ratio>> = {},
): ReadonlyArray<{ readonly credit: ResetCredit; readonly kind: ResetKind; readonly spare: number; readonly expiresAt?: number }> => {
  if (weekAbsent(account)) return []
  return (account.reading?.resets?.credits ?? [])
    .filter((credit) => inHand(credit, now))
    .flatMap((credit) => {
      const spare = spareOf(provider, account, credit, ratios)
      const kind = kindOf(provider, credit)
      return spare <= 0 ? [] : Array.from({ length: credit.count }, () => ({ credit, kind, spare, ...(credit.expiresAt === undefined ? {} : { expiresAt: credit.expiresAt }) }))
    })
    .toSorted((left, right) => (left.expiresAt ?? Number.POSITIVE_INFINITY) - (right.expiresAt ?? Number.POSITIVE_INFINITY))
}

/**
 * The week's use a claim gave back, as its own readings observed it: the
 * account-wide week read right before the send and read again after the
 * answer, in the same period (its reset kept), the after reading its own (not
 * a window carried over from an older one), and lower. The reading after is
 * the one taken right after the answer, or, when that one could not be taken,
 * the first one taken later (`Claim.observed`). Only a claim this host's send
 * made go through (`reset`) gives back room: an `already-redeemed` answer
 * proves no send of this claim's own, so a lower week around it may be another
 * actor's refund. None too for a claim that failed or went nowhere, a
 * 5-hour-only reset that left the week as it was, or a reading after that is
 * absent or carried over (a 429).
 */
export const observedGiveback = (claim: Claim): Option.Option<{ readonly before: number; readonly after: number }> =>
  Option.filter(Option.some(claim), (made) => made.outcome === "reset").pipe(
    Option.flatMap((made) => Option.orElse(givebackIn(made, Option.fromUndefinedOr(made.after)), () => givebackIn(made, Option.fromUndefinedOr(made.observed)))),
  )

/** The account-wide week in `windows`. */
const weekIn = (windows: ReadonlyArray<QuotaWindow>) => Arr.findFirst(windows, (window) => window.name === "7d" && accountWide(window))

/** The account-wide week in `windows` read with them: not a window carried over from an older reading (`at`). */
const ownWeekIn = (windows: Option.Option<ReadonlyArray<QuotaWindow>>) =>
  Option.flatMap(windows, weekIn).pipe(Option.filter((window) => Option.isNone(Option.fromUndefinedOr(window.at))))

/** Whether two weekly windows are of one period: their resets within a minute. */
const samePeriod = (left: QuotaWindow, right: QuotaWindow) =>
  Option.exists(Option.all([Option.fromUndefinedOr(left.resetAt), Option.fromUndefinedOr(right.resetAt)]), ([one, two]) => Math.abs(one - two) <= MINUTE)

/** The week `windows` read lower than the claim's reading before it, in the same period, by its own reading (not a window carried over from an older one, `at`). */
const givebackIn = (claim: Claim, windows: Option.Option<ReadonlyArray<QuotaWindow>>): Option.Option<{ readonly before: number; readonly after: number }> =>
  Option.all([weekIn(claim.before), ownWeekIn(windows)]).pipe(
    Option.filter(([was, now]) => samePeriod(was, now) && now.utilization < was.utilization - 1e-9),
    Option.map(([was, now]) => ({ before: was.utilization, after: now.utilization })),
  )

/** The window `name` in `windows` (the weekly one account-wide), read with them: not carried over from an older reading (`at`). */
const ownWindowIn = (windows: ReadonlyArray<QuotaWindow>, name: string) =>
  Arr.findFirst(windows, (window) => window.name === name && (name !== "7d" || accountWide(window)) && Option.isNone(Option.fromUndefinedOr(window.at)))

/**
 * Whether `windows` show the claim's recovery: a window the claim was for
 * (`Claim.judged`: the 5-hour window, the week or a model's own week; the
 * week for a claim recorded without one) read with them lower than the
 * claim's reading before it, the week in the same period. A 5-hour refill
 * leaves the week as it was, so its own window is what shows it.
 */
const recovered = (claim: Claim, windows: Option.Option<ReadonlyArray<QuotaWindow>>): boolean =>
  Option.getOrElse(Option.fromUndefinedOr(claim.judged), () => ["7d"]).some((name) =>
    Match.value(name).pipe(
      Match.when("7d", () => Option.isSome(givebackIn(claim, windows))),
      Match.orElse(() =>
        Option.exists(
          Option.all([Arr.findFirst(claim.before, (window) => window.name === name), Option.flatMap(windows, (read) => ownWindowIn(read, name))]),
          ([was, now]) => now.utilization < was.utilization - 1e-9,
        ),
      ),
    ),
  )

/**
 * The claim's own recovery in a reading of `windows` taken at `at`: a claim
 * that went through, a reading after it and within OBSERVE_MS of it, a window
 * it was for lower than the claim's reading before it (`recovered`). A reading
 * that shows that window unchanged, a later one, or a week of another period
 * is none: a quiet provider is not the claim's room, nor is a refund long after.
 */
export const recoveryIn = (claim: Claim, windows: ReadonlyArray<QuotaWindow>, at: number): boolean =>
  claim.outcome === "reset" && at > claim.at && at <= claim.at + OBSERVE_MS && recovered(claim, Option.some(windows))

/**
 * Each account's line (pace.ts `PacePlan`). Fresh, approved Anthropic stock
 * accelerates existing quota toward exhaustion and credit expiry; it never
 * bypasses a hard quota. Once a reset was claimed this
 * week and its own readings observed the week lower after it
 * (`observedGiveback`), the line starts again there: the claim's time and the
 * week's use observed after it, never below the week's own line
 * (weekly-pace.ts `lineOf`). The claims and spends are the fleet's, merged
 * from every host's report (fleet-plans.ts), so every host builds one line
 * and one give-back is spent once across them.
 * The requests admitted on that room so far (`spends`) count as spent on it
 * until a reading shows the week past them (`PacePlan.rebase.spent`).
 */
export const pacePlans = (
  provider: ResetProvider,
  accounts: ReadonlyArray<AccountStatus>,
  claims: ReadonlyArray<Claim>,
  now: number,
  spends: ReadonlyArray<Spend> = [],
  planCredits = false,
): Readonly<Record<string, PacePlan>> => {
  const plans: Record<string, PacePlan> = {}
  for (const account of accounts) {
    const week = weekly(account)
    if (week?.resetAt === undefined) continue
    const periodStart = week.resetAt - 7 * DAY
    const observed = claims
      .filter((claim) => claim.provider === provider && claim.credentialID === account.credentialID && claim.at <= now && claim.at > periodStart)
      .flatMap((claim) => Option.toArray(Option.map(observedGiveback(claim), (given) => ({ at: claim.at, from: given.after, key: claim.key }))))
    // The newest: claims are kept oldest first, and the sort keeps their order, so of two at one instant the later one listed.
    const newest = Arr.last(observed.toSorted((left, right) => left.at - right.at))
    if (Option.isSome(newest)) {
      const spent = spends.filter((spend) => spend.claim === newest.value.key).reduce((sum, spend) => sum + spend.cost, 0)
      plans[account.credentialID] = { rebase: { ...newest.value, spent } }
    }
    const capacity = plannedCapacity(provider, account, claims, now, planCredits)
    if (Option.isSome(capacity)) plans[account.credentialID] = { ...plans[account.credentialID], capacity: capacity.value }
  }
  return plans
}

/**
 * The share of the shared week a claim of `credit` gives back to every model
 * when the pace has run the week to its stop: all of it for a grant that
 * empties the weekly window (effectOf), none for one that gives back a
 * model's part (a Fable reset: it returns only what Fable spent, so pacing
 * other models on it spends into a hole the reset does not clear), nor for one
 * that leaves the week as it is.
 */
const pacedSpareOf = (credit: ResetCredit): number =>
  Match.value(credit.givesBack !== true && Option.exists(Option.fromUndefinedOr(credit.clears), (clears) => clears.some((name) => Option.getOrElse(Option.fromUndefinedOr(CLAUDE_WINDOWS[name]), () => name) === "7d"))).pipe(
    Match.when(true, () => TARGET_WEEK),
    Match.orElse(() => 0),
  )

/**
 * Only fresh, approved, cadence-preserving stock accelerates an existing
 * allowance, and only by what its claims give back to every model at the
 * stop (`pacedSpareOf`), while a claim at the stop can still run: claims are
 * on (`approved`) and the week does not reset by itself within the rule's
 * guard (claim-rule.ts `soon`: NATURAL_MS for a grant that keeps the weekly
 * deadline).
 */
const plannedCapacity = (provider: ResetProvider, account: AccountStatus, claims: ReadonlyArray<Claim>, now: number, approved: boolean) => {
  const reading = Option.fromUndefinedOr(account.reading)
  const read = Option.fromUndefinedOr(readAt(account))
  const last = Math.max(...Arr.filterMap(claims, (claim) => Result.liftPredicate(claim.at, () => claim.provider === provider && claim.credentialID === account.credentialID, () => false)), Number.NEGATIVE_INFINITY)
  const guarded = Option.exists(Option.flatMap(Option.fromUndefinedOr(weekly(account)), (week) => Option.fromUndefinedOr(week.resetAt)), (resetAt) => resetAt - now <= NATURAL_MS)
  if (!approved || provider !== "claude" || guarded || Option.isNone(reading) || !Option.exists(read, (at) => at <= now && now - at < FRESH_MS && at > last)) return Option.none()
  const observed = new Set(Arr.filterMap(claims, (claim) => Result.liftPredicate(claim.requestID, () => claim.provider === provider && claim.credentialID === account.credentialID && (claim.outcome === "reset" || claim.outcome === "already-redeemed"), () => false)))
  const fields = reading.value
  const fresh = { ...account, reading: { ...fields, windows: fields.windows.filter((window) => {
    const at = Option.getOrElse(Option.fromUndefinedOr(window.at), () => fields.at)
    return at <= now && now - at < FRESH_MS && at > last
  }) } }
  // sparesOf answers what a reset could give back at all (push.ts reads it so); the pace takes only what it gives every model.
  // No fresh shared week, no capacity: a week carried over from an older reading shows nothing to give back.
  if (Option.isNone(Option.fromUndefinedOr(weekly(fresh)))) return Option.none()
  const stock = sparesOf(provider, fresh, now)
    .filter(({ credit }) => !observed.has(claimRequestID(provider, account, credit, now)))
    .map((item) => ({ ...item, spare: pacedSpareOf(item.credit) }))
    .filter(({ spare }) => spare > 0)
  const extra = stock.reduce((sum, item) => sum + item.spare, 0)
  if (extra <= 0) return Option.none()
  const expiries = stock.flatMap((spare) => Option.toArray(Option.fromUndefinedOr(spare.expiresAt)))
  const deadline = Option.map(Arr.head(expiries), (at) => at - LAST_CALL_MS)
  return Option.some({ extra, ...Option.match(deadline, { onNone: () => ({}), onSome: (expiresAt) => ({ expiresAt }) }) })
}

/**
 * The claim on an account whose effect is still to be observed at `now`: the
 * newest claim on it, when that one went through (`reset`), its reading
 * after it could not be taken or showed no recovery yet (the provider's
 * reporting lags), nothing since was recorded as its recovery, and OBSERVE_MS
 * has not passed since it. A reading after it of another period ends it: a
 * week that rolled over is no longer the claim's to show. Only the newest:
 * once another claim on the account was made, a lower week can no longer be
 * told apart from that one's.
 */
export const awaitingObservation = (claims: ReadonlyArray<Claim>, provider: ResetProvider, credentialID: string, now: number): Option.Option<Claim> =>
  Arr.findLast(claims, (claim) => claim.provider === provider && claim.credentialID === credentialID).pipe(Option.filter((claim) => pending(claim, now)))

/** Whether a claim still waits for its recovery to show (`awaitingObservation`), as the newest on its account. */
const pending = (claim: Claim, now: number): boolean =>
  claim.outcome === "reset" &&
  now <= claim.at + OBSERVE_MS &&
  Option.isNone(Option.fromUndefinedOr(claim.observed)) &&
  !recovered(claim, Option.fromUndefinedOr(claim.after)) &&
  // Its own reading after it (not a window carried over from an older one) of another period: the week rolled over.
  !Option.exists(Option.all([weekIn(claim.before), ownWeekIn(Option.fromUndefinedOr(claim.after))]), ([was, after]) => !samePeriod(was, after))

/**
 * In words for a held answer, the claims of `pool` that went through and
 * still wait at `now` for a reading to show their recovery
 * (`awaitingObservation`): claim pending, which is neither a hold for want of
 * quota nor room. None when no claim waits.
 */
export const pendingWords = (claims: ReadonlyArray<Claim>, pool: string, now: number): Option.Option<string> =>
  Arr.match(
    claims.filter(
      (claim) => claim.pool === pool && Option.exists(awaitingObservation(claims, claim.provider, claim.credentialID, now), (waiting) => waiting.key === claim.key),
    ),
    {
      onEmpty: () => Option.none(),
      onNonEmpty: (waiting) =>
        Option.some(
          `claim pending: ${waiting.map((claim) => `a reset claimed at ${formatNotificationTime(claim.at)} went through, and no reading has shown its recovery yet (it counts until ${formatNotificationTime(claim.at + OBSERVE_MS)})`).join("; ")}`,
        ),
    },
  )

/** Whether the newest claim on an account, of any provider, still waits for its recovery to show: the account is settling it. */
const awaitingOn = (state: ResetsState, credentialID: string, now: number): boolean =>
  Option.exists(Arr.findLast(state.claims, (claim) => onAccount(claim, credentialID)), (claim) => pending(claim, now))

/**
 * Whether the reservation `id`, written before this read, holds: it is read
 * back (a write that failed is not), and with every reservation read beside
 * it the account's claim room is not overspent (`roomLeft`). Of two
 * reservations written by racing instances, the later write's read sees the
 * earlier one, so the two never both hold past the room; when both read both,
 * both are withdrawn and their requests held.
 */
export const reservationHolds = (state: ResetsState, provider: ResetProvider, account: AccountStatus, now: number, id: string): boolean =>
  (state.spends ?? []).some((spend) => spend.id === id) &&
  Option.exists(roomLeft(account, now, pacePlans(provider, [account], state.claims, now, state.spends)[account.credentialID]), (room) => room >= -1e-9)

// ── A push's resets ──

/**
 * The windows that hold a start of `model` on an account now, for lack of
 * quota: an account-wide 5-hour or weekly window spent or past the pace's
 * room (`SHORT_5H`, `TARGET`), and the model's own week (`7d:Fable`) spent.
 */
export const blockingOf = (account: AccountStatus, now: number, model?: string): ReadonlyArray<QuotaWindow> =>
  (account.reading?.windows ?? []).filter((window) => {
    if (window.resetAt === undefined || window.resetAt <= now) return false
    if (window.name === "5h") return window.utilization >= SHORT_5H
    if (window.name === "7d") return window.utilization >= TARGET
    const scope = scopeOf(window.name)
    return scope !== undefined && model !== undefined && limitsModel(scope, model) && window.utilization >= 1
  })

/** Whether a window still holds a start at `used`. */
const stillBlocks = (name: string, used: number) => (name === "5h" ? used >= SHORT_5H : name === "7d" ? used >= TARGET : used >= 1)

/** One reset a push could spend on an account: what it gives back, by window length, and when it would be lost. */
export interface PushOption {
  readonly account: AccountStatus
  readonly credit: ResetCredit
  readonly kind: ResetKind
  readonly gives: ReadonlyArray<Giveback>
  /** The use it gives back of week-long windows (the weekly, a model's own week). */
  readonly weekly: number
  /** The use it gives back of the 5-hour window. */
  readonly short: number
  /** The account's weekly window's natural reset, when read. */
  readonly weekResetAt?: number
  /** It expires before the account's week resets by itself: unused, it is lost. */
  readonly expiresFirst: boolean
}

/** Whether a push allows a reset: its kind and its account (by id or label) among those the owner named, when named. */
const allows = (grant: Pick<PushGrant, "kinds" | "accounts">, view: PoolView, account: AccountStatus, kind: ResetKind) =>
  (grant.kinds === undefined || grant.kinds.includes(kind)) &&
  (grant.accounts === undefined ||
    grant.accounts.includes(account.credentialID) ||
    grant.accounts.includes(view.labels[account.credentialID] ?? account.credentialID))

/**
 * The resets a push may spend on an account for a start of `model`: of a kind
 * and an account it allows, that give back at least MIN_RESTORE of a window
 * and leave no window holding the start. A Fable reset only when the model's
 * own week is what holds it: Fable's share comes back, nothing else. With
 * `held` false (a plan), an account no window holds yet counts what each
 * reset would give back once spent: every usable reset of the kinds allowed.
 */
export const pushOptions = (
  view: PoolView,
  account: AccountStatus,
  grant: Pick<PushGrant, "kinds" | "accounts">,
  now: number,
  model?: string,
  held = true,
): ReadonlyArray<PushOption> => {
  if (weekAbsent(account)) return []
  const blocking = blockingOf(account, now, model)
  if (held && blocking.length === 0) return []
  const fableOut = blocking.some((window) => scopeOf(window.name) !== undefined)
  const weekResetAt = weekly(account)?.resetAt
  return usableCredits(account, now).flatMap((credit) => {
    const kind = kindOf(view.provider, credit)
    if (!allows(grant, view, account, kind)) return []
    if (kind === "fable" && held && !fableOut) return []
    const gives = effectOf(view.provider, account, credit, view.ratios)
    const given = new Map(gives.map((give) => [give.window, give]))
    if (held && blocking.some((window) => stillBlocks(window.name, given.get(window.name)?.to ?? window.utilization))) return []
    const restored = (give: Giveback) => give.from - give.to
    const weeklyBack = gives.filter((give) => (windowMs(give.window) ?? 0) >= LONG_WINDOW_MS).reduce((total, give) => total + restored(give), 0)
    const short = gives.filter((give) => give.window === "5h").reduce((total, give) => total + restored(give), 0)
    if (Math.max(weeklyBack, short) < MIN_RESTORE && held) return []
    return [
      {
        account,
        credit,
        kind,
        gives,
        weekly: weeklyBack,
        short,
        ...(weekResetAt === undefined ? {} : { weekResetAt }),
        expiresFirst: credit.expiresAt !== undefined && credit.expiresAt < (weekResetAt ?? Number.POSITIVE_INFINITY),
      },
    ]
  })
}

/**
 * The order a push spends its resets in, by value: a reset that would expire
 * before its week resets by itself first (the soonest first: unused it is
 * lost), then the most week-long use given back, then the most 5-hour use,
 * then the most time left before the account's natural weekly reset (a claim
 * does not move it, so the use given back has longest to be spent).
 */
export const rankPush = (left: PushOption, right: PushOption): number =>
  Number(right.expiresFirst) - Number(left.expiresFirst) ||
  (left.expiresFirst && right.expiresFirst ? (left.credit.expiresAt ?? 0) - (right.credit.expiresAt ?? 0) : 0) ||
  right.weekly - left.weekly ||
  right.short - left.short ||
  (right.weekResetAt ?? 0) - (left.weekResetAt ?? 0)

/** The key of a push's claim on a held account: once per push, account and hold. */
export const pushKey = (pushID: string, credentialID: string, until: number) => `push:${pushID}:${credentialID}:${Math.floor(until / KEY_BUCKET_MS)}`

/** Until when the windows that hold the account block a start of `model`; none when none does. */
const blockedUntil = (account: AccountStatus, now: number, model?: string): number | undefined => {
  const blocking = blockingOf(account, now, model)
  return blocking.length === 0 ? undefined : Math.max(...blocking.map((window) => window.resetAt ?? 0))
}

/** The resets a push has spent or is spending: in flight, to be sent again, or claimed. */
export const pushUsed = (state: ResetsState, pushID: string): ReadonlyArray<Reset> =>
  Object.values(state.resets).filter(
    (reset) =>
      reset.push === pushID &&
      (reset.stage === "claiming" ||
        (reset.stage === "failed" && reset.attempts < MAX_ATTEMPTS) ||
        (reset.stage === "settled" && (reset.outcome === "reset" || reset.outcome === "already-redeemed"))),
  )

/** The push that covers a held start: active here, its scope's root the wait's (or none: the whole host), with a reset left. */
const pushFor = (state: ResetsState, wait: Wait, pushes: ReadonlyArray<PushGrant>): PushGrant | undefined =>
  pushes.find((grant) => (grant.root === undefined || grant.root === wait.root) && pushUsed(state, grant.id).length < grant.max)

/**
 * The claim a push makes in a pool: a start its pace held for lack of quota
 * waits in the push's scope, and the push has an approved reset left. One at
 * a time across the host (no other push claim in flight), on an account no
 * claim is due on or settling, the best by value (`rankPush`). An asked
 * claim (`yes`): the owner approved it with the push, so the fleet's lease
 * passes over a peer that cannot be reached, and the account is read again
 * right before the send (model.ts `sendClaim`).
 */
const pushDue = (
  state: ResetsState,
  view: PoolView,
  pushes: ReadonlyArray<PushGrant>,
  current: ReadonlySet<string>,
  now: number,
  claiming: ReadonlySet<string>,
): ReadonlyArray<ClaimDue> => {
  const busy = Object.values(state.resets).some(
    (reset) => reset.push !== undefined && ((reset.stage === "claiming" && now - reset.at < RETRY_MS) || retries(reset, current)),
  )
  if (busy) return []
  const wait = waiting(state, view.id, now, view.accounts)
  const held = wait?.hard === true ? wait : undefined
  // A start held in its scope is served first; else an account whose week is spent has its reset claimed at once.
  const covering = held === undefined ? undefined : pushFor(state, held, pushes)
  // A spent week is claimed on with no start held only for a push of the whole host: one scoped to a session's tree changes nothing outside it.
  const grant = covering ?? pushes.find((item) => item.root === undefined && pushUsed(state, item.id).length < item.max)
  if (grant === undefined) return []
  const open = view.accounts.filter((account) => !claiming.has(account.credentialID) && !settling(state, current, account, now))
  const candidates = (model: string | undefined, spentWeek: boolean) =>
    open.flatMap((account) => {
      if (spentWeek && !blockingOf(account, now).some((window) => window.name === "7d")) return []
      const until = blockedUntil(account, now, model)
      if (until === undefined) return []
      const key = pushKey(grant.id, account.credentialID, until)
      if (state.resets[key] !== undefined) return []
      return pushOptions(view, account, grant, now, model)
        .filter((option) => !spentWeek || option.weekly >= MIN_RESTORE)
        .map((option) => ({ option, key }))
    })
  const best = [
    ...(covering === undefined || held === undefined ? [] : candidates(held.model, false)),
    ...(grant.root === undefined ? candidates(undefined, true) : []),
  ].toSorted((left, right) =>
    rankPush(left.option, right.option),
  )[0]
  if (best === undefined) return []
  const reset = resetOf(view, best.option.account, best.option.credit, best.key, "push", "claiming", now)
  return [
    ClaimDue.make({
      reset: { ...reset, yes: true, push: grant.id, buys: buysOf(best.option.gives), judged: best.option.gives.filter((give) => restoredOf(give) > 0).map((give) => give.window) },
    }),
  ]
}

/** The keys of the pushes' claims still current: each push, on each account a window holds for the pool's waiting model. */
const pushKeys = (state: ResetsState, pools: ReadonlyArray<PoolView>, pushes: ReadonlyArray<PushGrant>, now: number): ReadonlyArray<string> =>
  pushes.flatMap((grant) =>
    pools.flatMap((view) =>
      view.accounts.flatMap((account) =>
        [state.waits[view.id]?.model, undefined].flatMap((model) => {
          const until = blockedUntil(account, now, model)
          return until === undefined ? [] : [pushKey(grant.id, account.credentialID, until)]
        }),
      ),
    ),
  )

/** Old period keys and subsequent credit-count generations share one natural deadline. */
const withGenerations = (periods: ReadonlySet<string>, keys: ReadonlyArray<string>): ReadonlySet<string> =>
  new Set([...periods, ...keys.filter((key) => periods.has(key.replace(/:pool-[0-9a-f]{24}$/, "")))])

const review = (state: ResetsState, command: Review, now: number): ReadonlyArray<Event> => {
  const auto = command.auto !== false
  const pushes = command.pushes ?? []
  const current = withGenerations(new Set([...currentKeys(command.pools, now), ...pushKeys(state, command.pools, pushes, now)]), Object.keys(state.resets))
  const events: Array<Event> = []
  let after = state
  // The accounts (credentials, whichever pool lists them) a claim is due on in this review: one each.
  const claiming = new Set<string>()
  const accountOf = (reset: Reset) =>
    command.pools.find((view) => view.id === reset.pool)?.accounts.find((account) => account.credentialID === reset.credentialID)
  // A claim that did not go through goes again, the same claim, while its window period lasts; one the pool decided on its own, only on fresh evidence.
  for (const reset of Object.values(after.resets)) {
    if (!retries(reset, current) || now - reset.at < RETRY_MS || claiming.has(reset.credentialID)) continue
    const account = accountOf(reset)
    if (automatic(reset) && (!auto || account === undefined || freshView(state, account, now) === undefined)) continue
    claiming.add(reset.credentialID)
    events.push(ClaimDue.make({ reset: { ...reset, stage: "claiming", at: now } }))
  }
  for (const view of command.pools) {
    const due = poolDue(after, command, view, current, now, claiming)
    // A pool reviewed after another sees what the other decided: an account two pools list is claimed on once.
    after = due.reduce(evolve, after)
    events.push(...due)
    for (const event of due) if (event._tag === "ClaimDue") claiming.add(event.reset.credentialID)
  }
  const stale = Object.values(state.resets).flatMap((reset) =>
    reset.stage !== "claiming" && !current.has(reset.key) && now - reset.at >= KEEP_MS ? [reset.key] : [],
  )
  if (stale.length > 0) events.push(ResetsForgotten.make({ keys: stale }))
  return events
}

// ── The settling ──

/** The weekly window's reset before and after a claim: moved by more than a minute, kept, or not read on both sides. */
export const weeklyMove = (before: ReadonlyArray<QuotaWindow>, after: ReadonlyArray<QuotaWindow> | undefined): WeeklyMove => {
  const was = before.find((window) => window.name === "7d")?.resetAt
  const is = after?.find((window) => window.name === "7d")?.resetAt
  if (was === undefined || is === undefined) return "unread"
  return Math.abs(is - was) > MINUTE ? "moved" : "kept"
}

const settleClaim = (state: ResetsState, command: SettleClaim, now: number): ReadonlyArray<Event> => {
  const reset = state.resets[command.key]
  if (reset === undefined || reset.stage !== "claiming") return []
  const claim: Claim = {
    key: reset.key,
    pool: reset.pool,
    provider: reset.provider,
    credentialID: reset.credentialID,
    label: reset.label,
    creditID: reset.creditID,
    requestID: reset.requestID,
    at: now,
    outcome: command.outcome,
    ...(command.message === undefined ? {} : { message: command.message }),
    before: command.before,
    ...(command.after === undefined ? {} : { after: command.after }),
    weekly: weeklyMove(command.before, command.after),
    ...(command.lease === undefined ? {} : { lease: command.lease }),
    ...Option.match(Option.fromUndefinedOr(reset.judged), { onNone: () => ({}), onSome: (judged) => ({ judged }) }),
  }
  const settled = ClaimSettled.make({ claim, stage: retryable(command.outcome) ? "failed" : "settled" })
  if (!automatic(reset) || (command.outcome !== "reset" && command.outcome !== "already-redeemed")) return [settled]
  // Claimed on its own: the owner is told after, in the session that waited last.
  const newest = Object.values(state.waits)
    .filter((wait) => wait.sessionID !== undefined)
    .toSorted((left, right) => right.at - left.at)[0]
  const text = toldText(reset)
  return [settled, OwnerTold.make({ key: reset.key, at: now, text, ...(newest?.sessionID === undefined ? {} : { sessionID: newest.sessionID }) })]
}

/** A kind as a notice names it: the 5-hour reset as the usage wording does, `5h`. */
const NOTICE_KIND: Readonly<Record<ResetKind, string>> = { ...KIND_LABEL, session: "5h reset" }

const leftText = (reset: Pick<Reset, "left" | "nextExpires">) =>
  Option.match(Option.fromUndefinedOr(reset.left), {
    onNone: () => "",
    onSome: (left) =>
      Match.value(left).pipe(
        Match.when(0, () => " No resets left this week."),
        Match.orElse(
          () =>
            ` ${left} ${plural(left, "reset")} left this week; ${Option.match(Option.fromUndefinedOr(reset.nextExpires), { onNone: () => "none expires", onSome: (at) => `next expires ${formatNotificationTime(at)}` })}.`,
        ),
      ),
  })

/**
 * What the owner is told of a reset the pool claimed on its own, in the
 * usage wording: `Claimed the 5h reset on Max 1: 5h 100% used of 100% → 0%
 * used (the pool runs out before its reset: …). 2 resets left this week;
 * next expires 2026-11-18 12:00Z.`
 */
export const toldText = (reset: Pick<Reset, "kind" | "label" | "buys" | "reason" | "left" | "nextExpires">): string =>
  `Claimed the ${Option.match(Option.fromUndefinedOr(reset.kind), { onNone: () => "reset", onSome: (kind) => NOTICE_KIND[kind] })} on ${reset.label}` +
  `${Option.match(Option.fromUndefinedOr(reset.buys), { onNone: () => "", onSome: (buys) => `: ${buys}` })}` +
  `${Option.match(Option.fromUndefinedOr(reset.reason), { onNone: () => "", onSome: (reason) => ` (${reason})` })}.${leftText(reset)}`

/**
 * Why a claim decided earlier is no longer to be sent, judged on the
 * account as read right before it is sent, under the claim lock (model.ts);
 * undefined: send it. The provider's reading is the authority: a claim made
 * since on the account, from any pool or host, shows in it. The reset must
 * still be listed and claimable; one for held work needs a window still
 * holding the account. Ordinary automatic claims (`forecast`, a persisted
 * legacy name) must still satisfy the exhaustion rule. Automatic claims need
 * positive restoration; explicit pushes retain their minimum restoration.
 */
export const staleReason = (view: PoolView, account: AccountStatus, reset: Pick<Reset, "creditID" | "why" | "provider">, now: number): string | undefined => {
  const credit = usableCredits(account, now).find((item) => item.id === reset.creditID)
  if (credit === undefined) return "the reset is no longer listed as claimable"
  if (reset.why === "forecast") {
    const options = candidatesOf(empty, { ...view, accounts: [account] }, new Set<string>(), now, new Set<string>()).filter((candidate) => candidate.credit.id === credit.id)
    const verdict = decideClaim({ now, held: 0, running: 1, hosts: 1, accounts: [], settling: false, pushed: false, room: false }, options.map((candidate) => candidate.option))
    if (verdict._tag === "NoClaim") return "the account no longer has a claimable exhausted window"
  }
  const lastDay = Option.exists(Option.fromUndefinedOr(credit.expiresAt), (at) => at - now <= EXPIRING_MS)
  const floor = Match.value((reset.why === "expiring" && lastDay) || reset.why === "forecast").pipe(
    Match.when(true, () => Number.MIN_VALUE),
    Match.orElse(() => MIN_RESTORE),
  )
  const holding =
    spentUntil(account, now) !== undefined ||
    blockingOf(account, now).length > 0 ||
    (account.reading?.windows ?? []).some((window) => scopeOf(window.name) !== undefined && window.utilization >= 1)
  if (reset.why === "held" && !holding) return "no window holds the account any more"
  // A grant that does not say what it clears is judged by the hold it was claimed for.
  if (reset.provider === "claude" && credit.clears === undefined)
    return spentUntil(account, now) === undefined ? "no spent window holds the account any more" : undefined
  const restores = effectOf(view.provider, account, credit, view.ratios).some((give) => give.from - give.to >= floor)
  return restores ? undefined : "it would give nothing back now"
}

/**
 * What a claim's observation and a request's reservation record, decided on
 * the state alone (the Resets decider's for these commands): an observation
 * only for the claim still waiting for one (`awaitingObservation`), a
 * reservation as asked, a withdrawal of a reservation still kept.
 */
export const decideSpend = (state: ResetsState, command: ObserveClaim | ReserveSpend | WithdrawSpend, now: number): ReadonlyArray<Event> => {
  switch (command._tag) {
    case "ObserveClaim":
      return Option.toArray(
        awaitingObservation(state.claims, command.provider, command.credentialID, Math.min(now, command.at)).pipe(
          Option.filter((claim) => claim.pool === command.pool && recoveryIn(claim, command.windows, command.at)),
        ),
      ).map((claim) => ClaimObserved.make({ key: claim.key, windows: command.windows }))
    case "ReserveSpend":
      return [SpendReserved.make({ spend: command.spend })]
    case "WithdrawSpend":
      return Option.toArray(Arr.findFirst(Option.getOrElse(Option.fromUndefinedOr(state.spends), () => []), (spend) => spend.id === command.id)).map((spend) => SpendWithdrawn.make({ spend }))
  }
}

export const Resets: Decider<ResetsState, Command, Event> = {
  initial: empty,
  decide: (state, command, now) => {
    switch (command._tag) {
      case "NoteWait":
        return Effect.succeed([
          WaitNoted.make({
            pool: command.pool,
            wait: {
              at: now,
              ...(command.sessionID === undefined ? {} : { sessionID: command.sessionID }),
              ...(command.hard === true ? { hard: true } : {}),
              ...(command.root === undefined ? {} : { root: command.root }),
              ...(command.model === undefined ? {} : { model: command.model }),
            },
          }),
        ])
      case "Review":
        return Effect.succeed(review(state, command, now))
      case "SettleClaim":
        return Effect.succeed(settleClaim(state, command, now))
      case "NoteSend":
        return Effect.succeed(state.resets[command.key]?.stage === "claiming" ? [ClaimSent.make({ key: command.key, at: now })] : [])
      case "ObserveClaim":
      case "ReserveSpend":
      case "WithdrawSpend":
        return Effect.succeed(decideSpend(state, command, now))
    }
  },
  evolve: (state, event) => evolve(state, event),
}

/** The state with `spends` as its reservations: the key left out when there are none, as a state read with none has it. */
const withSpends = (state: ResetsState, spends: ReadonlyArray<Spend>): ResetsState => {
  const { spends: _dropped, ...rest } = state
  if (spends.length === 0) return rest
  return { ...rest, spends }
}

/**
 * The reservations of claims still kept, and those of the last week on a claim
 * this host does not keep: a peer's, whose room the fleet shares
 * (fleet-plans.ts), counted here until its week is surely over.
 */
export const keptSpends = (claims: ReadonlyArray<Claim>, spends: ReadonlyArray<Spend>, now: number): ReadonlyArray<Spend> => {
  const kept = new Set(claims.map((claim) => claim.key))
  return spends.filter((spend) => kept.has(spend.claim) || now - spend.at < 7 * DAY)
}

const withStage = (state: ResetsState, key: string, stage: Stage, at: number, extra: Partial<Reset> = {}): ResetsState => {
  const reset = state.resets[key]
  return reset === undefined ? state : { ...state, resets: { ...state.resets, [key]: { ...reset, ...extra, stage, at } } }
}

export const evolve = (state: ResetsState, event: Event): ResetsState => {
  switch (event._tag) {
    case "WaitNoted":
      return { ...state, waits: { ...state.waits, [event.pool]: event.wait } }
    case "ClaimDue":
      return { ...state, resets: { ...state.resets, [event.reset.key]: { ...event.reset, attempts: event.reset.attempts + 1 } } }
    case "ClaimWeighed":
      return state
    case "ClaimSettled": {
      const claims = [...state.claims, event.claim].slice(-MAX_CLAIMS)
      return withSpends(
        {
          ...withStage(state, event.claim.key, event.stage, event.claim.at, {
            outcome: event.claim.outcome,
            ...(event.claim.message === undefined ? {} : { message: event.claim.message }),
          }),
          claims,
        },
        keptSpends(claims, state.spends ?? [], event.claim.at),
      )
    }
    case "ClaimObserved":
      return { ...state, claims: state.claims.map((claim) => Object.assign({}, claim, claim.key === event.key && { observed: event.windows })) }
    case "SpendReserved":
      return withSpends(state, [...(state.spends ?? []), event.spend])
    case "SpendWithdrawn":
      return withSpends(state, (state.spends ?? []).filter((spend) => spend.id !== event.spend.id))
    case "ResetsForgotten": {
      const drop = new Set(event.keys)
      return { ...state, resets: Object.fromEntries(Object.entries(state.resets).filter(([key]) => !drop.has(key))) }
    }
    case "OwnerTold": {
      const reset = state.resets[event.key]
      return reset === undefined ? state : { ...state, resets: { ...state.resets, [event.key]: { ...reset, told: event.text } } }
    }
    case "ClaimSent": {
      const reset = state.resets[event.key]
      return reset === undefined ? state : { ...state, resets: { ...state.resets, [event.key]: { ...reset, sentAt: event.at } } }
    }
  }
}
