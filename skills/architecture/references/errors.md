# Error Handling

Effect patterns for typed errors, recovery, and HTTP mapping.

## Decision Tree

```
Error type?
├─ Domain/business error        → Schema.TaggedError
├─ API error (empty body)       → HttpApiSchema.EmptyError
├─ Unexpected/bug               → Defect (Effect.die)
├─ Multiple error types         → Schema.Union of TaggedErrors
└─ Error in streaming           → error as event type

Recovery strategy?
├─ Handle specific error        → Effect.catchTag
├─ Handle all expected          → Effect.catchAll
├─ Handle including defects     → Effect.catchAllCause
├─ Fallback value               → Effect.orElse
├─ Retry on failure             → Effect.retry with Schedule
└─ Map error to different type  → Effect.mapError
```

## Core Principle

**Errors are types.** Expected errors live in the type signature. Defects (bugs) crash. Never catch defects silently.

## Patterns

### 1. Schema.TaggedError

Domain errors with schema validation:

```typescript
import { Schema as S } from "effect"
import { HttpApiSchema } from "@effect/platform"

// Error with payload
class UserNotFoundError extends S.TaggedError<UserNotFoundError>()(
  "UserNotFoundError",
  {
    userId: UserIdSchema,
    message: S.String,
  },
  HttpApiSchema.annotations({ status: 404 }),
) {}

// Error with validation details
class ValidationError extends S.TaggedError<ValidationError>()(
  "ValidationError",
  {
    field: S.String,
    message: S.String,
    value: S.optional(S.Unknown),
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

// Simple error
class UnauthorizedError extends S.TaggedError<UnauthorizedError>()(
  "UnauthorizedError",
  { message: S.String },
  HttpApiSchema.annotations({ status: 401 }),
) {}

// Rate limit error with retry info
class RateLimitError extends S.TaggedError<RateLimitError>()(
  "RateLimitError",
  {
    retryAfter: S.Number,
    message: S.String,
  },
  HttpApiSchema.annotations({ status: 429 }),
) {}
```

### 2. HttpApiSchema.EmptyError

For errors without body (just status code):

```typescript
import { HttpApiSchema } from "@effect/platform"

class BadRequest extends HttpApiSchema.EmptyError<BadRequest>()({
  tag: "BadRequest",
  status: 400,
}) {}

class NotFound extends HttpApiSchema.EmptyError<NotFound>()({
  tag: "NotFound",
  status: 404,
}) {}

class Forbidden extends HttpApiSchema.EmptyError<Forbidden>()({
  tag: "Forbidden",
  status: 403,
}) {}

class InternalError extends HttpApiSchema.EmptyError<InternalError>()({
  tag: "InternalError",
  status: 500,
}) {}
```

### 3. Typed Error Channel

Errors in the type signature:

```typescript
// Function signature shows possible errors
const findUser: (id: UserId) => Effect.Effect<
  User, // Success type
  UserNotFoundError | DatabaseError // Error type
>

// Caller sees errors in types
const program = Effect.gen(function* () {
  const user = yield* findUser(userId)
  // Type: Effect<User, UserNotFoundError | DatabaseError>
  return user
})

// Handle specific error
const handled = program.pipe(Effect.catchTag("UserNotFoundError", (e) => Effect.succeed(guestUser)))
// Type: Effect<User, DatabaseError> - UserNotFoundError handled
```

### 4. Error Recovery

#### catchTag - Handle Specific Error

```typescript
const program = findUser(userId).pipe(
  Effect.catchTag("UserNotFoundError", (error) => Effect.succeed(createGuestUser(error.userId))),
)
```

#### catchTags - Handle Multiple Specific Errors

```typescript
const program = processOrder(orderId).pipe(
  Effect.catchTags({
    OrderNotFoundError: (e) => Effect.succeed(null),
    PaymentFailedError: (e) => refundAndRetry(e.orderId),
    ValidationError: (e) => Effect.fail(new BadRequestError({ message: e.message })),
  }),
)
```

#### catchAll - Handle All Expected Errors

```typescript
const program = riskyOperation().pipe(
  Effect.catchAll((error) => {
    // error is the union of all expected errors
    logger.error("Operation failed", { error })
    return Effect.succeed(fallbackValue)
  }),
)
```

#### catchAllCause - Handle Everything (Including Defects)

```typescript
const program = riskyOperation().pipe(
  Effect.catchAllCause((cause) => {
    // cause contains full error information including defects
    const squashed = Cause.squash(cause)
    logger.error("Operation failed", { error: squashed })
    return Effect.succeed(fallbackValue)
  }),
)
```

### 5. Expected vs Defects

