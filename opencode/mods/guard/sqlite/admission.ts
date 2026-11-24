import { Database } from "bun:sqlite"
import { Clock, Context, Effect, FileSystem, Layer, Option, Path, Predicate, Schema } from "effect"
import { Admission, AdmissionUnavailable, initial, type Lease, LeaseLedger, receipt, transition } from "../admission.ts"
import { Reply } from "../admission-wire.ts"
import { Holder, HolderJournal, canonicalHolder, holderOf, normalizeHolder, NO_PROOF, trustedObservation, UNKNOWN_OWNER, UNKNOWN_USAGE } from "../host-resources.ts"
import { POLICY } from "../host-supply.ts"
import { ProcessPin } from "../process/launchers.ts"

export interface Identity {
  readonly hostId: string
  readonly bootId: string
}
const stateJson = Schema.fromJsonString(Admission)
const replyJson = Schema.fromJsonString(Reply)
const holderJson = Schema.fromJsonString(Holder)
const decodeState = Schema.decodeUnknownSync(stateJson)
const encodeState = Schema.encodeSync(stateJson)
const decodeReply = Schema.decodeUnknownSync(replyJson)
const encodeReply = Schema.encodeSync(replyJson)
const decodeHolder = Schema.decodeUnknownSync(holderJson)

const migrate = (db: Database) => {
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON")
  return db.transaction(() => {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version
    if (!Object.is(version, 0) && !Object.is(version, 1)) return false
    db.exec(`CREATE TABLE IF NOT EXISTS admission_v1 (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lease_events_v1 (revision INTEGER PRIMARY KEY, id TEXT NOT NULL, owner TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS lease_events_by_id_v1 ON lease_events_v1(id, owner, revision);
    CREATE TABLE IF NOT EXISTS holders_v1 (revision INTEGER PRIMARY KEY, boot TEXT NOT NULL, holder TEXT NOT NULL, producer TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS holder_by_id_v1 ON holders_v1(boot, holder, revision);
    CREATE UNIQUE INDEX IF NOT EXISTS holder_by_producer_v1 ON holders_v1(boot, producer, seq);
    CREATE TABLE IF NOT EXISTS native_volumes_v1 (boot TEXT NOT NULL, resource TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(boot, resource));
    CREATE TABLE IF NOT EXISTS native_peers_v1 (boot TEXT NOT NULL, owner TEXT NOT NULL, pid INTEGER NOT NULL, start INTEGER NOT NULL, PRIMARY KEY(boot, owner));
    CREATE TABLE IF NOT EXISTS native_scopes_v1 (boot TEXT NOT NULL, binding TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(boot, binding));
    CREATE TABLE IF NOT EXISTS native_holds_v1 (boot TEXT NOT NULL, binding TEXT NOT NULL, since INTEGER NOT NULL, evidence TEXT NOT NULL, PRIMARY KEY(boot, binding));
    CREATE TABLE IF NOT EXISTS native_sampler_v1 (boot TEXT PRIMARY KEY, owner TEXT NOT NULL, until INTEGER NOT NULL);
    PRAGMA user_version=1`)
    return true
  }).immediate()
}

const unavailable = () => new AdmissionUnavailable({ reason: "unavailable" })
const reject = (reason: ConstructorParameters<typeof AdmissionUnavailable>[0]["reason"]) => new AdmissionUnavailable({ reason })
const sql = <A>(body: () => A) => Effect.try({ try: body, catch: unavailable })

const data = (db: Database, identity: Identity) => {
  const read = db.query<{ body: string }, []>("SELECT body FROM admission_v1 WHERE singleton = 1")
  const write = db.query("INSERT INTO admission_v1 VALUES(1, ?) ON CONFLICT(singleton) DO UPDATE SET body = excluded.body")
  const load = () => {
    const row = read.get()
    if (Predicate.isNull(row)) return initial(identity.hostId, identity.bootId)
    return decodeState(row.body)
  }
  const current = () => {
    const state = load()
    if (state.hostId !== identity.hostId) return Option.none()
    if (state.bootId === identity.bootId) return Option.some(state)
    return Option.some(initial(identity.hostId, identity.bootId, state.revision + 1))
  }
  const save = (state: Admission) => write.run(encodeState(state))
  return { current, save }
}

