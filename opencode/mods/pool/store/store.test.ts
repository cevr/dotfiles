// The login store source's refresh timing against a fake token endpoint and a
// fake clock: when a token is refreshed, what a refresh that cannot happen
// serves, how trades from one store are spaced, what the read that never trades
// returns, and what is logged. The store is its slot-file layout in a temporary
// directory; its lock is the real SQLite lock. Every token is a fake.
import { afterAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Logger } from "effect"
import {
  STORE_PREFIX,
  CLAUDE_USER_AGENT,
  StoreCredentialError,
  StoreSource,
  isStoreOwned,
  slotPath,
  REFRESH_AHEAD_MS,
  REFRESH_GAP_MS,
  REFRESH_JITTER_MS,
  refreshJitter,
  withStoreLock,
} from "./store.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const root = mkdtempSync(join(tmpdir(), "login-store-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const token = (kind: string) => `fake-${kind}-${randomBytes(12).toString("hex")}`

/** What the fake endpoint answers one trade. */
type Answer = "rotate" | "rate-limited" | "unavailable" | "unreachable" | "refused"

interface Trade {
  /** The fake clock when the trade went out. */
  readonly at: number
  readonly refresh: string
}

/** The `user-agent` of every trade the fake endpoint saw, in order. */
const agents: Array<string | null> = []

interface Bench {
  readonly dir: string
  readonly source: StoreSource
  /** The fake clock, epoch ms. */
  readonly clock: { now: number }
  readonly trades: Array<Trade>
  /** Everything logged, as level and text. */
  readonly logs: Array<{ readonly level: string; readonly text: string }>
  /** Every token written to the store or answered by the endpoint. */
  readonly tokens: Array<string>
  /** Sign `label` in to the store, expiring at `expires`. */
  readonly signIn: (label: string, expires: number) => { readonly access: string; readonly refresh: string }
  readonly file: (label: string) => string
}

/** A login store, a fake endpoint answering each trade with `answer()`, and a clock a trade's wait moves. */
const bench = (answer: () => Answer = () => "rotate", options: { lockPolls?: number } = {}): Bench => {
  const dir = mkdtempSync(join(root, "store-"))
  const slots = join(dir, ".slots/anthropic")
  mkdirSync(slots, { recursive: true })
  const clock = { now: 1_800_000_000_000 }
  const trades: Array<Trade> = []
  const logs: Array<{ level: string; text: string }> = []
  const tokens: Array<string> = []
  const logger = Logger.make(({ logLevel, message }) => {
    logs.push({ level: logLevel, text: (Array.isArray(message) ? message : [message]).map(String).join(" ") })
  })
  const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
    const refresh = new URLSearchParams(String(init.body)).get("refresh_token") ?? ""
    trades.push({ at: clock.now, refresh })
    agents.push(new Headers(init.headers).get("user-agent"))
    const kind = answer()
    if (kind === "unreachable") return Promise.reject(new TypeError("fetch failed"))
    if (kind === "rate-limited") return new Response("<html>Error 1015</html>", { status: 429, headers: { server: "cloudflare" } })
    if (kind === "unavailable") return new Response("down", { status: 503 })
    if (kind === "refused") return Response.json({ error: "invalid_grant", error_description: "Refresh token not found or invalid" }, { status: 400 })
    const next = { access_token: token("access"), refresh_token: token("refresh"), expires_in: 8 * 3600 }
    tokens.push(next.access_token, next.refresh_token)
    return Response.json(next)
  }
  const source = new StoreSource({
    dir,
    tokenURL: "http://token.invalid/v1/oauth/token",
    fetch,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms
    },
    context: Context.make(Logger.CurrentLoggers, new Set([logger])),
    ...(options.lockPolls === undefined ? {} : { lockPolls: options.lockPolls }),
  })
  return {
    dir,
    source,
    clock,
    trades,
    logs,
    tokens,
    signIn: (label, expires) => {
      const login = { access: token("access"), refresh: token("refresh") }
      tokens.push(login.access, login.refresh)
      writeFileSync(
        join(slots, label),
        JSON.stringify({ _tag: "Oauth", type: "oauth", ...login, expires, accountId: null, metadata: { owner: "store" } }),
        { mode: 0o600 },
      )
      return login
    },
    file: (label) => readFileSync(join(slots, label), "utf8"),
  }
}

