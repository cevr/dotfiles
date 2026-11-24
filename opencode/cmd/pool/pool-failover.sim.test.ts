// The pool's failover on the simulated host, each test at 20 seeds:
// tests/pool-failover.test.ts's names and claims, moved off real OpenCode. Two
// Anthropic logins OpenCode holds, the Anthropic auth plugin and the pool, as
// the real run configures them (`cmd/anthropic-auth/server.ts`'s and
// `cmd/pool/server.ts`'s roots, sweeps off), against the world's Anthropic
// (sim/provider.ts), which answers as tests/fake-anthropic.ts does. The first
// login answers an agent turn with a plan-limit 429; the run must finish on
// the second, and the provider must have seen exactly that. The seed varies
// how long each answer streams, the order of fibers and the tokens.
import { Config, Console, DateTime, Effect, Option } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import * as Provider from "../../sim/provider.ts"
import { below, generator, line } from "../../sim/runtime.ts"
import { simulationRunner } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = simulationRunner("cmd/pool/pool-failover.sim.test.ts")
const isolated = simulationRunner("cmd/pool/pool-failover.sim.test.ts", { past: [10285280, 10286953] })

const HOUR = 3_600_000
const WORK = "/scratch/work"
/** How long the real run waited for OpenCode to finish. */
const RUN_LIMIT_MS = 120_000
const OTHER = "/scratch/other"
const POOL_STORE = "dotfiles-opencode.pool"

/** Agent turns on the first login meet a plan limit; titles, and everything on the second login, go through. */
const firstRefused =
  (resetAt: number) =>
  ({ account, body }: Provider.RequestInfo): Provider.Answer => {
    const tools = body["tools"]
    const turn = Array.isArray(tools) && tools.length > 0
    if (turn && account === "first") return { kind: "usage-429", claim: "five_hour", resetAt }
    if (turn) return { kind: "ok", text: "Hello from the second login." }
    return { kind: "ok", text: "Greeting" }
  }

/** One run of "say hello": the world with the two logins, the auth plugin and (when `pooled`) the pool, to the session's rest. */
const run = (seed: number, pooled: boolean, script = firstRefused(World.START + 3 * HOUR)) =>
  Effect.gen(function* () {
    const accounts = Provider.accounts(seed, ["first", "second"])
    const world = World.make({
      seed,
      script: () => World.say(""),
      anthropic: { accounts, script },
      integrations: {
        anthropic: Object.entries(accounts).map(([name, account], index) => ({
          id: `cred_${name}`,
          label: `Anthropic ${index + 1}`,
          ...account,
          expires: World.START + 8 * HOUR,
        })),
      },
    })
    yield* world.load(Plugins.anthropicAuth(world.provider()), { directory: WORK })
    if (pooled) yield* world.load(Plugins.pool(), { directory: WORK, options: { sweepMinutes: 0, limitsFile: "/nonexistent/sim/limits.json" } })
    const session = yield* world.session(WORK)
    yield* world.prompt(session, "say hello")
    yield* world.until(() => world.sessions.get(session)?.running === false, RUN_LIMIT_MS)
    const transcript = world.messages(session).map(line).join("\n")
    const messages = world.provider().received().filter((request) => request.path === "/v1/messages")
    const turns = messages.filter((request) => request.tools > 0)
    return { world, accounts, transcript, messages, turns }
  })

seeded("without the pool, the same refusal ends the run: the host does not retry a plan limit", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { transcript, turns } = yield* run(seed, false)
    expect(transcript).not.toContain("Hello from the second login.")
    expect(turns.map((request) => [request.account, request.status])).toEqual([["first", 429]])
  }),
)

