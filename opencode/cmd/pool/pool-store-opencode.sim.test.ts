// OpenCode on a login store's Claude accounts through the pool, on the
// simulated host at 20 seeds: tests/pool-store-opencode.test.ts's name and
// claims, moved off real OpenCode. OpenCode holds no Anthropic login of its
// own: both accounts are the store's (memory slots, mods/pool/memory/slots.ts,
// which keep the disk's laws). The first one's turn meets a plan limit; the
// run must finish on the second, each request carrying the token of the slot
// the pool picked, and the stale second slot must be refreshed once under the
// store's lock and written back in its slot.
import { Effect, Option } from "effect"
import * as MemorySlots from "@dotfiles/opencode-pool/memory/slots"
import { decodeStoredOAuth, encodeRefresh } from "@dotfiles/opencode-pool/store/store"
import * as Plugins from "../../sim/plugins.ts"
import * as Provider from "../../sim/provider.ts"
import { line } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/pool/pool-store-opencode.sim.test.ts")

const HOUR = 3_600_000
const WORK = "/scratch/work"
const STORE = "/scratch/store-auth"
/** How long the real run waited for OpenCode to finish. */
const RUN_LIMIT_MS = 120_000

const slot = (label: string) => `${STORE}/.slots/anthropic/${encodeURIComponent(label)}`

/** A sign-in as the store's own sign-in writes it: owned by the store. */
const signIn = (slots: MemorySlots.MemorySlots, label: string, tokens: { readonly access: string; readonly refresh: string; readonly expires: number }) =>
  slots.put(slot(label), encodeRefresh({ type: "oauth", ...tokens, metadata: { owner: "store" } }, tokens))

const stored = (slots: MemorySlots.MemorySlots, label: string) =>
  Option.flatMap(slots.get(slot(label)), (text) => Option.fromNullishOr(decodeStoredOAuth(text)))

seeded("the turn goes out on the store slot the pool picked, and fails over to the next store slot", ({ seed, expect }) =>
  Effect.gen(function* () {
    const accounts = Provider.accounts(seed, ["alpha", "beta"])
    const resetAt = World.START + 3 * HOUR
    const world = World.make({
      seed,
      script: () => World.say(""),
      anthropic: {
        accounts,
        script: ({ account, body }) => {
          const tools = body["tools"]
          const turn = Array.isArray(tools) && tools.length > 0
          if (turn && account === "alpha") return { kind: "usage-429", claim: "five_hour", resetAt }
          if (turn) return { kind: "ok", text: "Hello from the store's second account." }
          return { kind: "ok", text: "Greeting" }
        },
      },
    })
    const slots = MemorySlots.make()
    signIn(slots, "alpha", { ...accounts.alpha, expires: World.START + 8 * HOUR })
    // beta's token is stale: the pool refreshes it under the store's lock before it sends.
    signIn(slots, "beta", { ...accounts.beta, expires: World.START - 1000 })
    const stores = Plugins.stores(slots, world.provider())
    // No login in OpenCode's own store: the world holds no Anthropic integration.
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
    const provider = world.provider()
    const messages = provider.received().filter((request) => request.path === "/v1/messages")
    const turns = messages.filter((request) => request.tools > 0)

    expect(transcript).not.toContain('"type":"error"')
    expect(transcript).toContain("Hello from the store's second account.")
    expect(turns.map((request) => [request.account, request.status])).toEqual([
      ["alpha", 429],
      ["beta", 200],
    ])
    // Every request carried a store slot's current token; none went out unsigned.
    expect(messages.every((request) => request.account !== "")).toBe(true)
    expect(messages.flatMap((request) => request.opencodeHeaders)).not.toContain("x-opencode-credential-id")

    // beta was refreshed once, by the pool, and its slot holds the result.
    const trades = provider.received().filter((request) => request.path === "/v1/oauth/token")
    expect(trades.map((request) => [request.account, request.status])).toEqual([["beta", 200]])
    const beta = stored(slots, "beta")
    expect(Option.map(beta, (login) => login.access)).toEqual(Option.some(provider.tokens("beta").access))
    expect(Option.map(beta, (login) => login.refresh)).toEqual(Option.some(provider.tokens("beta").refresh))
    expect(Option.map(beta, (login) => login.metadata)).toEqual(Option.some({ owner: "store" }))
    // alpha is as the store holds it.
    expect(Option.map(stored(slots, "alpha"), (login) => login.access)).toEqual(Option.some(accounts.alpha.access))

    // No token in the transcript, the trace or the logs.
    const printed = `${transcript}\n${world.trace()}\n${world.logs().map(line).join("\n")}`
    for (const name of ["alpha", "beta"] as const)
      for (const token of [accounts[name].access, accounts[name].refresh, provider.tokens(name).access, provider.tokens(name).refresh])
        expect(printed).not.toContain(token)
  }),
)
