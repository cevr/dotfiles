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
// - no execution runs: no turn, no tool, no permission or question awaited;
// - no subagent or background job of it runs;
// - it made a request since its last compaction, which wrote that cache;
// - the request was cached, on a provider whose lifetime is known;
// - the request's prompt is above the threshold;
// - the cache has not expired yet.
import { Data, Option } from "effect"
import { marginOf, type Margins } from "./cache.ts"

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
}

/** What is known of a session when deciding. */
export interface Facts {
  /** It is a subagent's session. */
  readonly child: boolean
  /** An execution runs: a turn, a tool, or a permission or question it awaits. */
  readonly running: boolean
  /** Subagents and background jobs of it still running, described. */
  readonly busy: ReadonlyArray<string>
  /** The last request since the last compaction, if any. */
  readonly last: Option.Option<LastRequest>
  /** It compacted, or idle compaction already started for this cache, after the last request. */
  readonly compacted: boolean
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
  | "busy"
  | "no-request"
  | "compacted"
  | "no-cache"
  | "too-small"
  | "expired"

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

/** Whether and when the session compacts, judged at `now` (epoch ms). */
export const due = (facts: Facts, now: number, policy: Policy): Decision => {
  if (facts.child && !policy.subagents) return skip("subagent-session")
  if (facts.running) return skip("running")
  if (facts.busy.length > 0) return skip("busy")
  if (facts.compacted) return skip("compacted")
  if (Option.isNone(facts.last)) return skip("no-request")
  const last = facts.last.value
  const ttl = Option.orElse(policy.ttl, () => last.ttl)
  if (Option.isNone(ttl) || !last.cached) return skip("no-cache")
  const threshold = thresholdOf(last.window, policy)
  if (last.prompt <= threshold) return skip("too-small")
  const expiresAt = last.startedAt + ttl.value
  if (now >= expiresAt) return skip("expired")
  const at = Math.max(last.startedAt, expiresAt - marginOf(ttl.value, policy.margins))
  return Decision.Due({ at, expiresAt, ttl: ttl.value, prompt: last.prompt, threshold })
}