seeded("the first login's plan-limit 429 holds it, and the run goes out on the second", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, accounts, transcript, messages, turns } = yield* run(seed, true)

    // The run ended in an answer, not an error.
    expect(transcript).not.toContain('"type":"error"')
    expect(transcript).toContain("Hello from the second login.")
    // The agent turn went out on the first login, was refused, and went again at once on the second.
    expect(turns.map((request) => [request.account, request.status])).toEqual([
      ["first", 429],
      ["second", 200],
    ])
    const [refused, retried] = turns
    // At once: the pool's retry waits no gap; the second request leaves as the first's answer is read.
    expect(retried.at - refused.at).toBeLessThan(2_000)
    expect(world.trace()).toContain('"kind":"retry-decision","sessionID"')
    expect(world.trace().match(/"kind":"retry-decision"[^\n]*"retry":true,"delay":0/g)).toHaveLength(1)
    // Nothing went out unsigned, nothing on a stranger's token.
    expect(messages.every((request) => request.account !== "")).toBe(true)
    // The credential choice never reached Anthropic.
    expect(messages.flatMap((request) => request.opencodeHeaders)).not.toContain("x-opencode-credential-id")
    // The wire extras: Haiku's beta set and the session header.
    for (const request of messages) {
      expect(request.betas).toContain("oauth-2025-04-20")
      expect(request.betas).not.toContain("interleaved-thinking-2025-05-14")
      expect(request.sessionHeader).toMatch(/^[0-9a-f-]{36}$/)
    }
    // No token in the transcript, the trace or the logs.
    const printed = `${transcript}\n${world.trace()}\n${world.logs().map(line).join("\n")}`
    for (const account of Object.values(accounts)) {
      expect(printed).not.toContain(account.access)
      expect(printed).not.toContain(account.refresh)
    }
  }),
)

/** Every agent turn meets a plan limit: the first login resets in three hours, the second in one. */
const bothSpent = ({ account, body }: Provider.RequestInfo): Provider.Answer => {
  const tools = body["tools"]
  if (!Array.isArray(tools) || tools.length === 0) return { kind: "ok", text: "Greeting" }
  if (account === "second") return { kind: "usage-429", claim: "five_hour", resetAt: World.START + HOUR }
  return { kind: "usage-429", claim: "five_hour", resetAt: World.START + 3 * HOUR }
}

/** The pool's own refusal: every account held, and when the first opens. */
const POOL_REFUSAL = /^dotfiles-opencode\.pool: all pool accounts are held; it may go again at (\S+Z)$/

seeded(
  "with both logins spent, the run ends on the pool's own refusal and when the first opens, never sent on a spent login again",
  ({ seed, expect }) =>
    Effect.gen(function* () {
      const { world, turns } = yield* run(seed, true, bothSpent)
      // Each login was refused once, and nothing went out on it again before its reset.
      expect(turns.map((request) => [request.account, request.status])).toEqual([
        ["first", 429],
        ["second", 429],
      ])
      // The turn ends on the pool's words and a time to try again: the second login's reset, the soonest.
      const session = [...world.sessions.keys()][0] ?? ""
      const ends = world.messages(session).flatMap((message) => {
        if (message.type !== "error") return []
        return [message.message]
      })
      expect(ends).toHaveLength(1)
      const opens = Option.flatMap(Option.fromNullishOr(POOL_REFUSAL.exec(ends.join(""))?.[1]), DateTime.make)
      expect(Option.isSome(opens), ends.join("")).toBe(true)
      expect(Math.abs(Option.getOrElse(Option.map(opens, DateTime.toEpochMillis), () => 0) - (World.START + HOUR))).toBeLessThan(5_000)
    }),
)

seeded("a two-copy hold interleaved with a pending request is checked at the final hook, through reload too", ({ seed, expect }) =>
  Effect.gen(function* () {
    const random = generator(`pool-handoff:${seed}`)
    const wait = 10 + below(random, 30)
    const reload = below(random, 2) === 0
    const accounts = Provider.accounts(seed, ["first", "second"])
    const world = World.make({
      seed, script: () => World.say(""),
      anthropic: { accounts, script: firstRefused(World.START + 3 * HOUR) },
      integrations: {
        anthropic: Object.entries(accounts).map(([name, account]) => ({ id: name, label: name, ...account, expires: World.START + 8 * HOUR })),
      },
    })
    const pool = Plugins.pool()
    const auth = Plugins.anthropicAuth(world.provider())
    const target = "ses_handoff_target"
    // Delay only before auth. Place in WORK, publish a refusal from OTHER,
    // optionally reload both copies, then release the old request to auth.
    yield* world.load({
      id: "sim.pool-handoff-barrier",
      effect: (ctx) => ctx.session.hook("http.request", (event) => {
        if (event.sessionID !== target) return Effect.void
        return Effect.sleep(wait)
      }).pipe(Effect.orDie, Effect.asVoid),
    }, { directory: WORK })
    for (const directory of [WORK, OTHER]) {
      yield* world.load(auth, { directory })
      yield* world.load(pool, { directory, options: { sweepMinutes: 0, limitsFile: "/nonexistent/sim/limits.json" } })
    }
    const one = yield* world.session(WORK, { id: target })
    const two = yield* world.session(OTHER)
    yield* world.prompt(one, "pending")
    yield* world.prompt(two, "record the refusal")
    expect(world.provider().received().some((request) => request.account === "first" && request.status === 429)).toBe(true)
    if (reload) yield* world.restart
    yield* world.advance(wait * 4)
    yield* world.until(() => world.sessions.get(one)?.running === false, RUN_LIMIT_MS)
    expect(world.messages(one).map(line).join("\n")).toContain("Hello from the second login.")
    expect(world.inFlightAtRefusal()).toBe(0)
  }),
)

