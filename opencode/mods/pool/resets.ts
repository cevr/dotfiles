// Rate-limit resets: when the pool claims one, and when it asks the owner
// first. A Codex reset credit restarts the account's whole week, so the pool
// claims one on its own when every Codex account is held by a spent window
// and a start waits; a Claude grant clears the 5-hour window (and the model's
// own week) but does not move the weekly reset, so it is worth only the time
// left until that reset: the pool asks the owner, once per hold, with that
// value, and claims only on a yes.
//
// Each reset has a kind (quota.ts `ResetKind`) and gives back windows
// (`effectOf`): a Fable reset empties Fable's own week and takes Fable's part
// of the weekly use off the weekly window, whose reset stays. Two more rules:
//
// - Use it or lose it: a reset that would expire unused is claimed on its
//   own, Claude's too, once the window it gives back cannot reset by itself
//   before the reset expires: at once when that window is spent, else in the
//   reset's last day when the window is half used. A reset whose windows all
//   reset before it expires is left. The owner is told after (`OwnerTold`).
// - Demand: a reset gives use back but keeps the weekly reset date, so it is
//   worth most early in the week. When a start waits (the pool holds work),
//   an account has (nearly) spent a week-long window a reset gives back, and
//   at the account's burn this week the use given back would mostly be spent
//   before the window's natural reset, the owner is offered the reset, once
//   per account, kind and window period, withdrawn when no longer worth it.
//
// The Resets aggregate keeps, across every pool of the host, the newest start
// each pool's pace held (a latch asks again every two minutes, so a wait
// older than WAIT_MS has gone), each hold's reset as it is worked (asked,
// claiming, settled, declined, withdrawn) under the hold's key, and the
// claims made with what they did to the windows. A hold's key names the
// account and the reset of its spent window, so a claim or a question is made
// once per hold; the claim's request id comes from the key, so a claim sent
// again (a restart, a retry) is the same claim to the provider.
//
// `Review` is the decision: it reads every pool's accounts as the pool holds
// them now and records what is due. The model (model.ts) carries it out.
import { Effect, Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"
import { windowMs } from "./limits.ts"
import type { PacePlan } from "./pace.ts"
import { accountWide, ClaimOutcome, grantKind, QuotaWindow, type ResetCredit, ResetKind, scopeOf } from "./quota.ts"
import type { AccountStatus } from "./status.ts"

export { ClaimOutcome } from "./quota.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A held start older than this no longer waits: its latch would have asked again. */
export const WAIT_MS = 5 * MINUTE
/** A reset that expires within this is claimed rather than lost, once it gives back half a window it is the last chance for. */
export const EXPIRING_MS = DAY
/** The use given back at which an expiring reset is worth claiming before its last day ends. */
export const EXPIRING_WEEKLY_USE = 0.5
/** Below this much time to the weekly reset, a Claude reset is probably not worth it. */
export const NOT_WORTH_MS = DAY
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
/** A window used this much is spent, or about to be, for an offer. */
export const ABOUT_SPENT = 0.9
/** An offer gives back at least this much of a window. */
export const MIN_RESTORE = 0.1
/** An offer is made when at least this share of what it gives back would be used before the window resets by itself. */
export const WORTH_SHARE = 0.5
/** An offer is about a window at least this long: a week, not the 5-hour window, which a held start's question covers. */
const OFFER_WINDOW_MS = DAY

/** Whose resets a pool holds: Claude grants are asked about, Codex credits claimed. */
export const ResetProvider = Schema.Literals(["claude", "codex"])
export type ResetProvider = typeof ResetProvider.Type

/** A start the pace held: when, and the session that made the call, if the pace was told. */
export const Wait = Schema.Struct({ at: Schema.Number, sessionID: Schema.optionalKey(Schema.String) })
export type Wait = typeof Wait.Type

/** The outcomes worth sending the same claim again for, later. */
export const retryable = (outcome: ClaimOutcome): boolean =>
  outcome === "cooldown" || outcome === "rate-limited" || outcome === "unconfirmed" || outcome === "failed"

/**
 * Why a reset is worked: every account is held and a start waits, a credit is
 * about to expire unused, or demand makes it worth offering.
 */
export const ResetWhy = Schema.Literals(["held", "expiring", "offer"])
export type ResetWhy = typeof ResetWhy.Type

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
  /** The claim's idempotency key, from the hold's key. */
  requestID: Schema.String,
  why: ResetWhy,
  stage: Stage,
  /** When it entered its stage (epoch ms). */
  at: Schema.Number,
  /** Claims sent so far. */
  attempts: Schema.Number,
  /** The session asked in, and the question, for a Claude reset. */
  sessionID: Schema.optionalKey(Schema.String),
  question: Schema.optionalKey(Schema.String),
  /** The question's header, when not a held start's (`claudeHeader`). */
  header: Schema.optionalKey(Schema.String),
  outcome: Schema.optionalKey(ClaimOutcome),
  message: Schema.optionalKey(Schema.String),
  /** The reset's kind. */
  kind: Schema.optionalKey(ResetKind),
  /** What it gives back, as the owner reads it. */
  buys: Schema.optionalKey(Schema.String),
  /** What the owner was told after it was claimed on its own. */
  told: Schema.optionalKey(Schema.String),
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
 * The weekly use a model's own week took, estimated: the week's use times the
 * ratio (weekly points per own-week point). The ratio is the limit tally's,
 * when it has fitted the model on both windows (its 95% range from the fit's),
 * else the usage endpoint's allowance share (the own week's whole allowance as
 * a share of the weekly: exact if every own-week point costs the weekly the
 * same, which no reading has confirmed), else unread: none counted.
 */
export interface Share {
  readonly points: number
  readonly low: number
  readonly high: number
  readonly source: "tally" | "api" | "unread"
}

export const shareOf = (scoped: QuotaWindow, weekly: QuotaWindow | undefined, ratio: Ratio | undefined): Share => {
  const found: Ratio | undefined = ratio ?? (scoped.ofWeekly === undefined ? undefined : { rate: scoped.ofWeekly, source: "api" })
  const cap = weekly?.utilization ?? 0
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
    source: shares.every((share) => share.source === "unread") ? "unread" : shares.some((share) => share.source === "tally") ? "tally" : "api",
  }
  return [
    ...gives.filter((give) => give.window !== "7d"),
    { window: "7d", from: weekly.utilization, to: weekly.utilization - share.points, ...(weekly.resetAt === undefined ? {} : { resetAt: weekly.resetAt }), share },
  ]
}

