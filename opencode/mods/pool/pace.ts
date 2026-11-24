// Quota-space admission, across every harness spending these accounts. The
// shared Claude budget scans Claude transcripts only, so its calibrated
// cost/agent estimates exclude OpenCode. Here 99% of the weekly allowance is
// spent evenly, with 5 percentage points of leeway. No tokens or USD are
// mistaken for provider quota. This is less predictive than the shared queue.
// A held start latches until retryAt (orchestrate's latch, a wake of its
// parent's), and is decided again then; nothing grants a stale slot.
//
// A reading lags the agents just admitted, on this host and on the others of
// the fleet (fleet.ts): each start that has not settled yet is charged a fixed
// share of one account's week until it has, so a wave on one host holds the
// next start on any host before the readings show it.
import { Array as Arr, DateTime, Match, Option, Schema } from "effect"
import { formatNotificationTime } from "@dotfiles/decider/notification-time"
import type { RequestKind } from "./accounts.ts"
import { futureRetryAt, holdRecheckAt, pendingRecoveryAt, type FutureRetryAt } from "./hold.ts"
import { DEFINED_MODEL_WINDOWS, limitsModel, SCOPE_REPORT_SAMPLES, scopeOf } from "./quota.ts"
import type { AccountStatus } from "./status.ts"
import { byCount, holdsAt, signInReason, tryAgainAt, used } from "./usage-text.ts"

/** A share to a tenth of a percent: `0.567` → `56.7%`. */
const tenth = (share: number) => `${(100 * share).toFixed(1)}%`

const WEEK = 7 * 86400000
const FIVE_HOURS = 5 * 3_600_000
/** The share of a week the spend-evenly line reaches by its reset; a weekly window used this much has no room. */
export const TARGET = 0.99
/** A 5-hour window used this much has no room for a new start. */
export const SHORT_5H = 0.9
const LEEWAY = 0.05
/** How far past a window's natural length a reset may read (a header's reset is rounded to the second). */
const RESET_SLACK_MS = 60_000

/** A weekly window's reset, when it is one a week now can have: after now, and no more than a week ahead. */
const validWeekReset = (window: { readonly resetAt?: number }, now: number): Option.Option<number> =>
  Option.filter(Option.fromUndefinedOr(window.resetAt), (resetAt) => resetAt > now && resetAt <= now + WEEK + RESET_SLACK_MS)

/** The account's last reading, including any older carried windows. */
const windowsOf = (account: AccountStatus) =>
  Option.match(Option.fromUndefinedOr(account.reading), { onNone: () => [], onSome: (reading) => reading.windows })
/** A window of an account's reading, by name. */
const windowOf = (account: AccountStatus, name: string) => Arr.findFirst(windowsOf(account), (w) => w.name === name)

/** The account-wide week of an account's reading. */
const weekOf = (account: AccountStatus) => windowOf(account, "7d")

/**
 * What room admits a start or a request: `ordinary`, the even line with its
 * leeway; `backed`, past that line but within one a reset the pool claimed and
 * a fresh reading after it observed (`PacePlan.rebase`); `held`, neither.
 */
export const Admission = Schema.Literals(["ordinary", "backed", "held"])
export type Admission = typeof Admission.Type

/** Total remedy order, from getting a trustworthy pool/candidate to spending its room. */
export const HoldReason = Schema.Literals([
  "store-unavailable", "logins-unavailable", "usage-unread", "model-unreported", "record-unreadable", "account-held", "model-limit", "quota-limit",
  "even-line", "reset-room", "auxiliary", "placement-changed",
])
export type HoldReason = typeof HoldReason.Type

/** The pace method's answer: whether a new agent may start now, and if not, when to ask again. */
export const NoPoolLogin = Schema.Literal("not-tracked-no-pool-login")
const paceFields = {
  measured: Schema.Boolean,
  reason: Schema.String,
  tracking: Schema.optionalKey(NoPoolLogin),
  /** A hold of the spend-evenly target only: the accounts still have quota. */
  soft: Schema.optionalKey(Schema.Boolean),
  /** What room the answer rests on, when measured. An older pool answers none: read it as `ok`'s. */
  admission: Schema.optionalKey(Admission),
  /**
   * A dispatch's answer (`dispatch`), when measured: the logins a request of the model may go out on now
   * (`eligibleFor`). A send outside the host's hooks (the cache's keepalive) goes out only on one of these.
   */
  eligible: Schema.optionalKey(Schema.Array(Schema.String)),
}
export const Pace = Schema.Union([
  Schema.Struct({ ...paceFields, ok: Schema.Literal(true), retryAt: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ ...paceFields, ok: Schema.Literal(false), retryAt: Schema.Finite, reasonCode: HoldReason, signIn: Schema.optionalKey(Schema.Array(Schema.String)) }),
])
export type WirePace = typeof Pace.Type
type HeldPace = Omit<Extract<WirePace, { readonly ok: false }>, "retryAt"> & { readonly retryAt: FutureRetryAt }
export type Pace = Extract<WirePace, { readonly ok: true }> | HeldPace