seeded("a refusal committed after the final hook counts as in flight, and the 429 re-places the turn", ({ seed, expect }) =>
  Effect.gen(function* () {
    const accounts = Provider.accounts(seed, ["first", "second"])
    const resetAt = World.START + 3 * HOUR
    const world = World.make({
      seed, script: () => World.say(""), bodyMaterialization: true,
      anthropic: { accounts, script: firstRefused(resetAt) },
      integrations: {
        anthropic: Object.entries(accounts).map(([name, account]) => ({ id: name, label: name, ...account, expires: World.START + 8 * HOUR })),
      },
    })
    yield* world.load(Plugins.anthropicAuth(world.provider()), { directory: WORK })
    yield* world.load(Plugins.pool(), { directory: WORK, options: { sweepMinutes: 0, limitsFile: "/nonexistent/sim/limits.json" } })
    const session = yield* world.session(WORK)
    yield* world.prompt(session, "in flight")
    // Commit the other copy's hold while this request is inside the host's
    // body-materialization window, not before the auth hook decided.
    expect(world.provider().received().filter((request) => request.path === "/v1/messages")).toHaveLength(0)
    const records = Option.getOrThrow(Option.fromUndefinedOr(world.storage.get(POOL_STORE)))
    records.set("anthropic/hold/first", { kind: "rate-limit", at: world.now(), until: resetAt, refusedUntil: resetAt })
    yield* world.until(() => world.sessions.get(session)?.running === false, RUN_LIMIT_MS)
    expect(world.inFlightAtRefusal()).toBeGreaterThan(0)
    expect(world.messages(session).map(line).join("\n")).toContain("Hello from the second login.")
    if (Option.isSome(yield* Config.option(Config.Int("SIM_SWARM_COUNT")))) {
      yield* Console.log(`pool-in-flight-at-refusal ${seed} ${world.inFlightAtRefusal()}`)
    }
  }),
)

isolated.seeded("a separate writer publishes a hold after the answering copy placed its request, without a quota event", ({ seed, expect }) =>
  Effect.gen(function* () {
    const wait = 20 + below(generator(`pool-isolated-handoff:${seed}`), 40)
    const accounts = Provider.accounts(seed, ["first", "second"])
    const world = World.make({
      seed, script: () => World.say(""),
      anthropic: { accounts, script: ({ account }) => ({ kind: "ok", text: `answered on ${account}` }) },
      integrations: { anthropic: Object.entries(accounts).map(([id, account]) => ({ id, label: id, ...account, expires: World.START + 8 * HOUR })) },
    })
    yield* world.load({
      id: "sim.handoff-barrier",
      effect: (ctx) => ctx.session.hook("http.request", () => Effect.sleep(wait)).pipe(Effect.orDie, Effect.asVoid),
    }, { directory: WORK })
    yield* world.load(Plugins.anthropicAuth(world.provider()), { directory: WORK })
    yield* world.load(Plugins.pool(), { directory: WORK, options: { sweepMinutes: 0, limitsFile: "/nonexistent/sim/limits.json" } })
    yield* world.load({
      id: POOL_STORE,
      effect: (ctx) => ctx.session.hook("model.request", () =>
        ctx.storage.set("anthropic/hold/first", { kind: "rate-limit", at: world.now(), until: world.now() + HOUR }),
      ).pipe(Effect.orDie, Effect.asVoid),
    }, { directory: OTHER })
    const target = yield* world.session(WORK)
    const writer = yield* world.session(OTHER, { model: World.SIM_MODEL })
    yield* world.prompt(target, "pause a signed-in login before auth")
    const records = Option.getOrThrow(Option.fromUndefinedOr(world.storage.get(POOL_STORE)))
    expect(records.get(`anthropic/cache/${target}`)).toMatchObject({ credentialID: "first" })
    yield* world.prompt(writer, "commit the refusal in the other copy")
    expect(records.has("anthropic/hold/first")).toBe(true)
    yield* world.until(() => world.sessions.get(target)?.running === false, RUN_LIMIT_MS)
    expect(world.provider().received().filter((request) => request.path === "/v1/messages").map((request) => request.account)).toEqual(["second", "second"])
  }),
)
