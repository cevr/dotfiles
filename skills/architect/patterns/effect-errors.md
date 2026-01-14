# Effect Error Handling

Using Schema.TaggedError for type-safe errors with HTTP status mapping.

## Defining Errors

```typescript
import { Schema as S } from "effect"
import { HttpApiSchema } from "@effect/platform"

// Basic tagged error
export class SessionNotFound extends S.TaggedError<SessionNotFound>()(
  "SessionNotFound",
  {
    sessionId: S.String,
    message: S.String,
  }
) {}

// With HTTP status annotation (for HttpApi)
export class UserNotFound extends S.TaggedError<UserNotFound>()(
  "UserNotFound",
  {
    userId: S.String,
    message: S.String,
  },
  HttpApiSchema.annotations({ status: 404 })
) {}

// Validation error (400)
export class ValidationError extends S.TaggedError<ValidationError>()(
  "ValidationError",
  {
    field: S.String,
    message: S.String,
  },
  HttpApiSchema.annotations({ status: 400 })
) {}

// Unauthorized (401)
export class Unauthorized extends S.TaggedError<Unauthorized>()(
  "Unauthorized",
  {
    message: S.String,
  },
  HttpApiSchema.annotations({ status: 401 })
) {}

// Forbidden (403)
export class Forbidden extends S.TaggedError<Forbidden>()(
  "Forbidden",
  {
    resource: S.String,
    message: S.String,
  },
  HttpApiSchema.annotations({ status: 403 })
) {}
```

## Using Errors in Services

```typescript
export class UserService extends Context.Tag("UserService")<
  UserService,
  {
    readonly get: (id: UserId) => Effect.Effect<User, UserNotFound>
    readonly create: (data: CreateUser) => Effect.Effect<User, ValidationError>
  }
>() {
  static Live = Layer.effect(
    UserService,
    Effect.gen(function* () {
      const storage = yield* StorageService

      return UserService.of({
        get: (id) =>
          Effect.gen(function* () {
            const user = yield* storage.get<User>(`user:${id}`)
            if (!user) {
              return yield* Effect.fail(
                new UserNotFound({
                  userId: id,
                  message: `User not found: ${id}`,
                })
              )
            }
            return user
          }),

        create: (data) =>
          Effect.gen(function* () {
            // Validate email format
            if (!isValidEmail(data.email)) {
              return yield* Effect.fail(
                new ValidationError({
                  field: "email",
                  message: "Invalid email format",
                })
              )
            }
            // ... create user
          }),
      })
    })
  )
}
```

## Handling Errors

### catchTag - Handle specific error

```typescript
const program = Effect.gen(function* () {
  const users = yield* UserService
  return yield* users.get(userId)
}).pipe(
  Effect.catchTag("UserNotFound", (error) =>
    Effect.succeed({ fallback: true, userId: error.userId })
  )
)
```

### catchTags - Handle multiple errors

```typescript
const program = Effect.gen(function* () {
  const users = yield* UserService
  return yield* users.create(data)
}).pipe(
  Effect.catchTags({
    ValidationError: (error) =>
      Effect.fail(new BadRequest({ message: error.message })),
    UserNotFound: (error) =>
      Effect.fail(new NotFound({ message: error.message })),
  })
)
```

### mapError - Transform errors

```typescript
const program = users.get(userId).pipe(
  Effect.mapError((error) => ({
    ...error,
    timestamp: new Date(),
  }))
)
```

## Error in HttpApi

```typescript
// In packages/api/src/definition/groups/UserGroup.ts
export const UserGroup = HttpApiGroup.make("users")
  .add(
    HttpApiEndpoint.get("get", "/:id")
      .setPath(S.Struct({ id: UserIdSchema }))
      .addSuccess(UserSchema)
      .addError(UserNotFound)  // 404 from annotation
      .addError(Unauthorized)   // 401 from annotation
  )
  .add(
    HttpApiEndpoint.post("create", "/")
      .setPayload(CreateUserSchema)
      .addSuccess(UserSchema, { status: 201 })
      .addError(ValidationError)  // 400 from annotation
  )
```

## Error Unions

```typescript
// Define error union for a service
type UserServiceError = UserNotFound | ValidationError | Forbidden

// Service methods declare their errors
readonly update: (
  id: UserId,
  data: UpdateUser
) => Effect.Effect<User, UserNotFound | Forbidden | ValidationError>
```

## Best Practices

1. **One error per failure mode**: Don't reuse generic errors
2. **Include context**: Add relevant IDs and messages
3. **HTTP annotations**: Use HttpApiSchema.annotations for API errors
4. **Error unions**: Be explicit about which errors a method can return
5. **Never throw**: Always use `Effect.fail()` with tagged errors
