// The provider laws: scripted exchanges with Anthropic, answered alike by the
// world's provider (sim/provider.ts) and the fake the real tier keeps using
// (tests/fake-anthropic.ts). Each law sends its requests through a `Wire` and
// reports what a plugin reads of the answers (the status, the headers the auth
// plugin and the pool read, the body), with what differs by nature taken out:
// tokens become their account's name, ids their kind, and times their offset
// from the law's start in seconds. sim/provider-laws.test.ts runs each law on
// both and asks for the same report, so the simulated provider is no kinder
// than the fake.
import { Effect, Option, Schema } from "effect"
import type * as Provider from "./provider.ts"

/** The headers a plugin reads of an answer, in this order. */
const READ = [
  "content-type",
  "request-id",
  "retry-after",
  "anthropic-ratelimit-unified-status",
  "anthropic-ratelimit-unified-representative-claim",
  "anthropic-ratelimit-unified-reset",
  "anthropic-ratelimit-unified-5h-utilization",
  "anthropic-ratelimit-unified-5h-reset",
  "anthropic-ratelimit-unified-7d-utilization",
  "anthropic-ratelimit-unified-7d-reset",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-tokens-remaining",
  "anthropic-ratelimit-tokens-reset",
]

const HOUR = 3_600_000

/** What the provider is told before the law: as both take it. */
export interface Setup {
  readonly script?: (request: Provider.RequestInfo) => Provider.Answer
  readonly quota?: (account: string) => Provider.Quota
  readonly token?: (account: string) => Provider.TokenAnswer
  readonly grants?: (account: string) => ReadonlyArray<Provider.Grant>
  readonly claim?: (account: string, grant: string) => Provider.ClaimResult
}

/** One provider as a law reaches it. */
export interface Wire {
  /** Where it answers: the fake's port, or the world's origin. */
  readonly origin: string
  /** One exchange. */
  readonly send: (request: Request) => Effect.Effect<Response>
  /** Each account's tokens now: they change when it refreshes. */
  readonly tokens: (account: string) => Provider.Account
}

export interface ProviderLaw {
  readonly name: string
  /** The accounts the provider knows. */
  readonly accounts: ReadonlyArray<string>
  /** The setup, at the law's start `at` (epoch ms, a whole second). */
  readonly setup: (at: number) => Setup
  /** The exchanges: what a plugin reads of each answer, one line each. */
  readonly run: (wire: Wire, read: (response: Response) => Effect.Effect<string>, at: number) => Effect.Effect<ReadonlyArray<string>>
}

const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g
const EPOCH_SECONDS = /^\d{10}$/

/** `text` with what differs by nature taken out: tokens as their account, ids as their kind, times as offsets from `at`. */
export const normalize = (text: string, at: number, tokens: ReadonlyArray<readonly [string, string]>) => {
  const named = tokens.reduce((current, [token, name]) => current.split(token).join(name), text)
  return named
    .replace(/msg_(?:fake|sim)_\d+/g, "msg_N")
    .replace(/toolu_(?:fake|sim)_\d+/g, "toolu_N")
    .replace(/req_(?:fake|sim)_/g, "req_")
    .replace(ISO, (iso) => `T${Math.round((Date.parse(iso) - at) / 1000)}s`)
}

/** What a plugin reads of an answer: its status, the headers it reads, its body. */
export const reading = (at: number, tokens: () => ReadonlyArray<readonly [string, string]>) => (response: Response) =>
  Effect.promise(() => response.text()).pipe(
    Effect.map((body) => {
      const headers = READ.flatMap((name) =>
        Option.match(Option.fromNullishOr(response.headers.get(name)), {
          onNone: () => [],
          onSome: (value) => [`${name}=${Option.match(Option.liftPredicate(value, (raw) => EPOCH_SECONDS.test(raw)), { onNone: () => value, onSome: (raw) => `T${Number(raw) - at / 1000}s` })}`],
        }),
      )
      return normalize(`${response.status} ${headers.join(" ")} ${body}`, at, tokens())
    }),
  )

