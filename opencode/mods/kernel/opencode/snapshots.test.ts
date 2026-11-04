// The stored bindings in the plugin's storage: the Snapshots laws over a
// stand-in storage that keeps JSON as the host's does, then the entry's format,
// which every earlier version wrote and every later one must read.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Json } from "../frame.ts"
import { snapshotsLaws } from "../laws.ts"
import { Snapshots } from "../service.ts"
import { KernelSessionId } from "../session.ts"
import * as OpenCodeSnapshots from "./snapshots.ts"

/** The host's storage over `entries`: JSON in, JSON out. */
const storage = (entries: Map<string, unknown>): OpenCodeSnapshots.Store => ({
  get: (key) => Effect.sync(() => entries.get(key)),
  set: (key, value) => Effect.sync(() => void entries.set(key, JSON.parse(JSON.stringify(value)))),
  remove: (key) => Effect.sync(() => void entries.delete(key)),
})

snapshotsLaws("OpenCode's storage", () => OpenCodeSnapshots.layer(storage(new Map())))

const session = KernelSessionId.make("ses_1")
const load = (entries: Map<string, unknown>) =>
  Effect.runPromise(Snapshots.use((snapshots) => snapshots.load(session)).pipe(Effect.provide(OpenCodeSnapshots.layer(storage(entries)))))

describe("the storage entry", () => {
  test("is `kernel:<session>` holding `{ bindings: [{ name, value }] }`", async () => {
    const entries = new Map<string, unknown>()
    const value: Json = { $kernel: "clone", data: "AAEC" }
    await Effect.runPromise(
      Snapshots.use((snapshots) => snapshots.save(session, [{ name: "n", value }])).pipe(Effect.provide(OpenCodeSnapshots.layer(storage(entries)))),
    )
    expect([...entries]).toEqual([["kernel:ses_1", { bindings: [{ name: "n", value }] }]])
  })

  test("written by an earlier version loads as it was written", async () => {
    const earlier = { bindings: [{ name: "n", value: 5 }, { name: "m", value: { $kernel: "clone", data: "AAEC" } }] }
    expect(await load(new Map([["kernel:ses_1", earlier]]))).toEqual(earlier.bindings)
  })

  test("that holds something else, or cannot be read, holds no bindings", async () => {
    expect(await load(new Map([["kernel:ses_1", { bindings: "not a list" }]]))).toEqual([])
    expect(await load(new Map([["kernel:ses_1", "garbage"]]))).toEqual([])
    const broken: OpenCodeSnapshots.Store = { ...storage(new Map()), get: () => Effect.die(new Error("storage is down")) }
    expect(
      await Effect.runPromise(Snapshots.use((snapshots) => snapshots.load(session)).pipe(Effect.provide(OpenCodeSnapshots.layer(broken)))),
    ).toEqual([])
  })
})
