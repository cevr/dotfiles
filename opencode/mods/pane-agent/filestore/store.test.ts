import { describe } from "bun:test"
import { Effect, FileSystem, Layer } from "effect"
import * as BunServices from "@effect/platform-bun/BunServices"
import { storeLaws } from "../laws.ts"
import { makeMemoryStore } from "../memory/doubles.ts"
import * as FileStore from "./store.ts"

describe("memory WorkerStore", () => {
  storeLaws(() => Layer.unwrap(makeMemoryStore().pipe(Effect.map((made) => made.layer))))
})

describe("filestore WorkerStore", () => {
  storeLaws(() =>
    Layer.unwrap(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pane-agent-store-" })
        return FileStore.layer(`${dir}/workers.json`)
      }).pipe(Effect.orDie),
    ).pipe(Layer.provide(BunServices.layer)),
  )
})
