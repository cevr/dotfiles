// Rate-limit resets: the pool spends them itself, under a standing owner
// approval. Every reset in hand may be claimed, as needed, and none is ever
// asked about: when a claim pays is one pure rule (claim-rule.ts
// `decideClaim`), and after a claim the owner is told once, in their terms
// (`claimNotice`). A Codex reset credit restarts the account's whole week, so
// the pool claims one when every Codex account is held by a spent window and
// a start waits (`codexDue`). A push (push.ts) still caps or shapes what is
// spent for the work it covers.
//
// Each reset has a kind (quota.ts `ResetKind`) and gives back windows
// (`effectOf`): a Fable reset empties Fable's own week and takes Fable's part
// of the weekly use off the weekly window, whose reset stays. Capacity is
// taken in the rule's order: a reset about to expire unused first (one that
// expires within a day is just used, timed onto a spent window), then a fresh
// account (no claim while the forecast keeps room to the pool's first natural
// reset), then a reset not about to expire, when the forecast of the work on
// the pool (its burn, burn.ts; the agents running across the fleet; any start
// held) runs it out before that reset, on the most-used account near its
// limit, when the work would spend at least half of what it gives back before
// the window resets by itself. Never for a window that resets by itself soon
// anyway.
//
// Spending is guarded at three levels:
// - Here, the decision: a claim rests only on the account's fields read
//   within FRESH_MS and after its last claim, each by its own read time
//   (`freshView`: a window carried over from an older reading is unread). An
//   account is its credential, whichever pool lists it; it takes one claim at
//   a time, and nothing more is claimed on it until a reading newer than the
//   claim shows what it did (`settling`). A claim is keyed by account, window
//   and period (`expiringKey`), not credit or pool, so a window period takes
//   one. `Review.auto: false` (the owner's kill switch) claims nothing on its
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
import { Array as Arr, Effect, Match, Option, Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"
import { periodBurn } from "./burn.ts"
import { type AccountLoad, type ClaimOption, type ClaimSituation, type ClaimStep, decideClaim, EXPIRING_MS, MIN_RESTORE, STEP_TEXT, plural } from "./claim-rule.ts"
import { windowMs } from "./limits.ts"
import { type PacePlan, SHORT_5H, TARGET } from "./pace.ts"
import { accountWide, ClaimOutcome, grantKind, limitsModel, QuotaWindow, type ResetCredit, ResetKind, scopeOf } from "./quota.ts"
import type { AccountStatus } from "./status.ts"
import { iso, percent, used } from "./usage-text.ts"

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
 * Why a reset is worked: the forecast runs the pool out before its reset, a
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
})
export type Claim = typeof Claim.Type

