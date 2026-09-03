# Schema

Use schemas as executable domain boundaries: the same definition owns the runtime check, static type, encoding contract, and construction policy.

## Records and construction

```ts
import { Schema } from "effect"

export const User = Schema.Struct({
  id: Schema.String.pipe(Schema.brand("UserId")),
  name: Schema.NonEmptyString,
  nickname: Schema.optionalKey(Schema.String)
})
export interface User extends Schema.Schema.Type<typeof User> {}

const decodeUser = Schema.decodeUnknownEffect(User)
const user = yield* decodeUser(input)
const trusted = User.make({ id: "u_1", name: "Ada" })
const validated = yield* User.makeEffect({ id: "u_1", name: "Ada" })
```

- Decode unknown or persisted external values effectfully.
- Use `makeEffect` when constructor validation belongs in the error channel.
- Use throwing `make` only where invalid input is a programmer defect.
- Express optional object keys with `Schema.optionalKey(...)`; use `Schema.OptionFromUndefinedOr(...)` when the decoded domain value should be `Option`.

## Brands

Brand scalar values when two values share a carrier but are not interchangeable.

```ts
const UserId = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("UserId")
)
type UserId = typeof UserId.Type
```

Decode the brand at the boundary. Keep application functions typed in the brand instead of repeatedly validating strings.

## Internal tagged state

Use `Data.TaggedEnum` for internal decisions that do not need a codec.

```ts
import { Data } from "effect"

type JobState = Data.TaggedEnum<{
  Idle: {}
  Running: { readonly attempt: number }
  Failed: { readonly message: string }
}>

const JobState = Data.taggedEnum<JobState>()
const label = JobState.$match(state, {
  Idle: () => "idle",
  Running: ({ attempt }) => `attempt ${attempt}`,
  Failed: ({ message }) => message
})
```

## Boundary variants

Use schema-backed tagged variants when values cross storage, process, HTTP, or event boundaries.

```ts
const Command = Schema.TaggedUnion({
  Create: { name: Schema.NonEmptyString },
  Delete: { id: UserId }
})

const result = Command.match(command, {
  Create: ({ name }) => create(name),
  Delete: ({ id }) => remove(id)
})
```

For an external discriminator, define the field explicitly and then add union helpers:

```ts
const Added = Schema.Struct({ type: Schema.tag("added"), id: UserId })
const Removed = Schema.Struct({ type: Schema.tag("removed"), id: UserId })
const Event = Schema.Union([Added, Removed]).pipe(Schema.toTaggedUnion("type"))
```

After decoding, use `Predicate` or `Match` for normal tagged-value control flow. Do not use either tool to validate unknown input. See [TAGGED_VALUES.md](TAGGED_VALUES.md).

## Durable formats

Treat persisted and wire-visible schemas as versioned contracts. Add a new schema version and upcast at the decode boundary when a change is incompatible. Do not reinterpret historical data with a cast or silently change the meaning of an existing field.

Preserve the wire distinction between absent, `undefined`, and `null` values. Use `Schema.optionalKey`, `Schema.optional`, and `Schema.NullOr` according to the actual contract.

## Typed failures

```ts
export class UserNotFound extends Schema.TaggedErrorClass<UserNotFound>()(
  "UserNotFound",
  { id: UserId }
) {}
```

Use one truthful error type per recovery decision. Add fields the handler needs to decide or report; avoid a generic message-only wrapper that erases provider detail.

## JSON and transformations

- Use `Schema.fromJsonString(schema)` for typed JSON decoding and encoding.
- Use `.check(...)` for refinements and `.annotate(...)` for schema metadata.
- Use `Schema.decodeTo(...)` and schema getters for fallible transformations.
- Keep codecs at the boundary; keep already-decoded domain logic on domain types.