export const storeHeld = (retryAt: number, now: number): HeldPace => ({
  ok: false, measured: false, admission: "held", eligible: [], reasonCode: "store-unavailable",
  reason: "the pool could not confirm its current holds; retry the hold store read", retryAt: nextRetryAt(now, [retryAt]),
})

/** A sign-in is an account prerequisite, not a quota deadline; its date only schedules a recheck. */
export const needsSignIn = (account: AccountStatus): boolean =>
  account.hold?.kind === "signin" || account.reading?.refusal?.kind === "signin"

const unreadableAt = (accounts: ReadonlyArray<AccountStatus>) => accounts.flatMap(({ hold }) => {
  const damaged = Option.filter(Option.fromUndefinedOr(hold), (entry) => entry.kind === "record-unreadable")
  if (Option.isNone(damaged)) return []
  return [holdRecheckAt(damaged.value)]
})
const unreadablePace = (now: number, times: ReadonlyArray<number>): HeldPace => ({
  ok: false, measured: false, admission: "held", eligible: [], reasonCode: "record-unreadable",
  reason: "a login's hold record is unreadable; the pool checks fresh authenticated usage after its recheck time",
  retryAt: nextRetryAt(now, times),
})

const fromAccountHolds = (accounts: ReadonlyArray<AccountStatus>, now: number, required: ReadonlyArray<string> = []): Option.Option<HeldPace> => {
  if (accounts.length === 0) return Option.none()
  const signIn = accounts.values().filter((a) => a.hold?.kind !== "record-unreadable" && needsSignIn(a)).map((a) => a.credentialID).toArray().sort()
  if (signIn.length === accounts.length) return Option.some({
    ok: false, measured: false, admission: "held", eligible: [], reasonCode: "account-held", signIn,
    reason: `${signInReason(signIn)}; time alone will not clear this hold`,
    retryAt: nextRetryAt(now, []),
  })
  const ends: Array<number> = []
  const unreadable = unreadableAt(accounts)
  for (const account of accounts) {
    if (account.hold?.kind === "record-unreadable") continue
    if (needsSignIn(account) || Option.isSome(unreportedScope(account, required))) continue
    const hold = liveHold(account, now)
    if (Option.isSome(hold)) ends.push(hold.value.until)
  }
  if (ends.length + unreadable.length + signIn.length !== accounts.length) return Option.none()
  if (unreadable.length > 0 && Math.min(...unreadable) <= Math.min(...ends)) return Option.some(unreadablePace(now, unreadable))
  return Option.some({
    ok: false, measured: true, admission: "held", eligible: [], reasonCode: "account-held", signIn: [],
    reason: "all pool accounts are held", retryAt: nextRetryAt(now, ends),
  })
}

/**
 * Compare viable paths back, not just the most severe fault on any login.
 * A readable alternative makes sign-in or a model change unnecessary.
 * Among the remaining remedies use the closed order above; a stable deadline
 * breaks ties, never the ordering of the accounts in the provider response.
 */
const selectHold = (primary: HeldPace, alternatives: ReadonlyArray<HeldPace>): HeldPace => {
  const actionOnly = (held: HeldPace) =>
    held.reasonCode === "model-unreported" || held.reasonCode === "logins-unavailable" ||
    Option.exists(Option.fromUndefinedOr(held.signIn), (ids) => ids.length > 0)
  const choices = [primary, ...alternatives]
  const timed = choices.filter((choice) => !actionOnly(choice))
  const order = HoldReason.literals
  return Arr.match(timed, { onEmpty: () => choices, onNonEmpty: (some) => some })
    .reduce((best, next) => {
      const prior = order.indexOf(best.reasonCode)
      const candidate = order.indexOf(next.reasonCode)
      if (candidate < prior || (candidate === prior && next.retryAt < best.retryAt)) return next
      return best
    })
}

/**
 * A model request the pool's pace holds at its dispatch: no credential is set
 * and nothing goes out. The same answer a start of the model would get now
 * (`poolPace`), its reason and when to ask again; the reset review was told of
 * the held work, so a reset that relieves it is claimed meanwhile.
 */
export class RequestHeld extends Schema.TaggedError<RequestHeld>()("RequestHeld", {
  sessionID: Schema.String,
  reason: Schema.String,
  reasonCode: HoldReason,
  retryAt: Schema.Finite,
}) {}

