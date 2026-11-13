// The provider as part of the world: Anthropic's messages API, its token
// endpoint, its usage endpoint and a login's profile, as world state on the
// world's clock. The plugins reach it through the seams the real files use:
// the host sends a model request to the URL the plugins' hooks leave it (the
// auth plugin routes it to `ANTHROPIC_BASE_URL`, here `ORIGIN`), and the auth
// plugin and the login store fetch the token and usage endpoints through it.
//
// It answers what tests/fake-anthropic.ts answers the real tier, in the same
// shapes (status, the headers the plugins read, the body), from the same
// scripts (`FakeAnswer`, `FakeTokenAnswer`, `FakeQuota`), so the simulated
// provider is no kinder than the fake the real files keep using
// (sim/provider.test.ts runs one set of exchanges on both). What differs is
// only what a world cannot have: time is the world's, tokens are drawn from
// the seed, and a request to any other origin does not connect.
import { Array as Arr, DateTime, Effect, Fiber, Option, Schema } from "effect"
import {
  type FakeAccount,
  type FakeAnswer,
  type FakeClaimResult,
  type FakeGrant,
  type FakeQuota,
  type FakeTokenAnswer,
  type FakeWindow,
  unifiedHeaders,
} from "../tests/fake-anthropic.ts"
import { below, generator, line, plain, type Runtime, SimError } from "./runtime.ts"

export type { FakeAccount as Account, FakeAnswer as Answer, FakeClaimResult as ClaimResult, FakeGrant as Grant, FakeQuota as Quota, FakeTokenAnswer as TokenAnswer }

/** A claim the provider received: never a token. */
export interface Claim {
  readonly account: string
  readonly organization: string
  readonly grant: string
  readonly requestID: string
  readonly result: string
}

/** Where the world's Anthropic answers: a loopback origin, as the fake's, that nothing outside the world listens on. */
export const ORIGIN = "http://127.0.0.1:9"

const HOUR = 3_600_000

const Body = Schema.Record(Schema.String, Schema.Json)
type Body = typeof Body.Type
const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(Body))

/** What the provider knows of one request when it picks the answer, as the fake's script reads it. */
export interface RequestInfo {
  /** The account whose access token signed it; none for an unknown token. */
  readonly account: string
  /** How many `/v1/messages` requests this account made before this one. */
  readonly index: number
  readonly body: Body
}

/** A request the provider received, as tests assert on it; never a token. */
export interface Received {
  readonly path: string
  /** The account whose token signed it; "" for none it knows. */
  readonly account: string
  readonly status: number
  readonly model: string
  /** How many tools the request offered: an agent turn offers some, a title request none. */
  readonly tools: number
  readonly betas: ReadonlyArray<string>
  /** The Claude Code session header; "" when absent. */
  readonly sessionHeader: string
  /** Headers named `x-opencode-*`: none should ever reach Anthropic. */
  readonly opencodeHeaders: ReadonlyArray<string>
  /** Virtual epoch ms. */
  readonly at: number
}

export interface Options {
  readonly seed: number
  readonly accounts: { readonly [name: string]: FakeAccount }
  /** The answer to each `/v1/messages` request. Default: `ok`. */
  readonly script?: (request: RequestInfo) => FakeAnswer
  /** The quota each account's answers report. Default: 10% of 5h, 20% of 7d from now, as the fake's. */
  readonly quota?: (account: string) => FakeQuota
  /** The answer to each refresh of a known refresh token. Default: rotate at once; a `delayMs` is waited on the world's clock. */
  readonly token?: (account: string) => FakeTokenAnswer
  /** The reset grants the usage endpoint lists for an account (asked with `?cedar_ember=1`). Default none. */
  readonly grants?: (account: string) => ReadonlyArray<FakeGrant>
  /** The answer to a claim of a grant. Default `reset`, and `already_used` for a request id claimed before. */
  readonly claim?: (account: string, grant: string) => FakeClaimResult
  /** A model request no known token signs is answered as `ANONYMOUS`'s, as a provider on an API key would: the host laws' model. Default: refused (401). */
  readonly anonymous?: boolean
}

/** The account an unsigned request is answered as, on an anonymous provider. */
export const ANONYMOUS = "anonymous"

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms))

const sse = (events: ReadonlyArray<{ readonly type: string; readonly [field: string]: Schema.Json }>) => events.map((event) => `event: ${event.type}\ndata: ${line(event)}\n\n`).join("")

