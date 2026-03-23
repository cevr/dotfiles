# Schema v4

Key Schema changes from v3 to v4.

## Type System Change

```typescript
// v3: Schema<Type, Encoded, Requirements>  (3 params)
// v4: Schema<Type>                          (1 param — decode-only)
//     Codec<Type, Encoded, RDecode, REncode>  (4 params — full)
```

Use `Schema.revealCodec(s)` to access the full Codec type (replaces `Schema.asSchema`).

## .check() Replaces Pipe Filters

```typescript
// v3
Schema.Number.pipe(Schema.int(), Schema.positive())

// v4
Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))

// Common checks
Schema.String.check(Schema.isMinLength(1))
Schema.String.check(Schema.isMaxLength(255))
Schema.String.check(Schema.isPattern(/^[a-z]+$/))
Schema.String.check(Schema.isNonEmpty())
Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }))
Schema.Number.check(Schema.isInt())
Schema.Number.check(Schema.isFinite())
Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
```

## .annotate() Replaces .annotations()

```typescript
// v3
Schema.String.annotations({ description: "A name", examples: ["Ada"] })

// v4
Schema.String.annotate({ description: "A name", examples: ["Ada"] })
```

## Constructor Renames

```typescript
// v3 → v4
Schema.Literal("a", "b")         → Schema.Literals(["a", "b"])
Schema.Union(A, B)                → Schema.Union([A, B])
Schema.Tuple(A, B)                → Schema.Tuple([A, B])
Schema.TemplateLiteral(A, ".", B) → Schema.TemplateLiteral([A, ".", B])
```

## Decode/Encode API Renames

```typescript
// v3 → v4
Schema.decodeUnknownEither  → Schema.decodeUnknownResult
Schema.decodeEither         → Schema.decodeResult
Schema.encodeUnknownEither  → Schema.encodeUnknownResult
Schema.encodeEither         → Schema.encodeResult
Schema.decodeUnknown        → Schema.decodeUnknownEffect
Schema.decode               → Schema.decodeEffect
// Note: "decode" in v4 is a transformation builder, not a decoder
```

## Schema.TaggedErrorClass (renamed from TaggedError)

```typescript
// v3
export class HttpError extends Schema.TaggedError<HttpError>()(
  "HttpError",
  { status: Schema.Number, message: Schema.String }
) {}

// v4
export class HttpError extends Schema.TaggedErrorClass<HttpError>()(
  "HttpError",
  { status: Schema.Number, message: Schema.String }
) {}

// Usage — same
const program = Effect.gen(function* () {
  yield* new HttpError({ status: 404, message: "Not found" })
})
```

## Built-in Schema Types

```typescript
// v4 pre-built validated types
Schema.NonEmptyString     // String.check(isNonEmpty())
Schema.Char               // String.check(isLengthBetween(1, 1))
Schema.Int                // Number.check(isInt())
Schema.Finite             // Number.check(isFinite())
Schema.DateValid          // Date.check(isDateValid())
```

## Schema.Class (unchanged)

```typescript
class User extends Schema.Class<User>("User")({
  id: UserId,
  name: Schema.String,
  email: Schema.String,
  createdAt: Schema.DateFromSelf,
}) {}
```

## Branded Types (unchanged)

```typescript
const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type
```

## Schema.mutable — Arrays Only

```typescript
// v3 — worked on structs and arrays
Schema.mutable(Schema.Struct({ name: Schema.String }))
Schema.mutable(Schema.Array(Schema.String))

// v4 — only arrays; structs are mutable by default
Schema.mutable(Schema.Array(Schema.String))  // OK
// Schema.mutable(Schema.Struct(...))         // BREAKS — just use Schema.Struct directly
```

## Schema.optionalWith — Replaced

```typescript
// v3: { as: 'Option' } — decode to Option<T>
Schema.optionalWith(MySchema, { as: 'Option' })
// v4:
Schema.optionalKey(Schema.OptionFromUndefinedOr(MySchema))

// v3: { nullable: true } — accept null
Schema.optionalWith(MySchema, { nullable: true })
// v4:
Schema.optionalKey(Schema.NullishOr(MySchema))

// v3: { default: () => value } — provide default
Schema.optionalWith(Schema.Number, { default: () => 0 })
// v4:
Schema.optional(Schema.Number).pipe(Schema.withConstructorDefault(() => 0))
```

## Quick Reference

| v3 | v4 |
|----|----|
| `Schema.TaggedError` | `Schema.TaggedErrorClass` |
| `.annotations({...})` | `.annotate({...})` |
| `.pipe(Schema.int())` | `.check(Schema.isInt())` |
| `.pipe(Schema.positive())` | `.check(Schema.isGreaterThan(0))` |
| `.pipe(Schema.nonNegative())` | `.check(Schema.isGreaterThanOrEqualTo(0))` |
| `.pipe(Schema.nonEmpty())` | `.check(Schema.isNonEmpty())` |
| `.pipe(Schema.between(a,b))` | `.check(Schema.isBetween({ minimum: a, maximum: b }))` |
| `Schema.Literal("a", "b")` | `Schema.Literals(["a", "b"])` |
| `Schema.Union(A, B)` | `Schema.Union([A, B])` |
| `Schema.Record({ key, value })` | `Schema.Record(K, V)` |
| `Schema.pick(S, keys)` | Destructure `S.fields` into new `Schema.Struct` |
| `Schema.typeSchema(S)` | `Schema.toType(S)` |
| `Schema.Config("name", codec)` | `Config.schema(codec, "name")` |
| `Schema.transformOrFail(F, T, {...})` | `Schema.decodeTo` + `SchemaGetter.transformOrFail` |
| `Schema.disableValidation` option | Removed — just delete the option |
| `Schema.Schema.AnyNoContext` | `Schema.Any` or `Schema.Top` |
| `decodeUnknown` | `decodeUnknownEffect` |
| `encodeUnknown` | `encodeUnknownEffect` |
| `decode(S)` | `decodeEffect(S)` |
| `encode(S)` | `encodeEffect(S)` |
| `decodeUnknownEither` | `decodeUnknownResult` |
| `decodeEither` | `decodeResult` |
| `ParseResult.ParseError` | `Schema.SchemaError` |
| `Schema<A, I, R>` | `Codec<A, I, RD, RE>` |
| `Schema.asSchema` | `Schema.revealCodec` |
| `Schema.parseJson` | `Schema.fromJsonString` |
| `Schema.fromJsonString(S, { space: 2 })` | Removed — use `JSON.stringify(data, null, 2)` |
| `Schema.optionalWith(S, { as: 'Option' })` | `Schema.optionalKey(Schema.OptionFromUndefinedOr(S))` |
| `Schema.optionalWith(S, { nullable: true })` | `Schema.optionalKey(Schema.NullishOr(S))` |
| `Schema.optionalWith(S, { default: () => v })` | `Schema.optional(S).pipe(Schema.withConstructorDefault(() => v))` |
| `Schema.mutable(Schema.Struct(...))` | Just `Schema.Struct(...)` (structs are mutable) |
| `Schema.mutable(Schema.Array(...))` | `Schema.mutable(Schema.Array(...))` (unchanged for arrays) |