const json = (body: Schema.Json) => ({ method: "POST", headers: { "content-type": "application/json" }, body: Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(body) })
const signed = (access: string, init: { readonly method: string; readonly headers: { readonly [key: string]: string }; readonly body?: string }) => ({
  ...init,
  headers: { ...init.headers, authorization: `Bearer ${access}`, "anthropic-version": "2023-06-01" },
})

/** A message request: a turn offers a tool, a title none; it streams unless `stream` is false. */
const message = (tools: boolean, stream = true) =>
  json({
    model: "claude-haiku-4-5",
    max_tokens: 1000,
    messages: [{ role: "user", content: [{ type: "text", text: "law: hello" }] }],
    ...Option.match(Option.liftPredicate(tools, Boolean), { onNone: () => ({}), onSome: () => ({ tools: [{ name: "read", description: "read", input_schema: { type: "object" } }] }) }),
    stream,
  })

const quotaAt = (at: number): Provider.Quota => ({
  fiveHour: { utilization: 0.4, resetAt: at + 2 * HOUR },
  sevenDay: { utilization: 0.3, resetAt: at + 50 * HOUR },
})

/** Sends a model request on `account`'s token and reads it. */
const ask = (wire: Wire, read: (response: Response) => Effect.Effect<string>, access: string, init: ReturnType<typeof json>) =>
  wire.send(new Request(`${wire.origin}/v1/messages`, signed(access, init))).pipe(Effect.flatMap(read))

