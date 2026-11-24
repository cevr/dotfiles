import { Effect, Match, Option, Schema } from "effect"
import { Pace } from "@dotfiles/opencode-pool/pace"
import { HeldSendAnswer } from "@dotfiles/opencode-pool/refuse"
import * as ChatGPT from "../../sim/chatgpt.ts"
import * as Plugins from "../../sim/plugins.ts"
import * as Provider from "../../sim/provider.ts"
import { simulationRunner } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"
import { spentAccount } from "../../tests/fake-chatgpt.ts"

const { seeded } = simulationRunner("cmd/pool/pool-openai-send-hold.sim.test.ts")
const decode = Schema.decodeUnknownSync(Pace)
const DIRECTORY = "/scratch/openai"
const POOL = "dotfiles-opencode.pool"
const heldSendOf = Schema.decodeUnknownSync(HeldSendAnswer)

for (const transport of ["http", "websocket"] as const)
for (const quotaResult of ["free", "spent", "timeout"] as const)
seeded(`no ${transport} send before a new login's first measure completes or times out (${quotaResult})`, ({ seed, expect }) =>
  Effect.gen(function* () {
    const model = { providerID: "openai", id: "gpt-6.2-fixture" }
    const account = Provider.accounts(seed, ["sol"]).sol
    const quota = ChatGPT.make()
    const usage = spentAccount(account.access, "never-claim", World.START)
    usage.credits.length = 0
    usage.fiveHourResetAt = World.START + 60_000
    if (quotaResult !== "spent") usage.fiveHour = 0
    quota.accounts.set("fixture", usage)
    const delay = 100 + seed % 700
    const sends: Array<number> = []
    const requests: Array<number> = []
    let offline = quotaResult === "timeout"
    const receive = () => sends.push(world.now())
    const wire = Match.value(transport).pipe(
      Match.when("websocket", () => ({ models: [{ ...model, modelID: model.id, limit: { context: 128_000 }, cost: [], settings: { transport: "websocket" as const } }] })),
      Match.when("http", () => ({ provider: { id: model.providerID, baseURL: "http://127.0.0.1:11",
        handle: () => Effect.sync(() => { receive(); return new Response("data: {\"type\":\"message_stop\"}\n\n") }) },
      })),
      Match.exhaustive,
    ) satisfies Partial<World.Options>
    const world = World.make({ seed, model, ...wire, latency: [1, 10], script: () => { receive(); return World.say("synthetic answer") },
      integrations: { openai: [{ id: "cred_sol", label: "Sol", ...account,
        expires: World.START + 86_400_000, methodID: "chatgpt-browser", metadata: { accountID: "fixture" } }] },
    })
    const delayedQuota = { ...quota, handle: (request: Request) => Effect.suspend(() => {
      if (request.url !== ChatGPT.USAGE_URL) return quota.handle(request)
      requests.push(world.now())
      return Match.value(offline).pipe(
        Match.when(true, () => Effect.delay(Effect.succeed(new Response("stalled", { status: 503 })), 30_000)),
        Match.orElse(() => Effect.delay(quota.handle(request), delay)),
      )
    }) }
    const network = Provider.make({ seed, accounts: {}, chatgpt: delayedQuota }, world.runtime)
    const plugin = Plugins.pool(new Map(), Plugins.network(network))
    const second = `${DIRECTORY}-second`
    for (const directory of [DIRECTORY, second]) yield* world.load(plugin, {
      directory, options: { providers: {}, paced: { openai: "openai" }, sweepMinutes: 0, resets: false,
        usageURL: ChatGPT.USAGE_URL, limitsFile: "/nonexistent/sim/limits.json" },
    })
    const one = yield* world.session(DIRECTORY, { title: "No auxiliary title request" })
    const two = yield* world.session(second, { title: "No auxiliary title request" })
    yield* world.prompt(one, "first sign-in send")
    yield* world.prompt(two, "another send for the same login")
    yield* world.advance(delay - 1)
    expect(sends).toEqual([])
    expect(requests).toHaveLength(1)
    const firstAt = Option.getOrThrow(Option.fromUndefinedOr(requests[0]))
    if (quotaResult === "timeout") {
      yield* world.advance(firstAt + 9_999 - world.now())
      expect(sends).toEqual([])
    }
    yield* world.advance(2_000)
    if (quotaResult === "spent") {
      expect(sends).toEqual([])
      expect(yield* world.rpc(POOL, "heldSend", { sessionID: one })).toMatchObject({ state: "held", hold: { reasonCode: "account-held" } })
      expect(yield* world.rpc(POOL, "heldSend", { sessionID: two })).toMatchObject({ state: "held", hold: { reasonCode: "account-held" } })
    } else {
      const safeAt = Match.value(quotaResult).pipe(Match.when("timeout", () => firstAt + 10_000), Match.orElse(() => firstAt + delay))
      expect(sends).toHaveLength(2)
      expect(sends.every((at) => at >= safeAt)).toBe(true)
    }
    expect(requests).toHaveLength(1)
    if (quotaResult === "spent") return
    const status = yield* world.rpc(POOL, "status", {})
    const measurement = Match.value(offline).pipe(Match.when(true, () => "unmeasured"), Match.orElse(() => "measured"))
    expect(status).toMatchObject({ openai: { accounts: [expect.objectContaining({ measurement })] } })
    offline = false
    yield* world.prompt(one, "a subsequent attempt")
    yield* world.until(() => sends.length === 3, 2_000)
    expect(requests).toHaveLength(1 + Number(quotaResult === "timeout"))
  }))