/** The turn's end a held request names: the pace's words, and when it asks again. */
export const requestHeldMessage = (held: RequestHeld): string => {
  const prefix = `dotfiles-opencode.pool: the request is held: ${held.reason}`
  if (held.reasonCode === "model-unreported") return `${prefix} After switching, ${tryAgainAt(held.retryAt)} (next usage refresh).`
  return `${prefix}; ${tryAgainAt(held.retryAt)}`
}

/** The answer for a provider the pool does not hold. */
export const UNPOOLED: Pace = { ok: true, measured: false, reason: "provider is not pooled" }

/**
 * The agents admitted in the fleet whose spend may not show in a reading yet:
 * when each started (epoch ms), what each is charged (a share of one account's
 * week, 0 to 1) and how long until a start has settled into the readings.
 */
export interface Inflight {
  readonly starts: ReadonlyArray<number>
  readonly cost: number
  readonly settleMs: number
}

export const NO_INFLIGHT: Inflight = { starts: [], cost: 0, settleMs: 0 }

/**
 * Until when an account cannot take a start of `model`: its hold, and, for a
 * model with a window of its own on the account (`7d:Fable` for
 * `claude-fable-5-2`), that window while it is spent. None when it can.
 */
const blockedUntil = (account: AccountStatus, now: number, model: string | undefined): number | undefined => {
  const untils = [
    ...Option.toArray(Option.map(liveHold(account, now), (hold) => hold.until)),
    ...spentOwn(account, now, model).map((w) => w.resetAt),
  ]
  return untils.length ? Math.max(...untils) : undefined
}

/** The windows of `model`'s own on an account (`7d:Fable`) that are spent now, by name, with when each resets. */
const spentOwn = (account: AccountStatus, now: number, model?: string): ReadonlyArray<{ readonly name: string; readonly resetAt: number }> =>
  model === undefined
    ? []
    : (account.reading?.windows ?? []).flatMap((w) => {
        const scope = scopeOf(w.name)
        return scope !== undefined && limitsModel(scope, model) && w.utilization >= 1 && w.resetAt !== undefined && w.resetAt > now
          ? [{ name: w.name, resetAt: w.resetAt }]
          : []
      })

/**
 * What a reset the pool claimed did to an account's spend-evenly line
 * (resets.ts `pacePlans`). A reset in hand moves nothing: it is room only once
 * claimed, sent once under the fleet's lease, and a fresh reading after it
 * observed the week lower than before. Once one was claimed at `rebase.at`,
 * leaving the week at `rebase.from`, the line starts again there and spends
 * the rest evenly to the weekly reset.
 */
export interface PacePlan {
  readonly rebase?: {
    readonly at: number
    readonly from: number
    /** The claim whose room it is (`Spend.claim`). */
    readonly key?: string
    /** The share of the week reserved on that room by requests admitted on it (resets.ts `Spend`). */
    readonly spent?: number
  }
}

/**
 * The share of its week an account has used as far as the pace may know: the
 * reading's, plus, on a claim's room, every request admitted on that room
 * (`spent`) that the reading does not yet show: only the week's rise since
 * the claim's observation covers them. A reading that lags the requests sent
 * never gives their reservation back; one that shows the week risen past them
 * has covered them; one lower than the observation (more given back since)
 * covers none.
 */
export const usedOf = (reading: number, plan?: PacePlan): number =>
  Option.match(Option.fromUndefinedOr(plan?.rebase), {
    onNone: () => reading,
    onSome: (rebase) => reading + Math.max(0, (rebase.spent ?? 0) - Math.max(0, reading - rebase.from)),
  })

/** An account's spend-evenly line now: the share of its week it may have used. */
export const lineOf = (resetAt: number, now: number, plan: PacePlan | undefined): number => {
  const left = (resetAt - now) / WEEK
  const rebase = plan?.rebase
  const base =
    rebase !== undefined && rebase.at <= now && rebase.at > resetAt - WEEK && resetAt > rebase.at
      ? rebase.from + (TARGET - rebase.from) * ((now - rebase.at) / (resetAt - rebase.at))
      : TARGET * (1 - left)
  return base + LEEWAY
}

/**
 * The accounts that can take a start or a request of `model` now: not held,
 * no window of the model's own spent, the 5-hour window under SHORT_5H and the
 * week under TARGET. Placement chooses among these alone, the cache's account
 * too, so the pace and the request boundary read one rule.
 */
export const eligibleFor = (accounts: ReadonlyArray<AccountStatus>, now: number, model?: string): ReadonlyArray<AccountStatus> =>
  accounts.filter((a) => Option.isNone(Option.fromUndefinedOr(blockedUntil(a, now, model))) && Option.isNone(shortUntil(a, now)))