const refresh = (wire: Wire, read: (response: Response) => Effect.Effect<string>, refreshToken: string, form: boolean) => {
  const request = Option.match(Option.liftPredicate(form, Boolean), {
    onNone: () => new Request(`${wire.origin}/v1/oauth/token`, json({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: "law" })),
    onSome: () =>
      new Request(`${wire.origin}/v1/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: "law" }).toString(),
      }),
  })
  return wire.send(request).pipe(Effect.flatMap(read))
}

export const PROVIDER_LAWS: ReadonlyArray<ProviderLaw> = [
  {
    name: "an answer streams its text, with the unified quota headers allowed on the five-hour window",
    accounts: ["first"],
    setup: (at) => ({ quota: () => quotaAt(at), script: () => ({ kind: "ok", text: "law: heard" }) }),
    run: (wire, read) => Effect.all([ask(wire, read, wire.tokens("first").access, message(true))]),
  },
  {
    name: "a request that does not stream gets the whole message, and a tool call carries its input",
    accounts: ["first"],
    setup: (at) => ({ quota: () => quotaAt(at), script: ({ index }) => ({ kind: "ok", ...Option.match(Option.liftPredicate(index, (n) => n === 0), { onNone: () => ({ tool: { name: "read", input: { path: "/law" } } }), onSome: () => ({ text: "law: whole" }) }) }) }),
    run: (wire, read) =>
      Effect.all([
        ask(wire, read, wire.tokens("first").access, message(true, false)),
        ask(wire, read, wire.tokens("first").access, message(true)),
        ask(wire, read, wire.tokens("first").access, message(true, false)),
      ]),
  },
  {
    name: "a transient 429 carries retry-after and the request and token resets",
    accounts: ["first"],
    setup: (at) => ({ quota: () => quotaAt(at), script: () => ({ kind: "transient-429", retryAfterSeconds: 7 }) }),
    run: (wire, read) => Effect.all([ask(wire, read, wire.tokens("first").access, message(true))]),
  },
  {
    name: "a plan limit is a 429 that names its window, rejected, with retry-after to its reset",
    accounts: ["first", "second"],
    setup: (at) => ({
      quota: () => quotaAt(at),
      script: ({ account }) => ({ kind: "usage-429", claim: Option.match(Option.liftPredicate(account, (name) => name === "first"), { onNone: () => "seven_day" as const, onSome: () => "five_hour" as const }), resetAt: at + 3 * HOUR }),
    }),
    run: (wire, read) =>
      Effect.all([ask(wire, read, wire.tokens("first").access, message(true)), ask(wire, read, wire.tokens("second").access, message(true))]),
  },
  {
    name: "an expired token, an unknown token and an overloaded provider each answer as Anthropic does",
    accounts: ["first", "second"],
    setup: (at) => ({ quota: () => quotaAt(at), script: ({ account }) => ({ kind: Option.match(Option.liftPredicate(account, (name) => name === "first"), { onNone: () => "overloaded" as const, onSome: () => "unauthorized" as const }) }) }),
    run: (wire, read) =>
      Effect.all([
        ask(wire, read, wire.tokens("first").access, message(true)),
        ask(wire, read, wire.tokens("second").access, message(true)),
        ask(wire, read, "law-unknown-token", message(true)),
      ]),
  },
  {
    name: "a refresh rotates both tokens: the new access token signs, the old refresh token is refused, as JSON or as a form",
    accounts: ["first", "second"],
    setup: (at) => ({ quota: () => quotaAt(at) }),
    run: (wire, read) =>
      Effect.gen(function* () {
        const before = wire.tokens("first")
        const second = wire.tokens("second").refresh
        const rotated = yield* refresh(wire, read, before.refresh, false)
        const again = yield* refresh(wire, read, before.refresh, false)
        const signs = yield* ask(wire, read, wire.tokens("first").access, message(false))
        const old = yield* ask(wire, read, before.access, message(false))
        const form = yield* refresh(wire, read, second, true)
        const wrongGrant = yield* wire
          .send(new Request(`${wire.origin}/v1/oauth/token`, json({ grant_type: "authorization_code", refresh_token: wire.tokens("second").refresh })))
          .pipe(Effect.flatMap(read))
        return [rotated, again, signs, old, form, wrongGrant]
      }),
  },
  {
    name: "a refresh answered 429 carries retry-after; one unavailable is a 503; a revoked one is invalid_grant",
    accounts: ["first", "second", "third", "fourth"],
    setup: () => ({
      token: (account) => {
        if (account === "first") return { kind: "rate-limited", retryAfterSeconds: 30 }
        if (account === "second") return { kind: "rate-limited" }
        if (account === "third") return { kind: "unavailable" }
        return { kind: "rejected" }
      },
    }),
    run: (wire, read) => Effect.forEach(["first", "second", "third", "fourth"], (name) => refresh(wire, read, wire.tokens(name).refresh, true)),
  },
  {
    name: "the usage endpoint reports the windows in percent, Fable's week, and the grants when asked",
    accounts: ["first", "second"],
    setup: (at) => ({
      quota: (account) => ({ ...quotaAt(at), ...Option.match(Option.liftPredicate(account, (name) => name === "first"), { onNone: () => ({}), onSome: () => ({ fable: { utilization: 0.5, resetAt: at + 40 * HOUR, ofWeekly: 0.25 } }) }) }),
      grants: () => [{ id: "grant_law", resetsLeft: 2, endsAt: at + 100 * HOUR, clears: ["five_hour"], type: "session", givesBackWeekly: true }],
    }),
    run: (wire, read) =>
      Effect.forEach(
        [
          [wire.tokens("first").access, ""],
          [wire.tokens("second").access, "?cedar_ember=1"],
          ["law-unknown-token", ""],
        ] as const,
        ([access, query]) => wire.send(new Request(`${wire.origin}/api/oauth/usage${query}`, signed(access, { method: "GET", headers: {} }))).pipe(Effect.flatMap(read)),
      ),
  },
  {
    name: "a grant is claimed once: the same request id again is already used, and another organization is refused",
    accounts: ["first"],
    setup: (at) => ({
      quota: () => quotaAt(at),
      grants: () => [{ id: "grant_law", resetsLeft: 2, endsAt: at + 100 * HOUR, clears: ["five_hour"], givesBackWeekly: true }],
    }),
    run: (wire, read) =>
      Effect.gen(function* () {
        const access = wire.tokens("first").access
        const profile = yield* wire.send(new Request(`${wire.origin}/api/oauth/profile`, signed(access, { method: "GET", headers: {} }))).pipe(Effect.flatMap(read))
        const claim = (organization: string, requestID: string) =>
          wire
            .send(new Request(`${wire.origin}/api/organizations/${organization}/reset_rate_limits`, signed(access, json({ program: "cedar_ember", grant_id: "grant_law", request_id: requestID }))))
            .pipe(Effect.flatMap(read))
        return [profile, yield* claim("org-first", "req-law-1"), yield* claim("org-first", "req-law-1"), yield* claim("org-other", "req-law-2")]
      }),
  },
]
