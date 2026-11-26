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
