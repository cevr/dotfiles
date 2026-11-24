import * as BunServices from "@effect/platform-bun/BunServices"
import { CryptoHasher } from "bun"
import { Database } from "bun:sqlite"
import { Effect, FileSystem, Option, Path, Predicate, Result, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { expect, it } from "effect-bun-test"
import { AdmissionUnavailable } from "../admission.ts"
import { qualifiedForm } from "../admission-wire.ts"
import fixture from "../fixtures/holder-v1.json"
import {
  EMPTY_OWNER, EMPTY_USAGE, Holder, type ResourceRef, canonicalHolder, readHolderSnapshot, resourceHolders, resourceRef, storageCharges,
} from "../host-resources.ts"
import { owner, request, supply } from "../memory/admission-acceptance.ts"
import { type ProcessPin } from "../process/launchers.ts"
import { type Authority, type Intent, OwnershipEvent, type OwnedReceipt, type OwnerSession } from "../process/ownership.ts"
import { open } from "./admission.ts"

const HOST = { hostId: "host-a", bootId: "boot-a" }
const sample = supply({ cores: 12, now: 2000 })
const folder = Effect.fn("OwnershipFixture.folder")(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped({ prefix: "host-resources-fixture-" }).pipe(Effect.flatMap(fs.realPath))
})
const makeFixture = Effect.fn("OwnershipFixture.open")(function* () {
  const path = yield* Path.Path
  const directory = yield* folder()
  const filename = path.join(directory, "fixture.sqlite")
  const a = yield* open(filename, HOST)
  const b = yield* open(filename, HOST)
  return { directory, filename, a, b }
})

const person = (name: string, lane: string, epoch = 1): Authority =>
  ({ ...HOST, authorityId: name, epoch, owner: { ...EMPTY_OWNER, class: "agent", authorityId: name, laneId: lane, callId: `call-${name}` } })
const draft = (key: string): Intent => ({
  nonce: `nonce-${key}`, resourceId: `resource-${key}`, incarnation: `generation-${key}`, kind: "cache",
  dependsOn: [], parentResourceId: Option.none(), placement: {
    ...fixture.fixtures.disk.placement, objectRef: `native-${key}`,
  },
  coverage: "partial", protection: "eligible-class",
  usage: { ...EMPTY_USAGE, allocatedBytes: 8192, sharedBytes: 4096, extentGroupRef: `extent-${key}` },
})
const eventRef = (receipt: OwnedReceipt): ResourceRef => Option.getOrThrow(resourceRef(receipt.holder))
const expectedRef = (ref: ResourceRef, resourceId = ref.resourceId) => ({ ...ref, resourceId })
const why = <A, E extends { readonly reason: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.result, Effect.map((result) => {
    if (Result.isSuccess(result)) return "accepted"
    return result.failure.reason
  }))

it.effect("the public fixture keeps the peer's neutral bytes and the canonical golden", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = yield* path.fromFileUrl(new URL("../fixtures/holder-v1.json", import.meta.url))
    const published = yield* fs.readFileString(file)
    // B added the golden after the neutral cases, not inside their wire packet.
    const neutral = published.split(',\n  "normalized":')[0]
    expect(new CryptoHasher("sha256").update(`${neutral}\n}\n`).digest("hex"))
      .toBe("50c5063a6318711c194d1f3396b1148906f5362f2c9ff608ecd2e9aff4d61ee8")
    const disk = yield* Schema.decodeUnknownEffect(Holder)(fixture.fixtures.disk)
    expect(canonicalHolder(disk)).toBe(fixture.normalized.disk)
    const launch = yield* Schema.decodeUnknownEffect(Holder)(fixture.fixtures.launch)
    const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Holder))
    expect(canonicalHolder(yield* decodeJson(canonicalHolder(launch)))).toBe(canonicalHolder(launch))
  }).pipe(Effect.provide(BunServices.layer)),
)