const holderState: Readonly<Record<Lease["state"], Holder["state"]>> = {
  queued: "awaiting", granted: "starting", running: "live", draining: "draining",
  released: "terminal", expired: "terminal", cancelled: "terminal", refused: "terminal",
}
const ownerClass = { "external-runner": "unknown", "native-shell": "agent", "wake-job": "agent" } as const
const holderCoverage = (binding: Lease["binding"]): Holder["coverage"] => {
  if (Option.isNone(binding)) return "unknown"
  return "partial"
}
const proofOf = (row: Lease): typeof NO_PROOF => {
  if (row.state !== "released" || row.reason !== "scope-drained" || Option.isNone(row.evidence)) return NO_PROOF
  return { kind: "backend-quiescent", issuerId: Option.some("arbiter"), evidenceRef: row.evidence,
    epoch: Option.some(row.generation), validUntilBootMs: Option.some(row.changedAt + POLICY.freshnessMs) }
}
const controllerOf = (host: Identity, row: Lease, wall: number): Holder => holderOf({
  version: 1, hostId: host.hostId, bootId: host.bootId,
  resourceId: `execution-${row.id}`, incarnation: `incarnation-${row.generation}`, holderId: `admitted-${row.id}`,
  revision: Option.some(row.sequence), kind: "process-tree",
  owner: { ...UNKNOWN_OWNER, class: ownerClass[row.request.principal.kind], authorityId: Option.some(row.owner) },
  relation: "controller", parentResourceId: Option.none(), dependsOn: row.request.demand.keys,
  placement: { volumeId: Option.fromNullishOr(row.request.demand.volumeReservations[0]?.volumeId), objectRef: Option.none(), confinementRef: row.binding },
  lease: Option.some({ id: row.id, generation: row.generation }), usage: UNKNOWN_USAGE,
  observedAtMs: wall, sampleBootMs: row.changedAt, lastUseAtMs: Option.none(), coverage: holderCoverage(row.binding),
  state: holderState[row.state], proof: proofOf(row), protection: "eligible-class",
  producerId: "arbiter", producerSeq: row.sequence,
})

type BootClock = () => Option.Option<number>
const store = (db: Database, identity: Identity, readClock?: BootClock): LeaseLedger["Service"] => {
  const { current, save } = data(db, identity)
  const insert = db.query("INSERT INTO lease_events_v1 VALUES (?, ?, ?, ?)")
  const insertHolder = db.query("INSERT INTO holders_v1 VALUES (?, ?, ?, ?, ?, ?)")
  const select = db.query<{ body: string }, [string, string, number]>(
    "SELECT body FROM lease_events_v1 WHERE id = ? AND owner = ? AND revision > ? ORDER BY revision LIMIT 128",
  )
  return LeaseLedger.of({
    transact: Effect.fn("LeaseLedger.transact")(function* (input, observation) {
      const wall = yield* Clock.currentTimeMillis
      const result = yield* sql(() => db.transaction(() => {
        const before = current()
        if (Option.isNone(before)) return Option.none()
        const now = (readClock || (() => Option.some(observation.now)))()
        if (Option.isNone(now)) return Option.none()
        const next = transition(before.value, input, { ...observation, now: now.value })
        for (const change of next.changes) {
          insert.run(change.sequence, change.id, change.owner, encodeReply(receipt(next.state, change)))
          const holder = controllerOf(identity, change, wall)
          insertHolder.run(change.sequence, holder.bootId, holder.holderId, holder.producerId, holder.producerSeq, canonicalHolder(holder))
        }
        if (next.changes.length > 0) save(next.state)
        return Option.some(next)
      }).immediate())
      if (Option.isNone(result)) return yield* reject("incompatible")
      return result.value
    }),
    replay: Effect.fn("LeaseLedger.replay")(function* (address, after) {
      if (!address.id.startsWith(`${identity.bootId}:`)) return yield* reject("stale")
      return yield* sql(() => select.all(address.id, address.owner, after).map(({ body }) => decodeReply(body)))
    }),
    inspect: Effect.fn("LeaseLedger.inspect")(function* () {
      const result = yield* sql(current)
      if (Option.isNone(result)) return yield* reject("incompatible")
      return result.value
    }),
  })
}

const PAGE = 128
const MAX_BATCH = 128
interface HolderReads {
  readonly sameSequence: (seq: number) => Option.Option<Holder>
  readonly last: (holder: string) => Option.Option<Holder>
  readonly maxSequence: () => number
}

const sameObservation = (record: Holder, existing: Holder) =>
  canonicalHolder({ ...record, revision: existing.revision }) === canonicalHolder(existing)

const accepts = (record: Holder, now: number, identity: Identity, producer: string) =>
  record.hostId === identity.hostId && record.bootId === identity.bootId && record.producerId === producer &&
  record.sampleBootMs <= now && now - record.sampleBootMs <= POLICY.freshnessMs &&
  !record.holderId.startsWith("admitted-") && producer !== "arbiter" && trustedObservation(record)

const sameIncarnation = (latest: Holder, record: Holder) =>
  latest.revision === record.revision && latest.producerId === record.producerId && latest.relation === "observation" &&
  latest.incarnation === record.incarnation && latest.resourceId === record.resourceId && latest.kind === record.kind

