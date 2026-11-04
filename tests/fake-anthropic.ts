/**
 * A fake Anthropic API on a loopback port, for the pool's deterministic
 * tests: `POST /v1/messages` (streamed or not), `GET /api/oauth/usage` and
 * `POST /v1/oauth/token` (a JSON body, as the auth plugin sends, or a form,
 * as gent sends). It answers with the headers the real API sends a
 * Claude plan login: the unified quota headers on every answer, a refusal
 * included, and the classic `anthropic-ratelimit-*` pairs and `retry-after`
 * on a 429.
 *
 * Accounts are fake logins the test makes: each has an access and a refresh
 * token the test draws at run time, so no token is a fixture. A request is
 * told apart by the bearer token it carries and recorded under the account's
 * name; the record never holds a token.
 *
 * What each request gets is the test's `script`: an answer per request,
 * chosen from what the request carries (its account, its body, how many
 * requests that account has made).
 *
 * @module
 */

/** One fake login. The tokens are the test's own random strings. */
export interface FakeAccount {
  readonly access: string
  readonly refresh: string
}

/** A quota window as the unified headers carry it: utilization 0..1 and the reset in epoch ms. */
export interface FakeWindow {
  readonly utilization: number
  readonly resetAt: number
}

export interface FakeQuota {
  readonly fiveHour: FakeWindow
  readonly sevenDay: FakeWindow
}

/** What one request is answered with. */
export type FakeAnswer =
  /** A normal reply: `text`, or a call of the request's first tool named in `tool`. */
  | { readonly kind: "ok"; readonly text?: string; readonly tool?: { readonly name: string; readonly input: unknown } }
  /** A transient rate limit (requests per minute), with `retry-after`. */
  | { readonly kind: "transient-429"; readonly retryAfterSeconds: number }
  /** The plan refuses the account until `resetAt` (epoch ms) on the window `claim` names. */
  | { readonly kind: "usage-429"; readonly claim: "five_hour" | "seven_day"; readonly resetAt: number }
  /** The access token is not (or no longer) valid. */
  | { readonly kind: "unauthorized" }
  /** Anthropic is overloaded (529). */
  | { readonly kind: "overloaded" }

/** What the token endpoint answers a refresh with. */
export type FakeTokenAnswer =
  /** Rotate both tokens, after `delayMs` when given. */
  | { readonly kind: "rotate"; readonly delayMs?: number }
  /** A 503, as a token endpoint that is down. */
  | { readonly kind: "unavailable" }
  /** A 400 `invalid_grant`, as for a refresh token that was spent or revoked. */
  | { readonly kind: "rejected" }

/** What the fake knows of one request when it picks the answer. */
export interface FakeRequestInfo {
  /** The account whose access token signed it, or `undefined` for an unknown token. */
  readonly account: string | undefined
  /** How many `/v1/messages` requests this account made before this one. */
  readonly index: number
  readonly body: Record<string, unknown>
}

/** A request the fake received, as tests assert on it. */
export interface ReceivedRequest {
  readonly path: string
  readonly account: string | undefined
  readonly status: number
  readonly model: string | undefined
  /** How many tools the request offered: an agent turn offers some, a title request none. */
  readonly tools: number
  readonly betas: ReadonlyArray<string>
  readonly sessionHeader: string | undefined
  /** Headers named `x-opencode-*`: none should ever reach Anthropic. */
  readonly opencodeHeaders: ReadonlyArray<string>
  readonly at: number
}

export interface FakeAnthropicOptions {
  readonly accounts: Readonly<Record<string, FakeAccount>>
  /** The answer to each `/v1/messages` request. Default: `ok`. */
  readonly script?: (request: FakeRequestInfo) => FakeAnswer
  /** The quota each account's answers report. Default: 10% of 5h, 20% of 7d. */
  readonly quota?: (account: string) => FakeQuota
  /** Clock for the reset times the default quota names. */
  readonly now?: () => number
  /** The answer to each refresh of a known refresh token. Default: rotate at once. */
  readonly token?: (account: string) => FakeTokenAnswer
}

export interface FakeAnthropic {
  readonly url: string
  readonly port: number
  readonly received: ReadonlyArray<ReceivedRequest>
  /** The account's current tokens: they change when it refreshes. */
  readonly tokens: (account: string) => FakeAccount
  readonly stop: () => Promise<void>
}

const HOUR = 3_600_000

/** A random token: the fake's logins are made at run time, never stored. */
export const randomToken = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

/** A fake login with fresh random tokens. */
export const fakeAccount = (): FakeAccount => ({ access: randomToken("fake-access"), refresh: randomToken("fake-refresh") })

const seconds = (ms: number) => String(Math.floor(ms / 1000))

/**
 * The wire name of the tool a request offers as `name`. The auth plugin
 * renames tools on the way out (`mcp_T` and the name in base64url), so a
 * script names the tool OpenCode knows and calls it by the name the request
 * carries.
 */