const ready = (key: string, session: OwnerSession) =>
  Effect.gen(function* () {
    const first = yield* session.intent(draft(key), 2000)
    const bound = yield* session.change(OwnershipEvent.cases.bind.make({ at: eventRef(first), objectRef: `native-${key}` }), 2001)
    return yield* session.change(OwnershipEvent.cases.publish.make({ at: eventRef(bound) }), 2002)
  })

it.scoped("pin, bound owner and lease commit together before a launcher may exec", () =>
  Effect.gen(function* () {
    const { a, b } = yield* makeFixture()
    const offer = yield* a.ledger.transact({ op: "request", owner: owner("one"), request: request("one") }, sample)
    const id = Option.getOrThrow(Option.fromNullishOr(offer.reply.id))
    const address = { owner: owner("one"), id, generation: 1 }
    const pin: ProcessPin = {
      ...HOST, ref: "binding-a", pid: 415, group: 415, start: 42,
      cgroup: Option.none(), descriptor: { file: "/fixture/private/a.lock", device: "1", inode: "44" },
    }
    expect((yield* b.bind({ ...address, owner: owner("foreign") }, pin, sample)).reply.reason).toBe("wrong-owner")
    expect(yield* a.native.scope(pin.ref)).toEqual(Option.none())
    expect(yield* why(a.bind(address, { ...pin, bootId: "old-boot" }, sample))).toBe("stale")
    expect(yield* a.native.scope(pin.ref)).toEqual(Option.none())
    expect((yield* b.bind(address, pin, sample)).reply.state).toBe("running")
    expect(yield* a.native.scope(pin.ref)).toEqual(Option.some({
      ref: pin.ref, bootId: pin.bootId, pid: pin.pid, group: pin.group, start: pin.start,
      cgroup: pin.cgroup, descriptor: pin.descriptor,
    }))
    const after = yield* readHolderSnapshot(a.holder)
    expect(after.records[0]).toMatchObject({
      state: "live", owner: { ...EMPTY_OWNER, authorityId: owner("one") }, placement: { confinementRef: "binding-a" },
    })
    expect(after.records.map(canonicalHolder).join()).not.toContain(pin.descriptor.file)
    expect((yield* a.bind(address, pin, sample)).reply.reason).toBe("stale")
    expect(yield* readHolderSnapshot(b.holder)).toEqual(after)
    const next = yield* b.ledger.transact({ op: "request", owner: owner("two"), request: request("two") }, sample)
    const second = { generation: 1, owner: owner("two"), id: Option.getOrThrow(Option.fromNullishOr(next.reply.id)) }
    const alias = { ...pin, ref: "new-ref-same-descriptor" }
    const beforeFailedPin = yield* a.holder.list(0)
    expect(yield* why(b.bind(second, alias, sample))).toBe("stale")
    expect(yield* a.native.scope(alias.ref)).toEqual(Option.none())
    expect(yield* a.holder.list(0)).toEqual(beforeFailedPin)
    expect((yield* a.ledger.inspect()).leases[second.id]?.state).toBe("granted")
  }).pipe(Effect.provide(BunServices.layer)),
)

