// The Resets aggregate's state in the plugin's storage, which OpenCode keeps
// once per host, so every instance of the plugin (one per directory) works
// the same holds: one key per pool's newest held start, per hold's reset and
// per claim made: `resets/wait/<pool>`, `resets/reset/<key, URI-encoded>` and
// `resets/claim/<at, 15 digits>/<key, URI-encoded>`. A claim's record is the
// ledger of what claims did to the windows; the newest MAX_CLAIMS are kept.
// A request admitted on a claim's room is `resets/spend/<at, 15 digits>/<id, URI-encoded>`, kept
// while its claim is.
import { Array as Arr, Clock, Effect, Layer, Option, Schema } from "effect"
import { Claim, type Event, keptSpends, MAX_CLAIMS, Reset, type ResetsState, Spend, Wait } from "../resets.ts"
import { ResetsStore } from "../service.ts"
import { PAGE, type Storage } from "./ledger.ts"

const WAITS = "resets/wait/"
const RESETS = "resets/reset/"
const CLAIMS = "resets/claim/"
const SPENDS = "resets/spend/"

const atKey = (at: number) => String(Math.max(0, Math.floor(at))).padStart(15, "0")
const resetKey = (key: string) => `${RESETS}${encodeURIComponent(key)}`
const claimKey = (claim: Claim) => `${CLAIMS}${atKey(claim.at)}/${encodeURIComponent(claim.key)}`
const spendKey = (spend: Spend) => `${SPENDS}${atKey(spend.at)}/${encodeURIComponent(spend.id)}`

const decodeWait = Schema.decodeUnknownOption(Wait)
const decodeReset = Schema.decodeUnknownOption(Reset)
const decodeClaim = Schema.decodeUnknownOption(Claim)
const decodeSpend = Schema.decodeUnknownOption(Spend)
const encodeWait = Schema.encodeSync(Wait)
const encodeReset = Schema.encodeSync(Reset)
const encodeClaim = Schema.encodeSync(Claim)
const encodeSpend = Schema.encodeSync(Spend)

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

const EMPTY: ResetsState = { waits: {}, resets: {}, claims: [] }

const readClaims = (storage: Storage) =>
  scanAll(storage, CLAIMS).pipe(
    Effect.map((entries) => entries.flatMap(({ value }) => Option.toArray(decodeClaim(value))).slice(-MAX_CLAIMS)),
  )

export const layer = (storage: Storage) =>
  Layer.succeed(ResetsStore, {
    claims: readClaims(storage).pipe(Effect.catchCause(() => Effect.succeed(EMPTY.claims))),
    // State that cannot be read is empty: a hold is then worked again, under the same request id.
    read: Effect.gen(function* () {
      const waits: Record<string, Wait> = {}
      for (const { key, value } of yield* scanAll(storage, WAITS)) {
        const wait = Option.getOrUndefined(decodeWait(value))
        if (wait !== undefined) waits[decodeURIComponent(key.slice(WAITS.length))] = wait
      }
      const resets: Record<string, Reset> = {}
      for (const { value } of yield* scanAll(storage, RESETS)) {
        const reset = Option.getOrUndefined(decodeReset(value))
        if (reset !== undefined) resets[reset.key] = reset
      }
      const claims = yield* readClaims(storage)
      const spends = keptSpends(claims, (yield* scanAll(storage, SPENDS)).flatMap(({ value }) => Option.toArray(decodeSpend(value))), yield* Clock.currentTimeMillis)
      return { waits, resets, claims, ...Arr.match(spends, { onEmpty: () => ({}), onNonEmpty: (kept) => ({ spends: kept }) }) } satisfies ResetsState
    }).pipe(
      Effect.catchCause(() => Effect.succeed(EMPTY)),
      Effect.withSpan("ResetsStore.read"),
    ),
    // A write that fails is lost: the next instance's read may work a hold again, as the same claim.
    record: Effect.fn("ResetsStore.record")(function* (events: ReadonlyArray<Event>, state: ResetsState) {
      for (const event of events) {
        const write = (() => {
          switch (event._tag) {
            case "WaitNoted":
              return storage.set(`${WAITS}${encodeURIComponent(event.pool)}`, encodeWait(event.wait))
            case "ClaimDue": {
              const reset = state.resets[event.reset.key]
              return reset === undefined ? Effect.void : storage.set(resetKey(reset.key), encodeReset(reset))
            }
            case "OwnerTold":
            case "ClaimSent": {
              const reset = state.resets[event.key]
              return reset === undefined ? Effect.void : storage.set(resetKey(reset.key), encodeReset(reset))
            }
            case "ClaimSettled": {
              const reset = state.resets[event.claim.key]
              return Effect.all([
                reset === undefined ? Effect.void : storage.set(resetKey(reset.key), encodeReset(reset)),
                storage.set(claimKey(event.claim), encodeClaim(event.claim)),
                scanAll(storage, CLAIMS).pipe(
                  Effect.flatMap((entries) =>
                    Effect.forEach(entries.slice(0, Math.max(0, entries.length - MAX_CLAIMS)), ({ key }) => storage.remove(key), { discard: true }),
                  ),
                ),
                // The reservations of claims no longer kept go with them.
                scanAll(storage, SPENDS).pipe(
                  Effect.flatMap((entries) => {
                    const kept = new Set(state.claims.map((claim) => claim.key))
                    const gone = entries.filter(({ value }) => Option.exists(decodeSpend(value), (spend) => !kept.has(spend.claim)))
                    return Effect.forEach(gone, ({ key }) => storage.remove(key), { discard: true })
                  }),
                ),
              ])
            }
            case "ResetsForgotten":
              return Effect.forEach(event.keys, (key) => storage.remove(resetKey(key)), { discard: true })
            case "ClaimWeighed":
              return Effect.void
            case "ClaimObserved": {
              return Option.match(Arr.findFirst(state.claims, (item) => item.key === event.key), {
                onNone: () => Effect.void,
                onSome: (claim) => storage.set(claimKey(claim), encodeClaim(claim)),
              })
            }
            case "SpendReserved":
              return storage.set(spendKey(event.spend), encodeSpend(event.spend))
            case "SpendWithdrawn":
              return storage.remove(spendKey(event.spend))
          }
        })()
        yield* write.pipe(Effect.ignoreCause)
      }
    }),
  })
