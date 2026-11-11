// The Resets aggregate's state in the plugin's storage, which OpenCode keeps
// once per host, so every instance of the plugin (one per directory) works
// the same holds: one key per pool's newest held start, per hold's reset and
// per claim made: `resets/wait/<pool>`, `resets/reset/<key, URI-encoded>` and
// `resets/claim/<at, 15 digits>/<key, URI-encoded>`. A claim's record is the
// ledger of what claims did to the windows; the newest MAX_CLAIMS are kept.
import { Effect, Layer, Option, Schema } from "effect"
import { Claim, type Event, MAX_CLAIMS, Reset, type ResetsState, Wait } from "../resets.ts"
import { ResetsStore } from "../service.ts"
import { PAGE, type Storage } from "./ledger.ts"

const WAITS = "resets/wait/"
const RESETS = "resets/reset/"
const CLAIMS = "resets/claim/"

const atKey = (at: number) => String(Math.max(0, Math.floor(at))).padStart(15, "0")
const resetKey = (key: string) => `${RESETS}${encodeURIComponent(key)}`
const claimKey = (claim: Claim) => `${CLAIMS}${atKey(claim.at)}/${encodeURIComponent(claim.key)}`

const decodeWait = Schema.decodeUnknownOption(Wait)
const decodeReset = Schema.decodeUnknownOption(Reset)
const decodeClaim = Schema.decodeUnknownOption(Claim)
const encodeWait = Schema.encodeSync(Wait)
const encodeReset = Schema.encodeSync(Reset)
const encodeClaim = Schema.encodeSync(Claim)

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

export const layer = (storage: Storage) =>
  Layer.succeed(ResetsStore, {
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
      const claims = (yield* scanAll(storage, CLAIMS)).flatMap(({ value }) => Option.toArray(decodeClaim(value))).slice(-MAX_CLAIMS)
      return { waits, resets, claims } satisfies ResetsState
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
            case "ClaimDue":
            case "OwnerAsked": {
              const reset = state.resets[event.reset.key]
              return reset === undefined ? Effect.void : storage.set(resetKey(reset.key), encodeReset(reset))
            }
            case "AnswerDeclined":
            case "AskWithdrawn":
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
              ])
            }
            case "ResetsForgotten":
              return Effect.forEach(event.keys, (key) => storage.remove(resetKey(key)), { discard: true })
          }
        })()
        yield* write.pipe(Effect.ignoreCause)
      }
    }),
  })
