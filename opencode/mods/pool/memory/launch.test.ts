import { Context, Effect, Layer, Option, Schema } from "effect"
import { expect, it } from "effect-bun-test"
import { TestClock } from "effect/testing"
import { PoolId } from "../account-pool.ts"
import * as Model from "../model.ts"
import * as Lease from "../lease.ts"
import { Peers, PeerUnreachable } from "../service.ts"
import * as Fleet from "./fleet.ts"
import * as Ledger from "./ledger.ts"
import * as Logins from "./logins.ts"
import * as Owner from "./owner.ts"
import * as Quota from "./quota.ts"
import * as Resets from "./resets.ts"

const NOW = Date.parse("2026-11-25T19:00:00Z")
const HOUR = 3_600_000
const WEEK = 7 * 24 * 3_600_000
const ANTHROPIC = PoolId.make("anthropic")

it.effect("Mac and Workbox negotiate one remaining launch slot, including restart and idempotent retry", () => Effect.gen(function* () {
  yield* TestClock.setTime(NOW)
  const pools = new Map<string, Model.Pool["Service"]>()
  const down = new Set<string>()
  const legacy = new Set<string>()
  const states = new Map<string, Map<string, Schema.Json>>()
  const boot = (host: string, peer: string) => Effect.gen(function* () {
    const entries = Option.getOrElse(Option.fromNullishOr(states.get(host)), () => new Map<string, Schema.Json>())
    states.set(host, entries)
    const other = () => Option.filter(Option.fromNullishOr(pools.get(peer)), () => !down.has(peer))
    const unreachable = () => new PeerUnreachable({ peer, message: "offline" })
    const network = Layer.succeed(Peers, Peers.of({
      names: [peer],
      report: () => Option.match(other(), {
        onNone: () => Effect.fail(unreachable()),
        onSome: (pool) => pool.report.pipe(Effect.map((report) => {
          if (legacy.has(peer)) { const { launchProtocol: _version, ...old } = report; return old }
          return report
        })),
      }),
      lease: (_peer, message) => Option.match(other(), { onNone: () => Effect.fail(unreachable()), onSome: (pool) => pool.lease(message) }),
      push: () => Effect.fail(unreachable()),
    }))
    const externals = Layer.mergeAll(
      network, Layer.succeed(Lease.Leases, Lease.make({ quietMs: 0 })),
      Logins.layer({ connections: new Map([[ANTHROPIC, [{ type: "credential", method: "oauth", id: "a", label: "Claude" }]]]), marks: [] }),
      Quota.layer(new Map([[ANTHROPIC, new Map([["a", { at: NOW, windows: [{ name: "5h", utilization: 0.1, resetAt: NOW + 3_600_000 }, { name: "7d", utilization: 0.044, resetAt: NOW + WEEK }] }]])]]), new Map()),
      Ledger.layer(), Fleet.layer(entries), Resets.layer(), Owner.layer(Owner.empty()),
    )
    const services = yield* Layer.build(Model.layer({ cacheLifeMs: HOUR, providers: { anthropic: ANTHROPIC }, fleet: { ...Model.DEFAULT_FLEET, host } }).pipe(Layer.provide(externals)))
    const pool = Context.get(services, Model.Pool)
    pools.set(host, pool)
    return pool
  })
  const mac = yield* boot("mac", "workbox")
  const workbox = yield* boot("workbox", "mac")
  const launch = (pool: Model.Pool["Service"], launchID: string) => pool.reserveLaunch({ providerID: "anthropic", model: "claude-opus-5-5", sessionID: "parent", launchID })
  const replies = yield* Effect.all([launch(mac, "mac-one"), launch(workbox, "workbox-one")], { concurrency: 2 })
  expect(replies.filter((answer) => answer.ok)).toHaveLength(1)
  const reports = yield* Effect.all([mac.report, workbox.report])
  expect(reports.flatMap((report) => report.starts)).toHaveLength(1)
  // Neither the quota endpoint nor a process restart has yet observed the admitted worker's spend.
  const restarted = yield* boot("mac", "workbox")
  expect((yield* launch(restarted, "another")).ok).toBe(false)
  expect((yield* launch(workbox, "another")).ok).toBe(false)
  for (const report of reports) for (const start of report.starts) {
    const pool = Option.getOrThrow(Option.fromNullishOr(pools.get(report.host)))
    const originalID = Option.getOrThrow(Option.fromUndefinedOr(start.id)).slice(`${report.host}:`.length)
    expect((yield* launch(pool, originalID)).ok).toBe(true)
  }
  down.add("workbox")
  expect(yield* launch(restarted, "offline")).toMatchObject({ ok: false, reasonCode: "fleet-unavailable" })
  // Existing owner messages do not require this worker agreement.
  expect(yield* restarted.place({ providerID: "anthropic", sessionID: "parent", kind: "primary", model: "claude-opus-5-5", priority: true })).toMatchObject({ credentialID: "a" })
  down.clear()
  legacy.add("workbox")
  expect(yield* launch(restarted, "old-peer")).toMatchObject({ ok: false, reasonCode: "fleet-unavailable" })
}).pipe(Effect.scoped))

