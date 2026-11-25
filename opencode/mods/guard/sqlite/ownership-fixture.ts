import { Database } from "bun:sqlite"
import { Effect, FileSystem, Option, Path, Predicate, Result, Schema } from "effect"
import { expect } from "effect-bun-test"
import { AdmissionUnavailable } from "../admission.ts"
import { type qualifiedForm } from "../admission-wire.ts"
import fixture from "../fixtures/holder-v1.json"
import { EMPTY_OWNER, EMPTY_USAGE, Holder, readHolderSnapshot } from "../host-resources.ts"
import { owner, request, supply } from "../memory/admission-acceptance.ts"
import { type Authority, type Intent } from "../process/ownership.ts"
import { open } from "./admission.ts"

export const HOST = { hostId: "host-a", bootId: "boot-a" }
export const sample = supply({ cores: 12, now: 2000 })
export const folder = Effect.fn("OwnershipFixture.folder")(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped({ prefix: "host-resources-fixture-" }).pipe(Effect.flatMap(fs.realPath))
})
export const person = (name: string, lane: string, epoch = 1): Authority =>
  ({ ...HOST, authorityId: name, epoch, owner: { ...EMPTY_OWNER, class: "agent", authorityId: name, laneId: lane, callId: `call-${name}` } })
export const draft = (key: string): Intent => ({
  nonce: `nonce-${key}`, resourceId: `resource-${key}`, incarnation: `generation-${key}`, kind: "cache",
  dependsOn: [], parentResourceId: Option.none(), placement: {
    ...fixture.fixtures.disk.placement, objectRef: `native-${key}`,
  },
  coverage: "partial", protection: "eligible-class",
  usage: { ...EMPTY_USAGE, allocatedBytes: 8192, sharedBytes: 4096, extentGroupRef: `extent-${key}` },
})
export const why = <A, E extends { readonly reason: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.result, Effect.map((result) => {
    if (Result.isSuccess(result)) return "accepted"
    return result.failure.reason
  }))
export const sqlite = (filename: string) => Effect.acquireRelease(
  Effect.try({ try: () => new Database(filename, { create: true, strict: true }),
    catch: () => new AdmissionUnavailable({ reason: "unavailable" }) }),
  (db) => Effect.sync(() => db.close()),
)

type Journal = Effect.Success<ReturnType<typeof open>>
interface LegacyAdapter {
  readonly open: (filename: string, identity: typeof HOST) => Effect.Effect<
    Pick<Journal, "ledger" | "holder" | "native">,
    Effect.Error<ReturnType<typeof open>>, Effect.Services<ReturnType<typeof open>>
  >
}
interface LegacyWire { readonly qualifiedForm: typeof qualifiedForm }

export const checkLegacyWriter = (adapter: LegacyAdapter, wire: LegacyWire) =>
  Effect.gen(function* () {
    const directory = yield* folder()
    const path = yield* Path.Path
    const filename = path.join(directory, "fixture.sqlite")
    const old = yield* adapter.open(filename, HOST)
    const before = yield* old.ledger.transact({ op: "request", owner: owner("legacy"), request: request("legacy") }, sample)
    const legacyRef = Option.getOrThrow(Option.fromNullishOr(before.reply.id))
    const raw = yield* sqlite(filename)
    const previousWrite = raw.query("INSERT OR IGNORE INTO native_peers_v1 VALUES(?, ?, ?, ?)")
    const current = yield* open(filename, HOST)
    const kept = yield* current.ledger.replay({ id: legacyRef, owner: owner("legacy") }, 0)
    expect(kept.map(({ state }) => state)).toEqual(["queued", "granted"])
    const denied = yield* Effect.result(Effect.try({
      try: () => previousWrite.run(HOST.bootId, "raw-v1-writer", 445, 600),
      catch: (error) => error,
    }))
    expect(Result.isFailure(denied) && Predicate.isError(denied.failure) && denied.failure.message)
      .toContain("incompatible host-admit SQLite writer: private store requires v2")
    const closed = yield* Effect.scoped(why(adapter.open(filename, HOST)))
    expect(closed).toBe("incompatible")
    expect(wire.qualifiedForm("incompatible")).toBe("Use host-admit --help and host status --json for a qualified request.")

    const disk = yield* Schema.decodeUnknownEffect(Holder)(fixture.fixtures.disk)
    const peer = current.ownership.forOwner(person("v2-owner", "lane-v2"))
    for (let i = 0; i < 32; i++) {
      const currentRecord = draft(`v2-${i}`)
      if (i % 2 === 0) yield* peer.intent(currentRecord, 2000)
      const after = yield* current.ledger.inspect()
      const attempts = [
        Effect.asVoid(old.ledger.transact({ op: "request", owner: owner(`old-${i}`), request: request(`old-${i}`) }, sample)),
        Effect.asVoid(old.holder.putObservations("scanner-a", [{ ...disk, producerSeq: i + 1 }], 2000)),
        old.native.remember(`legacy-${i}`, 889, 500),
      ]
      const attempt = Option.getOrThrow(Option.fromNullishOr(attempts[i % attempts.length]))
      expect(yield* why(attempt)).toBe("unavailable")
      expect(wire.qualifiedForm("unavailable")).toBe("Retry once host-admit can open its ledger and read this process's identity; host status --json names any missing capability.")
      expect(yield* current.ledger.inspect()).toEqual(after)
      expect(yield* current.native.peer(`legacy-${i}`)).toBeNull()
      if (i % 2 === 1) yield* peer.intent(currentRecord, 2000)
    }
    const one = yield* Effect.scoped(open(filename, HOST).pipe(Effect.flatMap(({ holder }) => readHolderSnapshot(holder))))
    const two = yield* Effect.scoped(open(filename, HOST).pipe(Effect.flatMap(({ holder }) => readHolderSnapshot(holder))))
    expect(one).toEqual(two)
    expect(two.records.filter((row) => row.relation === "controller")).toHaveLength(33)
    expect(two.records.filter((row) => row.relation === "observation")).toEqual([])
  })