it.scoped("cache borrowers survive other children and lanes, and Work and Reclaim read one fence and one charge", () =>
  Effect.gen(function* () {
    const { a, b, filename } = yield* makeFixture()
    const controller = a.ownership.forOwner(person("cache-adapter", "control-lane"))
    const childOne = a.ownership.forOwner(person("a-one", "lane-a"))
    const childTwo = b.ownership.forOwner(person("a-two", "lane-a"))
    const other = b.ownership.forOwner(person("b-one", "lane-b"))
    const cache = yield* ready("cache", controller)
    const at = eventRef(cache)
    const attach = OwnershipEvent.cases.borrow.make({ at, use: "same-spelling" })
    const release = OwnershipEvent.cases.release.make({ at, use: "same-spelling" })
    const aOne = yield* childOne.change(attach, 2010)
    const aTwo = yield* childTwo.change(attach, 2011)
    const bOne = yield* other.change(attach, 2012)
    expect(aOne.holder.holderId).toBe(aTwo.holder.holderId)
    expect(bOne.holder.holderId).not.toBe(aOne.holder.holderId)
    const foreign = a.ownership.forOwner(person("foreign", "lane-a"))
    expect(yield* why(foreign.change(release, 2013))).toBe("wrong-owner")
    expect((yield* childOne.change(release, 2014)).holder.state).toBe("live")
    expect((yield* childOne.change(release, 2015)).disposition).toBe("unchanged")
    const gone = OwnershipEvent.cases.reconcile.make({ at, objectRef: "native-cache", fact: "gone", witness: "backend-fact", sequence: 1, sampleBootMs: 2012 })
    expect(yield* why(controller.change(gone, 2016))).toBe("resource")
    expect((yield* childTwo.change(release, 2017)).holder.state).toBe("terminal")
    expect(yield* why(controller.change(gone, 2018))).toBe("resource")
    const scanned = yield* Schema.decodeUnknownEffect(Holder)(fixture.fixtures.disk)
    yield* b.holder.putObservations("scanner-a", [{ ...scanned, resourceId: at.resourceId, incarnation: at.incarnation }], 2019)
    const left = yield* Effect.scoped(open(filename, HOST).pipe(Effect.flatMap(({ holder }) => readHolderSnapshot(holder))))
    const right = yield* Effect.scoped(open(filename, HOST).pipe(Effect.flatMap(({ holder }) => readHolderSnapshot(holder))))
    const work = Option.getOrThrow(resourceHolders(left, at))
    const reclaim = Option.getOrThrow(resourceHolders(right, at))
    expect(work).toEqual(reclaim)
    expect(work.map((row) => [row.relation, row.state])).toEqual([
      ["controller", "live"], ["borrower", "live"], ["borrower", "terminal"], ["observation", "unknown"],
    ])
    expect(storageCharges(work)).toEqual([{ allocatedBytes: Option.some(8192), sharedBytes: Option.some(4096) }])
    expect((yield* other.change(release, 2020)).holder.state).toBe("terminal")
    expect(yield* why(controller.change(gone, 2021))).toBe("stale")
    const ended = yield* controller.change({ ...gone, sampleBootMs: 2021 }, 2021)
    expect(ended.holder.state).toBe("terminal")
    expect(ended.holder.proof.kind).toBe("backend-quiescent")
    const reopened = yield* readHolderSnapshot(b.holder)
    expect(resourceHolders(reopened, at)).toEqual(Option.none())
    expect(resourceHolders(reopened, eventRef(ended)).pipe(Option.isSome)).toBe(true)
  }).pipe(Effect.provide(BunServices.layer)),
)

