import { Database } from "bun:sqlite"
import { Clock, Context, Effect, FileSystem, Layer, Option, Path, Predicate, Result, Schema } from "effect"
import { Admission, AdmissionUnavailable, initial, type Input, type Lease, LeaseLedger, type Observation, receipt, transition } from "../admission.ts"
import { Counter, Reply, type Reason } from "../admission-wire.ts"
import {
  EMPTY_OWNER, EMPTY_PROOF, EMPTY_USAGE, Holder, HolderJournal, canonicalHolder, holderOf, normalizeHolder,
  controllerDraft, NO_PROOF, type ResourceRef, sameResource, trustedObservation, UNKNOWN_OWNER, UNKNOWN_USAGE,
} from "../host-resources.ts"
import { POLICY } from "../host-supply.ts"
import { ProcessPin } from "../process/launchers.ts"
import { ref } from "../process/admission.ts"
import {
  Authority, Control, Intent, OwnershipEvent, OwnershipJournal, type NativeLocator, type OwnedReceipt,
  borrowerKey, changeControl, controllerKey, controls, newControl, trustedAuthority, useKey,
} from "../process/ownership.ts"

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
const PinText = Schema.fromJsonString(ProcessPin)
const decodePin = Schema.decodeUnknownSync(PinText)
const encodePin = Schema.encodeSync(PinText)

const STORE_VERSION = 2
const INCOMPATIBLE_WRITER = `incompatible host-admit SQLite writer: private store requires v${STORE_VERSION}`
const PRIVATE_WRITER_TABLES = [
  "admission_v1", "lease_events_v1", "holders_v1", "native_volumes_v1", "native_peers_v1",
  "native_scopes_v1", "native_holds_v1", "native_sampler_v1", "boot_visits_v2",
  "owner_intents_v2", "owner_uses_v2", "native_locators_v2",
]