const percent = (value: number) => `${Math.round(value * 100)}%`
const windowLabel = (name: string) => (name === "5h" ? "5h" : name === "7d" ? "weekly" : `${scopeOf(name) ?? name} week`)

const shareText = (share: Share) =>
  share.source === "unread"
    ? "Fable's part unread, none counted"
    : `Fable's part ${percent(share.points)}${share.low === share.high ? "" : ` (${percent(share.low)}–${percent(share.high)})`} by the ${share.source === "tally" ? "limit tally" : "usage endpoint's allowance share"}`

/** What a reset gives back, as the owner reads it: `5h 100% → 0%, Fable week 80% → 0%, weekly 45% → ~39% (Fable's part 6% (4%–8%) by the limit tally)`. */
export const buysOf = (gives: ReadonlyArray<Giveback>): string =>
  gives.length === 0
    ? "nothing the account reads"
    : gives
        .map((give) =>
          give.share === undefined
            ? `${windowLabel(give.window)} ${percent(give.from)} → ${percent(give.to)}`
            : `${windowLabel(give.window)} ${percent(give.from)} → ~${percent(give.to)} (${shareText(give.share)})`,
        )
        .join(", ")

/** The key of the hold `until` on an account. */
export const holdKey = (provider: ResetProvider, pool: string, credentialID: string, until: number) =>
  `${provider}:${pool}:${credentialID}:${Math.floor(until / KEY_BUCKET_MS)}`

/**
 * The key of a reset claimed before it expires: a Codex credit is one reset;
 * a Claude grant holds `count`, so each is its own claim.
 */
export const expiringKey = (pool: string, creditID: string, provider: ResetProvider = "codex", count = 1) =>
  provider === "codex" ? `codex-expiring:${pool}:${creditID}` : `claude-expiring:${pool}:${creditID}:${count}`