it.scoped("changing only a locator cannot alter a holder, leak a path, or bind its replacement", () =>
  Effect.gen(function* () {
    const { a, b } = yield* makeFixture()
    const session = a.ownership.forOwner(person("storage-adapter", "control-lane"))
    const stored = yield* ready("location", session)
    const at = eventRef(stored)
    yield* session.rememberLocator(at, { objectRef: "native-location", path: "/fixture/private/initial" })
    expect(yield* session.locator(at)).toEqual(Option.some("/fixture/private/initial"))
    const before = yield* b.holder.list(0)
    yield* session.rememberLocator(at, { objectRef: "native-location", path: "/fixture/private/renamed" })
    expect(yield* why(session.rememberLocator(at, { objectRef: "native-replacement", path: "/fixture/private/renamed" }))).toBe("stale")
    const fake = b.ownership.forOwner(person("other", "foreign-lane"))
    expect(yield* fake.locator(at)).toEqual(Option.none())
    expect(yield* session.locator(expectedRef(at, "replacement"))).toEqual(Option.none())
    expect(yield* session.locator(at)).toEqual(Option.some("/fixture/private/renamed"))
    const after = yield* a.holder.list(0)
    expect(after).toEqual(before)
    for (const row of after.records) expect(canonicalHolder(row)).not.toContain("/fixture/private/")
    expect(yield* why(fake.intent({
      ...draft("aliased"), placement: { ...draft("location").placement },
    }, 2003))).toBe("resource")
    const retired = yield* session.change(OwnershipEvent.cases.reconcile.make({
      at, objectRef: "native-location", fact: "gone", witness: "closed", sequence: 1, sampleBootMs: 2004,
    }), 2004)
    const replacement = yield* fake.intent({
      ...draft("location"), nonce: "replacement", incarnation: "replacement-generation",
      placement: { ...draft("location").placement, objectRef: "replacement-object" },
    }, 2005)
    expect(yield* why(session.rememberLocator(eventRef(replacement), { objectRef: "replacement-object", path: "/fixture/private/renamed" }))).toBe("stale")
    expect(resourceHolders(yield* readHolderSnapshot(b.holder), eventRef(retired))).toEqual(Option.none())
  }).pipe(Effect.provide(BunServices.layer)),
)

it.scoped("two authenticated scans share a restart-stable CAS frontier and no scanner becomes an owner", () =>
  Effect.gen(function* () {
    const { a, b, filename } = yield* makeFixture()
    const disk = yield* Schema.decodeUnknownEffect(Holder)(fixture.fixtures.disk)
    let saved = disk
    for (let i = 1; i <= 100; i++) {
      const row = { ...disk, producerSeq: i * 2, revision: saved.revision, observedAtMs: 1_000_000 + i }
      const scanner = Option.getOrThrow(Option.fromNullishOr(disk.producerId))
      const before = yield* a.holder.list(0)
      const bad = [{ ...row, producerSeq: i * 2 - 1, state: "terminal" as const }, row]
      expect(yield* why(a.holder.putObservations(scanner, bad, 2000))).toBe("invalid-request")
      expect(yield* why(b.holder.putObservations("foreign", [row], 2000))).toBe("invalid-request")
      const records = yield* b.holder.putObservations(scanner, [row, row], 2001)
      expect(records).toHaveLength(1)
      saved = Option.getOrThrow(Option.fromNullishOr(records[0]))
      const peers = [a, b]
      const peer = Option.getOrThrow(Option.fromNullishOr(peers[i % 2]))
      expect(yield* peer.holder.putObservations(scanner, [row], 200_000)).toEqual([saved])
      expect(yield* why(a.holder.putObservations(scanner, [{ ...row, incarnation: "replaced" }], 2001))).toBe("stale")
      expect(yield* why(a.holder.putObservations(scanner, [{ ...row, producerSeq: i * 2 - 1 }], 2001))).toBe("stale")
      expect((yield* b.holder.list(0)).revision).toBe(before.revision + 1)
      expect(yield* a.holder.list(0, before.revision)).toEqual(before)
    }
    const rebooted = yield* open(filename, { ...HOST, bootId: "next-boot" })
    expect((yield* rebooted.holder.list(0)).records).toEqual([])
    expect(yield* why(a.holder.putObservations("scanner-a", [saved], 2000))).toBe("stale")
    expect(yield* why(open(filename, HOST))).toBe("incompatible")
  }).pipe(Effect.provide(BunServices.layer)),
)

const boot = { ...HOST, bootId: "boot-after-fixture" }