const errorBody = (type: string, message: string) => line({ type: "error", error: { type, message } })

const json = (body: string, status: number, headers: Readonly<Record<string, string>> = {}) =>
  new Response(body, { status, headers: { "content-type": "application/json", ...headers } })

/** A body as the fake answers one it does not type: text, as `new Response(text)` sends it. */
const plainText = (body: string, status: number) => new Response(body, { status, headers: { "content-type": "text/plain;charset=utf-8" } })

const defaultQuota = (at: number): FakeQuota => ({
  fiveHour: { utilization: 0.1, resetAt: at + 3 * HOUR },
  sevenDay: { utilization: 0.2, resetAt: at + 72 * HOUR },
})

/** A window as the usage endpoint lists it. */
const windowOf = (value: FakeWindow) => ({ utilization: value.utilization * 100, resets_at: iso(value.resetAt) })

/** Fable's week as the usage endpoint listed it on 2026-11-09: a `weekly_scoped` entry of `limits`, its share named by index. */
const fableOf = (quota: FakeQuota) =>
  Option.match(Option.fromNullishOr(quota.fable), {
    onNone: () => ({}),
    onSome: (fable) => ({
      limits: [
        { kind: "session", group: "session", percent: quota.fiveHour.utilization * 100, resets_at: iso(quota.fiveHour.resetAt), scope: NULL },
        { kind: "weekly_all", group: "weekly", percent: quota.sevenDay.utilization * 100, resets_at: iso(quota.sevenDay.resetAt), scope: NULL },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: fable.utilization * 100,
          resets_at: iso(fable.resetAt),
          scope: { model: { id: NULL, display_name: "Fable" }, surface: NULL },
        },
      ],
      weekly_scoped_shares: [
        { limit_index: 2, used_percent_of_weekly: fable.utilization * fable.ofWeekly * 100, allowance_percent_of_weekly: fable.ofWeekly * 100 },
      ],
    }),
  })

/** A grant as the usage endpoint lists it, in the fields Claude Code reads. */
const grantOfList = (grant: FakeGrant) => ({
  id: grant.id,
  resets_left: grant.resetsLeft,
  ends_at: iso(grant.endsAt),
  paused: false,
  usable_now: grant.resetsLeft > 0,
  use_requires_limit: grant.useRequiresLimit ?? false,
  gives_back_weekly: grant.givesBackWeekly ?? false,
  ...Option.match(Option.fromNullishOr(grant.type), { onNone: () => ({}), onSome: (type) => ({ type }) }),
  ...Option.match(Option.fromNullishOr(grant.clears), { onNone: () => ({}), onSome: (clears) => ({ clears: [...clears] }) }),
})

const CLAIM_PATH = /^\/api\/organizations\/([^/]+)\/reset_rate_limits$/

/** The status a claim's result answers with. */
const claimStatus = (result: string) => {
  if (result === "unauthorized") return 403
  if (result === "rate-limited") return 429
  return 200
}

const ClaimBody = Schema.Struct({ grant_id: Schema.optional(Schema.String), request_id: Schema.optional(Schema.String), program: Schema.optional(Schema.Json) })
const decodeClaim = Schema.decodeUnknownOption(Schema.fromJsonString(ClaimBody))

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

/** JSON's null, as the wire carries it in a message's open fields. */
const NULL = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Null))("null")

/** The status a token answer gives a known refresh token. */
const tokenStatus = (answer: FakeTokenAnswer) => {
  if (answer.kind === "rejected") return 400
  if (answer.kind === "unavailable") return 503
  if (answer.kind === "rate-limited") return 429
  return 200
}

/** A refresh's grant and refresh token, from a form (the login store's) or JSON (the auth plugin's). */
const grantOf = (contentType: string, text: string) => {
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(text)
    return { grant: Option.getOrElse(Option.fromNullishOr(form.get("grant_type")), () => ""), refresh: Option.getOrElse(Option.fromNullishOr(form.get("refresh_token")), () => "") }
  }
  const body = Option.getOrElse(decodeBody(text), (): Body => ({}))
  return { grant: String(body["grant_type"] ?? ""), refresh: String(body["refresh_token"] ?? "") }
}