/** The key of an offer: once per account, kind and window period. */
export const offerKey = (provider: ResetProvider, pool: string, credentialID: string, kind: ResetKind, window: string, resetAt: number) =>
  `offer:${provider}:${pool}:${credentialID}:${kind}:${window}:${Math.floor(resetAt / KEY_BUCKET_MS)}`

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

// ── The question a Claude reset asks ──

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10)

/** A span as the owner reads it: days to one decimal from a day on, else hours. */
export const spanOf = (ms: number) => (ms >= DAY ? `${(ms / DAY).toFixed(1)} days` : `${Math.max(1, Math.round(ms / HOUR))} h`)

/** The question's choices; the first is the yes. */
export const CLAIM = "Claim it"
export const KEEP = "Don't claim"
/** What the pool does until an answer arrives. */
export const ASSUME = "Don't claim: the start waits for the window to reset"

/** Whether an answer to a Claude reset's question is a yes. */
export const isYes = (answer: string): boolean => {
  const said = answer.replace(/\s+/g, " ").trim().toLowerCase()
  return said === "claim it" || said === "claim" || said === "yes" || said === "y" || said.startsWith("claim it ") || said.startsWith("yes ")
}

/**
 * The question a Claude reset asks the owner: what it buys (the 5-hour window
 * back; the weekly window only when the grant clears it), the days left until
 * the account's natural weekly reset, which a claim does not move, and the
 * grant's end. Under a day to the weekly reset it says it is probably not worth it.
 */
export const claudeQuestion = (label: string, account: AccountStatus, credit: ResetCredit, now: number): string => {
  const spent = spentWindows(account, now).map((window) => window.name)
  const clears = credit.clears ?? []
  const week = weekly(account)
  const weekSpent = spent.includes("7d")
  const buys = weekSpent
    ? clears.includes("seven_day")
      ? "buys the 5h and weekly windows back"
      : `buys the 5h window back, but its weekly window is spent too and the grant clears ${clears.length === 0 ? "only the 5h window" : clears.join(", ")}, not seven_day: it may not lift the hold`
    : "buys the 5h window back"
  const left = week?.resetAt === undefined || week.resetAt <= now ? undefined : week.resetAt - now
  const remain = left === undefined ? "the weekly reset is unread" : `${spanOf(left)} remain before the weekly reset (${dayOf(now + left)})`
  const ends = credit.expiresAt === undefined ? "" : ` The grant ends ${dayOf(credit.expiresAt)}.`
  const worth = left !== undefined && left < NOT_WORTH_MS ? ` The weekly reset is ${spanOf(left)} away: probably not worth it.` : ""
  return `Claude reset on account ${label} now: ${buys} and ${remain}.${ends}${worth} Claim it?`
}

/** The question's header, at most 30 characters. */
export const claudeHeader = (label: string) => {
  const header = `Claude reset · ${label}`
  return header.length <= 30 ? header : `${header.slice(0, 29)}…`
}

// ── Commands and events ──

/** One pool as the review reads it: whose resets it holds, its accounts now, and each account's label. */
export interface PoolView {
  readonly id: string
  readonly provider: ResetProvider
  readonly accounts: ReadonlyArray<AccountStatus>
  readonly labels: Readonly<Record<string, string>>
  /** Points of the weekly window per point of a model's own week, by that window's name (`7d:Fable`); `weeklyRatios`. */
  readonly ratios?: Readonly<Record<string, Ratio>>
  /** The starts of the pool's provider in flight across the fleet (this host's and its peers'), not settled into a reading yet. */
  readonly inflight?: number
}

/** A start on the pool was held by its pace, from the session `sessionID` when the pace was told. */
export const NoteWait = Schema.TaggedStruct("NoteWait", { pool: Schema.String, sessionID: Schema.optionalKey(Schema.String) })
export interface NoteWait extends Schema.Schema.Type<typeof NoteWait> {}

/** Decide what is due, on every pool's accounts as the pool holds them now. */
export interface Review {
  readonly _tag: "Review"
  readonly pools: ReadonlyArray<PoolView>
}
export const Review = { make: (input: { readonly pools: ReadonlyArray<PoolView> }): Review => ({ _tag: "Review", ...input }) }

