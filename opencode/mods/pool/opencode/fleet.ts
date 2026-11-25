// The fleet in the plugin's storage, which OpenCode keeps once per host (its
// key-value table), so every instance of the plugin, one per directory the
// server serves, reads the same fleet. One key per start, so two instances
// recording at once both keep theirs, and one per peer:
// `fleet/start/<at, 15 digits>/<random>` and `fleet/peer/<name, URI-encoded>`.
import { Effect, Layer, Option, Random, Schema, Semaphore } from "effect"
import { Completion, type Event, type FleetState, Peer } from "../fleet.ts"
import { FleetStore, LaunchStoreUnavailable } from "../service.ts"
import { Start } from "../status.ts"
import { PAGE, type Storage } from "./ledger.ts"

const STARTS = "fleet/start/"

/**
 * A start's own key part, a version 4 UUID drawn from the host's random (a
 * seeded one on the simulated host): two starts at one instant on two
 * instances keep apart.
 */
const startId = Effect.all(Array.from({ length: 4 }, () => Random.nextIntBetween(0, 0xffff_ffff))).pipe(
  Effect.map((words) => {
    const hex = words.map((word) => word.toString(16).padStart(8, "0")).join("")
    const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }),
)
const PEERS = "fleet/peer/"
const COMPLETIONS = "fleet/completed/"
const reservationKey = (id: string) => `${STARTS}id/${encodeURIComponent(id)}`

const atKey = (at: number) => String(Math.max(0, Math.floor(at))).padStart(15, "0")
const peerKey = (name: string) => `${PEERS}${encodeURIComponent(name)}`

const decodeStart = Schema.decodeUnknownOption(Start)
const decodePeer = Schema.decodeUnknownOption(Peer)
const encodeStart = Schema.encodeSync(Start)
const encodePeer = Schema.encodeSync(Peer)

/** Every entry under `prefix`, in key order. */
const scanAll = (storage: Storage, prefix: string) =>
  Effect.gen(function* () {
    const entries: Array<{ readonly key: string; readonly value: unknown }> = []
    let after: string | undefined
    do {
      const page = yield* storage.scan({ prefix, ...(after === undefined ? {} : { after }), limit: PAGE })
      entries.push(...page.entries)
      after = page.next
    } while (after !== undefined)
    return entries
  })

export const authority = () => Semaphore.makeUnsafe(1)

export const layer = (storage: Storage, lock = authority()) => {
  const starts = Effect.gen(function* () {
    const result: Array<Start> = []
    for (const { value } of yield* scanAll(storage, STARTS)) {
      const decoded = decodeStart(value)
      if (Option.isNone(decoded)) return yield* new LaunchStoreUnavailable({ message: "a launch reservation could not be decoded" })
      result.push(decoded.value)
    }
    return result
  }).pipe(Effect.mapError(() => new LaunchStoreUnavailable({ message: "launch reservations could not be read" })))
  return Layer.succeed(FleetStore, {
    withState: (operation) => lock.withPermits(1)(operation),
    starts,
    reserve: Effect.fn("FleetStore.reserve")(function* (start: Start) {
      const id = Option.fromUndefinedOr(start.id)
      if (Option.isNone(id)) return yield* new LaunchStoreUnavailable({ message: "a reservation needs a launch identity" })
      const existing = (yield* starts).find((held) => held.id === id.value)
      const held = Option.fromUndefinedOr(existing)
      if (Option.isSome(held)) return held.value
      yield* storage.set(reservationKey(id.value), encodeStart(start)).pipe(
        Effect.mapError(() => new LaunchStoreUnavailable({ message: "the launch reservation could not be written" })),
      )
      const confirmed = Option.fromUndefinedOr((yield* starts).find((held) => held.id === id.value))
      if (Option.isNone(confirmed)) return yield* new LaunchStoreUnavailable({ message: "the launch reservation was not read back" })
      return confirmed.value
    }),
    // A fleet that cannot be read is empty: the pace goes on with the readings alone.
    read: Effect.gen(function* () {
      const kept = yield* starts
      const completions: Record<string, typeof Completion.Type> = {}
      for (const { key, value } of yield* scanAll(storage, COMPLETIONS)) {
        const completed = Schema.decodeUnknownOption(Completion)(value)
        if (Option.isSome(completed)) completions[decodeURIComponent(key.slice(COMPLETIONS.length))] = completed.value
      }
      const peers: Record<string, Peer> = {}
      for (const { key, value } of yield* scanAll(storage, PEERS)) {
        const peer = Option.getOrUndefined(decodePeer(value))
        if (peer !== undefined) peers[decodeURIComponent(key.slice(PEERS.length))] = peer
      }
      if (Object.keys(completions).length > 0) return { starts: kept, peers, completions } satisfies FleetState
      return { starts: kept, peers } satisfies FleetState
    }).pipe(
      Effect.catchCause(() => Effect.succeed<FleetState>({ starts: [], peers: {} })),
      Effect.withSpan("FleetStore.read"),
    ),
    // A write that fails is lost: a start then counts on this instance's next read only if another kept it.
    record: Effect.fn("FleetStore.record")(function* (events: ReadonlyArray<Event>, state: FleetState) {
      for (const event of events) {
        const write = (() => {
          switch (event._tag) {
            case "StartRecorded":
              const identity = Option.fromUndefinedOr(event.start.id)
              if (Option.isSome(identity)) return storage.set(reservationKey(identity.value), encodeStart(event.start))
              return startId.pipe(Effect.flatMap((id) => storage.set(`${STARTS}${atKey(event.start.at)}/${id}`, encodeStart(event.start))))
            case "StartBound": {
              const id = Option.fromUndefinedOr(event.start.id)
              return Option.match(id, { onNone: () => Effect.void, onSome: (id) => storage.set(reservationKey(id), encodeStart(event.start)) })
            }
            case "WorkCompleted":
              return storage.set(`${COMPLETIONS}${encodeURIComponent(event.sessionID)}`, Schema.encodeSync(Completion)(event.completion))
            case "StartsExpired":
              return Effect.all([scanAll(storage, STARTS), scanAll(storage, COMPLETIONS)]).pipe(
                Effect.flatMap(([entries, completions]) =>
                  Effect.forEach(
                    [...entries.filter(({ value }) => Option.exists(decodeStart(value), (start) => start.at <= event.before)), ...completions.filter(({ value }) => Option.exists(Schema.decodeUnknownOption(Completion)(value), (completion) => completion.at <= event.before))],
                    ({ key }) => storage.remove(key),
                    { discard: true },
                  ),
                ),
              )
            case "PeerReported":
            case "PeerMissed":
            case "PollClaimed": {
              const peer = state.peers[event.peer]
              return peer === undefined ? Effect.void : storage.set(peerKey(event.peer), encodePeer(peer))
            }
          }
        })()
        yield* write.pipe(Effect.ignoreCause)
      }
    }),
  })
}
