// A store account whose refresh is rate-limited, on the simulated host, at 20
// seeds: tests/pool-store-refresh.test.ts's name and claims, moved off real
// OpenCode. Two accounts in a login store the pool reads in place (memory
// slots, mods/pool/memory/slots.ts): alpha's token has expired and the token
// endpoint answers its refresh with a 429. That must not end the turn: the
// request is refused as a retryable rate limit, the session retries, and the
// pool places the retry on beta, where the turn completes with no error.
import { Effect, Option } from "effect"
import * as MemorySlots from "@dotfiles/opencode-pool/memory/slots"
import { decodeStoredOAuth, encodeRefresh } from "@dotfiles/opencode-pool/store/store"
import * as Plugins from "../../sim/plugins.ts"
import * as Provider from "../../sim/provider.ts"
import { line } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/pool/pool-store-refresh.sim.test.ts")

const HOUR = 3_600_000
const WORK = "/scratch/work"
const STORE = "/scratch/store-auth"
/** How long the real run waited for OpenCode to finish. */
const RUN_LIMIT_MS = 120_000

const slot = (label: string) => `${STORE}/.slots/anthropic/${encodeURIComponent(label)}`

/** A sign-in as the store's own sign-in writes it: owned by the store. */
const signIn = (slots: MemorySlots.MemorySlots, label: string, tokens: { readonly access: string; readonly refresh: string; readonly expires: number }) =>
  slots.put(slot(label), encodeRefresh({ type: "oauth", ...tokens, metadata: { owner: "store" } }, tokens))

seeded("the turn completes on the second account, with no error row", ({ seed, expect }) =>
  Effect.gen(function* () {
    const accounts = Provider.accounts(seed, ["alpha", "beta"])
    const world = World.make({
      seed,
      script: () => World.say(""),
      anthropic: {
        accounts,
        token: (account) => {
          if (account === "alpha") return { kind: "rate-limited", retryAfterSeconds: 60 }
          return { kind: "rotate" }
        },
        script: ({ body }) => {
          const tools = body["tools"]
          if (Array.isArray(tools) && tools.length > 0) return { kind: "ok", text: "Hello from the second store account." }
          return { kind: "ok", text: "Greeting" }
        },
      },
    })
    const slots = MemorySlots.make()
    // alpha's token has expired: it must be refreshed before it is sent, and its refresh is rate-limited.
    signIn(slots, "alpha", { ...accounts.alpha, expires: World.START - 1000 })
    signIn(slots, "beta", { ...accounts.beta, expires: World.START + 8 * HOUR })
    const stores = Plugins.stores(slots, world.provider())
    yield* world.load(Plugins.anthropicAuth(world.provider(), stores.registry), { directory: WORK })
    yield* world.load(Plugins.pool(new Map(), stores), {
      directory: WORK,
      options: {
        sweepMinutes: 0,
        limitsFile: "/nonexistent/sim/limits.json",
        sources: [{ kind: "store", dir: STORE, tokenURL: `${Provider.ORIGIN}/v1/oauth/token` }],
      },
    })
    const session = yield* world.session(WORK)
    yield* world.prompt(session, "say hello")
    yield* world.until(() => world.sessions.get(session)?.running === false, RUN_LIMIT_MS)
    const transcript = world.messages(session).map(line).join("\n")
    const received = world.provider().received()

    expect(transcript).toContain("Hello from the second store account.")
    // No error row: the refused attempt was retried, not reported.
    expect(transcript).not.toContain('"type":"error"')

    // alpha's refresh was tried once and rate-limited; the pause held every later try.
    const trades = received.filter((request) => request.path === "/v1/oauth/token")
    expect(trades.map((request) => [request.account, request.status])).toEqual([["alpha", 429]])
    // Nothing reached Anthropic on alpha's expired token; every turn went out on beta.
    const messages = received.filter((request) => request.path === "/v1/messages")
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.every((request) => request.account === "beta")).toBe(true)
    expect(messages.filter((request) => request.tools > 0).map((request) => request.status)).toEqual([200])
    // The pool failed over at once rather than waiting out alpha's pause.
    expect(world.now() - World.START).toBeLessThan(60_000)
    // alpha is as the store holds it.
    const alpha = Option.flatMap(slots.get(slot("alpha")), (text) => Option.fromNullishOr(decodeStoredOAuth(text)))
    expect(Option.map(alpha, (stored) => stored.access)).toEqual(Option.some(accounts.alpha.access))

    // The host's log has the trade at info and the pause once at warning, through the plugin's loggers.
    const logs = world.logs().map(line)
    expect(logs.filter((entry) => entry.includes('"level":"Info"') && entry.includes('store refresh \\"alpha\\": unavailable'))).toHaveLength(1)
    expect(logs.filter((entry) => entry.includes('"level":"Warn"') && entry.includes("store refresh: the token endpoint answered 429"))).toHaveLength(1)

    const printed = `${transcript}\n${world.trace()}\n${logs.join("\n")}`
    for (const account of Object.values(accounts)) {
      expect(printed).not.toContain(account.access)
      expect(printed).not.toContain(account.refresh)
    }
  }),
)