const launchHistories = (offset: number, count: number) =>
  Effect.gen(function* () {
    const { a, b, filename } = yield* makeFixture()
    const one = person("first-launcher", "lane-a")
    const two = person("next-launcher", "lane-b")
    const [first, second] = [a.ownership.forOwner(one), b.ownership.forOwner(one)]
    const [third, fourth] = [a.ownership.forOwner(two), b.ownership.forOwner(two)]
    let starts = 0
    for (let seed = offset; seed < offset + count; seed++) {
      const key = `case-${seed}`
      const initial = draft(key)
      const registered = yield* first.intent(initial, 2000)
      const same = yield* second.intent(initial, 2000)
      expect(same).toEqual({ holder: registered.holder, disposition: "unchanged" })
      expect(yield* why(second.intent({ ...initial, incarnation: "next-generation" }, 2000))).toBe("stale")
      const bind = OwnershipEvent.cases.bind.make({ at: eventRef(registered), objectRef: `native-${key}`, confinementRef: `binding-${key}` })
      expect(yield* why(third.change(bind, 2000))).toBe("wrong-owner")
      const bound = yield* second.change(bind, 2000)
      const publish = OwnershipEvent.cases.publish.make({ at: eventRef(bound) })
      const wrongBirth = OwnershipEvent.cases.reconcile.make({
        at: eventRef(bound), objectRef: `recycled-${key}`, fact: "gone", witness: "fixture-proof", sequence: 1, sampleBootMs: 2000,
      })
      expect(yield* why(first.change(wrongBirth, 2000))).toBe("stale")

      // Two deliveries of the same permit; the caller ordering changes over
      // generated histories. Only the successful delivery may run the fake payload.
      const order = [first, second]
      if (seed % 2 === 1) order.reverse()
      let running = bound
      for (const client of order) {
        const issued = yield* Effect.result(client.change(publish, 2001))
        if (Result.isFailure(issued)) {
          expect(issued.failure.reason).toBe("stale")
        } else {
          expect(issued.success.disposition).toBe("start-once")
          starts++
          running = issued.success
        }
      }
      const handoff = OwnershipEvent.cases.handoff.make({ at: eventRef(running), successor: two })
      const offered = yield* first.change(handoff, 2002)
      const adopt = OwnershipEvent.cases.adopt.make({ at: eventRef(offered) })
      expect(yield* why(first.change(adopt, 2002))).toBe("wrong-owner")
      let adopted = yield* Effect.scoped(open(filename, HOST).pipe(Effect.flatMap(({ ownership }) =>
        ownership.forOwner(two).change(adopt, 2003))))
      expect(adopted.holder.state).toBe("unknown")
      expect(adopted.holder.owner.authorityId).toBe(two.authorityId)
      expect(yield* why(fourth.change(adopt, 2003))).toBe("stale")
      expect(yield* why(first.intent(initial, 2003))).toBe("wrong-owner")
      expect(yield* why(third.change(OwnershipEvent.cases.publish.make({ at: eventRef(adopted) }), 2003))).toBe("stale")
      // A delayed old/reused generation and a duplicate evidence ordinal
      // cannot overwrite the adopted holder. Unknown never makes it terminal.
      const facts = ["unknown", "live", "gone"] as const
      for (let step = 0; step < 4; step++) {
        const fact = Option.getOrThrow(Option.fromNullishOr(facts[(seed >> (step * 2)) % 3]))
        const e = OwnershipEvent.cases.reconcile.make({
          at: eventRef(adopted), objectRef: `native-${key}`, fact, witness: `fake-fact-${step}`, sequence: step + 1, sampleBootMs: 2004 + step,
        })
        expect(yield* why(first.change(e, 2004 + step))).toBe("wrong-owner")
        expect(yield* why(third.change({ ...e, at: { ...e.at, bootId: boot.bootId } }, 2004 + step))).toBe("stale")
        if (adopted.holder.state === "terminal") {
          expect(yield* why(fourth.change(e, 2004 + step))).toBe("stale")
          continue
        }
        adopted = yield* fourth.change(e, 2004 + step)
        if (fact === "gone") expect(adopted.holder.state).toBe("terminal")
        else expect(adopted.holder.state).toBe(fact)
        expect(yield* why(third.change({ ...e, at: eventRef(adopted) }, 2004 + step))).toBe("stale")
      }
    }
    expect(starts).toBe(count)
    const seen = yield* readHolderSnapshot(a.holder)
    const afterBoot = yield* open(filename, boot)
    expect((yield* readHolderSnapshot(afterBoot.holder)).records).toEqual([])
    expect((yield* readHolderSnapshot(afterBoot.holder)).revision).toBeGreaterThan(seen.revision)
    expect(yield* why(a.ownership.forOwner(one).intent(draft("replayed-offline"), 3000))).toBe("stale")
    expect(yield* why(afterBoot.ownership.forOwner(one).intent(draft("wrong-new-boot"), 3000))).toBe("stale")
  }).pipe(Effect.provide(BunServices.layer))