/** Fake logins for `names`, their tokens drawn from the seed: as the fake's `fakeAccount`, never a real token. */
export const accounts = (seed: number, names: ReadonlyArray<string>) => {
  const random = generator(`accounts:${seed}`)
  const draw = (prefix: string, name: string) => `${prefix}-${name}-${Array.from({ length: 16 }, () => ALPHABET[below(random, ALPHABET.length)]).join("")}`
  return Object.fromEntries(names.map((name) => [name, { access: draw("sim-access", name), refresh: draw("sim-refresh", name) }] as const))
}

/** A provider on the world's clock (`now`): `handle` answers one HTTP exchange as Anthropic would; the rest is what tests read. */
export const make = (options: Options, world: Pick<Runtime, "now" | "fork">) => {
  const now = world.now
  const random = generator(`provider:${options.seed}`)
  const quotaOf = options.quota ?? (() => defaultQuota(now()))
  const script = options.script ?? ((): FakeAnswer => ({ kind: "ok" }))
  const current = new Map<string, FakeAccount>(Object.entries(options.accounts))
  const counts = new Map<string, number>()
  const received: Array<Received> = []
  const claims: Array<Claim> = []
  const claimed = new Set<string>()
  const state = { served: 0, drawn: 0 }

  /** A token drawn from the seed: never a real one. */
  const token = (prefix: string) => {
    state.drawn += 1
    return `${prefix}-${state.drawn}-${Array.from({ length: 12 }, () => ALPHABET[below(random, ALPHABET.length)]).join("")}`
  }

  const header = (request: Request, name: string) => Option.getOrElse(Option.fromNullishOr(request.headers.get(name)), () => "")

  /** The account whose access token signs the request; "" for none. */
  const accountOf = (request: Request) => {
    const bearer = header(request, "authorization").replace(/^Bearer /, "")
    for (const [name, account] of current) if (bearer !== "" && account.access === bearer) return name
    return ""
  }

  const record = (request: Request, path: string, account: string, status: number, body: Body = {}) => {
    const opencodeHeaders: Array<string> = []
    request.headers.forEach((_value, name) => {
      if (name.toLowerCase().startsWith("x-opencode")) opencodeHeaders.push(name.toLowerCase())
    })
    const tools = body["tools"]
    received.push({
      path,
      account,
      status,
      model: String(body["model"] ?? ""),
      tools: Option.match(Option.liftPredicate(tools, Array.isArray), { onNone: () => 0, onSome: (offered) => offered.length }),
      betas: header(request, "anthropic-beta")
        .split(",")
        .map((beta) => beta.trim())
        .filter((beta) => beta !== ""),
      sessionHeader: header(request, "x-claude-code-session-id"),
      opencodeHeaders,
      at: now(),
    })
  }

  /** The message for an `ok` answer, as the fake answers it: streamed, or whole when the request does not stream. */
  const reply = (answer: Extract<FakeAnswer, { kind: "ok" }>, model: string, stream: boolean) => {
    state.served += 1
    const id = `msg_sim_${state.served}`
    const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const blocks = Option.match(Option.fromNullishOr(answer.tool), {
      onNone: () => {
        const text = answer.text ?? "fake: ok"
        return { whole: { type: "text", text }, start: { type: "text", text: "" }, delta: { type: "text_delta", text }, stop: "end_turn" }
      },
      onSome: (tool) => {
        const input = plain(tool.input)
        return {
          whole: { type: "tool_use", id: `toolu_sim_${state.served}`, name: tool.name, input },
          start: { type: "tool_use", id: `toolu_sim_${state.served}`, name: tool.name, input: {} },
          delta: { type: "input_json_delta", partial_json: line(input) },
          stop: "tool_use",
        }
      },
    })
    if (!stream)
      return {
        type: "application/json",
        body: line({ id, type: "message", role: "assistant", model, content: [blocks.whole], stop_reason: blocks.stop, stop_sequence: NULL, usage }),
      }
    const body = sse([
      { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: NULL, stop_sequence: NULL, usage: { ...usage, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: blocks.start },
      { type: "content_block_delta", index: 0, delta: blocks.delta },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: blocks.stop, stop_sequence: NULL }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ])
    return { type: "text/event-stream", body }
  }

  /** The answer to a known account's message request. */
  const answered = (request: Request, path: string, account: string, body: Body) => {
    const model = String(body["model"] ?? "claude-fake")
    const index = counts.get(account) ?? 0
    counts.set(account, index + 1)
    const answer = script({ account, index, body })
    const at = now()
    const quota = quotaOf(account)
    const base = { "request-id": `req_sim_${index}` }
    switch (answer.kind) {
      case "ok": {
        record(request, path, account, 200, body)
        const message = reply(answer, model, body["stream"] === true)
        return new Response(message.body, { headers: { ...base, "content-type": message.type, ...unifiedHeaders(quota, "allowed", "five_hour") } })
      }
      case "transient-429": {
        record(request, path, account, 429, body)
        const reset = iso(at + answer.retryAfterSeconds * 1000)
        return json(errorBody("rate_limit_error", "Number of requests has exceeded your per-minute rate limit"), 429, {
          ...base,
          "retry-after": String(answer.retryAfterSeconds),
          "anthropic-ratelimit-requests-remaining": "0",
          "anthropic-ratelimit-requests-reset": reset,
          "anthropic-ratelimit-tokens-remaining": "1000",
          "anthropic-ratelimit-tokens-reset": reset,
          ...unifiedHeaders(quota, "allowed", "five_hour"),
        })
      }
      case "usage-429": {
        record(request, path, account, 429, body)
        const spent = { utilization: 1, resetAt: answer.resetAt }
        let refused: FakeQuota = { ...quota, sevenDay: spent }
        if (answer.claim === "five_hour") refused = { ...quota, fiveHour: spent }
        return json(errorBody("rate_limit_error", "You have reached your session usage limit."), 429, {
          ...base,
          "retry-after": String(Math.max(0, Math.ceil((answer.resetAt - at) / 1000))),
          ...unifiedHeaders(refused, "rejected", answer.claim),
        })
      }
      case "unauthorized":
        record(request, path, account, 401, body)
        return json(errorBody("authentication_error", "OAuth token has expired."), 401, base)
      case "overloaded":
        record(request, path, account, 529, body)
        return json(errorBody("overloaded_error", "Overloaded"), 529, { ...base, ...unifiedHeaders(quota, "allowed", "five_hour") })
    }
  }

  const messages = (request: Request, path: string) =>
    Effect.promise(() => request.text()).pipe(
      Effect.map((text) => {
        const account = accountOf(request)
        const body = Option.getOrElse(decodeBody(text), (): Body => ({}))
        if (account !== "") return answered(request, path, account, body)
        if (options.anonymous === true) return answered(request, path, ANONYMOUS, body)
        record(request, path, account, 401, body)
        return json(errorBody("authentication_error", "invalid x-api-key"), 401, { "request-id": "req_sim_unauthorized" })
      }),
    )

  const usage = (request: Request, path: string) => {
    const account = accountOf(request)
    if (account === "") {
      record(request, path, account, 401)
      return plainText(errorBody("authentication_error", "invalid token"), 401)
    }
    record(request, path, account, 200)
    const quota = quotaOf(account)
    const asked = new URL(request.url).searchParams.get("cedar_ember") === "1"
    const grants = Arr.filter([options.grants?.(account) ?? []], () => asked).map((listed) => ({
      cedar_ember: { eligible: listed.length > 0, grants: listed.map(grantOfList), weekly_resets_at: iso(quota.sevenDay.resetAt) },
    }))
    return Response.json({ five_hour: windowOf(quota.fiveHour), seven_day: windowOf(quota.sevenDay), ...fableOf(quota), ...grants[0] })
  }

  /** A claim of a grant: answered by the test's `claim`, a request id seen before `already_used`. */
  const claim = (request: Request, path: string, organization: string, text: string) => {
    const account = accountOf(request)
    const body = Option.getOrElse(decodeClaim(text), (): typeof ClaimBody.Type => ({}))
    const requestID = body.request_id ?? ""
    const grant = body.grant_id ?? ""
    const result = claimResult(account, organization, requestID, grant)
    if (requestID !== "" && result === "reset") claimed.add(requestID)
    claims.push({ account, organization, grant, requestID, result })
    const status = claimStatus(result)
    record(request, path, account, status)
    if (status !== 200) return plainText(errorBody("permission_error", result), status)
    if (result !== "reset") return Response.json({ result })
    // A reset answers what it cleared, as Claude Code reads the answer: a give-back clears into the weekly window too.
    const granted = (options.grants?.(account) ?? []).filter((item) => item.id === grant)
    const cleared = [...(granted[0]?.clears ?? []), ...Arr.filter(["seven_day"], () => granted[0]?.givesBackWeekly === true)]
    return Response.json({ result, cleared, resets_left: Math.max(0, (granted[0]?.resetsLeft ?? 1) - 1), weekly_resets_at: iso(quotaOf(account).sevenDay.resetAt) })
  }

  /** What a claim answers: unknown to an organization not the account's, `already_used` for an id seen before, else the test's. */
  const claimResult = (account: string, organization: string, requestID: string, grant: string): string => {
    if (account === "" || organization !== `org-${account}`) return "unauthorized"
    if (requestID !== "" && claimed.has(requestID)) return "already_used"
    return options.claim?.(account, grant) ?? "reset"
  }

  const profile = (request: Request, path: string) => {
    const account = accountOf(request)
    if (account === "") {
      record(request, path, account, 401)
      return plainText(errorBody("authentication_error", "invalid token"), 401)
    }
    record(request, path, account, 200)
    return Response.json({ account: { uuid: `acct-${account}` }, organization: { uuid: `org-${account}` } })
  }

  /** A refresh: rotated, refused, unavailable or rate-limited, as the test's `token` says. */
  const refreshed = (request: Request, path: string, text: string) => {
    const { grant, refresh } = grantOf(header(request, "content-type"), text)
    const entry = [...current].find(([, account]) => account.refresh === refresh)
    if (entry === void 0) {
      record(request, path, "", 400)
      return Effect.succeed(plainText(line({ error: "invalid_grant" }), 400))
    }
    const [name] = entry
    const answer: FakeTokenAnswer = options.token?.(name) ?? { kind: "rotate" }
    record(request, path, name, tokenStatus(answer))
    if (grant !== "refresh_token" || answer.kind === "rejected") return Effect.succeed(plainText(line({ error: "invalid_grant" }), 400))
    if (answer.kind === "unavailable") return Effect.succeed(plainText("unavailable", 503))
    if (answer.kind === "rate-limited") {
      const retryAfter = Option.match(Option.fromNullishOr(answer.retryAfterSeconds), { onNone: () => ({}), onSome: (seconds) => ({ "retry-after": String(seconds) }) })
      return Effect.succeed(new Response("rate limited", { status: 429, headers: { "content-type": "text/plain;charset=utf-8", ...retryAfter } }))
    }
    // A slow token endpoint answers after `delayMs` on the world's clock; the tokens rotate when it answers.
    return Effect.sleep(answer.delayMs ?? 0).pipe(
      Effect.andThen(
        Effect.sync(() => {
          const rotated = { access: token("sim-access"), refresh: token("sim-refresh") }
          current.set(name, rotated)
          return Response.json({ access_token: rotated.access, refresh_token: rotated.refresh, expires_in: 8 * 3600, token_type: "Bearer" })
        }),
      ),
    )
  }

  /** One HTTP exchange; a request to another origin does not connect, as on a host with no route there. */
  const handle = (request: Request): Effect.Effect<Response, SimError> =>
    Effect.gen(function* () {
      const url = new URL(request.url)
      if (url.origin !== ORIGIN) return yield* new SimError({ message: `no route to ${url.origin}: the world's provider answers at ${ORIGIN} only` })
      const path = url.pathname
      if (request.method === "POST" && path === "/v1/messages") return yield* messages(request, path)
      if (request.method === "GET" && path === "/api/oauth/usage") return usage(request, path)
      if (request.method === "POST" && path === "/v1/oauth/token") return yield* refreshed(request, path, yield* Effect.promise(() => request.text()))
      if (request.method === "GET" && path === "/api/oauth/profile") return profile(request, path)
      const claimed = Option.fromNullishOr(CLAIM_PATH.exec(path)?.[1])
      if (request.method === "POST" && Option.isSome(claimed))
        return claim(request, path, decodeURIComponent(claimed.value), yield* Effect.promise(() => request.text()))
      record(request, path, accountOf(request), 404)
      return plainText("not found", 404)
    })

  return {
    handle,
    /**
     * `fetch` onto the provider, as a plugin's fetch option takes it: the exchange runs as a fiber of the world, on its
     * clock; a request elsewhere rejects, as an unreachable host does.
     */
    fetch: (input: string | URL | Request, init?: RequestInit) => Effect.runPromise(Fiber.join(world.fork(handle(new Request(input, init))))),
    received: (): ReadonlyArray<Received> => received,
    /** Every claim of a reset grant, in order. */
    claims: (): ReadonlyArray<Claim> => claims,
    /** The account's current tokens: they change when it refreshes. */
    tokens: (account: string): FakeAccount => current.get(account) ?? { access: "", refresh: "" },
  }
}

export type Provider = ReturnType<typeof make>
