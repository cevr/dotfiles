// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
// The handle registry in the wakes plugin, on the simulated host (spec laws H1-H11; units.md §3 "Also add"):
// the kernel's calls reach it over its RPC (`HANDLES`), as they will from a cut cell.
//
// (a) a restart before the claim, between the claim and the send, and between the send and its record: one
//     message per delivery id; (b) a settle while a turn runs and during a compaction joins it: no second turn;
// (c) three settles 500 ms apart while idle: one turn; (d) a deleted session gets no letter, an archived one's
//     is parked, tried once per start and sent on unarchive, a stopped one's open handles are cancelled with
//     no turn; (e) two instances on one store, one reloaded: the other's handles untouched, and a dead owner is
//     found at a read; (f) the stored world bcf7101f wrote, through the plugin's own store adapter.
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as Handles from "@dotfiles/opencode-wake/handle"
import * as OpenCodeStore from "@dotfiles/opencode-wake/opencode/store"
import { WakeStore } from "@dotfiles/opencode-wake/service"
import { Entry, WAKES } from "@dotfiles/opencode-wake/wake"
import * as Plugins from "../../sim/plugins.ts"
import { simulationTest } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"
import fixture from "./fixtures/store-bcf7101f.json"

const WORK = "/scratch/project"
const OTHER = "/scratch/other"
const SECOND = 1_000

const options = { backstop: "off" }
const loaded = (world: World.World, directory = WORK) => world.load(Plugins.wake(world), { directory, options })

/** A message, when it is one of the registry's letters. */
const letterIn = (message: World.Message) => {
  if (message.type === "synthetic" && message.metadata["source"] === "handles") return [message]
  return []
}

/** The registry's letters in a session: the synthetic messages its letters came in. */
const letters = (world: World.World, session: string) =>
  world.messages(session).flatMap(letterIn)

/** How many turns the model was asked for in the session. */
const turns = (world: World.World, session: string) => world.asked().filter((request) => request.sessionID === session && request.kind === "primary").length

/** A value as the JSON a host would carry. */
const asText = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

const rpc = (world: World.World, method: string, input: Schema.Json) => world.rpc(Handles.HANDLES, method, input)
const open = (world: World.World, sessionID: string, id: string) => rpc(world, "open", { id, sessionID, kind: "call", tool: "webfetch" })
const settle = (world: World.World, id: string, outcome = "succeeded") => rpc(world, "settle", { id, outcome, value: "the page" })

/** The plugin's stored handles, as its store adapter reads them. */
const stored = (world: World.World) => {
  const space = world.storage.get(WAKES.id) ?? new Map<string, Schema.Json>()
  return [...space].filter(([key]) => key.startsWith(OpenCodeStore.HANDLE)).flatMap(([, value]) => Option.toArray(Schema.decodeUnknownOption(Handles.Handle)(value)))
}
const put = (world: World.World, handle: Handles.Handle) =>
  world.storage.get(WAKES.id)?.set(`${OpenCodeStore.HANDLE}${handle.id}`, Schema.encodeSync(Schema.toCodecJson(Handles.Handle))(handle))