/** Whether a window holds a start at its hold line: the 5-hour at SHORT_5H, the week at TARGET. */
const atHoldLine = (w: { readonly name: string; readonly utilization: number }) =>
  (w.name === "5h" && w.utilization >= SHORT_5H) || (w.name === "7d" && w.utilization >= TARGET)

/** Until when an account's 5-hour or weekly window holds a start at its hold line; none when neither does. */
const shortUntil = (account: AccountStatus, now: number): Option.Option<number> => {
  const resets = windowsOf(account).flatMap((w) => Option.toArray(Option.filter(Option.fromUndefinedOr(w.resetAt), (at) => at > now && atHoldLine(w))))
  return Option.liftPredicate(resets, (all) => all.length > 0).pipe(Option.map((all) => Math.max(...all)))
}

/**
 * The pace of a pool whose accounts read `accounts` at `now`, with the agents
 * `inflight` charged on top, for a start of `model` when one is named. A
 * model's own weekly window (`7d:Fable`) holds only that model's starts; the
 * account's 5-hour and weekly windows hold every start, since every model's
 * requests spend them. `plans` moves an account's line by its resets.
 */
function budgetPace(
  accounts: ReadonlyArray<AccountStatus>,
  now: number,
  inflight: Inflight = NO_INFLIGHT,
  model?: string,
  plans: Readonly<Record<string, PacePlan>> = {},
): Pace {
  if (!accounts.length) return { ok: true, measured: false, reason: "no pooled account readings" }
  const available = accounts.filter((a) => blockedUntil(a, now, model) === undefined)
  if (!available.length) {
    const untils = accounts.flatMap((a) => {
      const until = blockedUntil(a, now, model)
      return until === undefined ? [] : [until]
    })
    const scoped = accounts.some((a) => a.hold === undefined || a.hold.until <= now)
    const retryAt = nextRetryAt(now, untils)
    const names = [...new Set(accounts.flatMap((a) => spentOwn(a, now, model).map((w) => w.name)))]
    return {
      ok: false,
      measured: true,
      reason: scoped
        ? `every pool account is held or has ${model}'s own weekly window (${names.join(", ")}) at ${used(1)}: a ${model} start ${holdsAt(1)} there; the first resets ${formatNotificationTime(retryAt)}`
        : "all pool accounts are held",
      retryAt,
      reasonCode: Match.value(scoped).pipe(Match.when(true, () => "model-limit" as const), Match.orElse(() => "account-held" as const)),
      admission: "held",
    }
  }
  const known = accounts.flatMap((a) =>
    Option.toArray(
      Option.flatMap(weekOf(a), (w) => Option.map(validWeekReset(w, now), (resetAt) => ({ used: usedOf(w.utilization, plans[a.credentialID]), resetAt, plan: plans[a.credentialID] }))),
    ),
  )
  const short = available.flatMap((a) => Option.toArray(shortUntil(a, now)))
  if (short.length === available.length) {
    const retryAt = nextRetryAt(now, short)
    return {
      ok: false,
      measured: true,
      reason: `every pool account is at a hold line: its 5-hour window at ${used(SHORT_5H)} or more, or its week at ${used(TARGET)} or more; the first resets ${formatNotificationTime(retryAt)}`,
      retryAt,
      reasonCode: "quota-limit",
      admission: "held",
    }
  }
  if (!known.length) return { ok: true, measured: false, reason: "weekly pace unmeasured" }
  const read = known.reduce((n, a) => n + a.used, 0)
  const charged = inflight.starts.length * inflight.cost
  const spent = read + charged
  const allowance = known.reduce((n, a) => n + lineOf(a.resetAt, now, a.plan), 0)
  if (spent <= allowance + 1e-9) {
    // Past the even line but within one a claimed, observed reset rebased: the room is that reset's.
    const ordinary = known.reduce((n, a) => n + lineOf(a.resetAt, now, {}), 0)
    if (spent <= ordinary + 1e-9) return { ok: true, measured: true, reason: "the pool is within its weekly pace", admission: "ordinary" }
    return {
      ok: true,
      measured: true,
      reason: `the pool is within its weekly pace on the room a claimed reset gave back, observed after the claim (the even line alone ${byCount(known.length, "is", "averages")} ${tenth(ordinary / known.length)} used of 100%)`,
      admission: "backed",
    }
  }
  const catchesUp = now + ((spent - allowance) * WEEK) / (known.length * TARGET)
  const settles = inflight.starts.length ? [Math.min(...inflight.starts) + inflight.settleMs + 1] : []
  // Pool-wide figures read per account, on average, so each stays out of 100%.
  const n = known.length
  const starting = inflight.starts.length
    ? `, plus ${tenth(charged / n)} of the week counted for ${inflight.starts.length} agent${inflight.starts.length === 1 ? "" : "s"} started in the last ${Math.round(inflight.settleMs / 60_000)} min`
    : ""
  return {
    ok: false,
    measured: true,
    soft: true,
    reason:
      `the pool's weekly pace is over: its ${n} ${byCount(n, "account's week is", "accounts' weeks are")} at ${tenth(read / n)} used of 100%${byCount(n, "", " on average")}${starting}; ` +
      `the spend-evenly line ${byCount(n, "is", "averages")} ${tenth(allowance / n)} used of 100% now, and the start holds past it`,
    retryAt: nextRetryAt(now, [Math.ceil(catchesUp) + 1, ...settles, ...known.map((a) => a.resetAt)]),
    reasonCode: "even-line",
    admission: "held",
  }
}

