// The eval's pool transport against a fake Anthropic, a fake gent store and a
// fake live pool: no live call. It sends as the auth plugin does, places as the
// pool does (away from the owner's live sessions and holds), fails over on a
// 429 and stops when the pace or every account says so.
import { describe, expect, test } from "bun:test"
import { costOf, create, Ledger, MODEL, poolTransport, useModel, useSleep, useTransport } from "./api.ts"
import { type Live, Pool, PoolLimit, type Source, weeklyDrift } from "./pool.ts"
import type { AccountStatus } from "../../mods/pool/status.ts"
import type { Pace } from "../../mods/pool/pace.ts"

const NOW = Date.UTC(2026, 10, 9, 12)
const HOUR = 3_600_000

const source = (ids: ReadonlyArray<string>): Source => ({
  list: () => ids,
  resolve: async (id) => ({ access: `token-of-${id}`, expires: NOW + HOUR }),
})

const live = (accounts: ReadonlyArray<AccountStatus>, pace: Pace = { ok: true, measured: true, reason: "within pace" }): Live => ({
  status: async () => accounts,
  pace: async () => pace,
})

interface Seen {
  readonly url: string
  readonly headers: Headers
  readonly body: Record<string, unknown>
}

/** A fake Messages endpoint: each request answered by `answer`, by the token it carried. */
const anthropic = (answer: (token: string, seen: Seen) => Response) => {
  const seen: Array<Seen> = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const entry = { url: String(url), headers, body: JSON.parse(String(init?.body)) as Record<string, unknown> }
    seen.push(entry)
    return answer(headers.get("authorization")!.replace("Bearer ", ""), entry)
  }) as typeof fetch
  return { fetcher, seen }
}

/** A tool call of the request's first tool, under the alias it went out with. */
const ok = (seen: Seen, headers: Record<string, string> = {}) =>
  new Response(
    JSON.stringify({
      content: [{ type: "tool_use", id: "t1", name: (seen.body["tools"] as Array<{ name: string }>)[0]!.name, input: { text: "x" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 10 },
    }),
    { status: 200, headers: { "content-type": "application/json", ...headers } },
  )

const usageLimit = () =>
  new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "You have reached your usage limit." } }), {
    status: 429,
    headers: {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-5h-utilization": "1",
      "anthropic-ratelimit-unified-5h-reset": String((NOW + 2 * HOUR) / 1000),
    },
  })

const body = { model: "claude-haiku-4-5-20251001", max_tokens: 100, system: [{ type: "text", text: "You are a coding agent." }], tools: [{ name: "memory_save", description: "Save.", input_schema: { type: "object" } }], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }

const account = (credentialID: string, fields: Partial<AccountStatus> = {}): AccountStatus => ({ credentialID, load: 0, live: 0, noRoom: false, ...fields })

