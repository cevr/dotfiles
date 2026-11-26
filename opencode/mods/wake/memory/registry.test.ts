// The handle registry at work (registry.ts over handle.ts), on the memory store and sessions:
// told once across restarts (H1), a burst is one wake (H6), a running turn is joined (H9), the owner's
// stop and no (H10), only a dead owner loses a call (H4), and the letter carries no result (C31).
import { describe, expect } from "bun:test"
import { Context, Effect, Exit, Layer, Option, Schema, Scope } from "effect"
import { it } from "effect-bun-test"
import { TestClock } from "effect/testing"
import * as Handles from "../handle.ts"
import * as MemoryCourier from "./courier.ts"
import * as MemoryStore from "./store.ts"
import { Registry, layer, ownerOf } from "../registry.ts"

/** One host: its stored wakes, its sessions, which run a turn, which servers run, and what was told cancelled. */
interface World {
  readonly store: MemoryStore.MemoryWakes
  readonly sessions: MemoryCourier.MemorySessions
  readonly busy: Set<string>
  readonly running: Set<string>
  readonly cancelled: Array<string>
}

const world = (): World => ({
  store: MemoryStore.empty(),
  sessions: MemoryCourier.empty("ses_a", "ses_b"),
  busy: new Set(),
  running: new Set(["srv_1", "srv_2"]),
  cancelled: [],
})

/** An instance of the registry over the world: each one in a server and location takes the next epoch there; closing it is its end (a reload, or the server going). */
const instance = (w: World, server = "srv_1") =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const registry = layer({
      server,
      location: "/work/app",
      live: (id) => Effect.sync(() => w.running.has(id)),
      busy: (sessionID) => Effect.sync(() => w.busy.has(sessionID)),
      cancelled: (ids) => Effect.sync(() => void w.cancelled.push(...ids)),
    }).pipe(Layer.provide(Layer.merge(MemoryStore.layer(w.store), MemoryCourier.layer(w.sessions))))
    const service = Context.get(yield* Layer.buildWithScope(registry, scope), Registry)
    return { registry: service, stop: Scope.close(scope, Exit.void) }
  })

/** A value as the JSON a host would carry. */
const asText = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

const inbox = (w: World, session: string) => w.sessions.inboxes.get(session) ?? []
const call = (id: string, sessionID = "ses_a") => ({ id, sessionID, kind: "call" as const, tool: Option.some("webfetch") })
const ended = (id: string, outcome: Handles.Outcome = "succeeded") => ({ id, outcome, value: Option.some<Schema.Json>("PAGE_SECRET"), to: Option.none() })