seeded("the send hold is held or ended until admission, even across a restart", ({ seed, expect }) =>
  Effect.gen(function* () {
    const model = { providerID: "openai", id: "gpt-6.2-fixture" }
    const account = Provider.accounts(seed, ["sol"]).sol
    const quota = ChatGPT.make()
    const usage = spentAccount(account.access, "never-claim", World.START)
    usage.credits.length = 0
    const retryAt = World.START + 5_000 + 1_000 * (seed % 17)
    usage.fiveHourResetAt = retryAt
    quota.accounts.set("fixture", usage)
    const sends: Array<number> = []
    // The old host leaves retry to its caller, so crossing the deadline
    // does not itself produce a new admission.
    const world = World.make({
      seed, sendRefusal: false, model, latency: [1, 10], script: () => World.say("synthetic answer"),
      provider: { id: model.providerID, baseURL: "http://127.0.0.1:11", handle: () => Effect.sync(() => {
        sends.push(world.now())
        return new Response("data: {\"type\":\"message_stop\"}\n\n")
      }) },
      integrations: { openai: [{ id: "cred_sol", label: "Sol", ...account,
        expires: World.START + 86_400_000, methodID: "chatgpt-browser", metadata: { accountID: "fixture" } }] },
    })
    const network = Provider.make({ seed, accounts: {}, chatgpt: quota }, world.runtime)
    yield* world.load(Plugins.pool(new Map(), Plugins.network(network)), {
      directory: DIRECTORY, options: { providers: {}, paced: { openai: "openai" }, sweepMinutes: 0, resets: false,
        usageURL: ChatGPT.USAGE_URL, limitsFile: "/nonexistent/sim/limits.json" },
    })
    const sessionID = yield* world.session(DIRECTORY, { title: "No auxiliary title request" })
    const read = () => world.rpc(POOL, "heldSend", { sessionID })
    expect(decode(yield* world.rpc(POOL, "pace", { providerID: model.providerID, model: model.id, dispatch: true }))).toMatchObject({ ok: false, retryAt })
    yield* world.prompt(sessionID, "held original")
    yield* world.advance(retryAt - world.now() - 1)
    expect(sends).toEqual([])
    const hold = { sessionID, providerID: "openai", retryAt, reasonCode: "account-held" }
    expect(yield* read()).toMatchObject({ hold })
    yield* world.advance(1 + seed % 103)
    expect(sends).toEqual([])
    expect(yield* read()).toEqual({ state: "ended", hold })
    yield* world.restart
    expect(yield* read()).toEqual({ state: "ended", hold })
    usage.fiveHour = 0
    usage.fiveHourResetAt = retryAt + 3_600_000
    yield* world.prompt(sessionID, "retry explicitly")
    yield* world.until(() => sends.length === 1, 1_000)
    expect(sends[0]).toBeGreaterThanOrEqual(retryAt)
    expect(yield* read()).toEqual({})
  }))