const planObservations = (state: Admission, records: ReadonlyArray<Holder>, reads: HolderReads) => {
  const written: Holder[] = []
  const added: Array<Holder & { revision: number }> = []
  let revision = state.revision
  let highestSeq = reads.maxSequence()
  for (const record of records.toSorted((a, b) => a.producerSeq - b.producerSeq)) {
    const prior = Option.orElse(Option.fromNullishOr(added.find((row) => row.producerSeq === record.producerSeq)),
      () => reads.sameSequence(record.producerSeq))
    if (Option.isSome(prior)) {
      if (!sameObservation(record, prior.value) || (Predicate.isNotNull(record.revision) && record.revision !== prior.value.revision))
        return Option.none()
      if (!written.some((row) => row.revision === prior.value.revision)) written.push(prior.value)
      continue
    }
    const latest = Option.orElse(Option.fromNullishOr(added.findLast((row) => row.holderId === record.holderId)),
      () => reads.last(record.holderId))
    const valid = Option.match(latest, { onNone: () => Predicate.isNull(record.revision), onSome: (row) => sameIncarnation(row, record) })
    if (record.producerSeq <= highestSeq || !valid) return Option.none()
    highestSeq = record.producerSeq
    const kept = { ...record, revision: ++revision }
    added.push(kept)
    written.push(kept)
  }
  return Option.some({ added, written, state: { ...state, revision } })
}

const holders = (db: Database, identity: Identity): HolderJournal["Service"] => {
  const { current, save } = data(db, identity)
  const body = Option.map((record: { body: string }) => decodeHolder(record.body))
  const same = db.query<{ body: string }, [string, string, number]>("SELECT body FROM holders_v1 WHERE boot = ? AND producer = ? AND seq = ?")
  const latest = db.query<{ body: string }, [string, string]>("SELECT body FROM holders_v1 WHERE boot = ? AND holder = ? ORDER BY revision DESC LIMIT 1")
  const max = db.query<{ n: number }, [string, string]>("SELECT COALESCE(MAX(seq), -1) AS n FROM holders_v1 WHERE boot = ? AND producer = ?")
  const insert = db.query("INSERT INTO holders_v1 VALUES (?, ?, ?, ?, ?, ?)")
  const snapshot = db.query<{ body: string }, [string, number, number, number]>(`SELECT x.body FROM holders_v1 AS x
    JOIN (SELECT MAX(revision) AS r FROM holders_v1 WHERE boot = ? AND revision <= ? GROUP BY holder) AS heads ON x.revision = heads.r
    WHERE x.revision > ? ORDER BY x.revision LIMIT ?`)
  return HolderJournal.of({
    putObservations: Effect.fn("HolderJournal.putObservations")(function* (producer, records, now) {
      if (records.length === 0 || records.length > MAX_BATCH || !records.every((r) => accepts(r, now, identity, producer))) return yield* reject("invalid-request")
      const result = yield* sql(() => db.transaction(() => {
        // Validate the whole batch with the private transaction's read view,
        // including earlier observations in this same batch, before writing.
        const state = current()
        if (Option.isNone(state)) return Option.none()
        const planned = planObservations(state.value, records.map(normalizeHolder), {
          sameSequence: (seq) => body(Option.fromNullishOr(same.get(identity.bootId, producer, seq))),
          last: (holder) => body(Option.fromNullishOr(latest.get(identity.bootId, holder))),
          maxSequence: () => max.get(identity.bootId, producer)?.n ?? -1,
        })
        if (Option.isNone(planned)) return Option.none()
        const { added, written, state: after } = planned.value
        for (const row of added) {
          insert.run(row.revision, row.bootId, row.holderId, row.producerId, row.producerSeq, canonicalHolder(row))
        }
        if (added.length > 0) save(after)
        return Option.some(written)
      }).immediate())
      if (Option.isNone(result)) return yield* reject("stale")
      return result.value
    }),
    list: Effect.fn("HolderJournal.list")(function* (after, pinned) {
      const result = yield* sql(() => db.transaction(() => {
        const state = current()
        if (Option.isNone(state)) return Option.none()
        const { revision: latest, bootStartRevision, hostId, bootId } = state.value
        const revision = pinned ?? latest
        if (after > revision || revision > latest || revision < bootStartRevision) return Option.none()
        const read = snapshot.all(identity.bootId, revision, after, PAGE + 1)
        const records = read.slice(0, PAGE).map(({ body }) => decodeHolder(body))
        const complete = read.length <= PAGE
        const next = Option.filter(Option.fromNullishOr(records.at(-1)?.revision), () => !complete)
        return Option.some({ version: 1 as const, hostId, bootId, revision, complete, next: Option.getOrNull(next), records })
      })())
      if (Option.isNone(result)) return yield* reject("stale")
      return result.value
    }),
  })
}

