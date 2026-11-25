// A test's second process: two read authorities over the state file in
// `<root>/state/antigravity.json`, as another OpenCode server or the read
// command on the host would build them, each reading with consent once
// `<root>/go` exists, after it wrote `<root>/ready-<name>`. Its keychain is a stand-in that appends one line
// to `<root>/keychain-attempts` per attempt and finds nothing; its endpoints
// are on a host that is not Google's, so nothing can be sent. Run by
// source.test.ts as `bun race-writer.ts <root> <name>`.
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { argv } from "bun"
import { Array as Arr, Effect, FileSystem, Layer, Option, Schedule } from "effect"
import { FetchHttpClient } from "effect/http"
import { fileStore, places } from "./live.ts"
import { KeychainRead } from "./signin.ts"
import { make } from "./source.ts"

const root = Option.getOrElse(Arr.get(argv, 2), () => "/nonexistent/race-writer")
const name = Option.getOrElse(Arr.get(argv, 3), () => "w")

BunRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const keychain = Effect.as(fs.writeFileString(`${root}/keychain-attempts`, "attempt\n", { flag: "a" }).pipe(Effect.orDie), KeychainRead.cases.Absent.make({}))
    const authority = Effect.gen(function* () {
      return yield* make({
        profile: `${root}/profile`,
        places: yield* places(keychain),
        store: yield* fileStore(`${root}/state/antigravity.json`),
        auth: "business",
        endpoints: { token: "https://example.invalid/token", daily: "https://example.invalid", prod: "https://example.invalid" },
        agent: Effect.succeed("race-writer"),
      })
    })
    const authorities = yield* Effect.all([authority, authority])
    // Ready, then all at once: the test lets every authority go at the same moment.
    yield* fs.writeFileString(`${root}/ready-${name}`, "")
    yield* fs.exists(`${root}/go`).pipe(
      Effect.filterOrFail((there) => there),
      Effect.retry({ schedule: Schedule.spaced(2), times: 10_000 }),
    )
    yield* Effect.all(
      authorities.map((source) => source.read(true)),
      { concurrency: 2 },
    )
  }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
)