for (const transport of ["http", "websocket"] as const)
for (const sendRefusal of [false, true])
for (const late of [false, true])
for (const providerID of ["openai", "sim-openai"])
seeded(`an OpenAI account hold (${String(late)} late) sends nothing via ${providerID} ${transport} (typed Step: ${String(sendRefusal)})`, ({ seed, expect }) =>
  Effect.gen(function* () {
    const model = { providerID, id: "gpt-6.2-fixture" }
    const account = Provider.accounts(seed, ["sol"]).sol
    const quota = ChatGPT.make()
    const usage = spentAccount(account.access, "never-claim", World.START)
    usage.credits.length = 0
    if (late || transport === "websocket") usage.fiveHour = 0
    const until = World.START + 5_000 + 1_000 * (seed % 17)
    usage.fiveHourResetAt = until
    quota.accounts.set("fixture", usage)
    const sends: Array<number> = []
    const receive = () => sends.push(world.now())
    const wire = Match.value(transport).pipe(
      Match.when("websocket", () => ({ models: [{ ...model, modelID: model.id, limit: { context: 128_000 }, cost: [], settings: { transport: "websocket" as const } }] })),
      Match.when("http", () => ({ provider: {
        id: providerID, baseURL: "http://127.0.0.1:11",
        handle: () => Effect.sync(() => {
          receive()
          return new Response("data: {\"type\":\"message_stop\"}\n\n")
        }),
      } })),
      Match.exhaustive,
    ) satisfies Partial<World.Options>
    const world = World.make({
      seed, sendRefusal, model, latency: [1, 10], script: () => { receive(); return World.say("synthetic answer") },
      ...wire,
      integrations: { openai: [{ id: "cred_sol", label: "Sol", ...account,
        expires: World.START + 86_400_000, methodID: "chatgpt-browser", metadata: { accountID: "fixture" } }] },
    })
    if (late) {
      // Another writer's hold appears after model.request and before the
      // production final gate. A stopped or disabled final gate goes red
      // even when the early check is still intact.
      yield* world.load({
        id: "sim.after-early-check",
        effect: (ctx) => ctx.session.hook(Match.value(transport).pipe(
          Match.when("http", () => "http.request" as const), Match.when("websocket", () => "experimental.ws.send" as const), Match.exhaustive,
        ), () =>
          Effect.sync(() => {
            const rows = Option.fromUndefinedOr(world.storage.get(POOL))
            if (transport === "websocket" && sends.length === 0) return
            if (world.now() < until && Option.isSome(rows)) rows.value.set("openai/hold/cred_sol", { kind: "rate-limit", at: world.now(), until })
          })).pipe(Effect.asVoid),
      }, { directory: DIRECTORY })
    }
    const network = Provider.make({ seed, accounts: {}, chatgpt: quota }, world.runtime)
    yield* world.load(Plugins.pool(new Map(), Plugins.network(network)), {
      directory: DIRECTORY, options: {
        providers: {}, paced: { [providerID]: "openai" }, sweepMinutes: 0, resets: false, usageURL: ChatGPT.USAGE_URL,
        limitsFile: "/nonexistent/sim/limits.json",
      },
    })
    const session = yield* world.session(DIRECTORY, { title: "No auxiliary title request" })
    if (transport === "websocket") {
      yield* world.prompt(session, "open the same session socket")
      yield* world.until(() => sends.length === 1 && world.sessions.get(session)?.running === false, 1_000)
      if (!late) {
        usage.fiveHour = 1
        const rows = Option.fromUndefinedOr(world.storage.get(POOL))
        if (Option.isSome(rows)) rows.value.set("openai/hold/cred_sol", { kind: "rate-limit", at: world.now(), until })
      }
    }
    const warm = sends.length
    const quote = decode(yield* world.rpc(POOL, "pace", { providerID, model: model.id, dispatch: true }))
    if (late) expect(quote).toMatchObject({ ok: true, measured: true, eligible: ["cred_sol"] })
    else {
      expect(quote).toMatchObject({ ok: false, measured: true, eligible: [] })
      expect(quote.retryAt).toBe(until)
    }
    yield* world.prompt(session, "held original")
    yield* world.advance(until - world.now() - 1)
    expect(sends.slice(warm)).toEqual([])
    const held = heldSendOf(yield* world.rpc(POOL, "heldSend", { sessionID: session }))
    expect(held.hold).toMatchObject({ sessionID: session, providerID, retryAt: until, reasonCode: "account-held" })
    expect(world.sessions.get(session)?.running).toBe(sendRefusal)
    usage.fiveHour = 0
    usage.fiveHourResetAt = until + 3_600_000
    yield* world.advance(1)
    if (!sendRefusal) yield* world.prompt(session, "retry explicitly on the installed host")
    yield* world.until(() => sends.length === warm + 1, 1_000)
    expect(sends[warm]).toBeGreaterThanOrEqual(until)
    expect(yield* world.rpc(POOL, "heldSend", { sessionID: session })).toEqual({})
  }),
)