/** The owner answered a reset's question (`undefined`: the question went without an answer, dismissed). */
export const TakeAnswer = Schema.TaggedStruct("TakeAnswer", { key: Schema.String, answer: Schema.optionalKey(Schema.String) })
export interface TakeAnswer extends Schema.Schema.Type<typeof TakeAnswer> {}

/** A claim came back, with the account's windows before it and as read again after it. */
export const SettleClaim = Schema.TaggedStruct("SettleClaim", {
  key: Schema.String,
  outcome: ClaimOutcome,
  message: Schema.optionalKey(Schema.String),
  before: Schema.Array(QuotaWindow),
  after: Schema.optionalKey(Schema.Array(QuotaWindow)),
})
export interface SettleClaim extends Schema.Schema.Type<typeof SettleClaim> {}

export type Command = NoteWait | Review | TakeAnswer | SettleClaim

export const WaitNoted = Schema.TaggedStruct("WaitNoted", { pool: Schema.String, wait: Wait })
export interface WaitNoted extends Schema.Schema.Type<typeof WaitNoted> {}

/** A claim is due: the model sends it. */
export const ClaimDue = Schema.TaggedStruct("ClaimDue", { reset: Reset })
export interface ClaimDue extends Schema.Schema.Type<typeof ClaimDue> {}

/** The owner is asked whether to claim: the model asks in the reset's session. */
export const OwnerAsked = Schema.TaggedStruct("OwnerAsked", { reset: Reset })
export interface OwnerAsked extends Schema.Schema.Type<typeof OwnerAsked> {}

/** The owner said no (or dismissed the question): no claim for this hold. */
export const AnswerDeclined = Schema.TaggedStruct("AnswerDeclined", { key: Schema.String, at: Schema.Number })
export interface AnswerDeclined extends Schema.Schema.Type<typeof AnswerDeclined> {}

/** The question is no longer worth an answer: the model withdraws it. */
export const AskWithdrawn = Schema.TaggedStruct("AskWithdrawn", { key: Schema.String, at: Schema.Number, why: Schema.String })
export interface AskWithdrawn extends Schema.Schema.Type<typeof AskWithdrawn> {}

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

export type Event = WaitNoted | ClaimDue | OwnerAsked | AnswerDeclined | AskWithdrawn | ClaimSettled | ResetsForgotten | OwnerTold

// ── Review ──

/** The newest held start of the pool, while it still waits. */
const waiting = (state: ResetsState, pool: string, now: number): Wait | undefined => {
  const wait = state.waits[pool]
  return wait !== undefined && now - wait.at < WAIT_MS ? wait : undefined
}

/** Whether every account the pool can use is held by a spent window; false for a pool with none. */
const allSpent = (accounts: ReadonlyArray<AccountStatus>, now: number) =>
  accounts.length > 0 && accounts.every((account) => spentUntil(account, now) !== undefined)

/** Whether a reset is still being worked: asked, claiming, or failed with tries left while its hold lasts. */
const active = (reset: Reset, current: ReadonlySet<string>, now: number) =>
  reset.stage === "asked" ||
  (reset.stage === "claiming" && now - reset.at < RETRY_MS) ||
  retries(reset, current)

/**
 * Whether a claim goes again, the same claim, while its hold lasts and it
 * has tries left: one that did not go through, or one sent that never came
 * back (a stop mid-claim) once RETRY_MS has passed.
 */
const retries = (reset: Reset, current: ReadonlySet<string>) =>
  (reset.stage === "failed" || reset.stage === "claiming") && reset.attempts < MAX_ATTEMPTS && current.has(reset.key)

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
  requestID: requestIdOf(key),
  why,
  stage,
  at: now,
  attempts: 0,
  kind: kindOf(view.provider, credit),
})

/**
 * Whether a reset's hold (or its reason) is still current: its key is among
 * the keys the pools give now: each hold, each usable credit's expiring key,
 * and each offer still worth making.
 */