/**
 * A reading older than this admits no request of a managed pool: the auth
 * plugin reads a login's usage again by then, so an older one is a read that
 * failed since (a 429, an outage), and the week may have moved any way.
 */
export const STALE_AFTER_MS = 30 * 60_000
/** When a request held for want of a fresh reading asks again: the next sweep's reading may be in. */
export const UNREAD_RETRY_MS = 60_000

/** An unnamed pace is an advisory weekly reading; a start with a model uses exactly the request's admission rule. */
export function poolPace(
  accounts: ReadonlyArray<AccountStatus>,
  now: number,
  inflight: Inflight = NO_INFLIGHT,
  model?: string,
  plans: Readonly<Record<string, PacePlan>> = {},
  policy: DispatchPolicy = {},
): Pace {
  return Option.match(Option.fromUndefinedOr(model), {
    onNone: () => Option.getOrElse(fromAccountHolds(accounts, now), (): Pace => budgetPace(accounts.filter((a) => !needsSignIn(a)), now, inflight, model, plans)),
    onSome: (id) => dispatchPace(accounts, now, plans, inflight.cost, id, { ...policy, inflight }),
  })
}

/** The first future event worth rechecking; absent usable events, ask for a new reading. */
export const nextRetryAt = (now: number, candidates: ReadonlyArray<number>): FutureRetryAt => {
  const future = candidates.filter((at) => Option.isSome(futureRetryAt(now, at)))
  return Option.getOrThrow(Option.orElse(futureRetryAt(now, Math.min(...future)), () => futureRetryAt(now, pendingRecoveryAt(now))))
}

/** The account-wide week of an account's reading when it was read in the last STALE_AFTER_MS (a window carried over by its own time) and its reset is a valid one. */
export const freshWeek = (account: AccountStatus, now: number): Option.Option<{ readonly utilization: number; readonly resetAt: number }> =>
  Option.flatMap(weekOf(account), (w) =>
    Option.map(
      Option.filter(validWeekReset(w, now), (at) => at > readAt(account, w) && now - readAt(account, w) <= STALE_AFTER_MS),
      (resetAt) => ({ utilization: w.utilization, resetAt }),
    ),
  )

/** A window's own reading time, never the arrival time of newer headers that lacked it. */
const readAt = (account: AccountStatus, window: { readonly at?: number }): number =>
  Option.fromUndefinedOr(window.at).pipe(
    Option.orElse(() => Option.map(Option.fromUndefinedOr(account.reading), (r) => r.at)),
    Option.getOrElse(() => Number.NEGATIVE_INFINITY),
  )

/**
 * The model's own windows a request of `model` needs read on every account
 * (`7d:Fable` for `claude-fable-5-2`): those the provider defines, and
 * those ever seen on the pool (carry-over keeps their names across readings).
 * An account whose reading lacks one is no evidence of the
 * model's room, whatever its week says. None for a model with no window of
 * its own, or none named.
 */
export const requiredScopes = (accounts: ReadonlyArray<AccountStatus>, model?: string): ReadonlyArray<string> =>
  Option.match(Option.fromUndefinedOr(model), {
    onNone: () => [],
    onSome: (id) => {
      const names = [...DEFINED_MODEL_WINDOWS, ...accounts.flatMap((a) => windowsOf(a).map((w) => w.name))].filter((name) =>
        Option.exists(Option.fromUndefinedOr(scopeOf(name)), (scope) => limitsModel(scope, id)),
      )
      return [...new Set(names)].toSorted()
    },
  })

/**
 * Why an account's reading is no evidence of room for a request needing the
 * windows `required` (`requiredScopes`) at `now`: no weekly window read in the
 * last STALE_AFTER_MS, a weekly reset no week can have, or a required window
 * of the model's own absent, stale, or with such a reset. None when it is
 * evidence. `stale` says whether reading the login again may mend it.
 */
