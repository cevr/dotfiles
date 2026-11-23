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
import { Array as Arr, Option, Schema } from "effect"
import { limitsModel, scopeOf } from "./quota.ts"
import type { AccountStatus } from "./status.ts"
import { byCount, holdsAt, iso, used } from "./usage-text.ts"

/** A share to a tenth of a percent: `0.567` → `56.7%`. */
const tenth = (share: number) => `${(100 * share).toFixed(1)}%`

const WEEK = 7 * 86400000
/** The share of a week the spend-evenly line reaches by its reset; a weekly window used this much has no room. */
export const TARGET = 0.99
/** A 5-hour window used this much has no room for a new start. */
export const SHORT_5H = 0.9
const LEEWAY = 0.05
/** How far past a week from now a weekly reset may read and still be one (a header's reset is rounded to the second). */
const RESET_SLACK_MS = 60_000

/** A weekly window's reset, when it is one a week now can have: after now, and no more than a week ahead. */
const validWeekReset = (window: { readonly resetAt?: number }, now: number): Option.Option<number> =>
  Option.filter(Option.fromUndefinedOr(window.resetAt), (resetAt) => resetAt > now && resetAt <= now + WEEK + RESET_SLACK_MS)

/** A window of an account's reading, by name. */
const windowOf = (account: AccountStatus, name: string) =>
  Option.flatMap(Option.fromUndefinedOr(account.reading), (reading) => Arr.findFirst(reading.windows, (w) => w.name === name))

/** The account-wide week of an account's reading. */
const weekOf = (account: AccountStatus) => windowOf(account, "7d")

/**
 * What room admits a start or a request: `ordinary`, the even line with its
 * leeway; `backed`, past that line but within one a reset the pool claimed and
 * a fresh reading after it observed (`PacePlan.rebase`); `held`, neither.
 */
export const Admission = Schema.Literals(["ordinary", "backed", "held"])
export type Admission = typeof Admission.Type