describe("the handle registry", () => {
  it.effect("H6: three settles of an idle session half a second apart are one wake, when the window of the first is up; no result in it", () =>
    Effect.gen(function* () {
      const w = world()
      const { registry } = yield* instance(w)
      for (const id of ["h1", "h2", "h3"]) yield* registry.open(call(id))
      for (const id of ["h1", "h2", "h3"]) {
        yield* registry.settle(ended(id))
        yield* TestClock.adjust(500)
      }
      expect(inbox(w, "ses_a")).toEqual([])
      yield* TestClock.adjust(500)
      expect(inbox(w, "ses_a")).toHaveLength(1)
      const [letter] = inbox(w, "ses_a")
      expect(letter?.resume).toBe(true)
      expect(letter?.letter.text).toContain("h1")
      expect(letter?.letter.text).toContain("h3")
      expect(asText(letter)).not.toContain("PAGE_SECRET")
      // The value is the cell's to read, at once.
      expect(yield* registry.get("ses_a", "h2")).toEqual({ state: "settled", disposition: "succeeded", value: "PAGE_SECRET" })
      yield* TestClock.adjust(60_000)
      expect(inbox(w, "ses_a")).toHaveLength(1)
    }).pipe(Effect.scoped),
  )

  it.effect("H9: a settle while the session's turn runs joins that turn at once and starts none", () =>
    Effect.gen(function* () {
      const w = world()
      w.busy.add("ses_a")
      const { registry } = yield* instance(w)
      yield* registry.open(call("h1"))
      yield* registry.settle(ended("h1"))
      // At once, before any window; it carries `resume` so the running execution goes on to read it rather than leave it for the next prompt.
      expect(inbox(w, "ses_a").map((message) => message.resume)).toEqual([true])
      expect(Handles.owed(Handles.stateOf([...(w.store.handles?.values() ?? [])]))).toEqual([])
    }).pipe(Effect.scoped),
  )

  it.effect("a restart between the claim and the send, and between the send and its record, tells each settle once", () =>
    Effect.gen(function* () {
      const w = world()
      const first = yield* instance(w)
      yield* first.registry.open(call("h1"))
      yield* first.registry.open(call("h2", "ses_b"))
      yield* first.registry.settle(ended("h1"))
      yield* first.registry.settle(ended("h2"))
      // The server goes after the claim was committed and before any send: the letter is owed.
      const claimed = (handle: Handles.Handle, delivery: string): Handles.Handle => ({
        ...handle,
        phase: Handles.Phase.cases.Claimed.make({ disposition: "succeeded", at: 0, delivery, mode: "wake", parked: false }),
      })
      yield* first.stop
      for (const [id, delivery] of [["h1", "msg_owed_a"], ["h2", "msg_owed_b"]] as const)
        Option.map(Option.fromNullishOr(w.store.handles?.get(id)), (handle) => w.store.handles?.set(id, claimed(handle, delivery)))
      // The send of ses_b's letter reached the host, but its record did not.
      w.sessions.inboxes.get("ses_b")?.push({ id: "msg_owed_b", letter: { text: "", description: "", metadata: {} }, resume: true })
      const second = yield* instance(w, "srv_1")
      yield* second.registry.start
      yield* second.stop
      const third = yield* instance(w, "srv_1")
      yield* third.registry.start
      expect(inbox(w, "ses_a").map((message) => message.id)).toEqual(["msg_owed_a"])
      expect(inbox(w, "ses_b").map((message) => message.id)).toEqual(["msg_owed_b"])
      expect(Handles.owed(Handles.stateOf([...(w.store.handles?.values() ?? [])]))).toEqual([])
    }).pipe(Effect.scoped),
  )

  it.effect("an archived session's letter is parked, tried once per start, and sent under its id when it is back; a deleted one's is never sent", () =>
    Effect.gen(function* () {
      const w = world()
      w.sessions.archived?.add("ses_a")
      const first = yield* instance(w)
      yield* first.registry.open(call("h1"))
      yield* first.registry.open(call("h2", "ses_gone"))
      yield* first.registry.settle(ended("h1"))
      yield* first.registry.settle(ended("h2"))
      yield* TestClock.adjust(2_000)
      expect(inbox(w, "ses_a")).toEqual([])
      yield* TestClock.adjust(10 * 60_000)
      expect(inbox(w, "ses_a")).toEqual([])
      // Gone: its handles went with it.
      expect([...(w.store.handles?.values() ?? [])].map((handle) => handle.session)).toEqual(["ses_a"])
      yield* first.stop
      const second = yield* instance(w, "srv_1")
      yield* second.registry.start
      expect(inbox(w, "ses_a")).toEqual([])
      w.sessions.archived?.delete("ses_a")
      yield* second.registry.unpark("ses_a")
      yield* second.registry.unpark("ses_a")
      expect(inbox(w, "ses_a")).toHaveLength(1)
    }).pipe(Effect.scoped),
  )

  it.effect("H4: only a dead owner loses its open calls; a live server's and a land are untouched", () =>
    Effect.gen(function* () {
      const w = world()
      const other = yield* instance(w, "srv_2")
      yield* other.registry.open(call("h_live"))
      const gone = yield* instance(w, "srv_3")
      yield* gone.registry.open(call("h_dead"))
      yield* gone.registry.open({ id: "h_land", sessionID: "ses_a", kind: "land", tool: Option.none() })
      const old = yield* instance(w, "srv_1")
      yield* old.registry.open(call("h_old"))
      // srv_3's process is gone without its scope closing; srv_1 reloads its location (epoch 1 → 2) with epoch 1 not yet closed.
      const fresh = yield* instance(w, "srv_1")
      yield* fresh.registry.start
      const phases = new Map([...(w.store.handles?.values() ?? [])].map((handle) => [handle.id, handle.phase._tag]))
      expect(Object.fromEntries(phases)).toEqual({ h_live: "Open", h_dead: "Settled", h_land: "Open", h_old: "Settled" })
      expect(ownerOf("srv_1", "/work/app", 2)).toBe("srv_1//work/app/2")
      // After its owner's end a call reads its end, and its value is not kept.
      const dead = yield* fresh.registry.get("ses_a", "h_dead")
      expect(dead).toMatchObject({ state: "settled", disposition: "lost" })
      expect("value" in dead && Schema.is(Handles.Unavailable)(dead.value)).toBe(true)
      yield* TestClock.adjust(2_000)
      expect(inbox(w, "ses_a")[0]?.letter.text).toContain("lost")
    }).pipe(Effect.scoped),
  )

  it.effect("H10 and H2: the owner's stop cancels with no letter; a declined call is a notice; a call handed on tells nothing", () =>
    Effect.gen(function* () {
      const w = world()
      const { registry } = yield* instance(w)
      for (const id of ["h1", "h2", "h3"]) yield* registry.open(call(id))
      yield* registry.settle({ ...ended("h2", "started"), to: Option.some("sh_9") })
      expect(yield* registry.stopped("ses_a")).toEqual(["h1", "h3"])
      expect(w.cancelled).toEqual(["h1", "h3"])
      yield* TestClock.adjust(60_000)
      expect(inbox(w, "ses_a")).toEqual([])
      expect(yield* registry.get("ses_a", "h2")).toEqual({ state: "handed", to: "sh_9" })
      yield* registry.open(call("h4"))
      yield* registry.settle(ended("h4", "declined"))
      expect(inbox(w, "ses_a").map((message) => message.resume)).toEqual([false])
      expect(yield* registry.get("ses_b", "h4")).toEqual({ state: "unknown" })
    }).pipe(Effect.scoped),
  )
})