const id = (label: string) => `${STORE_PREFIX}${label}`

const failure = async (run: Promise<unknown>): Promise<StoreCredentialError> => {
  const outcome = await run.then(
    () => undefined,
    (error: unknown) => error,
  )
  if (outcome instanceof StoreCredentialError) return outcome
  return expect.unreachable(`expected a StoreCredentialError, got ${String(outcome)}`)
}

/** When a label's token falls due: the refresh-ahead window plus its jitter. */
const window = (label: string) => REFRESH_AHEAD_MS + refreshJitter(label)

describe("a token is refreshed ahead of its expiry", () => {
  test("the jitter is fixed per label, within bounds, and spreads labels apart", () => {
    const labels = Array.from({ length: 64 }, (_, index) => `account-${index}`)
    for (const label of labels) {
      expect(refreshJitter(label)).toBe(refreshJitter(label))
      expect(refreshJitter(label)).toBeGreaterThanOrEqual(0)
      expect(refreshJitter(label)).toBeLessThanOrEqual(REFRESH_JITTER_MS)
      expect(Number.isInteger(refreshJitter(label))).toBe(true)
    }
    // Seven accounts signed in together fall due at seven different times.
    expect(new Set(labels.slice(0, 7).map((label) => refreshJitter(label))).size).toBe(7)
    expect(refreshJitter("alpha", 0)).toBe(0)
    expect(refreshJitter("alpha", 10)).toBeLessThanOrEqual(10)
  })

  test("a token outside its label's window is served; one inside it is refreshed", async () => {
    const { source, clock, trades, signIn } = bench()
    const early = signIn("alpha", clock.now + window("alpha") + 1)
    expect((await source.resolve(id("alpha"))).access).toBe(early.access)
    expect(trades).toHaveLength(0)

    const due = signIn("beta", clock.now + window("beta"))
    const refreshed = await source.resolve(id("beta"))
    expect(refreshed.access).not.toBe(due.access)
    expect(trades).toEqual([{ at: clock.now, refresh: due.refresh }])
    expect(refreshed.expires).toBe(clock.now + 8 * HOUR)
  })

  test("a trade names Claude Code's user agent, never the host's default", async () => {
    const { source, clock, signIn } = bench()
    signIn("alpha", clock.now)
    const from = agents.length
    await source.resolve(id("alpha"))
    expect(agents.slice(from)).toEqual([CLAUDE_USER_AGENT])
  })
})