for (let shard = 0; shard < 8; shard++) {
  it.scoped(`two clients replay crash and adoption without duplicate starts (seeds ${shard * 8}–${shard * 8 + 7})`,
    () => launchHistories(shard * 8, 8))
}

type Journal = Effect.Success<ReturnType<typeof open>>
interface LegacyAdapter {
  readonly open: (filename: string, identity: typeof HOST) => Effect.Effect<
    Pick<Journal, "ledger" | "holder" | "native">,
    Effect.Error<ReturnType<typeof open>>, Effect.Services<ReturnType<typeof open>>
  >
}
interface LegacyWire { readonly qualifiedForm: typeof qualifiedForm }
const legacyFiles = ["admission.ts", "admission-wire.ts", "host-resources.ts", "sqlite/admission.ts"]
const loadModule = (url: URL) => import(url.href)
const importFixture = <A>(url: URL) => Effect.tryPromise({
  try: (): Promise<A> => loadModule(url),
  catch: () => new AdmissionUnavailable({ reason: "unavailable" }),
})
const oldSource = Effect.fn("OwnershipFixture.v1")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const project = yield* path.fromFileUrl(new URL("../../../", import.meta.url))
  const source = path.join(directory, "legacy-guard")
  yield* fs.makeDirectory(path.join(source, "sqlite"), { recursive: true })
  yield* fs.symlink(path.join(project, "node_modules"), path.join(directory, "node_modules"))
  yield* fs.symlink(path.join(project, "mods/guard/host-supply.ts"), path.join(source, "host-supply.ts"))
  yield* fs.symlink(path.join(project, "mods/guard/process"), path.join(source, "process"))
  for (const file of legacyFiles) {
    const bytes = yield* spawner.string(ChildProcess.make("git", [
      "show", `e1d8f37f13114eded57319b4a543f9d9c1fcf2b0:opencode/mods/guard/${file}`,
    ], { cwd: project, stdin: "ignore", forceKillAfter: "1 second" }))
    yield* fs.writeFileString(path.join(source, file), bytes)
  }
  const root = yield* path.toFileUrl(`${source}/`)
  const adapter = yield* importFixture<LegacyAdapter>(new URL("sqlite/admission.ts", root))
  const wire = yield* importFixture<LegacyWire>(new URL("admission-wire.ts", root))
  return { adapter, wire }
})
const sqlite = (filename: string) => Effect.acquireRelease(
  Effect.try({ try: () => new Database(filename, { create: true, strict: true }),
    catch: () => new AdmissionUnavailable({ reason: "unavailable" }) }),
  (db) => Effect.sync(() => db.close()),
)

