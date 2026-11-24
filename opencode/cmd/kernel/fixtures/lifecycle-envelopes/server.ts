import { Console, Effect, Ref, Result, Schema, Stream } from "effect"
import { live, make } from "../../server.ts"
import { decodeEvent, eventsOf } from "../../../../mods/kernel/opencode/child-lifecycle.ts"
import { lifecycleEventTypes } from "../../../../mods/kernel/lifecycle-event-types.ts"

const inventory = new Set<string>(lifecycleEventTypes)
const readHeader = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.String }))
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

// Tap the exact raw object at the real Kernel subscriber; do not replace,
// rebuild or put a second event transport between the pin and the fold.
export default make(live, (ctx) => Stream.unwrap(Effect.gen(function* () {
  const recorded = yield* Ref.make(new Set<string>())
  return eventsOf(ctx).pipe(Stream.tap((raw) => {
    const header = readHeader(raw)
    if (header._tag === "None" || !inventory.has(header.value.type)) return Effect.void
    const { type } = header.value
    return Ref.modify(recorded, (before) => [!before.has(type), new Set([...before, type])]).pipe(
      Effect.flatMap((first) => {
        if (!first) return Effect.void
        const result = decodeEvent(raw)
        if (Result.isFailure(result)) return Console.log(`lifecycle-rejected ${type}: ${String(result.failure)}`)
        return Console.log(`lifecycle-envelope ${encode(raw)}`)
      }),
    )
  }))
})))