seeded("a store account that must sign in again fails the request as a 401 that says so, and the turn completes on the second account", ({ seed, expect }) =>
  Effect.gen(function* () {
    const accounts = Provider.accounts(seed, ["alpha", "beta"])
    const world = World.make({
      seed,
      script: () => World.say(""),
      anthropic: {
        accounts,
        // alpha's refresh token is refused: it needs a new sign-in.
        token: (account) => (account === "alpha" ? { kind: "rejected" } : { kind: "rotate" }),
        script: ({ body }) => {
          const tools = body["tools"]
          if (Array.isArray(tools) && tools.length > 0) return { kind: "ok", text: "Hello from the second store account." }
          return { kind: "ok", text: "Greeting" }
        },
      },
    })
    const slots = MemorySlots.make()
    signIn(slots, "alpha", { ...accounts.alpha, expires: World.START - 1000 })
    signIn(slots, "beta", { ...accounts.beta, expires: World.START + 8 * HOUR })
    const stores = Plugins.stores(slots, world.provider())
    yield* world.load(Plugins.anthropicAuth(world.provider(), stores.registry), { directory: WORK })
    yield* world.load(Plugins.pool(new Map(), stores), {
      directory: WORK,
      options: {
        sweepMinutes: 0,
        limitsFile: "/nonexistent/sim/limits.json",
        sources: [{ kind: "store", dir: STORE, tokenURL: `${Provider.ORIGIN}/v1/oauth/token` }],
      },
    })
    const session = yield* world.session(WORK)
    yield* world.prompt(session, "say hello")
    yield* world.until(() => world.sessions.get(session)?.running === false, RUN_LIMIT_MS)
    const transcript = world.messages(session).map(line).join("\n")
    const received = world.provider().received()

    expect(transcript).toContain("Hello from the second store account.")
    expect(world.messages(session).filter((message) => message.type === "error")).toEqual([])
    // alpha's request failed as the auth plugin's 401 naming the sign-in, and the pool's retry hook sent it again at once.
    const trace = world.trace()
    expect(trace).toContain('"tag":"Authentication"')
    expect(trace).toContain(`The store account \\"alpha\\" could not refresh (400). Sign in to it again.`)
    expect(trace).toContain('"retry":true,"delay":0')
    // Each trade was of alpha's refresh token, refused; nothing reached Anthropic's messages API on alpha.
    const trades = received.filter((request) => request.path === "/v1/oauth/token")
    expect(trades.length).toBeGreaterThan(0)
    expect(trades.every((request) => request.account === "alpha" && request.status === 400)).toBe(true)
    const messages = received.filter((request) => request.path === "/v1/messages")
    expect(messages.every((request) => request.account === "beta")).toBe(true)
    expect(messages.filter((request) => request.tools > 0).map((request) => request.status)).toEqual([200])
  }),
)