export const offeredTool = (body: Record<string, unknown>, name: string): string | undefined => {
  const tools = Array.isArray(body.tools) ? (body.tools as Array<{ name?: unknown }>) : []
  const alias = `mcp_T${Buffer.from(name, "utf8").toString("base64url")}`
  return tools
    .map((tool) => (typeof tool.name === "string" ? tool.name : ""))
    .find((wire) => wire === name || wire === `mcp_${name}` || wire === alias)
}

/** Whether the request's last message carries a tool result. */
export const answersTool = (body: Record<string, unknown>): boolean => {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ content?: unknown }>) : []
  const content = messages.at(-1)?.content
  return (
    Array.isArray(content) &&
    content.some((block: unknown) => typeof block === "object" && block !== null && "type" in block && block.type === "tool_result")
  )
}

/** The unified quota headers for `quota`, `status` and the window that limits the account. */
export const unifiedHeaders = (
  quota: FakeQuota,
  status: "allowed" | "allowed_warning" | "rejected",
  claim: "five_hour" | "seven_day",
): Record<string, string> => ({
  "anthropic-ratelimit-unified-status": status,
  "anthropic-ratelimit-unified-representative-claim": claim,
  "anthropic-ratelimit-unified-reset": seconds(claim === "five_hour" ? quota.fiveHour.resetAt : quota.sevenDay.resetAt),
  "anthropic-ratelimit-unified-5h-utilization": String(quota.fiveHour.utilization),
  "anthropic-ratelimit-unified-5h-reset": seconds(quota.fiveHour.resetAt),
  "anthropic-ratelimit-unified-7d-utilization": String(quota.sevenDay.utilization),
  "anthropic-ratelimit-unified-7d-reset": seconds(quota.sevenDay.resetAt),
})

const sse = (events: ReadonlyArray<Record<string, unknown>>) =>
  events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("")

const errorBody = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } })

let served = 0

/** The streamed (or whole) message for an `ok` answer. */
const replyBody = (answer: Extract<FakeAnswer, { kind: "ok" }>, model: string, stream: boolean) => {
  served += 1
  const id = `msg_fake_${served}`
  const block = answer.tool
    ? { type: "tool_use", id: `toolu_fake_${served}`, name: answer.tool.name, input: answer.tool.input }
    : { type: "text", text: answer.text ?? "fake: ok" }
  const stop = answer.tool ? "tool_use" : "end_turn"
  const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  if (!stream) {
    return {
      type: "application/json",
      body: JSON.stringify({
        id,
        type: "message",
        role: "assistant",
        model,
        content: [block],
        stop_reason: stop,
        stop_sequence: null,
        usage,
      }),
    }
  }
  const start =
    block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" }
  const delta =
    block.type === "tool_use"
      ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
      : { type: "text_delta", text: block.text }
  return {
    type: "text/event-stream",
    body: sse([
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...usage, output_tokens: 1 },
        },
      },
      { type: "content_block_start", index: 0, content_block: start },
      { type: "content_block_delta", index: 0, delta },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ]),
  }
}

