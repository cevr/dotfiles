import { Effect, FileSystem, Layer, Path, Ref, Schema, Semaphore } from "effect"
import { StoreFailed, WorkerStore } from "../service.ts"
import { EMPTY_SNAPSHOT, type PaneAnchor, type PaneWorker, StoreSnapshot } from "../worker.ts"

const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(StoreSnapshot))
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(StoreSnapshot))

const storeFailure = (operation: string, cause: { readonly message: string }) =>
  new StoreFailed({ operation, message: cause.message })

/** File-backed atomic JSON store using Effect FileSystem + Path (no node:* imports). */
export const layer = (file: string) =>
  Layer.effect(
    WorkerStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const lock = yield* Semaphore.make(1)
      const seq = yield* Ref.make(0)

      const readRaw = Effect.fn("FileWorkerStore.readRaw")(function* () {
        const exists = yield* fs.exists(file).pipe(Effect.mapError((cause) => storeFailure("exists", cause)))
        if (!exists) return EMPTY_SNAPSHOT
        const text = yield* fs.readFileString(file).pipe(Effect.mapError((cause) => storeFailure("read", cause)))
        return yield* decodeSnapshot(text).pipe(Effect.mapError((cause) => storeFailure("decode", cause)))
      })

      const writeRaw = Effect.fn("FileWorkerStore.writeRaw")(function* (snapshot: StoreSnapshot) {
        const encoded = yield* encodeSnapshot(snapshot).pipe(Effect.mapError((cause) => storeFailure("encode", cause)))
        const dir = path.dirname(file)
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError((cause) => storeFailure("mkdir", cause)))
        const nextSeq = yield* Ref.updateAndGet(seq, (n) => n + 1)
        const temp = `${file}.tmp-${nextSeq}`
        yield* fs.writeFileString(temp, `${encoded}\n`).pipe(Effect.mapError((cause) => storeFailure("write", cause)))
        yield* fs.rename(temp, file).pipe(Effect.mapError((cause) => storeFailure("rename", cause)))
      })

      const read = Effect.fn("FileWorkerStore.read")(function* () {
        return yield* lock.withPermits(1)(readRaw())
      })

      const write = Effect.fn("FileWorkerStore.write")(function* (snapshot: StoreSnapshot) {
        return yield* lock.withPermits(1)(writeRaw(snapshot))
      })

      const upsertWorker = Effect.fn("FileWorkerStore.upsertWorker")(function* (worker: PaneWorker) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* readRaw()
            const others = current.workers.filter((item) => item.id !== worker.id)
            const next: StoreSnapshot = { ...current, workers: [...others, worker] }
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
              ...current,
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