// A host that does not pace a provider still reports the workers it launches on it: a peer that paces that provider on
// the same accounts (`paced`) counts them, once, before any reading shows their spend (launch-admission.md).
const unpacedWorld = Effect.gen(function* () {
  const pools = new Map<string, Model.Pool["Service"]>()
  const stores = new Map<string, Map<string, Schema.Json>>()
  const boot = (host: string, peer: Option.Option<string>, config: Omit<Model.Config, "cacheLifeMs">) => Effect.gen(function* () {
    // A restart keeps the host's storage: the same map under a new layer.
    const entries = Option.getOrElse(Option.fromNullishOr(stores.get(host)), () => new Map<string, Schema.Json>())
    stores.set(host, entries)
    const unreachable = (name: string) => new PeerUnreachable({ peer: name, message: "offline" })
    const other = (name: string) => Option.match(Option.fromNullishOr(pools.get(name)), { onNone: () => Effect.fail(unreachable(name)), onSome: Effect.succeed })
    const network = Layer.succeed(Peers, Peers.of({
      names: Option.toArray(peer),
      report: (name) => Effect.flatMap(other(name), (pool) => pool.report),
      lease: (name, message) => Effect.flatMap(other(name), (pool) => pool.lease(message)),
      push: (name) => Effect.fail(unreachable(name)),
    }))
    const externals = Layer.mergeAll(
      network, Layer.succeed(Lease.Leases, Lease.make({ quietMs: 0 })),
      Logins.layer({ connections: new Map([[ANTHROPIC, [{ type: "credential", method: "oauth", id: "a", label: "Claude" }]]]), marks: [] }),
      Quota.layer(new Map([[ANTHROPIC, new Map([["a", { at: NOW, windows: [{ name: "5h", utilization: 0.1, resetAt: NOW + HOUR }, { name: "7d", utilization: 0.45, resetAt: NOW + WEEK / 2 }] }]])]]), new Map()),
      Ledger.layer(), Fleet.layer(entries), Resets.layer(), Owner.layer(Owner.empty()),
    )
    const services = yield* Layer.build(Model.layer({ cacheLifeMs: HOUR, ...config }).pipe(Layer.provide(externals)))
    const pool = Context.get(services, Model.Pool)
    pools.set(host, pool)
    return pool
  })
  // Host A paces nothing: its scripted provider spends the accounts host B paces.
  const bootA = boot("a", Option.none(), { providers: {}, fleet: { ...Model.DEFAULT_FLEET, host: "a" } })
  const b = yield* boot("b", Option.some("a"), { providers: {}, paced: { sim: ANTHROPIC }, fleet: { ...Model.DEFAULT_FLEET, host: "b", startCost: 0.05 } })
  const launch = (pool: Model.Pool["Service"], launchID: string) => pool.reserveLaunch({ providerID: "sim", model: "sim-model", sessionID: "parent", launchID })
  return { bootA, b, launch }
})

