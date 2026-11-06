// The server's request log: each model request a session sent, its prompt's
// fingerprint and what the cache made of it, judged against the session's
// request before it. A line per request goes to the ledger file
// (`~/.cache/opencode-cache-ledger/ledger.jsonl`) and the TUI reads a session's
// causes over the `dotfiles-opencode.cache` RPC, to name which segment of a
// changed prefix changed. The RPC definition is the wire contract, kept byte
// for byte.
import { Schema } from "effect"
import { firstChange, type Change, type Segment } from "./fingerprint.ts"
import { NOISE_FLOOR_TOKENS } from "./miss.ts"

/** A request as the server saw it go out. */
export interface Sent {
  /** When it went out (epoch ms): the cache's lifetime runs from here. */
  readonly at: number
  readonly kind: "primary" | "compaction"
  readonly agent: string
  /** `providerID/modelID`. */
  readonly model: string
  /** The pool's login (credential id, never a token) it went out on, when the pool chose one. */
  readonly login?: string
  /** How long its cache keeps the prompt. */
  readonly ttlMs: number
  readonly segments: ReadonlyArray<Segment>
}

/** What the provider billed a request's prompt as. */
export interface Tokens {
  /** Every prompt token: uncached input, cache reads and cache writes. */
  readonly prompt: number
  readonly read: number
  readonly write: number
}

/**
 * Why a request wrote what it wrote.
 * - `first`: no earlier request of the session went out through this server.
 * - `hit`: the cache read the previous prompt (all but the noise floor); its
 *   writes are the prompt's new end.
 * - `uncached`: neither it nor the request before reported any cache activity.
 * - `model`: it went to another model than the request before.
 * - `expired`: it went out after the previous request's lifetime ran out.
 * - `login`: inside the lifetime, the pool sent it on another login.
 * - `compaction`: inside the lifetime, it is a compaction's summary request, or
 *   the first request after a compaction.
 * - `prefix`: inside the lifetime, on one login, its prompt changed: `change`
 *   names the first segment that changed.
 * - `unchanged`: inside the lifetime, on one login, its prompt held the
 *   previous one unchanged and the cache still did not read it (the provider
 *   dropped it, or the login reached another organisation's cache).
 */
export const Cause = Schema.Literals(["first", "hit", "uncached", "model", "expired", "login", "compaction", "prefix", "unchanged"])
export type Cause = typeof Cause.Type

/** The causes of a miss inside the cache's lifetime: what no wait explains. */
export const UNEXPLAINED: ReadonlySet<Cause> = new Set(["login", "prefix", "unchanged"])

export const ChangeSchema = Schema.Struct({
  segment: Schema.String,
  previous: Schema.optionalKey(Schema.String),
  offsetTokens: Schema.Number,
  head: Schema.optionalKey(Schema.String),
})

/** One line of the ledger file. Times are epoch ms; logins are credential ids, never tokens. */
export const LedgerLine = Schema.Struct({
  at: Schema.Number,
  host: Schema.String,
  sessionID: Schema.String,
  /** The assistant message the request wrote; none for a compaction's summary request. */
  messageID: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(["primary", "compaction"]),
  agent: Schema.String,
  model: Schema.String,
  login: Schema.optionalKey(Schema.String),
  ttlMs: Schema.Number,
  /** Since the previous request of the session went out. */
  gapMs: Schema.optionalKey(Schema.Number),
  prompt: Schema.Number,
  read: Schema.Number,
  write: Schema.Number,
  /** Prompt tokens the previous request cached that this one did not read. */
  missed: Schema.optionalKey(Schema.Number),
  cause: Cause,
  change: Schema.optionalKey(ChangeSchema),
  /** The login the previous request went out on, when the pool moved this one. */
  from: Schema.optionalKey(Schema.String),
})
export type LedgerLine = typeof LedgerLine.Type