const PinText = Schema.fromJsonString(ProcessPin)
const decodePin = Schema.decodeUnknownSync(PinText)
const encodePin = Schema.encodeSync(PinText)
const encodeNative = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

/** Native locators are not exported or accepted through the v1 protocol. This
 * side table shares the database but is not a claim or a source of authority. */
const native = (db: Database, boot: string) => {
  const volume = db.query("INSERT INTO native_volumes_v1 VALUES(?, ?, ?) ON CONFLICT(boot, resource) DO UPDATE SET path = excluded.path")
  const volumes = db.query<{ path: string }, [string]>("SELECT path FROM native_volumes_v1 WHERE boot = ? ORDER BY resource LIMIT 32")
  const setPeer = db.query("INSERT OR IGNORE INTO native_peers_v1 VALUES(?, ?, ?, ?)")
  const peer = db.query<{ pid: number; start: number }, [string, string]>("SELECT pid, start FROM native_peers_v1 WHERE boot = ? AND owner = ?")
  const scope = db.query("INSERT OR IGNORE INTO native_scopes_v1 VALUES(?, ?, ?)")
  const getScope = db.query<{ body: string }, [string, string]>("SELECT body FROM native_scopes_v1 WHERE boot = ? AND binding = ?")
  const recordHolders = db.query("INSERT OR IGNORE INTO native_holds_v1 VALUES(?, ?, ?, ?)")
  const probe = db.query("INSERT INTO native_sampler_v1 VALUES(?, ?, ?) ON CONFLICT(boot) DO UPDATE SET owner = excluded.owner, until = excluded.until WHERE native_sampler_v1.until <= ?")
  const finish = db.query("DELETE FROM native_sampler_v1 WHERE boot = ? AND owner = ?")
  return {
    volume: (resource: string, path: string) => sql(() => { volume.run(boot, resource, path) }),
    volumes: () => sql(() => volumes.all(boot).map(({ path }) => path)),
    remember: (owner: string, pid: number, start: number) => sql(() => { setPeer.run(boot, owner, pid, start) }),
    peer: (owner: string) => sql(() => peer.get(boot, owner)),
    pin: Effect.fn("HostJournal.pin")(function* (pin: ProcessPin) {
      const body = encodePin(pin)
      const ok = yield* sql(() => {
        scope.run(boot, pin.ref, body)
        return getScope.get(boot, pin.ref)?.body === body
      })
      if (!ok) return yield* reject("stale")
    }),
    scope: (binding: string) => sql(() =>
      Option.map(Option.fromNullishOr(getScope.get(boot, binding)), ({ body }) => decodePin(body))),
    hold: (binding: string, since: number, evidence: Schema.Json) => sql(() =>
      recordHolders.run(boot, binding, since, encodeNative(evidence)).changes === 1),
    probe: (owner: string, now: number) => sql(() => probe.run(boot, owner, now + POLICY.freshnessMs, now).changes === 1),
    finish: (owner: string) => sql(() => { finish.run(boot, owner) }),
  }
}
export type NativeJournal = ReturnType<typeof native>

export const open = Effect.fn("HostJournal.open")(function* (filename: string, identity: Identity, readClock?: BootClock) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.dirname(filename)
  yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 }).pipe(Effect.mapError(unavailable))
  const stat = yield* fs.lstat(dir).pipe(Effect.mapError(unavailable))
  if (stat.type !== "Directory" || (stat.mode & 0o077) !== 0) return yield* reject("unavailable")
  const canonical = yield* fs.realPath(dir).pipe(Effect.mapError(unavailable))
  if (canonical !== dir) return yield* reject("unavailable")
  const existing = yield* fs.lstat(filename).pipe(
    Effect.map(Option.some),
    Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.succeed(Option.none())),
    Effect.mapError(unavailable),
  )
  if (Option.isSome(existing) && (existing.value.type !== "File" || Option.getOrUndefined(existing.value.nlink) !== 1n))
    return yield* reject("unavailable")
  const db = yield* Effect.acquireRelease(
    sql(() => new Database(filename, { create: true, strict: true })),
    (db) => Effect.sync(() => db.close()),
  )
  yield* fs.chmod(filename, 0o600).pipe(Effect.mapError(unavailable))
  if (!(yield* sql(() => migrate(db)))) return yield* reject("incompatible")
  return { ledger: store(db, identity, readClock), holder: holders(db, identity), native: native(db, identity.bootId) }
})

export const layer = (filename: string, identity: Identity) => Layer.effectContext(
  open(filename, identity).pipe(Effect.map(({ ledger, holder }) =>
    LeaseLedger.context(ledger).pipe(Context.add(HolderJournal, holder))),
  ),
)
