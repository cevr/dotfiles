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
import { DateTime, Effect, Option, Schema } from "effect"
import { type FakeAccount, type FakeAnswer, type FakeQuota, type FakeTokenAnswer, unifiedHeaders } from "../tests/fake-anthropic.ts"
import { below, generator, line, SimError } from "./runtime.ts"

export type { FakeAccount as Account, FakeAnswer as Answer, FakeQuota as Quota, FakeTokenAnswer as TokenAnswer }

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
  /** The quota each account's answers report at `now`. Default: 10% of 5h, 20% of 7d, as the fake's. */
  readonly quota?: (account: string, now: number) => FakeQuota
  /** The answer to each refresh of a known refresh token. Default: rotate. */
  readonly token?: (account: string) => FakeTokenAnswer
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

const defaultQuota = (_account: string, at: number): FakeQuota => ({
  fiveHour: { utilization: 0.1, resetAt: at + 3 * HOUR },
  sevenDay: { utilization: 0.2, resetAt: at + 72 * HOUR },
})

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
export const make = (options: Options, now: () => number) => {
  const random = generator(`provider:${options.seed}`)
  const quotaOf = options.quota ?? defaultQuota
  const script = options.script ?? ((): FakeAnswer => ({ kind: "ok" }))
  const current = new Map<string, FakeAccount>(Object.entries(options.accounts))
  const counts = new Map<string, number>()
  const received: Array<Received> = []
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

  /** The streamed message for an `ok` answer, as the fake streams it. */
  const reply = (answer: Extract<FakeAnswer, { kind: "ok" }>, model: string) => {
    state.served += 1
    const id = `msg_sim_${state.served}`
    const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const blocks = Option.match(Option.fromNullishOr(answer.tool), {
      onNone: () => ({ start: { type: "text", text: "" }, delta: { type: "text_delta", text: answer.text ?? "fake: ok" }, stop: "end_turn" }),
      onSome: (tool) => ({
        start: { type: "tool_use", id: `toolu_sim_${state.served}`, name: tool.name, input: {} },
        delta: { type: "input_json_delta", partial_json: line(tool.input) },
        stop: "tool_use",
      }),
    })
    return sse([
      { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: NULL, stop_sequence: NULL, usage: { ...usage, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: blocks.start },
      { type: "content_block_delta", index: 0, delta: blocks.delta },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: blocks.stop, stop_sequence: NULL }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ])
  }

  /** The answer to a known account's message request. */
  const answered = (request: Request, path: string, account: string, body: Body) => {
    const model = String(body["model"] ?? "claude-fake")
    const index = counts.get(account) ?? 0
    counts.set(account, index + 1)
    const answer = script({ account, index, body })
    const at = now()
    const quota = quotaOf(account, at)
    const base = { "request-id": `req_sim_${index}` }
    switch (answer.kind) {
      case "ok":
        record(request, path, account, 200, body)
        return new Response(reply(answer, model), { headers: { ...base, "content-type": "text/event-stream", ...unifiedHeaders(quota, "allowed", "five_hour") } })
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
      return json(errorBody("authentication_error", "invalid token"), 401)
    }
    record(request, path, account, 200)
    const quota = quotaOf(account, now())
    const window = (value: { readonly utilization: number; readonly resetAt: number }) => ({ utilization: value.utilization * 100, resets_at: iso(value.resetAt) })
    return json(line({ five_hour: window(quota.fiveHour), seven_day: window(quota.sevenDay) }), 200)
  }

  const profile = (request: Request, path: string) => {
    const account = accountOf(request)
    if (account === "") {
      record(request, path, account, 401)
      return json(errorBody("authentication_error", "invalid token"), 401)
    }
    record(request, path, account, 200)
    return json(line({ account: { uuid: `acct-${account}` }, organization: { uuid: `org-${account}` } }), 200)
  }

  /** A refresh: rotated, refused, unavailable or rate-limited, as the test's `token` says. */
  const refreshed = (request: Request, path: string, text: string) => {
    const { grant, refresh } = grantOf(header(request, "content-type"), text)
    const entry = [...current].find(([, account]) => account.refresh === refresh)
    if (entry === void 0) {
      record(request, path, "", 400)
      return json(line({ error: "invalid_grant" }), 400)
    }
    const [name] = entry
    const answer = options.token?.(name) ?? { kind: "rotate" }
    record(request, path, name, tokenStatus(answer))
    if (grant !== "refresh_token" || answer.kind === "rejected") return json(line({ error: "invalid_grant" }), 400)
    if (answer.kind === "unavailable") return new Response("unavailable", { status: 503 })
    if (answer.kind === "rate-limited") {
      const headers: Record<string, string> = {}
      if (answer.retryAfterSeconds !== void 0) headers["retry-after"] = String(answer.retryAfterSeconds)
      return new Response("rate limited", { status: 429, headers })
    }
    const rotated = { access: token("sim-access"), refresh: token("sim-refresh") }
    current.set(name, rotated)
    return json(line({ access_token: rotated.access, refresh_token: rotated.refresh, expires_in: 8 * 3600, token_type: "Bearer" }), 200)
  }

  /** One HTTP exchange; a request to another origin does not connect, as on a host with no route there. */
  const handle = (request: Request): Effect.Effect<Response, SimError> =>
    Effect.gen(function* () {
      const url = new URL(request.url)
      if (url.origin !== ORIGIN) return yield* new SimError({ message: `no route to ${url.origin}: the world's provider answers at ${ORIGIN} only` })
      const path = url.pathname
      if (request.method === "POST" && path === "/v1/messages") return yield* messages(request, path)
      if (request.method === "GET" && path === "/api/oauth/usage") return usage(request, path)
      if (request.method === "POST" && path === "/v1/oauth/token") return refreshed(request, path, yield* Effect.promise(() => request.text()))
      if (request.method === "GET" && path === "/api/oauth/profile") return profile(request, path)
      record(request, path, accountOf(request), 404)
      return new Response("not found", { status: 404 })
    })

  return {
    handle,
    /** `fetch` onto the provider, as a plugin's fetch option takes it: a request elsewhere rejects, as an unreachable host does. */
    fetch: (input: string | URL | Request, init?: RequestInit) => Effect.runPromise(handle(new Request(input, init))),
    received: (): ReadonlyArray<Received> => received,
    /** The account's current tokens: they change when it refreshes. */
    tokens: (account: string): FakeAccount => current.get(account) ?? { access: "", refresh: "" },
  }
}

export type Provider = ReturnType<typeof make>