/** Serve the fake on a free loopback port. */
export const startFakeAnthropic = (options: FakeAnthropicOptions): FakeAnthropic => {
  const now = options.now ?? Date.now
  const defaultQuota = (): FakeQuota => ({
    fiveHour: { utilization: 0.1, resetAt: now() + 3 * HOUR },
    sevenDay: { utilization: 0.2, resetAt: now() + 72 * HOUR },
  })
  const quotaOf = options.quota ?? defaultQuota
  const script = options.script ?? (() => ({ kind: "ok" }) as const)
  const current = new Map<string, FakeAccount>(Object.entries(options.accounts))
  const counts = new Map<string, number>()
  const received: ReceivedRequest[] = []

  const accountOf = (request: Request): string | undefined => {
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "")
    if (!token) return undefined
    for (const [name, account] of current) if (account.access === token) return name
    return undefined
  }

  const record = (
    request: Request,
    path: string,
    account: string | undefined,
    status: number,
    model?: string,
    body?: Record<string, unknown>,
  ) => {
    const opencodeHeaders: string[] = []
    request.headers.forEach((_value, name) => {
      if (name.toLowerCase().startsWith("x-opencode")) opencodeHeaders.push(name.toLowerCase())
    })
    received.push({
      path,
      account,
      status,
      model,
      tools: Array.isArray(body?.tools) ? body.tools.length : 0,
      betas: (request.headers.get("anthropic-beta") ?? "")
        .split(",")
        .map((beta) => beta.trim())
        .filter((beta) => beta !== ""),
      sessionHeader: request.headers.get("x-claude-code-session-id") ?? undefined,
      opencodeHeaders,
      at: now(),
    })
  }

  const messages = async (request: Request, path: string) => {
    const account = accountOf(request)
    const body = (await request.json()) as Record<string, unknown>
    const model = typeof body.model === "string" ? body.model : "claude-fake"
    if (account === undefined) {
      record(request, path, account, 401, model, body)
      return new Response(errorBody("authentication_error", "invalid x-api-key"), {
        status: 401,
        headers: { "content-type": "application/json", "request-id": "req_fake_unauthorized" },
      })
    }
    const index = counts.get(account) ?? 0
    counts.set(account, index + 1)
    const answer = script({ account, index, body })
    const quota = quotaOf(account)
    const base = { "request-id": `req_fake_${index}` }
    switch (answer.kind) {
      case "ok": {
        const reply = replyBody(answer, model, body.stream === true)
        record(request, path, account, 200, model, body)
        return new Response(reply.body, {
          headers: { ...base, "content-type": reply.type, ...unifiedHeaders(quota, "allowed", "five_hour") },
        })
      }
      case "transient-429": {
        record(request, path, account, 429, model, body)
        const reset = new Date(now() + answer.retryAfterSeconds * 1000).toISOString()
        return new Response(errorBody("rate_limit_error", "Number of requests has exceeded your per-minute rate limit"), {
          status: 429,
          headers: {
            ...base,
            "content-type": "application/json",
            "retry-after": String(answer.retryAfterSeconds),
            "anthropic-ratelimit-requests-remaining": "0",
            "anthropic-ratelimit-requests-reset": reset,
            "anthropic-ratelimit-tokens-remaining": "1000",
            "anthropic-ratelimit-tokens-reset": reset,
            ...unifiedHeaders(quota, "allowed", "five_hour"),
          },
        })
      }
      case "usage-429": {
        record(request, path, account, 429, model, body)
        const refused: FakeQuota =
          answer.claim === "five_hour"
            ? { ...quota, fiveHour: { utilization: 1, resetAt: answer.resetAt } }
            : { ...quota, sevenDay: { utilization: 1, resetAt: answer.resetAt } }
        return new Response(errorBody("rate_limit_error", "You have reached your session usage limit."), {
          status: 429,
          headers: {
            ...base,
            "content-type": "application/json",
            "retry-after": String(Math.max(0, Math.ceil((answer.resetAt - now()) / 1000))),
            ...unifiedHeaders(refused, "rejected", answer.claim),
          },
        })
      }
      case "unauthorized":
        record(request, path, account, 401, model, body)
        return new Response(errorBody("authentication_error", "OAuth token has expired."), {
          status: 401,
          headers: { ...base, "content-type": "application/json" },
        })
      case "overloaded":
        record(request, path, account, 529, model, body)
        return new Response(errorBody("overloaded_error", "Overloaded"), {
          status: 529,
          headers: { ...base, "content-type": "application/json", ...unifiedHeaders(quota, "allowed", "five_hour") },
        })
    }
  }

  const usage = (request: Request, path: string) => {
    const account = accountOf(request)
    record(request, path, account, account === undefined ? 401 : 200)
    if (account === undefined) return new Response(errorBody("authentication_error", "invalid token"), { status: 401 })
    const quota = quotaOf(account)
    const window = (value: FakeWindow) => ({
      utilization: value.utilization * 100,
      resets_at: new Date(value.resetAt).toISOString(),
    })
    return Response.json({ five_hour: window(quota.fiveHour), seven_day: window(quota.sevenDay) })
  }

  /** A refresh as JSON (the auth plugin's) or as a form (gent's). */
  const tokenBody = async (request: Request): Promise<{ grant_type?: string; refresh_token?: string }> => {
    if ((request.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
      const form = new URLSearchParams(await request.text())
      return { grant_type: form.get("grant_type") ?? undefined, refresh_token: form.get("refresh_token") ?? undefined }
    }
    return (await request.json()) as { grant_type?: string; refresh_token?: string }
  }

  const token = async (request: Request, path: string) => {
    const body = await tokenBody(request)
    const entry = [...current].find(([, account]) => account.refresh === body.refresh_token)
    const answer = entry === undefined ? undefined : (options.token?.(entry[0]) ?? { kind: "rotate" as const })
    const status = entry === undefined || answer?.kind === "rejected" ? 400 : answer?.kind === "unavailable" ? 503 : 200
    record(request, path, entry?.[0], status)
    if (body.grant_type !== "refresh_token" || entry === undefined || answer?.kind === "rejected") {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    }
    if (answer?.kind === "unavailable") return new Response("unavailable", { status: 503 })
    if (answer?.kind === "rotate" && answer.delayMs !== undefined) await Bun.sleep(answer.delayMs)
    const rotated = fakeAccount()
    current.set(entry[0], rotated)
    return Response.json({
      access_token: rotated.access,
      refresh_token: rotated.refresh,
      expires_in: 8 * 3600,
      token_type: "Bearer",
    })
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      if (request.method === "POST" && path === "/v1/messages") return messages(request, path)
      if (request.method === "GET" && path === "/api/oauth/usage") return usage(request, path)
      if (request.method === "POST" && path === "/v1/oauth/token") return token(request, path)
      record(request, path, accountOf(request), 404)
      return new Response("not found", { status: 404 })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port ?? 0,
    received,
    tokens: (account) => {
      const found = current.get(account)
      if (found === undefined) throw new Error(`no fake account ${account}`)
      return found
    },
    stop: () => server.stop(true),
  }
}