export const ResetsState = Schema.Struct({
  /** The newest held start of each pool. */
  waits: Schema.Record(Schema.String, Wait),
  /** Each hold's reset, by its key. */
  resets: Schema.Record(Schema.String, Reset),
  /** The claims made, oldest first, at most MAX_CLAIMS. */
  claims: Schema.Array(Claim),
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

/** A week-long window's own reset, which a claim does not move: `, next reset 2026-11-18 12:00Z`; none for the 5-hour window, which starts again. */
const resetsText = (give: Giveback) =>
  Option.match(Option.filter(Option.fromUndefinedOr(give.resetAt), () => give.window !== "5h"), { onNone: () => "", onSome: (at) => `, next reset ${iso(at)}` })

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
  const left = usableCredits(account, now)
    .filter((item) => kindOf(provider, item) === kind)
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
  /** The agents of the pool's provider running across the fleet (admitted in the last hour, this host's and its peers'), and the hosts they run on. */
  readonly running?: number
  readonly hosts?: number
  /** Each account's burn per window now, by credential and window name (burn.ts `burnsOf`); a window left out burns its period's average. */
  readonly burns?: Readonly<Record<string, Readonly<Record<string, number>>>>
}

/** A window's burn on an account now: as measured, else its period's average. */
const burnOn = (view: PoolView, account: AccountStatus, window: QuotaWindow, now: number): number =>
  view.burns?.[account.credentialID]?.[window.name] ?? periodBurn(window, now)

/** Each account of the pool as the forecast reads it: its windows still running, and until when a spent window or a usage-limit hold keeps it. */
const loadsOf = (view: PoolView, now: number): ReadonlyArray<AccountLoad> =>
  view.accounts.map((account) => ({
    credentialID: account.credentialID,
    windows: (account.reading?.windows ?? []).flatMap((window) =>
      Option.toArray(
        Option.map(
          Option.filter(Option.fromUndefinedOr(window.resetAt), (at) => at > now),
          (resetAt) => ({ name: window.name, used: window.utilization, resetAt, burn: burnOn(view, account, window, now) }),
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

export type Command = NoteWait | Review | SettleClaim | NoteSend

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

export type Event = WaitNoted | ClaimDue | ClaimWeighed | ClaimSettled | ResetsForgotten | OwnerTold | ClaimSent

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
  return out?.sentAt === undefined ? undefined : `a claim sent on ${out.label} at ${new Date(out.sentAt).toISOString()} may not show yet in a reading`
}

// ── Review ──

/** The newest held start of the pool, while it still waits. */
const waiting = (state: ResetsState, pool: string, now: number): Wait | undefined => {
  const wait = state.waits[pool]
  return wait !== undefined && now - wait.at < WAIT_MS ? wait : undefined
}

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
 * again, or its reading predates the last claim, so it cannot say what that
 * claim did. A settling account takes no other claim, offer or question: one
 * claim at a time per account, each judged on a reading that shows the last.
 */
const settling = (state: ResetsState, current: ReadonlySet<string>, account: AccountStatus, now: number): boolean => {
  const busy = Object.values(state.resets).some(
    (reset) => onAccount(reset, account.credentialID) && ((reset.stage === "claiming" && now - reset.at < RETRY_MS) || retries(reset, current)),
  )
  if (busy) return true
  const last = lastClaimAt(state, account.credentialID)
  const read = readAt(account)
  return last !== undefined && (read === undefined || read <= last)
}

/**
 * Whether a claim on the account may yet free it: one is in flight, or the
 * account was read only before its last claim. Such an account may take the
 * work once its reading shows the claim, so the pool's forecast waits for it
 * and no other is claimed meanwhile.
 */
const freeing = (state: ResetsState, account: AccountStatus, now: number): boolean => {
  const inFlight = Object.values(state.resets).some((reset) => onAccount(reset, account.credentialID) && reset.stage === "claiming" && now - reset.at < RETRY_MS)
  const last = lastClaimAt(state, account.credentialID)
  const read = readAt(account)
  return inFlight || (last !== undefined && (read === undefined || read <= last))
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
  const own = waiting(state, view.id, now)
  if (own !== undefined) return { wait: own, ...(own.model === undefined ? {} : { model: own.model }) }
  if (view.provider !== "codex") return undefined
  const claude = pools
    .filter((other) => other.provider === "claude" && allSpent(other.accounts, now))
    .flatMap((other) => Option.toArray(Option.fromUndefinedOr(waiting(state, other.id, now))))[0]
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
 * The resets the rule weighs on a pool: each usable reset on an account read
 * fresh (`freshView`), not settling a claim nor claimed on in this review,
 * judged on the window it gives back most of (the fullest on a tie), and
 * only while that window's period has had no claim (`expiringKey`).
 */
const candidatesOf = (
  state: ResetsState,
  view: PoolView,
  current: ReadonlySet<string>,
  now: number,
  claiming: ReadonlySet<string>,
  model?: string,
): ReadonlyArray<Candidate> =>
  view.accounts.flatMap((held) => {
    const account = freshView(state, held, now)
    if (account === undefined || claiming.has(account.credentialID) || settling(state, current, account, now)) return []
    const credits = usableCredits(account, now)
    const week = weekly(account)
    const blocking = blockingOf(account, now, model)
    return credits.flatMap((credit) => {
      const gives = effectOf(view.provider, account, credit, view.ratios)
      const best = gives
        .filter((give) => give.resetAt !== undefined && give.resetAt > now)
        .toSorted((left, right) => restoredOf(right) - restoredOf(left) || right.from - left.from)[0]
      if (best?.resetAt === undefined) return []
      const key = expiringKey(view.provider, account.credentialID, best.window, best.resetAt)
      if (state.resets[key] !== undefined) return []
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
      }
      return [{ option, account, credit, key, gives }]
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
    reset: { ...reset, buys: buysOf(chosen.gives), reason: `${STEP_TEXT[step]}: ${reason}`, ...leftAfter(chosen.account, chosen.credit, now) },
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
  const candidates = auto ? candidatesOf(state, view, current, now, claiming, work?.model) : []
  const situation: ClaimSituation = {
    now,
    held: work === undefined ? 0 : 1,
    running: view.running ?? 0,
    hosts: view.hosts ?? 1,
    accounts: loadsOf(view, now),
    settling: view.accounts.some((account) => freeing(state, account, now)),
    pushed: work !== undefined && pushFor(state, work.wait, pushes) !== undefined,
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
): ReadonlyArray<{ readonly credit: ResetCredit; readonly kind: ResetKind; readonly spare: number; readonly expiresAt?: number }> =>
  (account.reading?.resets?.credits ?? [])
    .filter((credit) => inHand(credit, now))
    .flatMap((credit) => {
      const spare = spareOf(provider, account, credit, ratios)
      const kind = kindOf(provider, credit)
      return spare <= 0 ? [] : Array.from({ length: credit.count }, () => ({ credit, kind, spare, ...(credit.expiresAt === undefined ? {} : { expiresAt: credit.expiresAt }) }))
    })
    .toSorted((left, right) => (left.expiresAt ?? Number.POSITIVE_INFINITY) - (right.expiresAt ?? Number.POSITIVE_INFINITY))

/**
 * The spare an account's line is raised by this week: the best reset in hand,
 * or, when more of them expire before they can be spent one per week, every
 * one of those. Taken soonest to expire first, one per week from this one
 * (the next weeks begin at the weekly reset, then every 7 days); a reset that
 * expires before its week begins must go this week too, or it is lost.
 */
export const spareThisWeek = (
  provider: ResetProvider,
  account: AccountStatus,
  weekResetAt: number,
  now: number,
  ratios: Readonly<Record<string, Ratio>> = {},
): number => {
  const spares = sparesOf(provider, account, now, ratios)
  let slot = 0
  let due = 0
  for (const item of spares) {
    if (slot === 0) {
      due += item.spare
      slot = 1
      continue
    }
    if ((item.expiresAt ?? Number.POSITIVE_INFINITY) <= weekResetAt + (slot - 1) * 7 * DAY) due += item.spare
    else slot += 1
  }
  return Math.max(0, due, ...spares.map((item) => item.spare))
}

/**
 * Each account's line (pace.ts `PacePlan`): the spare its resets in hand give
 * back of a spent week (`spareThisWeek`: the best one, or more when more would
 * expire before they can be spent one per week), and, once a reset was claimed this week (the
 * claim went through and its reading after it names the week), where the line
 * starts again: the claim's time and the week's use after it.
 */
export const pacePlans = (
  provider: ResetProvider,
  accounts: ReadonlyArray<AccountStatus>,
  claims: ReadonlyArray<Claim>,
  now: number,
  ratios: Readonly<Record<string, Ratio>> = {},
): Readonly<Record<string, PacePlan>> => {
  const plans: Record<string, PacePlan> = {}
  for (const account of accounts) {
    const week = weekly(account)
    if (week?.resetAt === undefined) continue
    const spare = spareThisWeek(provider, account, week.resetAt, now, ratios)
    const claim = claims
      .filter(
        (claim) =>
          claim.provider === provider &&
          claim.credentialID === account.credentialID &&
          (claim.outcome === "reset" || claim.outcome === "already-redeemed") &&
          claim.at <= now &&
          claim.at > (week.resetAt ?? 0) - 7 * DAY,
      )
      .toSorted((left, right) => right.at - left.at)[0]
    const after = claim?.after?.find((window) => window.name === "7d")
    const plan: PacePlan = {
      ...(spare > 0 ? { spare } : {}),
      ...(claim !== undefined && after !== undefined ? { rebase: { at: claim.at, from: after.utilization } } : {}),
    }
    if (plan.spare !== undefined || plan.rebase !== undefined) plans[account.credentialID] = plan
  }
  return plans
}

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
  const wait = waiting(state, view.id, now)
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
  return [ClaimDue.make({ reset: { ...reset, yes: true, push: grant.id, buys: buysOf(best.option.gives) } })]
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

const review = (state: ResetsState, command: Review, now: number): ReadonlyArray<Event> => {
  const auto = command.auto !== false
  const pushes = command.pushes ?? []
  const current = new Set([...currentKeys(command.pools, now), ...pushKeys(state, command.pools, pushes, now)])
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
            ` ${left} ${plural(left, "reset")} left this week; ${Option.match(Option.fromUndefinedOr(reset.nextExpires), { onNone: () => "none expires", onSome: (at) => `next expires ${iso(at)}` })}.`,
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
 * holding the account; and any must still give back at least MIN_RESTORE of
 * a window, but a reset claimed in its last EXPIRING_MS: it is lost otherwise,
 * so it goes on anything it gives back. A claim for the forecast needs no
 * window holding the account: it goes before the account runs out.
 */
export const staleReason = (view: PoolView, account: AccountStatus, reset: Pick<Reset, "creditID" | "why" | "provider">, now: number): string | undefined => {
  const credit = usableCredits(account, now).find((item) => item.id === reset.creditID)
  if (credit === undefined) return "the reset is no longer listed as claimable"
  const lastDay = Option.exists(Option.fromUndefinedOr(credit.expiresAt), (at) => at - now <= EXPIRING_MS)
  const floor = Match.value(reset.why === "expiring" && lastDay).pipe(
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
    }
  },
  evolve: (state, event) => evolve(state, event),
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
    case "ClaimSettled":
      return {
        ...withStage(state, event.claim.key, event.stage, event.claim.at, {
          outcome: event.claim.outcome,
          ...(event.claim.message === undefined ? {} : { message: event.claim.message }),
        }),
        claims: [...state.claims, event.claim].slice(-MAX_CLAIMS),
      }
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