describe("a refresh that cannot happen serves a token that is still good", () => {
  for (const answer of ["rate-limited", "unavailable", "unreachable"] as const) {
    test(`a ${answer} endpoint serves the stored token and writes nothing`, async () => {
      const { source, clock, trades, signIn, file } = bench(() => answer)
      const login = signIn("alpha", clock.now + 3 * MINUTE)
      const before = file("alpha")
      expect(await source.resolve(id("alpha"))).toEqual({ access: login.access, expires: clock.now + 3 * MINUTE })
      expect(trades).toHaveLength(1)
      expect(file("alpha")).toBe(before)
    })
  }

  test("a paused store serves every still-good token without a trade", async () => {
    const { source, clock, trades, signIn } = bench(() => "rate-limited")
    signIn("alpha", clock.now - 1000)
    expect((await failure(source.resolve(id("alpha")))).kind).toBe("unavailable")
    expect(trades).toHaveLength(1)

    // Long after the gap, still inside the five-minute pause.
    clock.now += MINUTE
    const beta = signIn("beta", clock.now + 2 * MINUTE)
    expect((await source.resolve(id("beta"))).access).toBe(beta.access)
    expect(trades).toHaveLength(1)
  })

  test("a lock another process holds for the whole wait serves the stored token", async () => {
    const { dir, source, clock, trades, signIn } = bench(() => "rotate", { lockPolls: 2 })
    const login = signIn("alpha", clock.now + 3 * MINUTE)
    const release = Promise.withResolvers<void>()
    const taken = Promise.withResolvers<void>()
    const held = Effect.runPromise(
      withStoreLock(dir, Effect.sync(() => taken.resolve()).pipe(Effect.andThen(Effect.promise(() => release.promise)))),
    )
    await taken.promise
    const served = await source.resolve(id("alpha"))
    release.resolve()
    await held
    expect(served.access).toBe(login.access)
    expect(trades).toHaveLength(0)
  })

  test("a token in its last minute must be refreshed: the failure fails the resolve", async () => {
    const { source, clock, signIn } = bench(() => "rate-limited")
    signIn("alpha", clock.now + 30_000)
    const error = await failure(source.resolve(id("alpha")))
    expect(error.kind).toBe("unavailable")
    expect(error.retryAt).toBe(clock.now + 5 * MINUTE)
  })

  test("a token a provider rejected has no fallback", async () => {
    const { source, clock, trades, signIn } = bench(() => "unavailable")
    const login = signIn("alpha", clock.now + 8 * HOUR)
    source.rejected(id("alpha"), login.access)
    expect((await failure(source.resolve(id("alpha")))).kind).toBe("unavailable")
    expect(trades).toHaveLength(1)
  })
})

describe("trades from one store are spaced", () => {
  test("a burst of seven expired accounts trades at least the gap apart, and every one is served", async () => {
    const { source, clock, trades, signIn } = bench()
    const labels = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"]
    const logins = labels.map((label) => signIn(label, clock.now - 1000))
    const served = await Promise.all(labels.map((label) => source.resolve(id(label))))
    expect(trades).toHaveLength(7)
    for (let index = 1; index < trades.length; index++) {
      const gap = (trades[index]?.at ?? 0) - (trades[index - 1]?.at ?? 0)
      expect(gap).toBeGreaterThanOrEqual(REFRESH_GAP_MS)
    }
    served.forEach((credential, index) => expect(credential.access).not.toBe(logins[index]?.access))
  })

  test("a still-good account inside the gap is served now and refreshed by a later request", async () => {
    const { source, clock, trades, signIn } = bench()
    signIn("alpha", clock.now + 2 * MINUTE)
    const beta = signIn("beta", clock.now + 2 * MINUTE)
    await source.resolve(id("alpha"))
    expect((await source.resolve(id("beta"))).access).toBe(beta.access)
    expect(trades).toHaveLength(1)

    clock.now += REFRESH_GAP_MS
    expect((await source.resolve(id("beta"))).access).not.toBe(beta.access)
    expect(trades.map((trade) => trade.refresh)).toContain(beta.refresh)
  })
})

describe("peek reads without trading", () => {
  test("serves a good token, even one due a refresh, and nothing for one that must be refreshed", async () => {
    const { source, clock, trades, signIn } = bench()
    const good = signIn("good", clock.now + 8 * HOUR)
    const due = signIn("due", clock.now + 2 * MINUTE)
    signIn("expired", clock.now - 1000)
    signIn("last-minute", clock.now + 30_000)
    const rejected = signIn("rejected", clock.now + 8 * HOUR)
    source.rejected(id("rejected"), rejected.access)

    expect(await source.peek(id("good"))).toEqual({ access: good.access, expires: clock.now + 8 * HOUR })
    expect(await source.peek(id("due"))).toEqual({ access: due.access, expires: clock.now + 2 * MINUTE })
    expect(await source.peek(id("expired"))).toBeUndefined()
    expect(await source.peek(id("last-minute"))).toBeUndefined()
    expect(await source.peek(id("rejected"))).toBeUndefined()
    expect(await source.peek(id("missing"))).toBeUndefined()
    expect(await source.peek("cred_other")).toBeUndefined()
    expect(trades).toHaveLength(0)
  })
})

