// The keepalive: a subagent's prompt cache kept warm while it waits on a
// running tool. Anthropic's cache only refreshes when a request reads the same
// cached prefix, so a ping re-sends the session's last request as it went out
// (the same URL, headers, system, tools and messages) with `max_tokens: 1`,
// and its answer is read for its usage and thrown away: a side request that
// never enters the session's history.
//
// - Only a subagent's primary request on a cache of five minutes or less arms
//   it; a root session waiting on the owner never does, nor an hour's cache.
// - A wait is the time one or more of the session's tool calls run. Its first
//   ping is due `INTERVAL_MS` after the request (or the ping) before it, each
//   later one `INTERVAL_MS` after the ping before; at most `MAX_PINGS` a wait.
// - None is sent once the cache's lifetime since the request before has
//   passed: that ping would only write a new cache.
// - A ping that fails (no answer, or not a 2xx) ends the wait's pings.
//
// Each ping is a `PingLine` in the keepalive log beside the cache ledger, for
// the dream's cache audit.
import { Effect, Option, Record, Result, Schema } from "effect"

/** How long after the request or ping before a ping is due: under the five-minute cache, with room for its trip. */
export const INTERVAL_MS = 270_000
/** The most pings one wait sends. */
export const MAX_PINGS = 4
/** The longest cache lifetime a ping keeps warm: Anthropic's five minutes. Longer caches outlive most waits. */
export const SHORT_CACHE_MS = 300_000

/** A header, as a ping copies it. */
export type Header = readonly [string, string]

/** A request as it went out, kept in memory only (it carries the login's authorization), never written anywhere. */
export interface Snapshot {
  readonly url: string
  readonly method: string
  readonly headers: ReadonlyArray<Header>
  /** The ping's body: the request's, with `max_tokens: 1`. */
  readonly body: string
  readonly ttlMs: number
  readonly agent: Option.Option<string>
  readonly model: string
  readonly login: Option.Option<string>
  /** When the request (or the last ping) went out. */
  readonly at: number
}

/** Why a request arms no keepalive, or `armed`. */
export type Arming = "armed" | "root" | "long-cache" | "unsigned" | "unpingable"

/**
 * Whether a request arms the keepalive. `child` (is the session a subagent's)
 * is asked last, only when the rest allows, since reading it is a host call.
 */
export const arming = <E, R>(facts: {
  readonly ttlMs: number
  readonly signed: boolean
  readonly body: Option.Option<string>
  readonly child: Effect.Effect<boolean, E, R>
}): Effect.Effect<Arming, E, R> => {
  if (facts.ttlMs > SHORT_CACHE_MS) return Effect.succeed("long-cache")
  if (!facts.signed) return Effect.succeed("unsigned")
  if (Option.isNone(facts.body)) return Effect.succeed("unpingable")
  return Effect.map(facts.child, (child): Arming => {
    if (child) return "armed"
    return "root"
  })
}

/** An object that keeps every key it has beyond `fields`, as they came. */
const open = <Fields extends Schema.Struct.Fields>(fields: Fields) => Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)])

/** A messages request's body: what the ping reads of it, every other key kept as it was. */
const RequestBody = Schema.fromJsonString(open({ messages: Schema.Array(Schema.Unknown), thinking: Schema.OptionFromOptionalKey(open({ type: Schema.String })) }))
const decodeRequest = Schema.decodeUnknownOption(RequestBody)
const encodeRequest = Schema.encodeSync(RequestBody)

/**
 * The ping's body: the request's JSON with `max_tokens: 1`, nothing else
 * changed. None when the body is no messages request, or it thinks on a
 * budget (`thinking.type: "enabled"`), which Anthropic requires to stay
 * under `max_tokens`; changing the thinking settings would miss the
 * messages' cache anyway.
 */
export const pingBody = (text: string): Option.Option<string> =>
  decodeRequest(text).pipe(
    Option.filter((body) => !Option.exists(body.thinking, (thinking) => thinking.type === "enabled")),
    Option.map((body) => encodeRequest({ ...body, max_tokens: 1 })),
  )

/** Headers a ping does not copy: the body's length (the body changed) and the host the URL names. */
const UNCOPIED = new Set(["content-length", "host"])

/** The request's headers as a ping sends them: all of them, the login's authorization among them, but its length. */
export const pingHeaders = (headers: ReadonlyArray<Header>): ReadonlyArray<Header> => headers.filter(([name]) => !UNCOPIED.has(name.toLowerCase()))

/** Whether the request carries its login (the auth plugin signed it before this plugin's hook ran). */
export const isSigned = (headers: ReadonlyArray<Header>): boolean =>
  headers.some(([name, value]) => (name.toLowerCase() === "authorization" || name.toLowerCase() === "x-api-key") && value.trim() !== "")

/**
 * How long to wait for the wait's next ping, or none: `sent` pings already
 * went out, or the cache written at `base` has expired by `now`.
 */
export const nextPing = (base: number, ttlMs: number, now: number, sent: number): Option.Option<number> => {
  if (sent >= MAX_PINGS) return Option.none()
  if (now >= base + ttlMs) return Option.none()
  return Option.some(Math.max(0, base + INTERVAL_MS - now))
}