export const evidenceGap = (
  account: AccountStatus,
  now: number,
  required: ReadonlyArray<string> = [],
): Option.Option<Gap> => {
  const unreported = unreportedScope(account, required)
  if (Option.isSome(unreported)) return unreported
  const known = Option.fromUndefinedOr(account.reading)
  if (Option.isNone(known)) return Option.some(Unread.make({ why: "no reading", stale: true }))
  const gapOf = (name: string): Option.Option<Gap> =>
    Option.match(windowOf(account, name), {
      onNone: () => {
        if (name === "5h" && Option.exists(Option.fromUndefinedOr(known.value.fiveHourAbsentAt), (at) =>
          at <= now && now - at <= STALE_AFTER_MS)) return Option.none()
        const model = Option.fromUndefinedOr(scopeOf(name))
        const usage = Option.fromUndefinedOr(known.value.usage)
        const refreshAt = Option.getOrElse(Option.map(usage, (sample) => sample.at + UNREAD_RETRY_MS), () => now)
        return Option.some(Unread.make({ why: `no ${name} window in its reading`, stale: Option.isNone(model) || refreshAt <= now }))
      },
      onSome: (w) => {
        const seen = readAt(account, w)
        if (now - seen > STALE_AFTER_MS)
          return Option.some(Unread.make({ why: `its ${name} window was read more than ${Math.round(STALE_AFTER_MS / 60_000)} min ago`, stale: true }))
        const short = name === "5h" || name.startsWith("5h:")
        const { duration, span } = Match.value(short).pipe(
          Match.when(true, () => ({ duration: FIVE_HOURS, span: "5 hours" })),
          Match.orElse(() => ({ duration: WEEK, span: "7 days" })),
        )
        // An explicit empty, inactive 5-hour window has no running period yet.
        const reset = Option.fromUndefinedOr(w.resetAt)
        if (short && w.utilization === 0 && Option.isNone(reset)) return Option.none()
        const at = Option.filter(reset, (time) => Option.isSome(DateTime.make(time)))
        const rolled = !Option.exists(at, (time) => time > Math.max(now, seen))
        if (!rolled && Option.exists(at, (time) => time <= now + duration + RESET_SLACK_MS)) return Option.none()
        const named = Option.getOrElse(Option.map(at, formatNotificationTime), () => "unread")
        return Option.some(Unread.make({ why: `its ${name} window's reset (${named}) is not within the next ${span}`, stale: rolled }))
      },
    })
  return Arr.findFirst(["7d", "5h", ...required], gapOf)
}

/** Why a reading is no evidence of room, and whether reading the login again may mend it (`evidenceGap`). */
const Unread = Schema.TaggedStruct("Unread", { why: Schema.String, stale: Schema.Boolean })
const Unreported = Schema.TaggedStruct("Unreported", { scope: Schema.String, refreshAt: Schema.Finite })
const Gap = Schema.Union([Unread, Unreported])
export type Gap = typeof Gap.Type

const liveHold = (account: AccountStatus, now: number) =>
  Option.filter(Option.fromUndefinedOr(account.hold), (hold) => hold.kind === "record-unreadable" || hold.until > now)

/** Fixing another missing window cannot bring up a login whose usage never reported the model. */
const unreportedScope = (account: AccountStatus, required: ReadonlyArray<string>): Option.Option<typeof Unreported.Type> => {
  if (required.length === 0) return Option.none()
  const usage = Option.flatMap(Option.fromUndefinedOr(account.reading), (reading) => Option.fromUndefinedOr(reading.usage))
  if (!Option.exists(usage, (sample) => sample.samples >= SCOPE_REPORT_SAMPLES)) return Option.none()
  const scope = Arr.findFirst(required, (name) => Option.isNone(windowOf(account, name)))
  return Option.all([scope.pipe(Option.flatMap((name) => Option.fromUndefinedOr(scopeOf(name)))), usage])
    .pipe(Option.map(([scope, usage]) => Unreported.make({ scope, refreshAt: usage.at + UNREAD_RETRY_MS })))
}

export const refreshEvidence = (gap: Gap, now: number): boolean =>
  Match.value(gap).pipe(Match.tagsExhaustive({ Unread: (missing) => missing.stale, Unreported: (missing) => missing.refreshAt <= now }))

const gapText = (gap: Gap) => Match.value(gap).pipe(Match.tagsExhaustive({
  Unread: (missing) => missing.why,
  Unreported: ({ scope }) => `no ${scope} window reported by this login after ${SCOPE_REPORT_SAMPLES} successful usage reads (an incomplete or changed usage report: pooled logins are expected to report their required windows)`,
}))

const alternate = "Use another model or login; time alone will not clear this hold. The retry time is the next usage refresh, not an opening time."

