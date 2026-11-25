// @reads all
// @reads-reason computed read at mods/pool/opencode/limits.ts: return renameValue(JSON.parse(readFileSync(path, "utf8")))
import { Context, Effect, Layer, Option, Schema } from "effect"
import { expect, it } from "effect-bun-test"
import { TestClock } from "effect/testing"
import { scratch } from "../../../tests/scratch.ts"
import { PoolId } from "../account-pool.ts"
import * as Model from "../model.ts"
import * as LimitsLive from "../opencode/limits.ts"
import { Limits } from "../service.ts"
import * as Fleet from "./fleet.ts"
import * as Ledger from "./ledger.ts"
import * as Logins from "./logins.ts"
import * as Owner from "./owner.ts"
import * as Peers from "./peers.ts"
import * as Quota from "./quota.ts"
import * as Resets from "./resets.ts"

const HOUR = 3_600_000
const DAY = 24 * HOUR
const ANTHROPIC = PoolId.make("anthropic")
const MODEL = "claude-opus-5-5"
const tokens = { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }

it.effect("the next launch learns complete actual work, freezes first completion, and recovers after restart", () => Effect.gen(function* () {
  yield* TestClock.setTime(0)
  const dir = yield* Effect.acquireRelease(Effect.sync(() => scratch("launch-learning-")), (dir) => Effect.sync(() => dir[Symbol.dispose]()))
  const uses = new Map<string, Schema.Json>()
  const history = new Map<string, Schema.Json>()
  const ledger = new Map<string, Schema.Json>()
  const limitsLayer = LimitsLive.layer(Ledger.storage(uses), `${dir.path}/limits.json`)
  const services = yield* Layer.build(limitsLayer)
  const limits = Context.get(services, Limits)
  yield* limits.use("calibration", { at: HOUR, pool: ANTHROPIC, credentialID: "calibration", model: MODEL, tokens })
  yield* limits.observe(ANTHROPIC, "calibration", { at: 2 * HOUR, windows: [{ name: "7d", utilization: 0.02, resetAt: 7 * DAY }] })
  yield* TestClock.setTime(4 * HOUR)
  yield* limits.flush
  const boot = (measuring: Limits["Service"]) => Effect.gen(function* () {
    const externals = Layer.mergeAll(
      Layer.succeed(Limits, measuring),
      Logins.layer({ connections: new Map([[ANTHROPIC, [{ type: "credential", method: "oauth", id: "a", label: "Claude" }]]]), marks: [] }),
      Quota.layer(new Map([[ANTHROPIC, new Map([["a", { at: 4 * HOUR, windows: [{ name: "5h", utilization: 0.1, resetAt: 5 * HOUR }, { name: "7d", utilization: 0.1, resetAt: 6 * DAY }] }]])]]), new Map()),
      Ledger.layer(ledger), Fleet.layer(history), Resets.layer(), Owner.layer(Owner.empty()), Peers.layer(new Map()),
    )
    const context = yield* Layer.build(Model.layer({ cacheLifeMs: HOUR, providers: { anthropic: ANTHROPIC } }).pipe(Layer.provide(externals)))
    return Context.get(context, Model.Pool)
  })
  const pool = yield* boot(limits)
  for (const [index, expected] of [0.005, 0.01, 0.015].entries()) {
    yield* TestClock.setTime(4 * HOUR + index * 1_000)
    const launchID = `launch-${index}`
    const sessionID = `worker-${index}`
    expect(yield* pool.reserveLaunch({ providerID: "anthropic", model: MODEL, sessionID: "parent", launchID })).toMatchObject({ ok: true, forecast: { cost: expected, samples: index } })
    if (index === 0) yield* pool.release(sessionID)
    yield* pool.place({ providerID: "anthropic", model: MODEL, sessionID, kind: "primary" })
    yield* pool.stepEnded(sessionID, 0, `msg-${index}`, { providerID: "anthropic", model: MODEL, tokens })
    // A fast child can complete before the original tool's result supplies its identity.
    yield* pool.release(sessionID)
    yield* pool.bindLaunch(launchID, sessionID)
    yield* limits.flush
  }
  expect(yield* pool.pace("anthropic", MODEL)).toMatchObject({ forecast: { cost: 0.02, samples: 3, source: "hour" } })
  yield* TestClock.setTime(4 * HOUR + 10_000)
  // A follow-up is independent work; it must not inflate the first launch's training sample.
  yield* pool.place({ providerID: "anthropic", model: MODEL, sessionID: "worker-0", kind: "primary" })
  yield* pool.stepEnded("worker-0", 0, "follow-up", { providerID: "anthropic", model: MODEL, tokens: { ...tokens, input: 100e6 } })
  yield* pool.release("worker-0")
  yield* limits.flush
  expect(yield* pool.pace("anthropic", MODEL)).toMatchObject({ forecast: { cost: 0.02, samples: 3 } })
  const restoredLimits = Context.get(yield* Layer.build(LimitsLive.layer(Ledger.storage(uses), `${dir.path}/limits.json`)), Limits)
  const restarted = yield* boot(restoredLimits)
  expect(yield* restarted.pace("anthropic", MODEL)).toMatchObject({ forecast: { cost: 0.02, samples: 3 } })
  expect(Option.fromUndefinedOr((yield* restarted.report).starts[0])._tag).toBe("Some")
}).pipe(Effect.scoped))