const currentKeys = (pools: ReadonlyArray<PoolView>, now: number): ReadonlySet<string> =>
  new Set(
    pools.flatMap((view) => [
      ...view.accounts.flatMap((account) => {
        const until = spentUntil(account, now)
        const held = until === undefined ? [] : [holdKey(view.provider, view.id, account.credentialID, until)]
        const expiring = usableCredits(account, now).map((credit) => expiringKey(view.id, credit.id, view.provider, credit.count))
        return [...held, ...expiring]
      }),
      ...view.accounts.flatMap((account) =>
        usableCredits(account, now).flatMap((credit) => {
          const offer = offerOf(view, account, credit, now)
          return offer === undefined ? [] : [offer.key]
        }),
      ),
    ]),
  )

/** The Codex claim due in a pool: one credit when every account is held and a start waits (an expiring one is `expiringDue`'s). */
const codexDue = (
  state: ResetsState,
  view: PoolView,
  pools: ReadonlyArray<PoolView>,
  current: ReadonlySet<string>,
  now: number,
): ReadonlyArray<Event> => {
  const events: Array<Event> = []
  const busy = Object.values(state.resets).some((reset) => reset.pool === view.id && reset.why === "held" && active(reset, current, now))
  const claudeHeld = pools.some((other) => other.provider === "claude" && allSpent(other.accounts, now) && waiting(state, other.id, now) !== undefined)
  if (!busy && allSpent(view.accounts, now) && (waiting(state, view.id, now) !== undefined || claudeHeld)) {
    const candidates = view.accounts.flatMap((account) => {
      const until = spentUntil(account, now)
      const credit = usableCredits(account, now)[0]
      if (until === undefined || credit === undefined) return []
      const key = holdKey("codex", view.id, account.credentialID, until)
      return state.resets[key] === undefined ? [{ account, credit, key }] : []
    })
    const soonest = candidates.toSorted(
      (left, right) => (left.credit.expiresAt ?? Number.POSITIVE_INFINITY) - (right.credit.expiresAt ?? Number.POSITIVE_INFINITY),
    )[0]
    if (soonest !== undefined) events.push(ClaimDue.make({ reset: resetOf(view, soonest.account, soonest.credit, soonest.key, "held", "claiming", now) }))
  }
  return events
}

// ── Use it or lose it ──

/**
 * The windows `credit` gives back that cannot reset by themselves before it
 * expires: the ones it is the last chance for. None for a reset that never
 * expires.
 */
const lastChance = (view: PoolView, account: AccountStatus, credit: ResetCredit): ReadonlyArray<Giveback> => {
  const expiresAt = credit.expiresAt
  if (expiresAt === undefined) return []
  return effectOf(view.provider, account, credit, view.ratios).filter((give) => give.resetAt === undefined || give.resetAt > expiresAt)
}

/**
 * Whether a usable reset is due now so it is not lost: a window it is the
 * last chance for is spent (now is when it buys most), or the reset has a day
 * left and gives back at least half of such a window. A reset whose windows
 * all reset before it expires is left: it is not lost yet.
 */
export const expiringDueNow = (view: PoolView, account: AccountStatus, credit: ResetCredit, now: number): boolean => {
  if (!credit.usable || credit.count <= 0 || credit.expiresAt === undefined || credit.expiresAt <= now) return false
  const last = lastChance(view, account, credit)
  return last.some((give) => give.from >= 1) || (credit.expiresAt - now <= EXPIRING_MS && last.some((give) => give.from - give.to >= EXPIRING_WEEKLY_USE))
}

/** Each pool's resets due so they are not lost, one per credit. */
const expiringDue = (state: ResetsState, pools: ReadonlyArray<PoolView>, now: number): ReadonlyArray<ClaimDue> =>
  pools.flatMap((view) => {
    const claimed = new Set<string>()
    return view.accounts.flatMap((account) =>
      usableCredits(account, now).flatMap((credit) => {
        if (claimed.has(credit.id) || !expiringDueNow(view, account, credit, now)) return []
        const key = expiringKey(view.id, credit.id, view.provider, credit.count)
        if (state.resets[key] !== undefined) return []
        claimed.add(credit.id)
        const reset = resetOf(view, account, credit, key, "expiring", "claiming", now)
        return [ClaimDue.make({ reset: { ...reset, buys: buysOf(effectOf(view.provider, account, credit, view.ratios)) } })]
      }),
    )
  })

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