export interface DispatchPolicy {
  readonly auxiliary?: Exclude<RequestKind, "primary" | "compaction">
  readonly liftEvenLine?: boolean
  /** Fleet starts not yet visible in the readings, when quoting a new start; an existing request already counted its launch. */
  readonly inflight?: Inflight
}

const splitEvidence = (accounts: ReadonlyArray<AccountStatus>, now: number, required: ReadonlyArray<string>) => {
  const fresh: Array<AccountStatus> = []
  const gaps: Array<Gap> = []
  const heldUnread: Array<number> = []
  for (const account of accounts) {
    if (needsSignIn(account) || account.hold?.kind === "record-unreadable") continue
    const gap = evidenceGap(account, now, required)
    if (Option.isNone(gap)) {
      fresh.push(account)
      continue
    }
    const hold = liveHold(account, now)
    if (gap.value._tag === "Unreported" || Option.isNone(hold)) gaps.push(gap.value)
    else heldUnread.push(hold.value.until)
  }
  return { fresh, gaps, heldUnread }
}

/** What room an account has on its claim's room for one more request of `cost`: its rebased line less its use (`usedOf`), when it has one. */
export const roomLeft = (account: AccountStatus, now: number, plan?: PacePlan): Option.Option<number> =>
  Option.all([freshWeek(account, now), Option.fromUndefinedOr(plan?.rebase)]).pipe(Option.map(([week]) => lineOf(week.resetAt, now, plan) - usedOf(week.utilization, plan)))

/** When an account's rebased line has risen `short` more of its week: it rises from the claim's use to TARGET by the weekly reset. */
const roomAt = (account: AccountStatus, now: number, short: number, plan?: PacePlan): ReadonlyArray<number> =>
  Option.toArray(
    Option.all([freshWeek(account, now), Option.fromUndefinedOr(plan?.rebase)]).pipe(
      Option.map(([week, rebase]) => {
        const slope = (TARGET - rebase.from) / Math.max(1, week.resetAt - rebase.at)
        if (slope <= 0) return week.resetAt
        return Math.min(week.resetAt, now + Math.ceil(short / slope) + 1)
      }),
    ),
  )

/**
 * The pace of one request of a managed pool at its dispatch, the last point
 * before it goes out, and the logins it may go out on (`eligible`). Only
 * accounts read in the last STALE_AFTER_MS count (`freshWeek`): with none, the
 * request is held, whatever a stale reading said. Within the even line
 * (`ordinary`), every eligible account takes it (`eligibleFor`). Past it, on a
 * claim's room (`backed`), only an account whose own claim's room still holds
 * `cost` more (one request's fixed share of its week) takes it, so a cached
 * login never spends another login's refund, and two requests never spend one
 * reservation: the caller reserves `cost` on the account it chose (resets.ts
 * `Spend`) before the request goes out.
 */