for (const transport of ["http", "websocket"] as const)
for (const sendRefusal of [false, true])
seeded(`an admitted ${transport} send does not admit its retry (typed Step: ${String(sendRefusal)})`, ({ seed, expect }) =>
  Effect.gen(function* () {
    const model = { providerID: "openai", id: "gpt-6.2-fixture" }
    const account = Provider.accounts(seed, ["sol"]).sol
    const quota = ChatGPT.make()
    const usage = spentAccount(account.access, "never-claim", World.START)
    usage.credits.length = 0
    usage.fiveHour = 0
    quota.accounts.set("fixture", usage)
    const sends: Array<number> = []
    const until = World.START + 120_000
    const receive = () => {
      const n = sends.push(world.now())
      if (n !== 2) return false
      const rows = Option.fromUndefinedOr(world.storage.get(POOL))
      if (Option.isSome(rows)) rows.value.set("openai/hold/cred_sol", { kind: "rate-limit", at: world.now(), until })
      return true
    }
    const wire = Match.value(transport).pipe(
      Match.when("websocket", () => ({ models: [{ ...model, modelID: model.id, limit: { context: 128_000 }, cost: [], settings: { transport: "websocket" as const } }] })),
      Match.when("http", () => ({ provider: {
        id: model.providerID, baseURL: "http://127.0.0.1:11",
        handle: () => Effect.sync(() => Match.value(receive()).pipe(
          Match.when(true, () => new Response("synthetic provider error", { status: 500 })),
          Match.orElse(() => new Response("data: {\"type\":\"message_stop\"}\n\n")),
        )),
      } })),
      Match.exhaustive,
    ) satisfies Partial<World.Options>
    const world = World.make({
      seed, sendRefusal, model, latency: [1, 10], ...wire,
      script: () => Match.value(receive()).pipe(
        Match.when(true, () => World.socketError("synthetic provider error")),
        Match.orElse(() => World.say("synthetic answer")),
      ),
      integrations: { openai: [{ id: "cred_sol", label: "Sol", ...account,
        expires: World.START + 86_400_000, methodID: "chatgpt-browser", metadata: { accountID: "fixture" } }] },
    })
    const network = Provider.make({ seed, accounts: {}, chatgpt: quota }, world.runtime)
    yield* world.load(Plugins.pool(new Map(), Plugins.network(network)), {
      directory: DIRECTORY, options: { providers: {}, paced: { openai: "openai" }, sweepMinutes: 0, resets: false,
        usageURL: ChatGPT.USAGE_URL, limitsFile: "/nonexistent/sim/limits.json" },
    })
    const session = yield* world.session(DIRECTORY, { title: "No auxiliary title request" })
    yield* world.prompt(session, "warm")
    yield* world.until(() => sends.length === 1 && world.sessions.get(session)?.running === false, 1_000)
    yield* world.prompt(session, "provider error after admission")
    yield* world.advance(60_000)
    expect(sends).toHaveLength(2)
    const held = heldSendOf(yield* world.rpc(POOL, "heldSend", { sessionID: session }))
    expect(held.hold).toMatchObject({ sessionID: session, providerID: "openai", retryAt: until, reasonCode: "account-held" })
    if (sendRefusal) expect(held.hold?.stepID).toEqual(expect.any(String))
    expect(world.sessions.get(session)?.running).toBe(sendRefusal)
    yield* world.advance(until - world.now())
    if (!sendRefusal) yield* world.prompt(session, "retry explicitly")
    yield* world.until(() => sends.length === 3, 1_000)
    expect(sends[2]).toBeGreaterThanOrEqual(until)
  }))