/** A ping's usage, from its answer. */
export interface PingUsage {
  readonly input: number
  readonly read: number
  readonly write: number
  readonly output: number
}

export const NO_USAGE: PingUsage = { input: 0, read: 0, write: 0, output: 0 }

const Count = Schema.OptionFromOptionalKey(Schema.Number)
const Usage = Schema.Struct({ input_tokens: Count, cache_read_input_tokens: Count, cache_creation_input_tokens: Count, output_tokens: Count })
type Usage = typeof Usage.Type
/** A whole message's answer. */
const Message = Schema.fromJsonString(Schema.Struct({ usage: Usage }))
/** The stream events that carry usage. */
const StreamEvent = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal("message_start"), message: Schema.Struct({ usage: Usage }) }),
    Schema.Struct({ type: Schema.Literal("message_delta"), usage: Usage }),
  ]),
)
const decodeMessage = Schema.decodeUnknownOption(Message)
const decodeEvent = Schema.decodeUnknownOption(StreamEvent)

/** The usage a stream event carries. */
const usageIn = (event: typeof StreamEvent.Type): Usage => {
  if (event.type === "message_start") return event.message.usage
  return event.usage
}

const fold = (usage: PingUsage, raw: Usage): PingUsage => ({
  input: Option.getOrElse(raw.input_tokens, () => usage.input),
  read: Option.getOrElse(raw.cache_read_input_tokens, () => usage.read),
  write: Option.getOrElse(raw.cache_creation_input_tokens, () => usage.write),
  output: Option.getOrElse(raw.output_tokens, () => usage.output),
})

/** The usage an answer reports: a stream's `message_start` and `message_delta` events, or a JSON message's `usage`. */
export const usageOf = (text: string): PingUsage =>
  Option.match(decodeMessage(text), {
    onSome: (message) => fold(NO_USAGE, message.usage),
    onNone: () =>
      text
        .split("\n")
        .flatMap((line) => Option.toArray(Option.flatMap(Option.liftPredicate(line, (each) => each.startsWith("data:")), (data) => decodeEvent(data.slice(5).trim()))))
        .reduce((usage, event) => fold(usage, usageIn(event)), NO_USAGE),
  })

const LIMITS = "anthropic-ratelimit"

/** The rate-limit headers an answer carries (`anthropic-ratelimit-*`), by lower-case name. */
export const limitsOf = (headers: ReadonlyArray<Header>): Record<string, string> =>
  Record.fromEntries(headers.flatMap(([name, value]) => Option.toArray(Option.liftPredicate([name.toLowerCase(), value] as const, ([lower]) => lower.startsWith(LIMITS)))))

/** One ping, as the keepalive log keeps it. */
export const PingLine = Schema.Struct({
  /** When the ping went out, ms since the epoch. */
  at: Schema.Number,
  host: Schema.String,
  sessionID: Schema.String,
  agent: Schema.OptionFromOptionalKey(Schema.String),
  model: Schema.String,
  login: Schema.OptionFromOptionalKey(Schema.String),
  /** Its place in the wait, from 1. */
  ping: Schema.Number,
  /** Since the request or ping before it. */
  gapMs: Schema.Number,
  ttlMs: Schema.Number,
  /** The answer's status; none when no answer came. */
  status: Schema.OptionFromOptionalKey(Schema.Number),
  /** Why no answer came. */
  error: Schema.OptionFromOptionalKey(Schema.String),
  input: Schema.Number,
  read: Schema.Number,
  write: Schema.Number,
  output: Schema.Number,
  limits: Schema.Record(Schema.String, Schema.String),
})
export type PingLine = typeof PingLine.Type

/** A ping's answer, read whole. */
export interface Answer {
  readonly status: number
  readonly headers: ReadonlyArray<Header>
  readonly text: string
}

/** What a ping came to: its answer, or why none came. */
export type Outcome = Result.Result<Answer, { readonly message: string }>

/** Whether the ping kept the cache: an answer with a 2xx status. A refused or failed one ends the wait's pings. */
export const kept = (outcome: Outcome): boolean => Result.isSuccess(outcome) && outcome.success.status >= 200 && outcome.success.status < 300

/** The log's line for the `ping`th ping of a wait on `snapshot`, sent at `at`. */
export const pingLine = (input: {
  readonly host: string
  readonly sessionID: string
  readonly snapshot: Snapshot
  readonly at: number
  readonly ping: number
  readonly outcome: Outcome
}): PingLine => {
  const { snapshot } = input
  const sent = {
    at: input.at,
    host: input.host,
    sessionID: input.sessionID,
    agent: snapshot.agent,
    model: snapshot.model,
    login: snapshot.login,
    ping: input.ping,
    gapMs: input.at - snapshot.at,
    ttlMs: snapshot.ttlMs,
  }
  return Result.match(input.outcome, {
    onSuccess: (answer) => ({ ...sent, status: Option.some(answer.status), error: Option.none(), ...usageOf(answer.text), limits: limitsOf(answer.headers) }),
    onFailure: (failed) => ({ ...sent, status: Option.none(), error: Option.some(failed.message), ...NO_USAGE, limits: {} }),
  })
}