/** The pace method's answer: whether a new agent may start now, and if not, when to ask again. */
export const Pace = Schema.Struct({
  ok: Schema.Boolean,
  measured: Schema.Boolean,
  reason: Schema.String,
  retryAt: Schema.optionalKey(Schema.Number),
  /** A hold of the spend-evenly target only: the accounts still have quota. */
  soft: Schema.optionalKey(Schema.Boolean),
  /** What room the answer rests on, when measured. An older pool answers none: read it as `ok`'s. */
  admission: Schema.optionalKey(Admission),
  /**
   * A dispatch's answer (`dispatch`), when measured: the logins a request of the model may go out on now
   * (`eligibleFor`). A send outside the host's hooks (the cache's keepalive) goes out only on one of these.
   */
  eligible: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type Pace = typeof Pace.Type

/**
 * A model request the pool's pace holds at its dispatch: no credential is set
 * and nothing goes out. The same answer a start of the model would get now
 * (`poolPace`), its reason and when to ask again; the reset review was told of
 * the held work, so a reset that relieves it is claimed meanwhile.
 */
export class RequestHeld extends Schema.TaggedError<RequestHeld>()("RequestHeld", {
  sessionID: Schema.String,
  reason: Schema.String,
  retryAt: Schema.OptionFromOptionalKey(Schema.Number),
}) {}

/** The turn's end a held request names: the pace's words, and when it asks again. */
export const requestHeldMessage = (held: RequestHeld): string =>
  `dotfiles-opencode.pool: the request is held: ${held.reason}${Option.match(held.retryAt, { onNone: () => "", onSome: (at) => `; it may go again at ${iso(at)}` })}`

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
    ...(account.hold !== undefined && account.hold.until > now ? [account.hold.until] : []),
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
  const windows = Option.match(Option.fromUndefinedOr(account.reading), { onNone: () => [], onSome: (reading) => reading.windows })
  const resets = windows.flatMap((w) => Option.toArray(Option.filter(Option.fromUndefinedOr(w.resetAt), (at) => at > now && atHoldLine(w))))
  return Option.liftPredicate(resets, (all) => all.length > 0).pipe(Option.map((all) => Math.max(...all)))
}

/**
 * The pace of a pool whose accounts read `accounts` at `now`, with the agents
 * `inflight` charged on top, for a start of `model` when one is named. A
 * model's own weekly window (`7d:Fable`) holds only that model's starts; the
 * account's 5-hour and weekly windows hold every start, since every model's
 * requests spend them. `plans` moves an account's line by its resets.
 */
export function poolPace(
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
    const retryAt = Math.min(...untils)
    const names = [...new Set(accounts.flatMap((a) => spentOwn(a, now, model).map((w) => w.name)))]
    return {
      ok: false,
      measured: true,
      reason: scoped
        ? `every pool account is held or has ${model}'s own weekly window (${names.join(", ")}) at ${used(1)}: a ${model} start ${holdsAt(1)} there; the first resets ${iso(retryAt)}`
        : "all pool accounts are held",
      retryAt,
      admission: "held",
    }
  }
  const known = accounts.flatMap((a) =>
    Option.toArray(
      Option.flatMap(weekOf(a), (w) => Option.map(validWeekReset(w, now), (resetAt) => ({ used: usedOf(w.utilization, plans[a.credentialID]), resetAt, plan: plans[a.credentialID] }))),
    ),
  )
  const short = available.flatMap((a) => Option.toArray(shortUntil(a, now)))
  if (short.length === available.length)
    return {
      ok: false,
      measured: true,
      reason: `every pool account is at a hold line: its 5-hour window at ${used(SHORT_5H)} or more, or its week at ${used(TARGET)} or more; the first resets ${iso(Math.min(...short))}`,
      retryAt: Math.min(...short),
      admission: "held",
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
    retryAt: Math.min(Math.ceil(catchesUp) + 1, ...settles, ...known.map((a) => a.resetAt)),
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

/** The account-wide week of an account's reading when it was read in the last STALE_AFTER_MS (a window carried over by its own time) and its reset is a valid one. */
export const freshWeek = (account: AccountStatus, now: number): Option.Option<{ readonly utilization: number; readonly resetAt: number }> =>
  Option.flatMap(weekOf(account), (w) =>
    Option.map(
      Option.filter(validWeekReset(w, now), () => Option.isNone(staleOf(account, w, now))),
      (resetAt) => ({ utilization: w.utilization, resetAt }),
    ),
  )

/** How long ago a window of an account's reading was read, when longer than STALE_AFTER_MS: its own time (`at`, carried over) or the reading's. */
const staleOf = (account: AccountStatus, window: { readonly at?: number }, now: number): Option.Option<number> =>
  Option.filter(
    Option.map(Option.fromUndefinedOr(account.reading), (reading) => now - Option.getOrElse(Option.fromUndefinedOr(window.at), () => reading.at)),
    (age) => age > STALE_AFTER_MS,
  )

/**
 * The model's own windows a request of `model` needs read on every account
 * (`7d:Fable` for `claude-fable-5-2`): each such window any account of the
 * pool reads. An account whose reading lacks one is no evidence of the
 * model's room, whatever its week says. None for a model with no window of
 * its own, or none named.
 */
export const requiredScopes = (accounts: ReadonlyArray<AccountStatus>, model?: string): ReadonlyArray<string> =>
  Option.match(Option.fromUndefinedOr(model), {
    onNone: () => [],
    onSome: (id) => {
      const names = accounts.flatMap((a) =>
        Option.match(Option.fromUndefinedOr(a.reading), { onNone: () => [], onSome: (reading) => reading.windows }).flatMap((w) =>
          Option.toArray(Option.filter(Option.fromUndefinedOr(scopeOf(w.name)), (scope) => limitsModel(scope, id))).map(() => w.name),
        ),
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
  if (Option.isNone(Option.fromUndefinedOr(account.reading))) return Option.some({ why: "no reading", stale: true })
  const gapOf = (name: string): Option.Option<Gap> =>
    Option.match(windowOf(account, name), {
      onNone: () => Option.some({ why: `no ${name} window in its reading`, stale: name === "7d" }),
      onSome: (w) =>
        Option.match(staleOf(account, w, now), {
          onSome: (): Option.Option<Gap> => Option.some({ why: `its ${name} window was read more than ${Math.round(STALE_AFTER_MS / 60_000)} min ago`, stale: true }),
          onNone: () =>
            Option.match(validWeekReset(w, now), {
              onSome: () => Option.none(),
              // A reset passed may be a period rolled over, which a reading taken now shows; one further than a week off no reading mends.
              onNone: () => {
                const reset = Option.fromUndefinedOr(w.resetAt)
                return Option.some({
                  why: `its ${name} window's reset (${Option.match(reset, { onNone: () => "unread", onSome: iso })}) is not within the next 7 days`,
                  stale: !Option.exists(reset, (at) => at > now),
                })
              },
            }),
        }),
    })
  return Arr.findFirst(["7d", ...required], (name) => Option.isSome(gapOf(name))).pipe(Option.flatMap(gapOf))
}

/** Why a reading is no evidence of room, and whether reading the login again may mend it (`evidenceGap`). */
export interface Gap {
  readonly why: string
  readonly stale: boolean
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
): Pace {
  const required = requiredScopes(accounts, model)
  const gaps = accounts.flatMap((a) => Option.toArray(evidenceGap(a, now, required)).map((gap) => gap.why))
  const fresh = accounts.filter((a) => Option.isNone(evidenceGap(a, now, required)))
  const scoped = Arr.match(required, { onEmpty: () => "", onNonEmpty: (names) => `, and ${names.join(", ")} read as freshly` })
  const needs = `a weekly window read in the last ${Math.round(STALE_AFTER_MS / 60_000)} min with its reset within the next 7 days${scoped}`
  const lacking = [...new Set(gaps)].join("; ")
  const of = Option.match(Option.fromUndefinedOr(model), { onNone: () => "", onSome: (id) => ` of ${id}` })
  if (accounts.length > 0 && fresh.length === 0)
    return {
      ok: false,
      measured: false,
      reason: `no account of the pool has a reading a request${of} of a managed pool goes out on (${needs}): ${lacking}`,
      retryAt: now + UNREAD_RETRY_MS,
      admission: "held",
      eligible: [],
    }
  const answer = poolPace(fresh, now, NO_INFLIGHT, model, plans)
  if (!answer.ok && answer.measured && gaps.length > 0)
    // The accounts read well hold it; the others may yet be read: the request asks again by the next sweep.
    return {
      ...answer,
      reason: `${answer.reason}; ${gaps.length} ${byCount(gaps.length, "account", "accounts")} more ${byCount(gaps.length, "has", "have")} no reading it may go out on (${needs}): ${lacking}`,
      retryAt: Math.min(...Option.toArray(Option.fromUndefinedOr(answer.retryAt)), now + UNREAD_RETRY_MS),
      eligible: [],
    }
  if (!answer.ok) return { ...answer, eligible: [] }
  // An unmeasured pace is no evidence of room at a dispatch: held, and asked again by the next sweep.
  if (!answer.measured) return { ...answer, ok: false, admission: "held", retryAt: now + UNREAD_RETRY_MS, eligible: [] }
  const open = eligibleFor(fresh, now, model)
  if (answer.admission !== "backed") return { ...answer, eligible: open.map((a) => a.credentialID) }
  const backed = open.filter((a) => Option.exists(roomLeft(a, now, plans[a.credentialID]), (room) => room >= cost - 1e-9))
  if (backed.length > 0) return { ...answer, eligible: backed.map((a) => a.credentialID) }
  const opens = open.flatMap((a) =>
    Option.toArray(roomLeft(a, now, plans[a.credentialID])).flatMap((room) => roomAt(a, now, cost - room, plans[a.credentialID])),
  )
  return {
    ok: false,
    measured: true,
    soft: true,
    reason: `the pool is past its spend-evenly line, and no account's room a claimed reset gave back holds one more request (${tenth(cost)} of its week): the requests already admitted on it hold the rest`,
    ...Option.match(Arr.match(opens, { onEmpty: () => Option.none<number>(), onNonEmpty: (all) => Option.some(Math.min(...all)) }), { onNone: () => ({}), onSome: (retryAt) => ({ retryAt }) }),
    admission: "held",
    eligible: [],
  }
}
