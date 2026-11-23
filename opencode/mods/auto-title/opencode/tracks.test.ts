// The storage-backed tracks owe the laws, over a stand-in of the plugin's
// storage that keeps JSON values as the host's key-value table does; an entry
// that no longer decodes reads as none.
import { expect } from "bun:test"
import { Effect, Option, type Schema } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { tracksLaws } from "../laws.ts"
import { Tracks } from "../service.ts"
import { layer, type Storage } from "./tracks.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"


const storage = (entries: Map<string, Schema.Json>): Storage => ({
  get: (key) => Effect.sync(() => entries.get(key)),
  set: (key, value) => Effect.sync(() => void entries.set(key, value)),
  remove: (key) => Effect.sync(() => void entries.delete(key)),
})

tracksLaws("the plugin storage's tracks", () => layer(storage(new Map())), effectTest)

effectTest(
  "an entry that no longer decodes reads as none",
  Effect.gen(function* () {
    expect(yield* (yield* Tracks).get("ses_old")).toEqual(Option.none())
  }).pipe(Effect.provide(layer(storage(new Map([["track:ses_old", { pinned: "yes" }]]))))),
  hangGuard("local-fixture"),
)