/**
 * Each account's line (pace.ts `PacePlan`): the spare its best reset in hand
 * gives back of a spent week, and, once a reset was claimed this week (the
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
    const spare = Math.max(0, ...(account.reading?.resets?.credits ?? []).filter((credit) => inHand(credit, now)).map((credit) => spareOf(provider, account, credit, ratios)))
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

// ── Demand ──

/** A window's length in the pool's names (`7d:Fable` is a week). */
const lengthOf = (name: string): number | undefined => windowMs(name)

/** An offer worth making: the reset, what it gives back, and the window it is worth most on. */
export interface Offer {
  readonly account: AccountStatus
  readonly credit: ResetCredit
  readonly kind: ResetKind
  readonly gives: ReadonlyArray<Giveback>
  /** The window it is offered for: its use given back, the time left before it resets by itself, and the use expected of it by then. */
  readonly window: string
  readonly resetAt: number
  readonly restored: number
  readonly left: number
  readonly elapsed: number
  readonly expected: number
  readonly key: string
}

/**
 * The offer `credit` makes on `account` now, demand aside: it gives back at
 * least MIN_RESTORE of a week-long window the account has (nearly) spent, no
 * spent window it leaves keeps holding the account, and at the account's burn
 * on that window this period (its use over the time since it began) at least
 * WORTH_SHARE of the use given back would be spent before the window resets
 * by itself. Early in the week the burn has days to spend it; late, little.
 */
export const offerOf = (view: PoolView, account: AccountStatus, credit: ResetCredit, now: number): Offer | undefined => {
  if (!credit.usable || credit.count <= 0) return undefined
  const gives = effectOf(view.provider, account, credit, view.ratios)
  const given = new Map(gives.map((give) => [give.window, give]))
  const stays = (account.reading?.windows ?? []).some(
    (window) => accountWide(window) && window.utilization >= 1 && (window.resetAt ?? 0) > now && (given.get(window.name)?.to ?? 1) >= 1,
  )
  if (stays) return undefined
  const kind = kindOf(view.provider, credit)
  const candidates = gives.flatMap((give) => {
    const length = lengthOf(give.window)
    if (length === undefined || length < OFFER_WINDOW_MS || give.resetAt === undefined || give.resetAt <= now) return []
    const restored = give.from - give.to
    if (give.from < ABOUT_SPENT || restored < MIN_RESTORE) return []
    const left = give.resetAt - now
    const elapsed = Math.max(length - left, MINUTE)
    const expected = Math.min(restored, (give.from / elapsed) * left)
    if (expected < WORTH_SHARE * restored) return []
    const key = offerKey(view.provider, view.id, account.credentialID, kind, give.window, give.resetAt)
    return [{ account, credit, kind, gives, window: give.window, resetAt: give.resetAt, restored, left, elapsed, expected, key }]
  })
  return candidates.toSorted((left, right) => right.expected - left.expected)[0]
}

/** Every offer worth making in a pool now, demand aside, the best per account. */
const offersOf = (view: PoolView, now: number): ReadonlyArray<Offer> =>
  view.accounts.flatMap((account) => {
    const offers = usableCredits(account, now).flatMap((credit) => {
      const offer = offerOf(view, account, credit, now)
      return offer === undefined ? [] : [offer]
    })
    return offers.toSorted((left, right) => right.expected - left.expected).slice(0, 1)
  })

const windowNoun = (name: string) => (name === "5h" ? "5-hour window" : name === "7d" ? "weekly window" : `${scopeOf(name) ?? name} week`)

/** The offer's question: the demand seen, what it gives back, the days left, the use expected before the natural reset, and its expiry. */
export const offerQuestion = (label: string, offer: Offer, inflight: number): string => {
  const demand = `a start is held${inflight > 0 ? ` and ${inflight} more ${inflight === 1 ? "is" : "are"} in flight across the fleet` : ""}`
  const ends = offer.credit.expiresAt === undefined ? "" : ` The reset expires ${dayOf(offer.credit.expiresAt)}.`
  return (
    `${KIND_LABEL[offer.kind]} on account ${label} now? Demand: ${demand}. It gives back ${buysOf(offer.gives)}. ` +
    `${spanOf(offer.left)} remain before the ${windowNoun(offer.window)} resets by itself (${dayOf(offer.resetAt)}), which a claim does not move; ` +
    `at its burn this period (${percent(offer.gives.find((give) => give.window === offer.window)?.from ?? 0)} in ${spanOf(offer.elapsed)}) ` +
    `~${percent(offer.expected)} of the ${percent(offer.restored)} given back would be used by then.${ends} Claim it?`
  )
}