describe("logging", () => {
  test("each trade is logged at info with its label and outcome, a pause once at warning, never a token", async () => {
    let answer: Answer = "rotate"
    const { source, clock, logs, tokens, signIn } = bench(() => answer)
    signIn("alpha", clock.now - 1000)
    await source.resolve(id("alpha"))
    expect(logs).toEqual([{ level: "Info", text: expect.stringContaining('store refresh "alpha": refreshed') }])

    answer = "rate-limited"
    clock.now += REFRESH_GAP_MS
    signIn("beta", clock.now - 1000)
    signIn("gamma", clock.now - 1000)
    expect((await failure(source.resolve(id("beta")))).kind).toBe("unavailable")
    expect((await failure(source.resolve(id("gamma")))).kind).toBe("unavailable")
    const pauseEnd = new Date(clock.now + 5 * MINUTE).toISOString()
    expect(logs.slice(1)).toEqual([
      { level: "Warn", text: expect.stringContaining(`waits until ${pauseEnd}`) },
      { level: "Info", text: expect.stringContaining('store refresh "beta": unavailable') },
    ])
    for (const { text } of logs) for (const secret of tokens) expect(text).not.toContain(secret)
  })
})

describe("a login whose refresh token the endpoint refused is lost until its file changes", () => {
  const lost = (source: StoreSource) => Effect.runPromise(source.lost)

  test("a refusal lists the login, since its first refusal, with the slot file to sign it in to again", async () => {
    let answer: Answer = "refused"
    const { dir, source, clock, signIn } = bench(() => answer)
    signIn("alpha", clock.now - 1000)
    signIn("beta", clock.now + 8 * HOUR)
    const first = clock.now
    expect((await failure(source.resolve(id("alpha")))).kind).toBe("rejected")
    const entry = {
      credentialID: id("alpha"),
      label: "alpha",
      since: first,
      slot: join(dir, ".slots/anthropic/alpha"),
    }
    expect(await lost(source)).toEqual([entry])

    // Refused again later: still the first refusal.
    clock.now += MINUTE
    expect((await failure(source.resolve(id("alpha")))).kind).toBe("rejected")
    expect(await lost(source)).toEqual([entry])

    // The owner signs in again: the file holds another login.
    answer = "rotate"
    signIn("alpha", clock.now + 8 * HOUR)
    expect(await lost(source)).toEqual([])
  })

  test("a new sign-in, another process's refresh, or a removed label clears it", async () => {
    let answer: Answer = "refused"
    const { dir, source, clock, signIn } = bench(() => answer)
    signIn("alpha", clock.now - 1000)
    signIn("beta", clock.now - 1000)
    signIn("gamma", clock.now - 1000)
    for (const label of ["alpha", "beta", "gamma"]) {
      expect((await failure(source.resolve(id(label)))).kind).toBe("rejected")
      clock.now += REFRESH_GAP_MS
    }
    expect((await lost(source)).map((login) => login.label)).toEqual(["alpha", "beta", "gamma"])

    answer = "rotate"
    signIn("alpha", clock.now - 1000)
    await source.resolve(id("alpha"))
    // Another process refreshed beta: another login in the file.
    signIn("beta", clock.now + 8 * HOUR)
    rmSync(join(dir, ".slots/anthropic/gamma"))
    expect(await lost(source)).toEqual([])
  })

  test("the slot file names the home directory as ~", () => {
    expect(slotPath(join(homedir(), ".local/share/opencode-prime/pool-auth"), "work")).toBe(
      "~/.local/share/opencode-prime/pool-auth/.slots/anthropic/work",
    )
    expect(slotPath("/tmp/a store", "work")).toBe("/tmp/a store/.slots/anthropic/work")
  })
})