it.effect("a launch on a provider this host does not pace is reserved for the peer that paces it, once", () => Effect.gen(function* () {
  yield* TestClock.setTime(NOW)
  const { bootA, b, launch } = yield* unpacedWorld
  const a = yield* bootA
  // On its readings alone B has room for one more worker: 45% used plus its own 5% stays under the line.
  expect(yield* b.pace("sim", "sim-model")).toMatchObject({ ok: true, measured: true })
  for (const launchID of ["first", "second", "first"]) expect(yield* launch(a, launchID)).toMatchObject({ ok: true, measured: false })
  const starts = (yield* a.report).starts
  // Not priced here (A has no reading of the accounts), and typed so: each reader counts it at its own launch estimate.
  expect(starts).toEqual([
    { id: "a:first", providerID: "sim", model: "sim-model", unpaced: true, at: NOW },
    { id: "a:second", providerID: "sim", model: "sim-model", unpaced: true, at: NOW },
  ])
  expect(yield* a.fleet).toMatchObject({ host: "a", starts: 2 })
  // B's next worker is held by A's two: 45% used, plus B's 5% estimate each over one account and its own 5%, past the line.
  const held = yield* b.reserveLaunch({ providerID: "sim", model: "sim-model", sessionID: "parent", launchID: "third" })
  expect(held).toMatchObject({ ok: false, measured: true })
  expect(held.reason).toContain("plus 10.0% of the week counted for 2 agents started in the last 10 min")
  // They settle as any start does: after the settle time neither host counts them, and B's worker goes.
  yield* TestClock.adjust(Model.DEFAULT_FLEET.settleMs)
  yield* b.poll
  expect(yield* a.fleet).toMatchObject({ starts: 0 })
  expect(yield* b.fleet).toMatchObject({ peers: [{ name: "a", starts: 0 }] })
  expect(yield* b.reserveLaunch({ providerID: "sim", model: "sim-model", sessionID: "parent", launchID: "fourth" })).toMatchObject({ ok: true, measured: true })
}).pipe(Effect.scoped))

/** A seeded generator: the same seed, the same sequence. */
const generator = (seed: number) => {
  const state = { value: Math.max((seed * 2654435761) >>> 0, 1) }
  return () => {
    state.value ^= state.value << 13
    state.value ^= state.value >>> 17
    state.value ^= state.value << 5
    return (state.value >>> 0) / 4294967296
  }
}

// Property: whatever mix of retries, new launches, restarts of the launching host and reads by its peer, the peer counts
// each distinct unpaced launch exactly once.
it.effect("an unpaced launch counts once on the peer across retries, restarts and repeated reads", () => Effect.gen(function* () {
  for (const seed of Array.from({ length: 30 }, (_, index) => index + 1)) {
    yield* TestClock.setTime(NOW)
    const random = generator(seed)
    const { bootA, b, launch } = yield* unpacedWorld
    const host = { a: yield* bootA }
    const launched = new Set<string>()
    for (const _step of Array.from({ length: 12 })) {
      yield* TestClock.adjust(Model.DEFAULT_FLEET.pollMs)
      const roll = random()
      if (roll < 0.6) {
        const launchID = `w${Math.floor(random() * 4)}`
        launched.add(launchID)
        expect(yield* launch(host.a, launchID)).toMatchObject({ ok: true, measured: false })
      } else if (roll < 0.8) host.a = yield* bootA
      else yield* b.poll
    }
    yield* TestClock.adjust(Model.DEFAULT_FLEET.pollMs)
    yield* b.poll
    const ids = (yield* host.a.report).starts.map((start) => start.id)
    expect({ seed, ids: ids.toSorted() }).toEqual({ seed, ids: [...launched].map((id) => `a:${id}`).toSorted() })
    expect({ seed, fleet: yield* b.fleet }).toMatchObject({ seed, fleet: { peers: [{ name: "a", starts: launched.size }] } })
    const quoted = (yield* b.pace("sim", "sim-model")).reason
    if (launched.size > 0) expect({ seed, quoted }).toMatchObject({ seed, quoted: expect.stringContaining(`counted for ${launched.size} agent`) })
  }
}).pipe(Effect.scoped))