const versionOf = (db: Database) => db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version
const recognized = (version: ReturnType<typeof versionOf>) => version === 0 || version === 1 || version === STORE_VERSION
const migrate = (db: Database) => {
  db.exec("PRAGMA busy_timeout=5000")
  const found = versionOf(db)
  if (!recognized(found)) return found
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON")
  return db.transaction(() => {
    const version = versionOf(db)
    if (version === STORE_VERSION) return STORE_VERSION
    if (!recognized(version)) return version
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
    CREATE TABLE boot_visits_v2 (boot TEXT PRIMARY KEY);
    CREATE TABLE writer_transaction_v2 (singleton INTEGER PRIMARY KEY CHECK (singleton = 1));
    CREATE TABLE owner_intents_v2 (
      boot TEXT NOT NULL, holder TEXT NOT NULL, issuer TEXT NOT NULL, epoch INTEGER NOT NULL,
      nonce TEXT NOT NULL, submitted TEXT NOT NULL, control TEXT NOT NULL,
      PRIMARY KEY(boot, holder), UNIQUE(boot, issuer, epoch, nonce)
    );
    CREATE TABLE owner_uses_v2 (
      boot TEXT NOT NULL, controller TEXT NOT NULL, borrower TEXT NOT NULL,
      use_ref TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0, 1)),
      PRIMARY KEY(boot, borrower, use_ref)
    );
    CREATE INDEX owner_uses_by_controller_v2 ON owner_uses_v2(boot, controller, active);
    CREATE TABLE native_locators_v2 (
      boot TEXT NOT NULL, object TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(boot, object)
    );
    CREATE INDEX holder_resource_v2 ON holders_v1(boot, json_extract(body, '$.resourceId'), revision);
    CREATE INDEX holder_binding_v2 ON holders_v1(boot, json_extract(body, '$.placement.confinementRef'))
      WHERE json_extract(body, '$.relation') = 'controller';
    CREATE INDEX holder_object_v2 ON holders_v1(boot, json_extract(body, '$.placement.objectRef'))
      WHERE json_extract(body, '$.relation') = 'controller';
    CREATE INDEX native_descriptor_v2 ON native_scopes_v1(boot, json_extract(body, '$.descriptor.device'), json_extract(body, '$.descriptor.inode'));
    PRAGMA user_version=${STORE_VERSION}`)
    for (const table of PRIVATE_WRITER_TABLES) {
      for (const op of ["INSERT", "UPDATE", "DELETE"]) {
        db.exec(`CREATE TRIGGER v2_${table}_${op} BEFORE ${op} ON ${table}
          WHEN NOT EXISTS (SELECT 1 FROM writer_transaction_v2 WHERE singleton = 1)
          BEGIN SELECT RAISE(ABORT, '${INCOMPATIBLE_WRITER}'); END`)
      }
    }
    return STORE_VERSION
  }).immediate()
}

const unavailable = () => new AdmissionUnavailable({ reason: "unavailable" })
const reject = (reason: ConstructorParameters<typeof AdmissionUnavailable>[0]["reason"]) => new AdmissionUnavailable({ reason })
const sql = <A>(body: () => A) => Effect.try({ try: body, catch: unavailable })

/** The marker is visible only inside this IMMEDIATE transaction. An old
 * connection can neither race it nor leave a marker on crash/rollback. */
const writer = (db: Database) => {
  const enter = db.query("INSERT INTO writer_transaction_v2 VALUES (1)")
  const leave = db.query("DELETE FROM writer_transaction_v2 WHERE singleton = 1")
  return <A>(run: () => A) => db.transaction(() => {
    enter.run()
    const result = run()
    leave.run()
    return result
  }).immediate()
}

const data = (db: Database, identity: Identity) => {
  const read = db.query<{ body: string }, []>("SELECT body FROM admission_v1 WHERE singleton = 1")
  const write = db.query("INSERT INTO admission_v1 VALUES(1, ?) ON CONFLICT(singleton) DO UPDATE SET body = excluded.body")
  const load = () => Option.map(Option.fromNullishOr(read.get()), ({ body }) => decodeState(body))
  const current = () => Option.filter(load(), (state) => state.hostId === identity.hostId && state.bootId === identity.bootId)
  const save = (state: Admission) => write.run(encodeState(state))
  const visited = db.query<{ boot: string }, [string]>("SELECT boot FROM boot_visits_v2 WHERE boot = ?")
  const mark = db.query("INSERT OR IGNORE INTO boot_visits_v2 VALUES (?)")
  const activate = () => {
    const prior = load()
    if (Option.isNone(prior)) {
      mark.run(identity.bootId)
      save(initial(identity.hostId, identity.bootId))
      return true
    }
    const state = prior.value
    if (state.hostId !== identity.hostId) return false
    if (state.bootId === identity.bootId) {
      mark.run(state.bootId)
      return true
    }
    if (Predicate.isNotNull(visited.get(identity.bootId))) return false
    mark.run(state.bootId)
    mark.run(identity.bootId)
    save(initial(identity.hostId, identity.bootId, state.revision + 1))
    return true
  }
  return { current, save, activate }
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
const ownerOf = (row: Lease): typeof UNKNOWN_OWNER => {
  const { principal, requestId } = row.request
  const common = { ...UNKNOWN_OWNER, class: ownerClass[principal.kind], authorityId: Option.some(row.owner) }
  if (principal.kind === "native-shell") return {
    ...common, sessionId: Option.some(principal.scopeId), sessionEpoch: Option.some(String(principal.epoch)),
  }
  if (principal.kind === "wake-job") return { ...common, jobId: Option.some(requestId) }
  return common
}
const controllerOf = (host: Identity, row: Lease, wall: number): Holder => holderOf({
  version: 1, hostId: host.hostId, bootId: host.bootId,
  resourceId: `execution-${row.id}`, incarnation: `incarnation-${row.generation}`, holderId: `admitted-${row.id}`,
  revision: Option.some(row.sequence), kind: "process-tree",
  owner: ownerOf(row),
  relation: "controller", parentResourceId: Option.none(), dependsOn: row.request.demand.keys,
  placement: { volumeId: Option.fromNullishOr(row.request.demand.volumeReservations[0]?.volumeId), objectRef: Option.none(), confinementRef: row.binding },
  lease: Option.some({ id: row.id, generation: row.generation }), usage: UNKNOWN_USAGE,
  observedAtMs: wall, sampleBootMs: row.changedAt, lastUseAtMs: Option.none(), coverage: holderCoverage(row.binding),
  state: holderState[row.state], proof: proofOf(row), protection: "eligible-class",
  producerId: "arbiter", producerSeq: row.sequence,
})

type BootClock = () => Option.Option<number>
const pinStore = (db: Database, bootId: string) => {
  const byRef = db.query<{ body: string }, [string, string]>("SELECT body FROM native_scopes_v1 WHERE boot = ? AND binding = ?")
  const byDescriptor = db.query<{ binding: string }, [string, string, string]>(`SELECT binding FROM native_scopes_v1
    WHERE boot = ? AND json_extract(body, '$.descriptor.device') = ? AND json_extract(body, '$.descriptor.inode') = ? LIMIT 1`)
  const put = db.query("INSERT OR IGNORE INTO native_scopes_v1 VALUES(?, ?, ?)")
  return {
    read: (binding: string) => Option.map(Option.fromNullishOr(byRef.get(bootId, binding)), ({ body }) => decodePin(body)),
    bind: (pin: ProcessPin) => Predicate.isNull(byDescriptor.get(bootId, pin.descriptor.device, pin.descriptor.inode)) &&
      put.run(bootId, pin.ref, encodePin(pin)).changes === 1,
  }
}

const bindingUsed = (db: Database, bootId: string) => {
  const previous = db.query<{ holder: string }, [string, string]>(`SELECT holder FROM holders_v1
    WHERE boot = ? AND json_extract(body, '$.placement.confinementRef') = ?
    AND json_extract(body, '$.relation') = 'controller' LIMIT 1`)
  return (binding: string) => Predicate.isNotNull(previous.get(bootId, binding))
}

const store = (db: Database, identity: Identity, readClock?: BootClock) => {
  const { current, save } = data(db, identity)
  const write = writer(db)
  const pins = pinStore(db, identity.bootId)
  const usedBinding = bindingUsed(db, identity.bootId)
  const insert = db.query("INSERT INTO lease_events_v1 VALUES (?, ?, ?, ?)")
  const insertHolder = db.query("INSERT INTO holders_v1 VALUES (?, ?, ?, ?, ?, ?)")
  const select = db.query<{ body: string }, [string, string, number]>(
    "SELECT body FROM lease_events_v1 WHERE id = ? AND owner = ? AND revision > ? ORDER BY revision LIMIT 128",
  )
  const transact = Effect.fn("LeaseLedger.transact")(function* (input: Input, observation: Observation, pin?: ProcessPin) {
      const wall = yield* Clock.currentTimeMillis
      const result = yield* sql(() => write(() => {
        const before = current()
        if (Option.isNone(before)) return Result.fail("incompatible" as const)
        const now = bootTime(observation.now, readClock)
        if (Option.isNone(now)) return Result.fail("unavailable" as const)
        const next = transition(before.value, input, { ...observation, now: now.value })
        if (input.op === "claim" && next.reply.state === "running") {
          if (usedBinding(input.binding) || (pin && !pins.bind(pin))) return Result.fail("stale" as const)
        }
        for (const change of next.changes) {
          insert.run(change.sequence, change.id, change.owner, encodeReply(receipt(next.state, change)))
          const holder = controllerOf(identity, change, wall)
          insertHolder.run(change.sequence, holder.bootId, holder.holderId, holder.producerId, holder.producerSeq, canonicalHolder(holder))
        }
        if (next.changes.length > 0) save(next.state)
        return Result.succeed(next)
      }))
      if (Result.isFailure(result)) return yield* reject(result.failure)
      return result.success
    })
  const ledger = LeaseLedger.of({
    transact: (input, observation) => transact(input, observation),
    replay: Effect.fn("LeaseLedger.replay")(function* (address, after) {
      if (!address.id.startsWith(`${identity.bootId}:`)) return yield* reject("stale")
      const result = yield* sql(() => db.transaction(() => Option.map(current(),
        () => select.all(address.id, address.owner, after).map(({ body }) => decodeReply(body))))())
      if (Option.isNone(result)) return yield* reject("stale")
      return result.value
    }),
    inspect: Effect.fn("LeaseLedger.inspect")(function* () {
      const result = yield* sql(current)
      if (Option.isNone(result)) return yield* reject("incompatible")
      return result.value
    }),
  })
  return {
    ledger,
    bind: (address: { readonly id: string; readonly owner: string; readonly generation: number }, pin: ProcessPin, observation: Observation) => {
      if (pin.bootId !== identity.bootId) return Effect.fail(reject("stale"))
      return transact({ op: "claim", ...address, binding: pin.ref }, observation, pin)
    },
  }
}

const bootTime = (now: number, readClock?: BootClock) => {
  if (Predicate.isUndefined(readClock)) return Option.some(now)
  return readClock()
}

const PAGE = 128
const MAX_BATCH = 128
interface HolderReads {
  readonly sameSequence: (seq: number) => Option.Option<Holder>
  readonly last: (holder: string) => Option.Option<Holder>
  readonly previous: (holder: string, before: number) => Option.Option<Holder>
  readonly maxSequence: () => number
}

const sameObservation = (record: Holder, existing: Holder) =>
  canonicalHolder({ ...record, revision: existing.revision }) === canonicalHolder(existing)

const isHolder = Schema.is(Holder)
const accepts = (record: Holder, identity: Identity, producer: string) =>
  isHolder(record) &&
  record.hostId === identity.hostId && record.bootId === identity.bootId && record.producerId === producer &&
  !["admitted-", "owned-", "borrowed-"].some((prefix) => record.holderId.startsWith(prefix)) &&
  producer !== "arbiter" && trustedObservation(record)

const sameIncarnation = (latest: Holder, record: Holder) =>
  latest.revision === record.revision && latest.producerId === record.producerId && latest.relation === "observation" &&
  latest.incarnation === record.incarnation && latest.resourceId === record.resourceId && latest.kind === record.kind

const planObservations = (state: Admission, records: ReadonlyArray<Holder>, reads: HolderReads, now: number) => {
  const written: Holder[] = []
  const added: Array<Holder & { revision: number }> = []
  let revision = state.revision
  let highestSeq = reads.maxSequence()
  for (const record of records.toSorted((a, b) => a.producerSeq - b.producerSeq)) {
    const prior = Option.orElse(Option.fromNullishOr(added.find((row) => row.producerSeq === record.producerSeq)),
      () => reads.sameSequence(record.producerSeq))
    if (Option.isSome(prior)) {
      if (!sameObservation(record, prior.value)) return Option.none()
      const previous = Option.orElse(
        Option.fromNullishOr(added.findLast((row) => row.holderId === record.holderId && row.producerSeq < record.producerSeq)),
        () => reads.previous(record.holderId, Option.getOrElse(Option.fromNullishOr(prior.value.revision), () => 0)),
      )
      const expected = Option.getOrNull(Option.flatMap(previous, (row) => Option.fromNullishOr(row.revision)))
      if (record.revision !== expected && record.revision !== prior.value.revision) return Option.none()
      if (!written.some((row) => row.revision === prior.value.revision)) written.push(prior.value)
      continue
    }
    const latest = Option.orElse(Option.fromNullishOr(added.findLast((row) => row.holderId === record.holderId)),
      () => reads.last(record.holderId))
    const valid = Option.match(latest, { onNone: () => Predicate.isNull(record.revision), onSome: (row) => sameIncarnation(row, record) })
    if (record.producerSeq <= highestSeq || !valid || record.sampleBootMs > now || now - record.sampleBootMs > POLICY.freshnessMs)
      return Option.none()
    highestSeq = record.producerSeq
    const kept = { ...record, revision: ++revision }
    added.push(kept)
    written.push(kept)
  }
  return Option.some({ added, written, state: { ...state, revision } })
}

const holders = (db: Database, identity: Identity, readClock?: BootClock): HolderJournal["Service"] => {
  const { current, save } = data(db, identity)
  const write = writer(db)
  const body = Option.map((record: { body: string }) => decodeHolder(record.body))
  const same = db.query<{ body: string }, [string, string, number]>("SELECT body FROM holders_v1 WHERE boot = ? AND producer = ? AND seq = ?")
  const latest = db.query<{ body: string }, [string, string]>("SELECT body FROM holders_v1 WHERE boot = ? AND holder = ? ORDER BY revision DESC LIMIT 1")
  const previous = db.query<{ body: string }, [string, string, number]>("SELECT body FROM holders_v1 WHERE boot = ? AND holder = ? AND revision < ? ORDER BY revision DESC LIMIT 1")
  const max = db.query<{ n: number }, [string, string]>("SELECT COALESCE(MAX(seq), -1) AS n FROM holders_v1 WHERE boot = ? AND producer = ?")
  const insert = db.query("INSERT INTO holders_v1 VALUES (?, ?, ?, ?, ?, ?)")
  const snapshot = db.query<{ body: string }, [string, number, number, number]>(`SELECT x.body FROM holders_v1 AS x
    JOIN (SELECT MAX(revision) AS r FROM holders_v1 WHERE boot = ? AND revision <= ? GROUP BY holder) AS heads ON x.revision = heads.r
    WHERE x.revision > ? ORDER BY x.revision LIMIT ?`)
  return HolderJournal.of({
    putObservations: Effect.fn("HolderJournal.putObservations")(function* (producer, records, now) {
      if (records.length === 0 || records.length > MAX_BATCH || !records.every((r) => accepts(r, identity, producer))) return yield* reject("invalid-request")
      const result = yield* sql(() => write(() => {
        // Validate the whole batch with the private transaction's read view,
        // including earlier observations in this same batch, before writing.
        const state = current()
        const time = bootTime(now, readClock)
        if (Option.isNone(state) || Option.isNone(time)) return Option.none()
        const planned = planObservations(state.value, records.map(normalizeHolder), {
          sameSequence: (seq) => body(Option.fromNullishOr(same.get(identity.bootId, producer, seq))),
          last: (holder) => body(Option.fromNullishOr(latest.get(identity.bootId, holder))),
          previous: (holder, before) => body(Option.fromNullishOr(previous.get(identity.bootId, holder, before))),
          maxSequence: () => Option.getOrElse(Option.fromNullishOr(max.get(identity.bootId, producer)?.n), () => -1),
        }, time.value)
        if (Option.isNone(planned)) return Option.none()
        const { added, written, state: after } = planned.value
        for (const row of added) {
          insert.run(row.revision, row.bootId, row.holderId, row.producerId, row.producerSeq, canonicalHolder(row))
        }
        if (added.length > 0) save(after)
        return Option.some(written)
      }))
      if (Option.isNone(result)) return yield* reject("stale")
      return result.value
    }),
    list: Effect.fn("HolderJournal.list")(function* (after, pinned) {
      const result = yield* sql(() => db.transaction(() => {
        const state = current()
        if (Option.isNone(state)) return Option.none()
        const { revision: latest, bootStartRevision, hostId, bootId } = state.value
        const revision = Option.getOrElse(Option.fromNullishOr(pinned), () => latest)
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

const intentDigest = Schema.encodeSync(Schema.fromJsonString(Intent))
const controlJson = Schema.fromJsonString(Control)
const encodeControl = Schema.encodeSync(controlJson)
const decodeControl = Schema.decodeUnknownSync(controlJson)
const valid = { authority: Schema.is(Authority), intent: Schema.is(Intent), event: Schema.is(OwnershipEvent), time: Schema.is(Counter) }

const ownershipRows = (db: Database, identity: Identity) => {
  const boot = identity.bootId
  const latest = db.query<{ body: string }, [string, string]>("SELECT body FROM holders_v1 WHERE boot = ? AND holder = ? ORDER BY revision DESC LIMIT 1")
  const heads = db.query<{ body: string }, [string, string]>(`SELECT x.body FROM holders_v1 x JOIN (
    SELECT MAX(revision) AS r FROM holders_v1 WHERE boot = ? AND json_extract(body, '$.resourceId') = ? GROUP BY holder
    ) AS heads ON x.revision = heads.r`)
  const insert = db.query("INSERT INTO holders_v1 VALUES (?, ?, ?, ?, ?, ?)")
  const foreignObject = db.query<{ holder: string }, [string, string, string]>(`SELECT holder FROM holders_v1
    WHERE boot = ? AND json_extract(body, '$.placement.objectRef') = ?
    AND json_extract(body, '$.relation') = 'controller' AND json_extract(body, '$.resourceId') <> ? LIMIT 1`)
  const submitted = db.query<{ holder: string; submitted: string }, [string, string, number, string]>(
    "SELECT holder, submitted FROM owner_intents_v2 WHERE boot = ? AND issuer = ? AND epoch = ? AND nonce = ?",
  )
  const control = db.query<{ control: string }, [string, string]>("SELECT control FROM owner_intents_v2 WHERE boot = ? AND holder = ?")
  const enroll = db.query("INSERT INTO owner_intents_v2 VALUES (?, ?, ?, ?, ?, ?, ?)")
  const update = db.query("UPDATE owner_intents_v2 SET control = ? WHERE boot = ? AND holder = ?")
  const insertUse = db.query("INSERT INTO owner_uses_v2 VALUES (?, ?, ?, ?, 1)")
  const endUse = db.query("UPDATE owner_uses_v2 SET active = 0 WHERE boot = ? AND borrower = ? AND use_ref = ?")
  const use = db.query<{ active: 0 | 1 }, [string, string, string]>(
    "SELECT active FROM owner_uses_v2 WHERE boot = ? AND borrower = ? AND use_ref = ?",
  )
  const anyUse = db.query<{ active: 1 }, [string, string]>(
    "SELECT active FROM owner_uses_v2 WHERE boot = ? AND controller = ? AND active = 1 LIMIT 1",
  )
  const anyLaneUse = db.query<{ active: 1 }, [string, string]>(
    "SELECT active FROM owner_uses_v2 WHERE boot = ? AND borrower = ? AND active = 1 LIMIT 1",
  )
  return {
    holder: (key: string) => Option.map(Option.fromNullishOr(latest.get(boot, key)), ({ body }) => decodeHolder(body)),
    related: (key: string) => heads.all(boot, key).map(({ body }) => decodeHolder(body)),
    foreignObject: (resourceId: string, objectRef: string) => Predicate.isNotNull(foreignObject.get(boot, objectRef, resourceId)),
    put: (row: Holder, revision: number) => {
      insert.run(revision, boot, row.holderId, row.producerId, revision, canonicalHolder(row))
    },
    submitted: (who: Authority, nonce: string) =>
      Option.fromNullishOr(submitted.get(boot, who.authorityId, who.epoch, nonce)),
    control: (key: string) => Option.map(Option.fromNullishOr(control.get(boot, key)), ({ control }) => decodeControl(control)),
    enroll: (who: Authority, key: string, nonce: string, digest: string) =>
      enroll.run(boot, key, who.authorityId, who.epoch, nonce, digest, encodeControl(newControl(who.epoch))),
    update: (key: string, control: Control) => update.run(encodeControl(control), boot, key),
    activeUse: (key: string, id: string) => Option.map(Option.fromNullishOr(use.get(boot, key, id)), (found) => found.active === 1),
    borrow: (controller: string, key: string, id: string) => insertUse.run(boot, controller, key, id),
    release: (key: string, id: string) => endUse.run(boot, key, id),
    borrowed: (key: string) => Predicate.isNotNull(anyUse.get(boot, key)),
    laneBorrowed: (key: string) => Predicate.isNotNull(anyLaneUse.get(boot, key)),
  }
}

type OwnershipRows = ReturnType<typeof ownershipRows>
type Change = Result.Result<OwnedReceipt, Reason>
const unchanged = (row: Holder): Change => Result.succeed({ holder: row, disposition: "unchanged" })
const commitHolder = (
  rows: OwnershipRows, state: Admission, save: (state: Admission) => void, row: Holder, at: number, wall: number,
  disposition: OwnedReceipt["disposition"] = "recorded",
): Change => {
  const revision = state.revision + 1
  const holder = normalizeHolder({ ...row, revision, producerId: "arbiter", producerSeq: revision, sampleBootMs: at, observedAtMs: wall })
  rows.put(holder, revision)
  save({ ...state, revision })
  return Result.succeed({ holder, disposition })
}

const draftOf = (identity: Identity, who: Authority, input: Intent, key: string): Holder =>
  controllerDraft({ ...input, ...identity, holderId: key, owner: who.owner })

const newIntent = (
  rows: OwnershipRows, identity: Identity, who: Authority, input: Intent, keep: (row: Holder) => Change,
): Change => {
  const key = controllerKey(input)
  const draft = draftOf(identity, who, input, key)
  const hash = ref("intent", intentDigest({ ...input, usage: draft.usage, dependsOn: draft.dependsOn }))
  const prior = rows.submitted(who, input.nonce)
  if (Option.isSome(prior)) {
    if (prior.value.submitted !== hash || prior.value.holder !== key) return Result.fail("stale")
    const old = rows.holder(key)
    const ctl = rows.control(key)
    if (Option.isNone(old) || Option.isNone(ctl) || !controls(old.value, ctl.value, who)) return Result.fail("wrong-owner")
    return unchanged(old.value)
  }
  if (Option.isSome(rows.holder(key)) || rows.related(input.resourceId).some((row) =>
    row.relation === "controller" && row.state !== "terminal")) return Result.fail("resource")
  const { objectRef, confinementRef } = input.placement
  if (Predicate.isNull(objectRef) || Predicate.isNotNull(confinementRef) ||
    input.dependsOn.includes(input.resourceId) || Option.contains(input.parentResourceId, input.resourceId)) return Result.fail("invalid-request")
  if (rows.foreignObject(input.resourceId, objectRef)) return Result.fail("resource")
  rows.enroll(who, key, input.nonce, hash)
  return keep(draft)
}

const borrowerOwner = (who: Authority): Holder["owner"] => {
  if (Predicate.isNull(who.owner.laneId)) return who.owner
  return { ...EMPTY_OWNER, class: who.owner.class, laneId: who.owner.laneId }
}

type UseEvent = Extract<OwnershipEvent, { readonly _tag: "borrow" | "release" }>
const isUse = (event: OwnershipEvent): event is UseEvent =>
  Predicate.isTagged(event, "borrow") || Predicate.isTagged(event, "release")
const changeUse = (rows: OwnershipRows, row: Holder, who: Authority, event: UseEvent, keep: (row: Holder) => Change): Change => {
  if (Predicate.isNotNull(row.lease)) return Result.fail("invalid-request")
  const key = borrowerKey(row, who)
  const id = useKey(who, event.use)
  const active = rows.activeUse(key, id)
  const prior = rows.holder(key)
  if (event._tag === "borrow") {
    if (Option.contains(active, true) && Option.isSome(prior)) return unchanged(prior.value)
    if (Option.isSome(active) || row.state !== "live") return Result.fail("stale")
    rows.borrow(row.holderId, key, id)
    if (Option.exists(prior, ({ state }) => state === "live")) return keep(prior.value)
    return keep({ ...row, holderId: key, owner: borrowerOwner(who), relation: "borrower", usage: EMPTY_USAGE,
      state: "live", proof: EMPTY_PROOF })
  }
  if (Option.isNone(active) || Option.isNone(prior)) return Result.fail("wrong-owner")
  if (!active.value) return unchanged(prior.value)
  rows.release(key, id)
  if (rows.laneBorrowed(key)) return keep(prior.value)
  return keep({ ...prior.value, state: "terminal" })
}

const currentHolder = (rows: OwnershipRows, identity: Identity, at: ResourceRef) =>
  Option.filter(rows.holder(at.holderId), (row) => row.hostId === identity.hostId && row.bootId === identity.bootId &&
    at.hostId === identity.hostId && at.bootId === identity.bootId && row.relation === "controller" &&
    at.revision === row.revision && sameResource(row, at))

const precedesBorrower = (rows: OwnershipRows, target: Holder, event: OwnershipEvent) =>
  Predicate.isTagged(event, "reconcile") && event.fact === "gone" && rows.related(target.resourceId).some((row) =>
    sameResource(row, target) && row.relation === "borrower" && row.sampleBootMs > event.sampleBootMs)

const ownerService = (db: Database, identity: Identity, readClock?: BootClock): OwnershipJournal["Service"] => {
  const { current, save } = data(db, identity)
  const write = writer(db)
  const rows = ownershipRows(db, identity)
  const usedBinding = bindingUsed(db, identity.bootId)
  const putPath = db.query("INSERT INTO native_locators_v2 VALUES (?, ?, ?) ON CONFLICT(boot, object) DO UPDATE SET path = excluded.path")
  const readPath = db.query<{ path: string }, [string, string]>("SELECT path FROM native_locators_v2 WHERE boot = ? AND object = ?")
  const perform = Effect.fn("OwnershipJournal.perform")(function* <A>(
    who: Authority, now: number, apply: (state: Admission, at: number, wall: number) => Result.Result<A, Reason>,
  ) {
    if (!valid.authority(who) || !trustedAuthority(who)) return yield* reject("wrong-owner")
    if (who.hostId !== identity.hostId || who.bootId !== identity.bootId) return yield* reject("stale")
    if (!valid.time(now)) return yield* reject("invalid-request")
    const wall = yield* Clock.currentTimeMillis
    const result = yield* sql(() => write(() => {
      const before = current()
      const time = bootTime(now, readClock)
      if (Option.isNone(before) || Option.isNone(time)) return Result.fail("stale" as const)
      return apply(before.value, time.value, wall)
    }))
    if (Result.isFailure(result)) return yield* reject(result.failure)
    return result.success
  })
  const ownObject = (who: Authority, at: ResourceRef) => {
    const row = currentHolder(rows, identity, at)
    const ctl = rows.control(at.holderId)
    if (Option.isNone(row) || Option.isNone(ctl) || !controls(row.value, ctl.value, who)) return Option.none()
    return Option.fromNullishOr(row.value.placement.objectRef)
  }
  return OwnershipJournal.of({
    forOwner: (who) => ({
      intent: (input, now) => perform(who, now, (state, at, wall) => {
        if (!valid.intent(input)) return Result.fail("invalid-request")
        return newIntent(rows, identity, who, input, (row) => commitHolder(rows, state, save, row, at, wall))
      }),
      change: (event, now) => perform(who, now, (state, at, wall) => {
        if (!valid.event(event)) return Result.fail("invalid-request")
        const row = currentHolder(rows, identity, event.at)
        if (Option.isNone(row)) return Result.fail("stale")
        const keep = (holder: Holder, disposition?: OwnedReceipt["disposition"]) =>
          commitHolder(rows, state, save, holder, at, wall, disposition)
        if (isUse(event)) return changeUse(rows, row.value, who, event, keep)
        const control = rows.control(row.value.holderId)
        if (Option.isNone(control)) return Result.fail("wrong-owner")
        if (event._tag === "bind" && event.confinementRef && usedBinding(event.confinementRef)) return Result.fail("stale")
        const next = changeControl(row.value, control.value, who, event, at, rows.borrowed(row.value.holderId))
        if (Result.isFailure(next)) return next
        if (precedesBorrower(rows, row.value, event)) return Result.fail("stale")
        rows.update(row.value.holderId, next.success.control)
        return keep(next.success.row, next.success.disposition)
      }),
      rememberLocator: (at, locator: NativeLocator) => perform(who, 0, () => {
        if (!Option.contains(ownObject(who, at), locator.objectRef)) return Result.fail("stale")
        putPath.run(identity.bootId, locator.objectRef, locator.path)
        return Result.succeed(void 0)
      }),
      locator: (at) => perform(who, 0, () => Result.succeed(Option.flatMap(ownObject(who, at), (object) =>
        Option.map(Option.fromNullishOr(readPath.get(identity.bootId, object)), ({ path }) => path)))),
    }),
  })
}

const encodeNative = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

/** Native locators are not exported or accepted through the v1 protocol. This
 * side table shares the database but is not a claim or a source of authority. */
const native = (db: Database, identity: Identity) => {
  const boot = identity.bootId
  const { current } = data(db, identity)
  const writerTransaction = writer(db)
  const change = Effect.fn("HostJournal.nativeWrite")(function* <A>(run: () => A) {
    const result = yield* sql(() => writerTransaction(() => Option.map(current(), run)))
    if (Option.isNone(result)) return yield* reject("stale")
    return result.value
  })
  const volume = db.query("INSERT INTO native_volumes_v1 VALUES(?, ?, ?) ON CONFLICT(boot, resource) DO UPDATE SET path = excluded.path")
  const volumes = db.query<{ path: string }, [string]>("SELECT path FROM native_volumes_v1 WHERE boot = ? ORDER BY resource LIMIT 32")
  const setPeer = db.query("INSERT OR IGNORE INTO native_peers_v1 VALUES(?, ?, ?, ?)")
  const peer = db.query<{ pid: number; start: number }, [string, string]>("SELECT pid, start FROM native_peers_v1 WHERE boot = ? AND owner = ?")
  const pins = pinStore(db, boot)
  const recordHolders = db.query("INSERT OR IGNORE INTO native_holds_v1 VALUES(?, ?, ?, ?)")
  const probe = db.query("INSERT INTO native_sampler_v1 VALUES(?, ?, ?) ON CONFLICT(boot) DO UPDATE SET owner = excluded.owner, until = excluded.until WHERE native_sampler_v1.until <= ?")
  const finish = db.query("DELETE FROM native_sampler_v1 WHERE boot = ? AND owner = ?")
  return {
    volume: (resource: string, path: string) => change(() => { volume.run(boot, resource, path) }),
    volumes: () => sql(() => volumes.all(boot).map(({ path }) => path)),
    remember: (owner: string, pid: number, start: number) => change(() => { setPeer.run(boot, owner, pid, start) }),
    peer: (owner: string) => sql(() => peer.get(boot, owner)),
    scope: (binding: string) => sql(() => pins.read(binding)),
    hold: (binding: string, since: number, evidence: Schema.Json) => change(() =>
      recordHolders.run(boot, binding, since, encodeNative(evidence)).changes === 1),
    probe: (owner: string, now: number) => change(() => probe.run(boot, owner, now + POLICY.freshnessMs, now).changes === 1),
    finish: (owner: string) => change(() => { finish.run(boot, owner) }),
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
  const found = yield* sql(() => migrate(db))
  if (Predicate.isUndefined(found)) return yield* reject("unavailable")
  if (found !== STORE_VERSION) return yield* new AdmissionUnavailable({
    reason: "incompatible", storeVersion: { found, supported: STORE_VERSION },
  })
  yield* fs.chmod(filename, 0o600).pipe(Effect.mapError(unavailable))
  if (!(yield* sql(() => writer(db)(data(db, identity).activate)))) return yield* reject("incompatible")
  return {
    ...store(db, identity, readClock), holder: holders(db, identity, readClock), native: native(db, identity),
    ownership: ownerService(db, identity, readClock),
  }
})

export const layer = (filename: string, identity: Identity) => Layer.effectContext(
  open(filename, identity).pipe(Effect.map(({ ledger, holder, ownership }) =>
    LeaseLedger.context(ledger).pipe(Context.add(HolderJournal, holder), Context.add(OwnershipJournal, ownership))),
  ),
)
