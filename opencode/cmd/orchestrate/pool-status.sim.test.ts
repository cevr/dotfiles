// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
// Pool quota rows appended to `orchestrate status` and `orchestrate land` on the
// simulated host (orch-tools-world.ts): Antigravity per group beside Claude and
// OpenAI when the pool answers, and bounded containment when the pool RPC stalls
// after a restart. Its own file, so orch-tools.sim.test.ts keeps its CPU budget.
import { POOL_STATUS } from "@dotfiles/opencode-pool/status"
import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { simulationRunner } from "../../sim/seed.ts"
import { boot, implement, ORCHESTRATE, WORK } from "./orch-tools-world.ts"

const { seeded } = simulationRunner("cmd/orchestrate/pool-status.sim.test.ts")

seeded("status and land answers show Antigravity per group beside Claude and OpenAI when the pool answers", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, true)
    const fakePool = Plugin.define({
      id: "sim.pool-status",
      effect: (ctx) =>
        ctx.rpc.register(
          { ...POOL_STATUS, methods: { status: POOL_STATUS.methods.status, antigravity: POOL_STATUS.methods.antigravity } },
          {
            status: () =>
              Effect.succeed({
                anthropic: { accounts: [{ credentialID: "store:alpha", reading: { windows: [{ name: "5h", utilization: 0.2 }, { name: "7d", utilization: 0.4 }] } }] },
                openai: { accounts: [{ credentialID: "chatgpt", reading: { windows: [{ name: "5h", utilization: 0.1 }, { name: "7d", utilization: 0.3 }] } }] },
              }),
            antigravity: () =>
              Effect.succeed({
                lines: [
                  "antigravity / Gemini · open",
                  "antigravity / Claude & GPT (shared) · limited until Nov 25, 2026, 2:00:00 AM EST (a pane's limit)",
                ],
              }),
          },
        ).pipe(Effect.asVoid, Effect.orDie),
    })
    yield* run.world.load(fakePool, { directory: WORK })
    const root = yield* run.world.session(WORK)
    const status = yield* run.probe(root, ORCHESTRATE, { action: "status" })
    expect(status.error).toBe(false)
    expect(status.text).toContain("anthropic / store:alpha")
    expect(status.text).toContain("openai / chatgpt")
    expect(status.text).toContain("antigravity / Gemini · open")
    expect(status.text).toContain("antigravity / Claude & GPT (shared) · limited")

    yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "a" })
    yield* implement(run, root, "a", 1, "implementor a r1", "ready")
    const landed = yield* run.probe(root, ORCHESTRATE, { action: "land", units: ["a"] })
    expect(landed.error).toBe(false)
    expect(landed.text).toContain("anthropic / store:alpha")
    expect(landed.text).toContain("openai / chatgpt")
    expect(landed.text).toContain("antigravity / Gemini · open")
    expect(landed.text).toContain("antigravity / Claude & GPT (shared) · limited")
  }),
)

seeded("status stays contained and bounded when the pool RPC stalls after a restart", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, true)
    const stalledPool = Plugin.define({
      id: "sim.pool-stalled",
      effect: (ctx) =>
        ctx.rpc.register(
          { ...POOL_STATUS, methods: { status: POOL_STATUS.methods.status, antigravity: POOL_STATUS.methods.antigravity } },
          {
            status: () => Effect.never,
            antigravity: () => Effect.never,
          },
        ).pipe(Effect.asVoid, Effect.orDie),
    })
    yield* run.world.load(stalledPool, { directory: WORK })
    const root = yield* run.world.session(WORK)
    const status = yield* run.probe(root, ORCHESTRATE, { action: "status" })
    expect(status.error).toBe(false)
    expect(status.text).toContain("orchestrate:")
  }),
)