/** The offer's header, at most 30 characters. */
export const offerHeader = (label: string) => {
  const header = `Reset now · ${label}`
  return header.length <= 30 ? header : `${header.slice(0, 29)}…`
}

/** What the pool does with an offer until an answer arrives. */
export const OFFER_ASSUME = "Don't claim: the pace holds starts until the window resets"

/**
 * The offer due in a pool: while a start waits from a session and no
 * question of the pool is open, the best offer not made before for its
 * account, kind and window period.
 */
const offerDue = (state: ResetsState, view: PoolView, now: number, busy: ReadonlySet<string>): ReadonlyArray<Event> => {
  const wait = waiting(state, view.id, now)
  if (wait?.sessionID === undefined) return []
  if (Object.values(state.resets).some((reset) => reset.pool === view.id && reset.stage === "asked")) return []
  const best = offersOf(view, now)
    .filter((offer) => state.resets[offer.key] === undefined && !busy.has(offer.credit.id))
    .toSorted((left, right) => right.expected - left.expected)[0]
  if (best === undefined) return []
  const reset = resetOf(view, best.account, best.credit, best.key, "offer", "asked", now)
  return [
    OwnerAsked.make({
      reset: {
        ...reset,
        sessionID: wait.sessionID,
        question: offerQuestion(reset.label, best, view.inflight ?? 0),
        header: offerHeader(reset.label),
        buys: buysOf(best.gives),
      },
    }),
  ]
}

/**
 * The Claude question due in a pool: when every account is held by a spent
 * window and a start waits from a session, one question, about the account
 * whose claim buys the most: one held by its 5-hour window alone before one
 * whose week is spent too, then the most time left before its weekly reset.
 * None while one is open, and never twice for one hold.
 */
const claudeDue = (state: ResetsState, view: PoolView, current: ReadonlySet<string>, now: number): ReadonlyArray<Event> => {
  const wait = waiting(state, view.id, now)
  if (wait?.sessionID === undefined || !allSpent(view.accounts, now)) return []
  if (Object.values(state.resets).some((reset) => reset.pool === view.id && active(reset, current, now))) return []
  const candidates = view.accounts.flatMap((account) => {
    const until = spentUntil(account, now)
    const credit = usableCredits(account, now)[0]
    if (until === undefined || credit === undefined) return []
    const key = holdKey("claude", view.id, account.credentialID, until)
    if (state.resets[key] !== undefined) return []
    const weekSpent = spentWindows(account, now).some((window) => window.name === "7d")
    const left = (weekly(account)?.resetAt ?? now) - now
    return [{ account, credit, key, weekSpent, left }]
  })
  const best = candidates.toSorted((left, right) => Number(left.weekSpent) - Number(right.weekSpent) || right.left - left.left)[0]
  if (best === undefined) return []
  const reset = resetOf(view, best.account, best.credit, best.key, "held", "asked", now)
  return [OwnerAsked.make({ reset: { ...reset, sessionID: wait.sessionID, question: claudeQuestion(reset.label, best.account, best.credit, now) } })]
}

