# Tagged Values, Predicate, and Match

Use this reference for normal tagged values. These rules do not replace Effect error handling or Schema decoding.

## Choose the construct

| Situation | Use |
| --- | --- |
| Recover a tagged failure in `Effect<A, E, R>` | `Effect.catchTag` or `Effect.catchTags` |
| Test one trusted tag | `Predicate.isTagged` |
| Reuse a multi-tag refinement | Compose named `Predicate.isTagged` guards |
| Transform every member of a closed tagged union | `Match.type<T>()` with `Match.tagsExhaustive` |
| Dispatch a closed union at one call site | `Match.value(value)` |
| Handle selected tags by contract | `Match.tag` or `Match.tags` with an explicit fallback |

`Match` selects a branch for an ordinary value. A branch can return an Effect. `Match` does not run that Effect. `Match` does not recover its failure channel.

## Narrow trusted values

Use `Predicate.isTagged` for a guard or reusable array refinement. The input must already be a trusted union value. The predicate checks the tag. It does not validate the other fields.

```ts
import { Predicate } from "effect"

type Message = Extract<Event, { readonly _tag: "UserMessage" | "AgentMessage" }>

const isMessage: Predicate.Refinement<Event, Message> = Predicate.or(
  Predicate.isTagged("UserMessage"),
  Predicate.isTagged("AgentMessage")
)

const messages = events.filter(isMessage)
```

Use a direct `_tag` check for one simple local guard. Extract a named predicate when the condition recurs, combines tags, or states a domain concept.

## Transform complete unions

Use an exhaustive match for a closed union that the application owns. A new variant then creates a type error at each complete transformation.

```ts
import { Match } from "effect"

const label = Match.type<JobState>().pipe(
  Match.tagsExhaustive({
    Idle: () => "idle",
    Running: ({ attempt }) => `attempt ${attempt}`,
    Failed: ({ message }) => message
  })
)
```

Use `Match.value(value)` for one local dispatch. Use a fallback only when unmatched values are valid by contract. Do not use a fallback only to suppress exhaustiveness for an owned union.

## Keep boundaries and failures separate

Decode an unknown value before you inspect its tag.

```ts
const decodeEvent = Schema.decodeUnknownEffect(Event)

const recovered = providerCall.pipe(
  Effect.catchTags({
    ProviderUnavailable: () => Effect.succeed(fallback),
    ProviderUnauthenticated: () => Effect.succeed(fallback)
  })
)
```

The decoder validates normal data. `catchTags` recovers typed failures. Do not replace either operation with the other.

## Review checklist

- [ ] The value is normal data, not an Effect failure.
- [ ] A Schema decoded untrusted input before tag dispatch.
- [ ] A repeated tag condition has a named refinement.
- [ ] A complete owned union uses exhaustive dispatch.
- [ ] A simple local guard stays simple when a matcher adds no value.
