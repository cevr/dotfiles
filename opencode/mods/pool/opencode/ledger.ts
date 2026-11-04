// The pools' ledger in the plugin's storage, one key per hold, reading and
// priced step under the pool's integration id: `<pool>/hold/<credentialID>`,
// `<pool>/reading/<credentialID>` and `<pool>/step/<at, 15 digits>/<sessionID>`.
// A previous process wrote the same keys, so the format stays as it is.
import { Effect, Layer, Option, Schema } from "effect"
import type { Event, LedgerState, PoolId } from "../account-pool.ts"
import { Step } from "../accounts.ts"
import { QuotaReading } from "../quota.ts"
import { Ledger } from "../service.ts"
import { Hold } from "../status.ts"

/** The plugin's storage, as the plugin provides it. */
export interface Storage {
  readonly scan: (options: {
    readonly prefix: string
    readonly after?: string
    readonly limit?: number
  }) => Effect.Effect<{ readonly entries: ReadonlyArray<{ readonly key: string; readonly value: unknown }>; readonly next?: string }, unknown>
  readonly set: (key: string, value: Schema.Json) => Effect.Effect<void, unknown>
  readonly remove: (key: string) => Effect.Effect<void, unknown>
}

/** How many entries one scan of the storage asks for. */
export const PAGE = 500

const holdKey = (credentialID: string) => `hold/${credentialID}`
const readingKey = (credentialID: string) => `reading/${credentialID}`
const stepKey = (step: Step) => `step/${String(step.at).padStart(15, "0")}/${step.sessionID}`

type Write = { readonly _tag: "Put"; readonly key: string; readonly value: Schema.Json } | { readonly _tag: "Remove"; readonly key: string }

const put = (key: string, value: Schema.Json): Write => ({ _tag: "Put", key, value })
const remove = (key: string): Write => ({ _tag: "Remove", key })

/** The writes that bring the ledger up to `event`, in order. */
const writesOf = (event: Event): ReadonlyArray<Write> => {
  switch (event._tag) {
    case "ReadingTaken":
      return [
        put(readingKey(event.credentialID), event.reading),
        ...(event.hold === undefined ? [] : [put(holdKey(event.credentialID), event.hold)]),
      ]
    case "RequestRefused":
      return [put(holdKey(event.credentialID), event.hold)]
    case "StepRecorded":
      return [put(stepKey(event.step), event.step)]
    case "LedgerPruned":
      return [...event.steps.map((step) => remove(stepKey(step))), ...event.holds.map((credentialID) => remove(holdKey(credentialID)))]
    case "LoginsListed":
    case "RequestPlaced":
    case "RunReleased":
      return []
  }
}

const decodeHold = Schema.decodeUnknownOption(Hold)
const decodeReading = Schema.decodeUnknownOption(QuotaReading)
const decodeStep = Schema.decodeUnknownOption(Step)

/** The ledger the entries hold; an entry that does not decode is left out. */
const ledgerOf = (entries: ReadonlyArray<{ readonly key: string; readonly value: unknown }>): LedgerState => {
  const holds: Record<string, Hold> = {}
  const readings: Record<string, QuotaReading> = {}
  const steps: Array<Step> = []
  for (const { key, value } of entries) {
    const [kind, id] = key.split("/", 2)
    if (id === undefined) continue
    if (kind === "hold") {
      const hold = Option.getOrUndefined(decodeHold(value))
      if (hold !== undefined) holds[id] = hold
    } else if (kind === "reading") {
      const reading = Option.getOrUndefined(decodeReading(value))
      if (reading !== undefined) readings[id] = reading
    } else if (kind === "step") {
      const step = Option.getOrUndefined(decodeStep(value))
      if (step !== undefined) steps.push(step)
    }
  }
  return { holds, readings, steps }
}

export const layer = (storage: Storage) =>
  Layer.succeed(Ledger, {
    // A ledger that cannot be read starts the pool empty.
    restore: Effect.fn("Ledger.restore")(
      function* (pool: PoolId) {
        const prefix = `${pool}/`
        const entries: Array<{ key: string; value: unknown }> = []
        let after: string | undefined
        do {
          const page = yield* storage.scan({ prefix, ...(after === undefined ? {} : { after }), limit: PAGE })
          for (const entry of page.entries) entries.push({ key: entry.key.slice(prefix.length), value: entry.value })
          after = page.next
        } while (after !== undefined)
        return ledgerOf(entries)
      },
      Effect.catchCause(() => Effect.succeed(ledgerOf([]))),
    ),
    // A write that fails is lost: the ledger only speeds the next process up.
    record: Effect.fn("Ledger.record")(function* (pool: PoolId, events: ReadonlyArray<Event>) {
      for (const write of events.flatMap(writesOf)) {
        const key = `${pool}/${write.key}`
        yield* (write._tag === "Put" ? storage.set(key, write.value) : storage.remove(key)).pipe(Effect.ignoreCause)
      }
    }),
  })
