// The pool's failover on the simulated host, each test at 20 seeds:
// tests/pool-failover.test.ts's names and claims, moved off real OpenCode. Two
// Anthropic logins OpenCode holds, the Anthropic auth plugin and the pool, as
// the real run configures them (`cmd/anthropic-auth/server.ts`'s and
// `cmd/pool/server.ts`'s roots, sweeps off), against the world's Anthropic
// (sim/provider.ts), which answers as tests/fake-anthropic.ts does. The first
// login answers an agent turn with a plan-limit 429; the run must finish on
// the second, and the provider must have seen exactly that. The seed varies
// how long each answer streams, the order of fibers and the tokens.
import { DateTime, Effect, Option } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import * as Provider from "../../sim/provider.ts"
import { line } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/pool/pool-failover.sim.test.ts")

const HOUR = 3_600_000
const WORK = "/scratch/work"
/** How long the real run waited for OpenCode to finish. */
const RUN_LIMIT_MS = 120_000

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
const POOL_REFUSAL = /^dotfiles-opencode\.pool: all pool accounts are held; the first opens at (\S+Z)$/

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