/** The request before, with what it was billed. */
export interface Previous {
  readonly sent: Sent
  readonly tokens: Tokens
}

/** A request's cause, with the evidence the line keeps. */
export interface Judgement {
  readonly cause: Cause
  readonly gapMs?: number
  readonly missed?: number
  readonly change?: Change
  readonly from?: string
}

/**
 * Judge a request against the session's request before it. `compacted` says
 * a compaction rewrote the context since then. A miss is the part of the
 * smaller of the two prompts the cache did not read, above the noise floor.
 * The prefix is compared for every miss inside the lifetime, so a login move
 * or a compaction still names the segment that changed.
 */
export const judge = (previous: Previous | undefined, sent: Sent, tokens: Tokens, compacted: boolean): Judgement => {
  if (previous === undefined) return { cause: "first" }
  const gapMs = Math.max(0, sent.at - previous.sent.at)
  if (sent.model !== previous.sent.model) return { cause: "model", gapMs }
  if (tokens.read + tokens.write === 0 && previous.tokens.read + previous.tokens.write === 0) return { cause: "uncached", gapMs }
  const missed = Math.min(previous.tokens.prompt, tokens.prompt) - tokens.read
  if (missed <= NOISE_FLOOR_TOKENS) return { cause: "hit", gapMs }
  if (gapMs > previous.sent.ttlMs) return { cause: "expired", gapMs, missed }
  const change = firstChange(previous.sent.segments, sent.segments)
  const evidence = { gapMs, missed, ...(change === undefined ? {} : { change }) }
  if (sent.login !== undefined && previous.sent.login !== undefined && sent.login !== previous.sent.login)
    return { cause: "login", ...evidence, from: previous.sent.login }
  if (compacted || sent.kind === "compaction") return { cause: "compaction", ...evidence }
  return { cause: change === undefined ? "unchanged" : "prefix", ...evidence }
}

/** The ledger line of a judged request. */
export const lineOf = (input: {
  readonly host: string
  readonly sessionID: string
  readonly messageID?: string
  readonly sent: Sent
  readonly tokens: Tokens
  readonly judgement: Judgement
}): LedgerLine => {
  const { sent, tokens, judgement } = input
  return {
    at: sent.at,
    host: input.host,
    sessionID: input.sessionID,
    ...(input.messageID === undefined ? {} : { messageID: input.messageID }),
    kind: sent.kind,
    agent: sent.agent,
    model: sent.model,
    ...(sent.login === undefined ? {} : { login: sent.login }),
    ttlMs: sent.ttlMs,
    ...(judgement.gapMs === undefined ? {} : { gapMs: judgement.gapMs }),
    prompt: tokens.prompt,
    read: tokens.read,
    write: tokens.write,
    ...(judgement.missed === undefined ? {} : { missed: judgement.missed }),
    cause: judgement.cause,
    ...(judgement.change === undefined ? {} : { change: judgement.change }),
    ...(judgement.from === undefined ? {} : { from: judgement.from }),
  }
}

/** The cache mod's own RPC: the TUI asks the server how each of a session's steps was judged. */
export const CACHE_LEDGER = {
  id: "dotfiles-opencode.cache",
  methods: {
    steps: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"] },
      output: { type: "object" },
    },
  },
  events: {},
} as const

/** The steps method's question. */
export const StepsQuery = Schema.Struct({ sessionID: Schema.String })
export type StepsQuery = typeof StepsQuery.Type

/** One judged step: the assistant message it wrote, its cause, and the segment that changed. */
export const StepCause = Schema.Struct({
  messageID: Schema.String,
  cause: Cause,
  change: Schema.optionalKey(ChangeSchema),
})
export type StepCause = typeof StepCause.Type

/** The steps method's answer: the session's steps this server judged since it started, oldest first. */
export const SessionSteps = Schema.Struct({ steps: Schema.Array(StepCause) })
export type SessionSteps = typeof SessionSteps.Type
