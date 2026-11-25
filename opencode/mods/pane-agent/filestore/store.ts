import { Array as Arr, Effect, FileSystem, Layer, Option, Path, Random, Ref, Schema, Semaphore } from "effect"
import { StoreConflict, StoreFailed, WorkerStore } from "../service.ts"
import {
  EMPTY_SNAPSHOT,
  isLive,
  PaneAnchor,
  PaneWorker,
  pendingWakesOf,
  revisionOf,
  STORE_VERSION,
  StoreSnapshot,
} from "../worker.ts"

const MAX_ENDED_WORKERS = 200

const RawEnvelope = Schema.Struct({
  version: Schema.optionalKey(Schema.Int),
  workers: Schema.Array(Schema.Unknown),
  anchors: Schema.Record(Schema.String, PaneAnchor),
})

const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(RawEnvelope))
const decodeWorkerOpt = Schema.decodeUnknownOption(PaneWorker)
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(StoreSnapshot))

const storeFailure = (operation: string, cause: { readonly message: string }) =>
  new StoreFailed({ operation, message: cause.message })

const mustRetain = (worker: PaneWorker): boolean => {
  const turns = Option.getOrElse(Option.fromUndefinedOr(worker.pendingTurns), () => [])
  return isLive(worker.state) || turns.length > 0 || pendingWakesOf(worker).length > 0
}

const pruneEndedWorkers = (workers: ReadonlyArray<PaneWorker>): ReadonlyArray<PaneWorker> => {
  const retained: Array<PaneWorker> = []
  const ended: Array<PaneWorker> = []
  for (const worker of workers) {
    if (mustRetain(worker)) {
      retained.push(worker)
    } else {
      ended.push(worker)
    }
  }
  if (ended.length <= MAX_ENDED_WORKERS) return workers
  const keptEnded = [...ended].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ENDED_WORKERS)
  return [...retained, ...keptEnded]
}

/** File-backed atomic JSON store with version check, per-worker decode isolation, and CAS revisions. */
export const layer = (file: string) =>
  Layer.effect(
    WorkerStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const lock = yield* Semaphore.make(1)
      const seq = yield* Ref.make(0)
      const instanceToken = (yield* Random.nextIntBetween(0x100000, 0xffffff)).toString(36)

      const readRaw = Effect.fn("FileWorkerStore.readRaw")(function* () {
        const exists = yield* fs.exists(file).pipe(Effect.mapError((cause) => storeFailure("exists", cause)))
        if (!exists) return EMPTY_SNAPSHOT
        const text = yield* fs.readFileString(file).pipe(Effect.mapError((cause) => storeFailure("read", cause)))
        const env = yield* decodeEnvelope(text).pipe(Effect.mapError((cause) => storeFailure("decode", cause)))
        const ver = Option.getOrElse(Option.fromUndefinedOr(env.version), () => 1)
        if (ver > STORE_VERSION) {
          return yield* new StoreFailed({
            operation: "version",
            message: `Store file ${file} has unsupported future version ${ver} (max supported ${STORE_VERSION}).`,
          })
        }
        const workers: Array<PaneWorker> = []
        for (const entry of env.workers) {
          const decoded = decodeWorkerOpt(entry)
          if (Option.isSome(decoded)) {
            workers.push(decoded.value)
          }
        }
        return { version: STORE_VERSION, workers, anchors: env.anchors }
      })

      const writeRaw = Effect.fn("FileWorkerStore.writeRaw")(function* (snapshot: StoreSnapshot) {
        const versioned: StoreSnapshot = {
          version: STORE_VERSION,
          workers: pruneEndedWorkers(snapshot.workers),
          anchors: snapshot.anchors,
        }
        const encoded = yield* encodeSnapshot(versioned).pipe(Effect.mapError((cause) => storeFailure("encode", cause)))
        const dir = path.dirname(file)
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError((cause) => storeFailure("mkdir", cause)))
        const nextSeq = yield* Ref.updateAndGet(seq, (n) => n + 1)
        const temp = `${file}.tmp-${instanceToken}-${nextSeq}`
        yield* fs.writeFileString(temp, `${encoded}\n`).pipe(Effect.mapError((cause) => storeFailure("write", cause)))
        yield* fs.rename(temp, file).pipe(Effect.mapError((cause) => storeFailure("rename", cause)))
      })

      const read = Effect.fn("FileWorkerStore.read")(function* () {
        return yield* lock.withPermits(1)(readRaw())
      })

      const write = Effect.fn("FileWorkerStore.write")(function* (snapshot: StoreSnapshot) {
        return yield* lock.withPermits(1)(writeRaw(snapshot))
      })

      const upsertWorker = Effect.fn("FileWorkerStore.upsertWorker")(function* (
        worker: PaneWorker,
        expectedRevision?: number,
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* readRaw()
            const existing = Arr.findFirst(current.workers, (item) => item.id === worker.id)
            const actualRevision = Option.match(existing, {
              onNone: () => 0,
              onSome: (found) => revisionOf(found),
            })
            const expectedOpt = Option.fromUndefinedOr(expectedRevision)
            if (Option.isSome(expectedOpt) && actualRevision !== expectedOpt.value) {
              return yield* new StoreConflict({
                workerId: worker.id,
                expectedRevision: expectedOpt.value,
                actualRevision,
                message: `Stale write rejected for worker ${worker.id}: expected revision ${expectedOpt.value}, found ${actualRevision}.`,
              })
            }
            const stamped: PaneWorker = { ...worker, revision: actualRevision + 1 }
            const others = current.workers.filter((item) => item.id !== worker.id)
            const next: StoreSnapshot = {
              version: STORE_VERSION,
              anchors: current.anchors,
              workers: [...others, stamped],
            }
            yield* writeRaw(next)
            return next
          }),
        )
      })

      const saveAnchor = Effect.fn("FileWorkerStore.saveAnchor")(function* (sessionID: string, anchor: PaneAnchor) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* readRaw()
            const next: StoreSnapshot = {
              version: STORE_VERSION,
              workers: current.workers,
              anchors: { ...current.anchors, [sessionID]: anchor },
            }
            yield* writeRaw(next)
            return next
          }),
        )
      })

      return WorkerStore.of({ read, write, upsertWorker, saveAnchor })
    }),
  )
