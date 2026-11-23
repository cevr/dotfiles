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
import { Option, Schema } from "effect"
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
  readonly rebase?: { readonly at: number; readonly from: number }
}

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
  const known = accounts.flatMap((a) => {
    const w = a.reading?.windows.find((w) => w.name === "7d")
    return w?.resetAt !== undefined && w.resetAt > now && w.resetAt <= now + WEEK
      ? [{ used: w.utilization, resetAt: w.resetAt, plan: plans[a.credentialID] }]
      : []
  })
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