describe("a run of trades the endpoint fails is recorded with its cause", () => {
  const record = (source: StoreSource) => Effect.runPromise(source.refreshes)

  test("a 429 starts the run with its status and server; a paused trade extends it and keeps the cause", async () => {
    let answer: Answer = "rate-limited"
    const { source, clock, signIn } = bench(() => answer)
    expect(await record(source)).toEqual({ failures: 0, pausedUntil: 0 })
    signIn("alpha", clock.now - 1000)
    const start = clock.now
    await failure(source.resolve(id("alpha")))
    const cause = { status: 429, server: "cloudflare" }
    expect(await record(source)).toEqual({
      failingSince: start,
      lastFailureAt: start,
      failures: 1,
      cause,
      pausedUntil: start + 5 * MINUTE,
    })

    clock.now += MINUTE
    await failure(source.resolve(id("alpha")))
    expect(await record(source)).toEqual({
      failingSince: start,
      lastFailureAt: start + MINUTE,
      failures: 2,
      cause,
      pausedUntil: start + 5 * MINUTE,
    })

    // The pause ends and a trade refreshes: the run is over.
    answer = "rotate"
    clock.now = start + 5 * MINUTE
    await source.resolve(id("alpha"))
    expect(await record(source)).toEqual({ failures: 0, pausedUntil: start + 5 * MINUTE })
  })

  test("a 5xx names its status, no answer names none, and a refusal ends the run", async () => {
    let answer: Answer = "unavailable"
    const { source, clock, signIn, tokens } = bench(() => answer)
    signIn("alpha", clock.now - 1000)
    await failure(source.resolve(id("alpha")))
    expect((await record(source)).cause).toEqual({ status: 503 })

    answer = "unreachable"
    clock.now += REFRESH_GAP_MS
    await failure(source.resolve(id("alpha")))
    expect(await record(source)).toMatchObject({ failures: 2, cause: {} })

    answer = "refused"
    clock.now += REFRESH_GAP_MS
    await failure(source.resolve(id("alpha")))
    const after = await record(source)
    expect(after).toEqual({ failures: 0, pausedUntil: 0 })
    const said = JSON.stringify([after, await Effect.runPromise(source.lost)])
    for (const secret of tokens) expect(said).not.toContain(secret)
  })
})

describe("a store's state outlives a hot reload", () => {
  test("a state an older copy of the module left, without the newer fields, is completed and kept", async () => {
    const dir = mkdtempSync(join(root, "store-"))
    mkdirSync(join(dir, ".slots/anthropic"), { recursive: true })
    // What the module before the lost-login alert kept for a store: no refusals, no failure run.
    const older = { pending: new Map(), rejected: new Map(), queue: Promise.resolve(), pausedUntil: 1234, lastTradeAt: 5678 }
    const global = globalThis as unknown as Record<symbol, Map<string, unknown> | undefined>
    const states = (global[Symbol.for("dotfiles-opencode.pool.login-stores")] ??= new Map())
    states.set(dir, older)
    const source = new StoreSource({ dir, tokenURL: "http://token.invalid/v1/oauth/token" })
    expect(await Effect.runPromise(source.lost)).toEqual([])
    expect((await Effect.runPromise(source.refreshes)).failures).toBe(0)
    // The older copy's pause and spacing still hold.
    expect(states.get(dir)).toBe(older)
    expect(older.pausedUntil).toBe(1234)
    expect(older.lastTradeAt).toBe(5678)
  })
})

describe("which sign-ins the store owns", () => {
  const unmarked = { type: "oauth" as const, access: "a", refresh: "r", expires: 1 }
  const signIn = (metadata: Record<string, string>) => ({ ...unmarked, metadata })
  test("any sign-in naming an owner, whichever wrote it; never a linked Claude Code login or one naming none", () => {
    // The owner mark the files already on disk carry is kept as written; any owner counts.
    expect(isStoreOwned(signIn({ owner: "store" }))).toBe(true)
    expect(isStoreOwned(signIn({ owner: "someone-else" }))).toBe(true)
    expect(isStoreOwned(signIn({ owner: "store", source: "claude-code" }))).toBe(false)
    expect(isStoreOwned(signIn({ source: "claude-code" }))).toBe(false)
    expect(isStoreOwned(signIn({}))).toBe(false)
    expect(isStoreOwned(unmarked)).toBe(false)
    expect(isStoreOwned(signIn({ owner: "" }))).toBe(false)
  })
})