describe("the handle registry on the simulated host", () => {
  simulationTest(
    "(a, c) a burst is one wake, and a restart at each step tells each settle once under its delivery id",
    Effect.gen(function* () {
      const world = World.make({ seed: 1, script: () => World.say("Read.") })
      yield* loaded(world)
      const session = yield* world.session(WORK)
      for (const id of ["h1", "h2", "h3"]) yield* open(world, session, id)
      for (const id of ["h1", "h2", "h3"]) {
        yield* settle(world, id)
        yield* world.advance(500)
      }
      // The server goes before the window was up: the next start claims what settled.
      yield* world.restart
      yield* world.advance(3 * SECOND)
      yield* world.until(() => world.sessions.get(session)?.running !== true, 60 * SECOND)
      expect(letters(world, session)).toHaveLength(1)
      expect(letters(world, session)[0]?.text).toContain("3 handles settled")
      expect(asText(letters(world, session))).not.toContain("the page")
      expect(turns(world, session)).toBe(1)

      // Between the claim and the send: the letter is owed in the store, and the next start sends it once.
      const claimed = (id: string, delivery: string): Handles.Handle => ({
        version: 1,
        id,
        session,
        kind: "call",
        owner: "sim//scratch/project/1",
        phase: Handles.Phase.cases.Claimed.make({ disposition: "succeeded", at: world.now(), delivery, mode: "wake", parked: false }),
      })
      put(world, claimed("h4", "msg_zz_owed"))
      yield* world.restart
      yield* world.advance(SECOND)
      yield* world.restart
      yield* world.advance(SECOND)
      yield* world.until(() => world.sessions.get(session)?.running !== true, 60 * SECOND)
      // Between the send and its record: the host took the letter, its `Delivered` was not written. The next start sends it again, under its id: the host keeps one.
      put(world, claimed("h4", "msg_zz_owed"))
      yield* world.restart
      yield* world.advance(SECOND)
      yield* world.until(() => world.sessions.get(session)?.running !== true, 60 * SECOND)
      expect(letters(world, session).map((message) => message.id).filter((id) => id === "msg_zz_owed")).toHaveLength(1)
      expect(Handles.owed(Handles.stateOf(stored(world)))).toEqual([])
      expect(stored(world).find((handle) => handle.id === "h4")?.phase._tag).toBe("Delivered")
    }),
  )

  simulationTest(
    "(b) a settle while the session's turn runs, and during a compaction, joins it: no second turn",
    Effect.gen(function* () {
      const world = World.make({ seed: 2, script: () => World.say("Working.") })
      yield* loaded(world)
      const session = yield* world.session(WORK)
      yield* open(world, session, "h1")
      yield* open(world, session, "h2")
      /** When the session's execution started: one value across a run means no second execution began. */
      const started = () => Option.flatten(Option.map(Option.fromNullishOr(world.sessions.get(session)), (each) => each.busy))
      yield* world.prompt(session, "Go.")
      expect(world.sessions.get(session)?.running).toBe(true)
      const execution = started()
      yield* settle(world, "h1")
      yield* world.until(() => world.sessions.get(session)?.running !== true, 60 * SECOND)
      yield* world.advance(5 * SECOND)
      // The letter was read in the execution that ran, which went on to read it; none began after.
      expect(letters(world, session)).toHaveLength(1)
      expect(started()).toEqual(execution)
      // A compaction is an execution too: a settle during it joins it.
      yield* world.compact(session)
      const compaction = started()
      expect(compaction).not.toEqual(execution)
      yield* settle(world, "h2")
      yield* world.until(() => world.sessions.get(session)?.running !== true, 60 * SECOND)
      yield* world.advance(5 * SECOND)
      expect(letters(world, session)).toHaveLength(2)
      expect(started()).toEqual(compaction)
    }),
  )

  simulationTest(
    "(d) a stop cancels with no turn; a deleted session gets no letter; an archived one's is parked, tried once per start, sent on unarchive",
    Effect.gen(function* () {
      const world = World.make({ seed: 3, script: () => World.say("Read.") })
      yield* loaded(world)
      const deleted = yield* world.session(WORK)
      const archived = yield* world.session(WORK)
      const stopped = yield* world.session(WORK)
      yield* open(world, deleted, "h_deleted")
      yield* open(world, archived, "h_archived")
      for (const id of ["h_s1", "h_s2"]) yield* open(world, stopped, id)

      expect(yield* rpc(world, "stopped", { sessionID: stopped })).toEqual({ ids: ["h_s1", "h_s2"] })
      yield* settle(world, "h_s1")
      yield* world.advance(60 * SECOND)
      expect(letters(world, stopped)).toEqual([])
      expect(turns(world, stopped)).toBe(0)

      yield* world.remove(deleted)
      yield* world.archive(archived)
      yield* settle(world, "h_deleted")
      yield* settle(world, "h_archived")
      yield* world.advance(10 * 60 * SECOND)
      expect(letters(world, archived)).toEqual([])
      expect(stored(world).some((handle) => handle.session === deleted)).toBe(false)
      yield* world.restart
      yield* world.advance(60 * SECOND)
      expect(letters(world, archived)).toEqual([])
      const parked = stored(world).find((handle) => handle.id === "h_archived")?.phase
      expect(parked?._tag === "Claimed" && parked.parked).toBe(true)
      yield* world.unarchive(archived)
      yield* world.advance(5 * SECOND)
      yield* world.until(() => world.sessions.get(archived)?.running !== true, 60 * SECOND)
      expect(letters(world, archived)).toHaveLength(1)
    }),
  )

  simulationTest(
    "(e) two instances on one store, one reloaded: the other's open calls untouched; a dead owner's call is found lost at a read",
    Effect.gen(function* () {
      const world = World.make({ seed: 4, script: () => World.say("Read.") })
      yield* loaded(world, WORK)
      yield* loaded(world, OTHER)
      const here = yield* world.session(WORK)
      const there = yield* world.session(OTHER)
      // Each instance's own open call, as it records it: this server, its location, its first epoch.
      yield* open(world, here, "h_probe")
      const server = Option.getOrElse(Option.fromNullishOr(stored(world)[0]?.owner.split("/")[0]), () => "")
      const call = (id: string, session: string, owner: string): Handles.Handle => ({ version: 1, id, session, kind: "call", owner, phase: Handles.Phase.cases.Open.make({}) })
      put(world, call("h_here", here, `${server}/${WORK}/1`))
      put(world, call("h_there", there, `${server}/${OTHER}/1`))
      // WORK's plugin is loaded again: its epoch there is 2, and the start retires epoch 1's calls. OTHER's are not WORK's.
      yield* loaded(world, WORK)
      yield* world.advance(SECOND)
      const phases = Object.fromEntries(stored(world).filter((handle) => handle.id !== "h_probe").map((handle) => [handle.id, handle.phase._tag]))
      expect(phases).toEqual({ h_here: "Settled", h_there: "Open" })
      // A server that runs no more owned this one; nobody started since, and the first read finds it.
      put(world, call("h_dead", there, `4194303@Thu Jan  1 00:00:00 1970/${OTHER}/1`))
      const dead = Schema.decodeUnknownSync(Handles.Reading)(yield* rpc(world, "get", { sessionID: there, id: "h_dead" }))
      expect(dead).toMatchObject({ state: "settled", disposition: "lost" })
      expect("value" in dead && Schema.is(Handles.Unavailable)(dead.value)).toBe(true)
      expect(yield* rpc(world, "get", { sessionID: there, id: "h_there" })).toEqual({ state: "open", kind: "call" })
    }),
  )

  simulationTest(
    "(f) the stored world bcf7101f wrote reads unchanged through the plugin's store adapter, and the registry delivers none of it",
    Effect.gen(function* () {
      const source = Schema.decodeUnknownSync(Schema.Struct({ world: Schema.Struct({ store: Schema.Struct({ entries: Schema.Struct({ $map: Schema.Array(Schema.Tuple([Schema.String, Schema.Json])) }) }) }) }))(fixture)
      const world = World.make({ seed: 5, script: () => World.say("Read.") })
      const space = new Map<string, Schema.Json>(source.world.store.entries.$map.map(([id, entry]) => [`${OpenCodeStore.ENTRY}${id}`, entry]))
      world.storage.set(WAKES.id, space)
      const adapter = OpenCodeStore.layer({
        get: (key) => Effect.sync(() => space.get(key)),
        set: (key, value) => Effect.sync(() => void space.set(key, value)),
        remove: (key) => Effect.sync(() => void space.delete(key)),
        scan: ({ prefix }) => Effect.sync(() => ({ entries: [...space.keys()].filter((key) => key.startsWith(prefix)).sort().map((key) => ({ key })) })),
      })
      const entries = yield* Context.get(yield* Layer.build(adapter), WakeStore).entries
      const decode = Schema.decodeUnknownSync(Entry)
      expect(entries.map((entry) => entry.id).toSorted()).toEqual(source.world.store.entries.$map.map(([id]) => id).toSorted())
      for (const [id, entry] of source.world.store.entries.$map) expect(entries.find((each) => each.id === id)).toEqual(decode(entry))
      const shown = entries.map((entry) => Handles.handleOfEntry(entry))
      expect(shown.every((handle) => handle.deliverer === "wakes" && handle.note.length > 0)).toBe(true)
      expect(shown.find((handle) => handle.state === "claimed")?.delivery).toBe("msg_000000000002")
      // The plugin starts on that store: its registry has no handle, retires nothing and writes no letter.
      yield* loaded(world, "/work/app")
      yield* world.advance(SECOND)
      expect(stored(world)).toEqual([])
    }).pipe(Effect.scoped),
  )
})