const review = (state: ResetsState, command: Review, now: number): ReadonlyArray<Event> => {
  const current = currentKeys(command.pools, now)
  const events: Array<Event> = []
  // A question whose hold lifted by itself, or whose grant is gone, is withdrawn first.
  const credits = new Set(
    command.pools.flatMap((view) => view.accounts.flatMap((account) => usableCredits(account, now).map((credit) => `${view.id}:${account.credentialID}:${credit.id}`))),
  )
  const withdrawn = new Set<string>()
  for (const reset of Object.values(state.resets)) {
    if (reset.stage !== "asked") continue
    const why = !credits.has(`${reset.pool}:${reset.credentialID}:${reset.creditID}`)
      ? "the grant can no longer be claimed"
      : !current.has(reset.key)
        ? reset.why === "offer"
          ? "no longer worth it"
          : "the hold lifted"
        : undefined
    if (why === undefined) continue
    withdrawn.add(reset.key)
    events.push(AskWithdrawn.make({ key: reset.key, at: now, why }))
  }
  const after = { ...state, resets: Object.fromEntries(Object.entries(state.resets).filter(([key]) => !withdrawn.has(key))) }
  // A claim that did not go through goes again, the same claim, while its hold lasts.
  for (const reset of Object.values(state.resets)) {
    if (retries(reset, current) && now - reset.at >= RETRY_MS)
      events.push(ClaimDue.make({ reset: { ...reset, stage: "claiming", at: now } }))
  }
  // A reset about to be lost is claimed first; the rules after it leave its credit alone.
  const expiring = expiringDue(after, command.pools, now)
  events.push(...expiring)
  const busy = new Set(expiring.map((event) => event.reset.creditID))
  for (const view of command.pools) {
    const due = (view.provider === "codex" ? codexDue(after, view, command.pools, current, now) : claudeDue(after, view, current, now)).filter(
      (event) => !(event._tag === "ClaimDue" || event._tag === "OwnerAsked") || !busy.has(event.reset.creditID),
    )
    events.push(...due)
    // One question per pool at a time: an offer waits while a held start's question is asked.
    if (due.some((event) => event._tag === "OwnerAsked")) continue
    for (const event of due) if (event._tag === "ClaimDue") busy.add(event.reset.creditID)
    events.push(...offerDue(after, view, now, busy))
  }
  const stale = Object.values(state.resets).flatMap((reset) =>
    reset.stage !== "asked" && reset.stage !== "claiming" && !current.has(reset.key) && now - reset.at >= KEEP_MS ? [reset.key] : [],
  )
  if (stale.length > 0) events.push(ResetsForgotten.make({ keys: stale }))
  return events
}

// ── The answer and the settling ──

const takeAnswer = (state: ResetsState, command: TakeAnswer, now: number): ReadonlyArray<Event> => {
  const reset = state.resets[command.key]
  if (reset === undefined || reset.stage !== "asked") return []
  return command.answer !== undefined && isYes(command.answer)
    ? [ClaimDue.make({ reset: { ...reset, stage: "claiming", at: now } })]
    : [AnswerDeclined.make({ key: command.key, at: now })]
}

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
  }
  const settled = ClaimSettled.make({ claim, stage: retryable(command.outcome) ? "failed" : "settled" })
  if (reset.why !== "expiring" || (command.outcome !== "reset" && command.outcome !== "already-redeemed")) return [settled]
  // Claimed on its own so it was not lost: the owner is told after, in the session that waited last.
  const newest = Object.values(state.waits)
    .filter((wait) => wait.sessionID !== undefined)
    .toSorted((left, right) => right.at - left.at)[0]
  const kind = reset.kind === undefined ? "reset" : KIND_LABEL[reset.kind]
  const text = `The pool claimed the ${kind} on account ${reset.label} before it expired unused${reset.buys === undefined ? "" : `: it gave back ${reset.buys}`}.`
  return [settled, OwnerTold.make({ key: reset.key, at: now, text, ...(newest?.sessionID === undefined ? {} : { sessionID: newest.sessionID }) })]
}

export const Resets: Decider<ResetsState, Command, Event> = {
  initial: empty,
  decide: (state, command, now) => {
    switch (command._tag) {
      case "NoteWait":
        return Effect.succeed([WaitNoted.make({ pool: command.pool, wait: { at: now, ...(command.sessionID === undefined ? {} : { sessionID: command.sessionID }) } })])
      case "Review":
        return Effect.succeed(review(state, command, now))
      case "TakeAnswer":
        return Effect.succeed(takeAnswer(state, command, now))
      case "SettleClaim":
        return Effect.succeed(settleClaim(state, command, now))
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
    case "OwnerAsked":
      return { ...state, resets: { ...state.resets, [event.reset.key]: event.reset } }
    case "AnswerDeclined":
      return withStage(state, event.key, "declined", event.at)
    case "AskWithdrawn":
      return withStage(state, event.key, "withdrawn", event.at, { message: event.why })
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
  }
}