it.scoped("the actual old adapter is refused before and after reopen, with no write or lost v1 history", () =>
  Effect.gen(function* () {
    const directory = yield* folder()
    const path = yield* Path.Path
    const filename = path.join(directory, "fixture.sqlite")
    const { adapter, wire } = yield* oldSource(directory)
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
      expect(wire.qualifiedForm("unavailable")).toBe("Retry submission when host status --json can attest the managed pool and volume.")
      expect(yield* current.ledger.inspect()).toEqual(after)
      expect(yield* current.native.peer(`legacy-${i}`)).toBeNull()
      if (i % 2 === 1) yield* peer.intent(currentRecord, 2000)
    }
    const one = yield* Effect.scoped(open(filename, HOST).pipe(Effect.flatMap(({ holder }) => readHolderSnapshot(holder))))
    const two = yield* Effect.scoped(open(filename, HOST).pipe(Effect.flatMap(({ holder }) => readHolderSnapshot(holder))))
    expect(one).toEqual(two)
    expect(two.records.filter((row) => row.relation === "controller")).toHaveLength(33)
    expect(two.records.filter((row) => row.relation === "observation")).toEqual([])
  }).pipe(Effect.provide(BunServices.layer)),
)

it.scoped("new readers give an exact remediation for a future store version without rewriting it", () =>
  Effect.gen(function* () {
    const directory = yield* folder()
    const path = yield* Path.Path
    const filename = path.join(directory, "future.sqlite")
    const future = yield* sqlite(filename)
    future.exec("PRAGMA user_version=7")
    const mode = future.query("PRAGMA journal_mode").get()
    const result = yield* Effect.result(open(filename, HOST))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe("incompatible")
      expect(qualifiedForm(result.failure.reason, result.failure.storeVersion))
        .toBe("Host admission store v7; this binary supports v2. Upgrade host-admit to support store v7.")
    }
    expect(future.query("PRAGMA user_version").get()).toEqual({ user_version: 7 })
    expect(future.query("PRAGMA journal_mode").get()).toEqual(mode)
  }).pipe(Effect.provide(BunServices.layer)),
)

it.scoped("a consumer pins all pages even if a second writer changes an early holder mid-read", () =>
  Effect.gen(function* () {
    const { a, b } = yield* makeFixture()
    const disk = yield* Schema.decodeUnknownEffect(Holder)(fixture.fixtures.disk)
    const entries = Array.from({ length: 128 }, (_, n) => ({ ...disk, holderId: `scan-${n}`, producerSeq: n + 1 }))
    const records = yield* a.holder.putObservations("scanner-a", entries, 2000)
    const old = Option.getOrThrow(Option.fromNullishOr(records[0]))
    yield* a.holder.putObservations("scanner-a", [{ ...disk, holderId: "still-later", producerSeq: 129 }], 2000)
    const first = yield* a.holder.list(0)
    expect(first.complete).toBe(false)
    expect(first.records).toHaveLength(128)
    const newest = { ...old, producerSeq: 130, observedAtMs: 1_002_000 }
    const pinned = yield* readHolderSnapshot({
      ...a.holder,
      list: (after, at) => {
        if (after === 0) return a.holder.list(after, at)
        return b.holder.putObservations("scanner-a", [newest], 2000).pipe(Effect.andThen(a.holder.list(after, at)))
      },
    })
    expect(pinned.revision).toBe(first.revision)
    expect(pinned.records).toHaveLength(129)
    expect(pinned.records[0]).toEqual(old)
    const reference = Option.getOrThrow(resourceRef(old))
    expect(resourceHolders(pinned, reference).pipe(Option.isSome)).toBe(true)
    expect(resourceHolders(yield* readHolderSnapshot(b.holder), reference)).toEqual(Option.none())
  }).pipe(Effect.provide(BunServices.layer)),
)

it.effect("a reader that cannot finish a bounded snapshot does not get a complete frontier", () =>
  Effect.gen(function* () {
    const pages: number[] = []
    const result = yield* why(readHolderSnapshot({
      putObservations: () => Effect.succeed([]),
      list: (after) => Effect.sync(() => {
        pages.push(after)
        return { ...HOST, version: 1, revision: 16_400, complete: false, next: after + 1, records: [] }
      }),
    }))
    expect(result).toBe("unavailable")
    expect(pages).toHaveLength(128)
  }),
)
