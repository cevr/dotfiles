// When an idle session compacts: shortly before its prompt cache expires,
// while compacting still reads the long prefix from cache. After it expires
// the next message writes the whole context again at the cache-write rate;
// compacted, the next message starts from a short summary instead.
//
// The cache was last refreshed at the start of the session's last model
// request (Anthropic counts the lifetime from a request's start, not its end;
// cache.ts), so the clock runs from there. It compacts at expiry minus the
// margin, and only when:
// - it is a main session, not a subagent's (unless the policy says so);
// - no execution runs: no turn, no tool, no permission or question awaited
//   (a foreground subagent is its parent's running tool call, so it counts);
// - it made a request since its last compaction, which wrote that cache, and
//   that request is not the first on top of the compaction's summary: the
//   summary request is no model request of the session's, and the first one
//   after it only loads the summary, so it is no new work (a session that
//   compacted, idle or automatic or manual, waits for real work first);
// - the request was cached, on a provider whose lifetime is known;
// - the request's prompt is above the threshold;
// - the cache has not expired yet;
// - compacting costs less than the next request writing the whole prompt
//   again (price.ts), when the catalog prices the model. An unpriced model
//   compacts on the threshold alone.
//
// Background work does not hold it back. A subagent or shell the session
// started in the background, still running while the session sits idle, wakes
// it with a notice when it ends; if that is after the cache expires, the wake
// writes the whole context again. So the timer runs as for any idle session,
// and a notice that comes first wakes the session and cancels it. The work is
// kept in the facts only to be logged with the decision.
import { Data, Option } from "effect"
import { marginOf, type Margins } from "./cache.ts"
import { type Bill, billOf, type Price } from "./price.ts"

/** The session's last model request, as the cache sees it. */
export interface LastRequest {
  /** When the request started, in epoch ms: the cache's last refresh. */
  readonly startedAt: number
  /** The request's prompt in tokens: input, cache reads and cache writes. */
  readonly prompt: number
  /** Whether the provider read or wrote the cache for it. */
  readonly cached: boolean
  /** The cache lifetime the request got, in ms; none when unknown. */
  readonly ttl: Option.Option<number>
  /** The model's input window in tokens; none when unknown. */
  readonly window: Option.Option<number>
  /** The model's catalog prices; absent when the catalog does not price it. */
  readonly price?: Price | undefined
}

/** What is known of a session when deciding. */
export interface Facts {
  /** It is a subagent's session. */
  readonly child: boolean
  /** An execution runs: a turn, a tool, or a permission or question it awaits. */
  readonly running: boolean
  /** Its background subagents and jobs still running, described: logged with the decision, never a reason to wait. */
  readonly busy: ReadonlyArray<string>
  /** The last request since the last compaction, if any. */
  readonly last: Option.Option<LastRequest>
  /** It compacted, or idle compaction already started for this cache, after the last request. */
  readonly compacted: boolean
  /** The last request is the first after a compaction: it loaded the summary, and no work came since. */
  readonly onSummary: boolean
}

/** The plugin's settings. */
export interface Policy {
  /** A lifetime that overrides every provider's, in ms. */
  readonly ttl: Option.Option<number>
  /** How long before expiry to compact, in ms. */
  readonly margins: Margins
  /** The threshold: this share of the model's window, */
  readonly ratio: number
  /** or this many tokens, whichever is smaller (this alone when the window is unknown). */
  readonly cap: number
  /** Subagents' sessions compact too. */
  readonly subagents: boolean
}

/** Why a session does not compact. */
export type Reason =
  | "subagent-session"
  | "running"
  | "no-request"
  | "compacted"
  | "no-new-work"
  | "no-cache"
  | "too-small"
  | "expired"
  | "costs-more"

export type Decision = Data.TaggedEnum<{
  /** Compact at `at` (epoch ms); `at` may have passed, which means now. */
  Due: {
    readonly at: number
    readonly expiresAt: number
    readonly ttl: number
    readonly prompt: number
    readonly threshold: number
  }
  Skip: { readonly reason: Reason }
}>
export const Decision = Data.taggedEnum<Decision>()

/** The prompt size a session must exceed to compact. */
export const thresholdOf = (window: Option.Option<number>, policy: Pick<Policy, "ratio" | "cap">): number =>
  Option.match(window, {
    onNone: () => policy.cap,
    onSome: (tokens) => Math.min(Math.floor(tokens * policy.ratio), policy.cap),
  })

const skip = (reason: Reason) => Decision.Skip({ reason })

/** The lifetime the session's cache is judged by: the policy's, else the request's. */
const ttlOf = (last: LastRequest, policy: Pick<Policy, "ttl">) => Option.orElse(policy.ttl, () => last.ttl)

/**
 * What compacting the session's last prompt costs and avoids; none when the
 * lifetime is unknown or the catalog does not price the model. The write is
 * billed at the lifetime the request asked for, the policy's when it did not say.
 */
export const billFor = (last: LastRequest, policy: Pick<Policy, "ttl">): Option.Option<Bill> =>
  Option.flatMap(Option.orElse(last.ttl, () => policy.ttl), (ttl) => billOf(last.price, last.prompt, ttl))

/** Whether and when the session compacts, judged at `now` (epoch ms). */
export const due = (facts: Facts, now: number, policy: Policy): Decision => {
  if (facts.child && !policy.subagents) return skip("subagent-session")
  if (facts.running) return skip("running")
  if (facts.compacted) return skip("compacted")
  if (Option.isNone(facts.last)) return skip("no-request")
  if (facts.onSummary) return skip("no-new-work")
  const last = facts.last.value
  const ttl = ttlOf(last, policy)
  if (Option.isNone(ttl) || !last.cached) return skip("no-cache")
  const threshold = thresholdOf(last.window, policy)
  if (last.prompt <= threshold) return skip("too-small")
  const expiresAt = last.startedAt + ttl.value
  if (now >= expiresAt) return skip("expired")
  const bill = billFor(last, policy)
  if (Option.isSome(bill) && bill.value.cost >= bill.value.avoided) return skip("costs-more")
  const at = Math.max(last.startedAt, expiresAt - marginOf(ttl.value, policy.margins))
  return Decision.Due({ at, expiresAt, ttl: ttl.value, prompt: last.prompt, threshold })
}