```typescript
// Expected error - part of the type signature, recoverable
const findUser = (id: UserId): Effect.Effect<User, UserNotFoundError> =>
  Effect.gen(function* () {
    const row = yield* db.query(...)
    if (!row) {
      yield* Effect.fail(new UserNotFoundError({ userId: id, message: '...' }))
    }
    return row as User
  })

// Defect - bug, should crash, not in type signature
const parseConfig = (json: string): Effect.Effect<Config> =>
  Effect.try({
    try: () => JSON.parse(json),
    catch: (e) => new Error(`Invalid config JSON: ${e}`),
  }).pipe(
    Effect.flatMap((parsed) => {
      if (!isValidConfig(parsed)) {
        // This is a bug - config should be valid
        return Effect.die(new Error('Invalid config structure'))
      }
      return Effect.succeed(parsed)
    })
  )
```

### 6. Error Transformation

#### Map Error Type

```typescript
// Transform error to different type
const apiCall = externalApi.fetch(url).pipe(
  Effect.mapError(
    (e) =>
      new ServiceUnavailableError({
        service: "external-api",
        message: e.message,
      }),
  ),
)
```

#### Annotate Error with Context

```typescript
const withContext = findUser(userId).pipe(
  Effect.mapError((e) => ({
    ...e,
    context: { requestId, timestamp: Date.now() },
  })),
)
```

### 7. Retry with Schedule

```typescript
import { Schedule } from "effect"

// Retry 3 times with exponential backoff
const withRetry = flakeyOperation().pipe(
  Effect.retry(Schedule.exponential("100 millis").pipe(Schedule.compose(Schedule.recurs(3)))),
)

// Retry only specific errors
const selectiveRetry = apiCall().pipe(
  Effect.retry({
    schedule: Schedule.recurs(3),
    while: (error) => error._tag === "RateLimitError",
  }),
)

// Retry with delay from error
const respectRateLimit = apiCall().pipe(
  Effect.retry({
    schedule: Schedule.once,
    while: (error) => error._tag === "RateLimitError",
    schedule: Schedule.fromFunction((error) => Schedule.sleep(`${error.retryAfter} seconds`)),
  }),
)
```

### 8. Error in API Endpoints

```typescript
// Define endpoint with errors
const getUser = HttpApiEndpoint.get("get", "/users/:id")
  .setPath(S.Struct({ id: UserIdSchema }))
  .addSuccess(User)
  .addError(UserNotFoundError) // 404
  .addError(UnauthorizedError) // 401

// Define group with shared errors
class UsersApi extends HttpApiGroup.make("users")
  .add(getUser)
  .add(createUser)
  .addError(ValidationError) // Applies to all endpoints
  .middleware(Authorization) {}

// Define API with global errors
class Api extends HttpApi.make("api").add(UsersApi).addError(InternalError, { status: 500 }) {
  // Global fallback
}
```

### 9. Error in Streaming

For SSE/WebSocket, errors are event types:

```typescript
const StreamEvent = S.Union(
  S.Struct({
    _tag: S.Literal("data"),
    payload: DataSchema,
  }),
  S.Struct({
    _tag: S.Literal("error"),
    code: S.String,
    message: S.String,
    retryable: S.Boolean,
  }),
  S.Struct({
    _tag: S.Literal("done"),
  }),
)

// Stream handler
const streamData = Effect.gen(function* () {
  const stream = yield* getDataStream()
  return stream.pipe(
    Stream.catchAll((error) =>
      Stream.succeed({
        _tag: "error" as const,
        code: "STREAM_ERROR",
        message: error.message,
        retryable: true,
      }),
    ),
  )
})
```

### 10. Layer Error Handling

```typescript
// Catch layer creation errors
const DatabaseLive = Layer.effect(Database, createConnection()).pipe(
  Layer.catchAll((error) => Layer.fail(new DatabaseConnectionError({ cause: error }))),
)

// Fallback layer
const CacheLive = Layer.effect(Cache, connectRedis()).pipe(Layer.orElse(() => InMemoryCacheLive))
```

## HTTP Status Mapping

| Error Type        | Status | When                            |
| ----------------- | ------ | ------------------------------- |
| ValidationError   | 400    | Invalid input, schema mismatch  |
| UnauthorizedError | 401    | Missing/invalid auth            |
| ForbiddenError    | 403    | Valid auth, insufficient perms  |
| NotFoundError     | 404    | Resource doesn't exist          |
| ConflictError     | 409    | State conflict (duplicate, etc) |
| RateLimitError    | 429    | Too many requests               |
| InternalError     | 500    | Unexpected server error         |

## See Also

- `domain.md` - error types as domain modeling
- `api.md` - error responses in API design
- `services.md` - error handling in service layers