export function dispatchPace(
  accounts: ReadonlyArray<AccountStatus>,
  now: number,
  plans: Readonly<Record<string, PacePlan>>,
  cost: number,
  model?: string,
  policy: DispatchPolicy = {},
): Pace {
  const required = requiredScopes(accounts, model)
  const refusal = fromAccountHolds(accounts, now, required)
  if (Option.isSome(refusal)) return refusal.value
  const { fresh, gaps, heldUnread } = splitEvidence(accounts, now, required)
  const scoped = Arr.match(required, { onEmpty: () => "", onNonEmpty: (names) => `, and ${names.join(", ")} read as freshly` })
  const needs = `its weekly and any applicable 5-hour windows read in the last ${Math.round(STALE_AFTER_MS / 60_000)} min with valid resets${scoped}`
  const lacking = [...new Set(gaps.map(gapText))].join("; ")
  const unavailable = gaps.length > 0 && gaps.every((gap) => gap._tag === "Unreported")
  const evidenceTime = gaps.map((gap) => Match.value(gap).pipe(Match.tagsExhaustive({
    Unread: () => now + UNREAD_RETRY_MS,
    Unreported: ({ refreshAt }) => nextRetryAt(now, [refreshAt]),
  })))
  const of = Option.match(Option.fromUndefinedOr(model), { onNone: () => "", onSome: (id) => ` of ${id}` })
  const unreadHold = Option.map(Arr.head(gaps), (): HeldPace => {
    const reason: string[] = [`no account of the pool has a reading a request${of} of a managed pool goes out on (${needs}): ${lacking}`]
    if (unavailable) reason.push(alternate)
    return {
      ok: false,
      measured: false,
      reason: reason.join(". "),
      reasonCode: Match.value(unavailable).pipe(Match.when(true, () => "model-unreported" as const), Match.orElse(() => "usage-unread" as const)),
      retryAt: nextRetryAt(now, evidenceTime),
      admission: "held",
      eligible: [],
    }
  })
  const waitForLogin = Arr.match(heldUnread, {
    onEmpty: (): ReadonlyArray<HeldPace> => [],
    onNonEmpty: (ends): ReadonlyArray<HeldPace> => [{
      ok: false, measured: true, reasonCode: "account-held", admission: "held", eligible: [],
      reason: "the pool's other logins are held; read their usage after the first hold ends",
      retryAt: nextRetryAt(now, ends),
    }],
  })
  const damaged = unreadableAt(accounts)
  const waitForLoginOrRepair = [
    ...waitForLogin,
    ...Option.toArray(Option.map(Arr.head(damaged), () => unreadablePace(now, damaged))),
  ]
  if (fresh.length === 0 && Option.isSome(unreadHold)) return selectHold(unreadHold.value, waitForLoginOrRepair)
  const alternatives = [...Option.toArray(unreadHold), ...waitForLoginOrRepair]
  const inflight = Option.getOrElse(Option.fromUndefinedOr(policy.inflight), () => NO_INFLIGHT)
  const answer = budgetPace(fresh, now, inflight, model, plans)
  const open = eligibleFor(fresh, now, model)
  const eligible = open.map((a) => a.credentialID)
  // A push can lift the even line, not the minimum evidence or any hard limit.
  if (policy.liftEvenLine === true && eligible.length > 0 && ((!answer.ok && answer.soft === true) || answer.admission === "backed"))
    return { ok: true, measured: true, reason: answer.reason, admission: "ordinary", eligible }

  const retry = (times: ReadonlyArray<number>) => {
    const windows = fresh.flatMap((a) => [
      ...Option.toArray(Option.map(freshWeek(a, now), (week) => week.resetAt)),
      ...Option.toArray(Option.map(Option.fromUndefinedOr(a.hold), (hold) => hold.until)),
      ...spentOwn(a, now, model).map((w) => w.resetAt),
      ...windowsOf(a).filter(atHoldLine).flatMap((w) => Option.toArray(Option.fromUndefinedOr(w.resetAt))),
    ])
    return nextRetryAt(now, [...times, ...windows, ...evidenceTime])
  }
  const reasonWithGaps = (reason: string) => {
    if (gaps.length === 0) return reason
    return `${reason}; ${gaps.length} ${byCount(gaps.length, "account", "accounts")} more ${byCount(gaps.length, "has", "have")} no reading it may go out on (${needs}): ${lacking}`
  }
  const ordinaryCatchUp = () => Option.toArray(Option.fromUndefinedOr(budgetPace(fresh, now, inflight, model).retryAt))
  if (!answer.ok) return selectHold(
    { ...answer, reason: reasonWithGaps(answer.reason), retryAt: retry([answer.retryAt, ...ordinaryCatchUp()]), eligible: [] },
    alternatives,
  )
  // An unmeasured pace is no evidence of room at a dispatch: held, and asked again by the next sweep.
  if (!answer.measured) return selectHold({
    ok: false, measured: false, admission: "held", reasonCode: "logins-unavailable", retryAt: nextRetryAt(now, []), eligible: [],
    reason: "the pool lists no logins; add or restore a login before trying again",
  }, alternatives)
  if (answer.admission !== "backed") return { ...answer, eligible }
  // Only primary work can spend a claim's room. Auxiliary work waits for ordinary room.
  const auxiliary = Option.fromUndefinedOr(policy.auxiliary)
  if (Option.isSome(auxiliary))
    return selectHold({
      ok: false,
      measured: true,
      reason: reasonWithGaps(`the pool is past its spend-evenly line, and a ${auxiliary.value} request does not spend the room a claimed reset gave back`),
      reasonCode: "auxiliary",
      retryAt: retry(ordinaryCatchUp()),
      admission: "held",
      eligible: [],
    }, alternatives)
  const backed = open.filter((a) => Option.exists(roomLeft(a, now, plans[a.credentialID]), (room) => room >= cost - 1e-9))
  if (backed.length > 0) return { ...answer, eligible: backed.map((a) => a.credentialID) }
  const increases = open.flatMap((a) =>
    Option.toArray(roomLeft(a, now, plans[a.credentialID])).flatMap((room) => roomAt(a, now, cost - room, plans[a.credentialID])),
  )
  return selectHold({
    ok: false,
    measured: true,
    soft: true,
    reasonCode: "reset-room",
    reason: reasonWithGaps(`the pool is past its spend-evenly line, and ${Arr.match(increases, {
      onEmpty: () => "no account with room from a claimed reset can take this model now",
      onNonEmpty: () => `no open account's room from a claimed reset holds one more request (${tenth(cost)} of its week)`,
    })}`),
    retryAt: retry([...ordinaryCatchUp(), ...increases]),
    admission: "held",
    eligible: [],
  }, alternatives)
}
