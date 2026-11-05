// The fleet in the plugin's storage, which OpenCode keeps once per host (its
// key-value table), so every instance of the plugin, one per directory the
// server serves, reads the same fleet. One key per start, so two instances
// recording at once both keep theirs, and one per peer:
// `fleet/start/<at, 15 digits>/<random>` and `fleet/peer/<name, URI-encoded>`.
import { Effect, Layer, Option, Schema } from "effect"
import { type Event, type FleetState, Peer } from "../fleet.ts"
import { FleetStore } from "../service.ts"
import { Start } from "../status.ts"
import { PAGE, type Storage } from "./ledger.ts"

const STARTS = "fleet/start/"
const PEERS = "fleet/peer/"

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

export const layer = (storage: Storage) =>
  Layer.succeed(FleetStore, {
    // A fleet that cannot be read is empty: the pace goes on with the readings alone.
    read: Effect.gen(function* () {
      const starts = (yield* scanAll(storage, STARTS)).flatMap(({ value }) => Option.toArray(decodeStart(value)))
      const peers: Record<string, Peer> = {}
      for (const { key, value } of yield* scanAll(storage, PEERS)) {
        const peer = Option.getOrUndefined(decodePeer(value))
        if (peer !== undefined) peers[decodeURIComponent(key.slice(PEERS.length))] = peer
      }
      return { starts, peers } satisfies FleetState
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
              return storage.set(`${STARTS}${atKey(event.start.at)}/${crypto.randomUUID()}`, encodeStart(event.start))
            case "StartsExpired":
              return scanAll(storage, STARTS).pipe(
                Effect.flatMap((entries) =>
                  Effect.forEach(
                    entries.filter(({ key }) => key.slice(STARTS.length, STARTS.length + 15) <= atKey(event.before)),
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