describe("the pool transport", () => {
  test("sends as the auth plugin does: OAuth headers, Claude Code's body, tool names under aliases and back", async () => {
    const fake = anthropic((_, seen) => ok(seen))
    const pool = new Pool({ source: source(["gent:a"]), fetch: fake.fetcher, now: () => NOW })
    const sent = await pool.send("s1", body.model, body)
    const [request] = fake.seen
    expect(request!.url).toBe("https://api.anthropic.com/v1/messages")
    expect(request!.headers.get("authorization")).toBe("Bearer token-of-gent:a")
    expect(request!.headers.get("x-api-key")).toBeNull()
    expect(request!.headers.get("anthropic-beta")).toContain("oauth-2025-04-20")
    expect(request!.headers.get("anthropic-beta")).toContain("claude-code-20250219")
    expect(request!.headers.get("user-agent")).toStartWith("claude-cli/")
    expect(request!.headers.get("x-claude-code-session-id")).not.toBeNull()
    const system = request!.body["system"] as Array<{ text: string }>
    expect(system[0]!.text).toStartWith("x-anthropic-billing-header:")
    expect(system[1]!.text).toBe("You are a Claude agent, built on Anthropic's Claude Agent SDK.")
    expect((request!.body["tools"] as Array<{ name: string }>)[0]!.name).toStartWith("mcp_")
    expect(sent.status).toBe(200)
    expect(JSON.parse(sent.text).content[0].name).toBe("memory_save")
    expect(sent.credentialID).toBe("gent:a")
  })

  test("places away from the owner's live sessions and an account the live pool holds; leaves OpenCode's own logins alone", async () => {
    const fake = anthropic((_, seen) => ok(seen))
    const accounts = [account("own-login"), account("gent:a", { live: 3, load: 5 }), account("gent:b"), account("gent:c", { hold: { kind: "rate-limit", until: NOW + HOUR, at: NOW } })]
    const pool = new Pool({ source: source(["gent:a", "gent:b", "gent:c"]), live: live(accounts), fetch: fake.fetcher, now: () => NOW })
    await pool.refresh()
    expect(pool.accounts).toEqual(["gent:a", "gent:b", "gent:c"])
    expect((await pool.send("s1", body.model, body)).credentialID).toBe("gent:b")
    // A session keeps its account, so its prompt cache stays there.
    pool.record("s1", 1)
    expect((await pool.send("s1", body.model, body)).credentialID).toBe("gent:b")
  })

  test("a 429 holds the account and fails over in the same send; with none left it throws PoolLimit", async () => {
    const fake = anthropic((token, seen) => (token === "token-of-gent:a" ? usageLimit() : ok(seen)))
    const pool = new Pool({ source: source(["gent:a", "gent:b"]), fetch: fake.fetcher, now: () => NOW })
    expect((await pool.send("s1", body.model, body)).credentialID).toBe("gent:b")
    expect(fake.seen.map((seen) => seen.headers.get("authorization"))).toEqual(["Bearer token-of-gent:a", "Bearer token-of-gent:b"])
    expect(pool.line()).toContain("gent:a 5h 100%")
    expect(pool.line()).toContain("held (usage-limit)")

    const refusing = anthropic(() => usageLimit())
    const exhausted = new Pool({ source: source(["gent:a", "gent:b"]), fetch: refusing.fetcher, now: () => NOW })
    const error = await exhausted.send("s1", body.model, body).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PoolLimit)
    expect((error as PoolLimit).retryAt).toBe(NOW + 2 * HOUR)
    expect(refusing.seen).toHaveLength(2)
  })

  test("pace: the live pool's no, then the eval accounts' own readings, stop the run", async () => {
    const wait: Pace = { ok: false, measured: true, reason: "the pool's weekly pace is over", retryAt: NOW + HOUR }
    const told = new Pool({ source: source(["gent:a"]), live: live([account("gent:a")], wait), now: () => NOW })
    expect(await told.pace()).toMatchObject({ ok: false, reason: "live pool: the pool's weekly pace is over" })

    const full = { at: NOW, windows: [{ name: "5h", utilization: 0.95, resetAt: NOW + HOUR }] }
    const near = new Pool({ source: source(["gent:a", "gent:b"]), live: live([account("gent:a", { reading: full }), account("gent:b", { reading: full })]), now: () => NOW })
    const pace = await near.pace()
    expect(pace.ok).toBe(false)
    expect(pace.reason).toStartWith("eval accounts: ")

    const room = new Pool({ source: source(["gent:a"]), live: live([account("gent:a")]), now: () => NOW })
    expect((await room.pace()).ok).toBe(true)
  })

  test("Opus runs only with the owner's approval; Haiku needs none", () => {
    expect(() => useModel("claude-opus-5-5")).toThrow("needs the owner's approval")
    expect(() => useModel("claude-sonnet-5")).toThrow("--model must be one of")
    useModel("claude-opus-5-5", true)
    expect(MODEL).toBe("claude-opus-5-5")
    expect(costOf({ input: 1e6, output: 1e6, cacheWrite: 1e6, cacheRead: 1e6 })).toBeCloseTo(29.2)
    useModel("claude-haiku-5-5")
    expect(MODEL).toBe("claude-haiku-5-5")
  })

  test("weekly: each account's 7-day reading in points; a rise past the limit names the account, a reset does not", async () => {
    const reading = (week: number) => ({ at: NOW, windows: [{ name: "7d", utilization: week, resetAt: NOW + 48 * HOUR }] })
    const pool = new Pool({ source: source(["gent:a", "gent:b"]), live: live([account("gent:a", { reading: reading(0.42) })]), now: () => NOW })
    await pool.refresh()
    expect(pool.weekly()).toEqual({ "gent:a": 42, "gent:b": undefined })

    const start = { "gent:a": 42, "gent:b": 10, "gent:c": undefined }
    expect(weeklyDrift(start, { "gent:a": 46, "gent:b": 14, "gent:c": 90 }, 5)).toBeUndefined()
    expect(weeklyDrift(start, { "gent:a": 48, "gent:b": 17, "gent:c": 90 }, 5)).toEqual({ credentialID: "gent:b", points: 7 })
    expect(weeklyDrift(start, { "gent:a": 2, "gent:b": 10 }, 5)).toBeUndefined()
  })

  test("create sends through the pool, charges the ledger and waits out a hold that ends soon", async () => {
    let now = NOW
    let refusals = 1
    const fake = anthropic((_, seen) => {
      if (refusals-- > 0) return new Response("{}", { status: 429, headers: { "retry-after": "5" } })
      return ok(seen)
    })
    const pool = new Pool({ source: source(["gent:a"]), fetch: fake.fetcher, now: () => now })
    useTransport(poolTransport(pool))
    const waited: Array<number> = []
    useSleep(async (ms) => {
      waited.push(ms)
      now += ms
    })
    const realNow = Date.now
    Date.now = () => now
    try {
      const ledger = new Ledger(1)
      const response = await create(ledger, { system: [{ type: "text", text: "You are a coding agent." }], tools: body.tools, messages: [{ role: "user", content: "hi" }], session: "s1" })
      expect(response.content[0]).toMatchObject({ type: "tool_use", name: "memory_save" })
      expect(ledger.requests).toBe(1)
      expect(waited).toHaveLength(1)
      expect(waited[0]).toBeLessThanOrEqual(5_250)
    } finally {
      Date.now = realNow
    }
  })
})
