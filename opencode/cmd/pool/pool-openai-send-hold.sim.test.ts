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
const MODEL = { providerID: "openai", id: "gpt-6.2-fixture" }
const DIRECTORY = "/scratch/openai"
const POOL = "dotfiles-opencode.pool"
const heldSendOf = Schema.decodeUnknownSync(HeldSendAnswer)

for (const transport of ["http", "websocket"] as const)
for (const sendRefusal of [false, true])
for (const late of [false, true])
seeded(`an OpenAI hold (${String(late)} late) sends nothing via ${transport} (typed Step: ${String(sendRefusal)})`, ({ seed, expect }) =>
  Effect.gen(function* () {
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
      Match.when("websocket", () => ({ models: [{ ...MODEL, modelID: MODEL.id, limit: { context: 128_000 }, cost: [], settings: { transport: "websocket" as const } }] })),
      Match.when("http", () => ({ provider: {
        id: MODEL.providerID, baseURL: "http://127.0.0.1:11",
        handle: () => Effect.sync(() => {
          receive()
          return new Response("data: {\"type\":\"message_stop\"}\n\n")
        }),
      } })),
      Match.exhaustive,
    ) satisfies Partial<World.Options>
    const world = World.make({
      seed, sendRefusal, model: MODEL, latency: [1, 10], script: () => { receive(); return World.say("synthetic answer") },
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
        providers: {}, paced: { openai: "openai" }, sweepMinutes: 0, resets: false, usageURL: ChatGPT.USAGE_URL,
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
    const quote = decode(yield* world.rpc(POOL, "pace", { providerID: MODEL.providerID, model: MODEL.id, dispatch: true }))
    if (late) expect(quote).toMatchObject({ ok: true, measured: true, eligible: ["cred_sol"] })
    else {
      expect(quote).toMatchObject({ ok: false, measured: true, eligible: [] })
      expect(quote.retryAt).toBe(until)
    }
    yield* world.prompt(session, "held original")
    yield* world.advance(until - world.now() - 1)
    expect(sends.slice(warm)).toEqual([])
    const held = heldSendOf(yield* world.rpc(POOL, "heldSend", { sessionID: session }))
    expect(held.hold).toMatchObject({ sessionID: session, providerID: "openai", retryAt: until, reasonCode: "account-held" })
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
