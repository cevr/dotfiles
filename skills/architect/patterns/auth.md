# Authentication Pattern

JWT-based authentication using Effect services.

## Auth Service

```typescript
// packages/core/src/auth/auth.ts
import { Context, Effect, Layer, Schema as S, Config } from "effect"
import * as jose from "jose"

export class AuthInvalidCredentials extends S.TaggedError<AuthInvalidCredentials>()(
  "AuthInvalidCredentials",
  { message: S.String }
) {}

export class AuthTokenExpired extends S.TaggedError<AuthTokenExpired>()(
  "AuthTokenExpired",
  { message: S.String }
) {}

export class AuthTokenInvalid extends S.TaggedError<AuthTokenInvalid>()(
  "AuthTokenInvalid",
  { message: S.String }
) {}

export interface TokenPayload {
  userId: string
  roles: string[]
}

export interface AuthTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export class AuthService extends Context.Tag("AuthService")<
  AuthService,
  {
    readonly login: (
      email: string,
      password: string
    ) => Effect.Effect<AuthTokens, AuthInvalidCredentials>
    readonly verifyToken: (
      token: string
    ) => Effect.Effect<TokenPayload, AuthTokenExpired | AuthTokenInvalid>
    readonly refreshToken: (
      token: string
    ) => Effect.Effect<AuthTokens, AuthTokenInvalid>
    readonly hashPassword: (password: string) => Effect.Effect<string>
    readonly verifyPassword: (
      password: string,
      hash: string
    ) => Effect.Effect<boolean>
  }
>() {
  static Live = Layer.effect(
    AuthService,
    Effect.gen(function* () {
      const jwtSecret = yield* Config.redacted("JWT_SECRET")
      const secret = new TextEncoder().encode(jwtSecret.value)

      const users = yield* UserService
      const accessTokenTTL = 15 * 60 // 15 minutes
      const refreshTokenTTL = 7 * 24 * 60 * 60 // 7 days

      return AuthService.of({
        login: (email, password) =>
          Effect.gen(function* () {
            const user = yield* users.findByEmail(email).pipe(
              Effect.catchTag("UserNotFound", () =>
                Effect.fail(
                  new AuthInvalidCredentials({ message: "Invalid credentials" })
                )
              )
            )

            const valid = yield* Effect.tryPromise(() =>
              Bun.password.verify(password, user.passwordHash)
            )

            if (!valid) {
              return yield* Effect.fail(
                new AuthInvalidCredentials({ message: "Invalid credentials" })
              )
            }

            const payload: TokenPayload = {
              userId: user.id,
              roles: user.roles,
            }

            const accessToken = yield* Effect.tryPromise(() =>
              new jose.SignJWT(payload)
                .setProtectedHeader({ alg: "HS256" })
                .setExpirationTime(`${accessTokenTTL}s`)
                .sign(secret)
            )

            const refreshToken = yield* Effect.tryPromise(() =>
              new jose.SignJWT({ userId: user.id, type: "refresh" })
                .setProtectedHeader({ alg: "HS256" })
                .setExpirationTime(`${refreshTokenTTL}s`)
                .sign(secret)
            )

            return {
              accessToken,
              refreshToken,
              expiresIn: accessTokenTTL,
            }
          }),

        verifyToken: (token) =>
          Effect.gen(function* () {
            const result = yield* Effect.tryPromise(() =>
              jose.jwtVerify(token, secret)
            ).pipe(
              Effect.catchAll((error) => {
                if (error instanceof jose.errors.JWTExpired) {
                  return Effect.fail(
                    new AuthTokenExpired({ message: "Token expired" })
                  )
                }
                return Effect.fail(
                  new AuthTokenInvalid({ message: "Invalid token" })
                )
              })
            )

            return result.payload as unknown as TokenPayload
          }),

        refreshToken: (token) =>
          Effect.gen(function* () {
            const result = yield* Effect.tryPromise(() =>
              jose.jwtVerify(token, secret)
            ).pipe(
              Effect.catchAll(() =>
                Effect.fail(new AuthTokenInvalid({ message: "Invalid refresh token" }))
              )
            )

            const payload = result.payload as { userId: string; type?: string }
            if (payload.type !== "refresh") {
              return yield* Effect.fail(
                new AuthTokenInvalid({ message: "Not a refresh token" })
              )
            }

            const user = yield* users.get(payload.userId as UserId)

            const newPayload: TokenPayload = {
              userId: user.id,
              roles: user.roles,
            }

            const accessToken = yield* Effect.tryPromise(() =>
              new jose.SignJWT(newPayload)
                .setProtectedHeader({ alg: "HS256" })
                .setExpirationTime(`${accessTokenTTL}s`)
                .sign(secret)
            )

            const newRefreshToken = yield* Effect.tryPromise(() =>
              new jose.SignJWT({ userId: user.id, type: "refresh" })
                .setProtectedHeader({ alg: "HS256" })
                .setExpirationTime(`${refreshTokenTTL}s`)
                .sign(secret)
            )

            return {
              accessToken,
              refreshToken: newRefreshToken,
              expiresIn: accessTokenTTL,
            }
          }),

        hashPassword: (password) =>
          Effect.tryPromise(() => Bun.password.hash(password)),

        verifyPassword: (password, hash) =>
          Effect.tryPromise(() => Bun.password.verify(password, hash)),
      })
    })
  )
}
```

## Auth Middleware (HttpApi)

```typescript
// packages/api/src/definition/middleware/AuthMiddleware.ts
import { Context, Schema as S } from "effect"
import { HttpApiMiddleware, HttpApiSchema, HttpApiSecurity } from "@effect/platform"

export class Unauthorized extends S.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: S.String },
  HttpApiSchema.annotations({ status: 401 })
) {}

export class AuthContext extends Context.Tag("AuthContext")<
  AuthContext,
  {
    readonly userId: string
    readonly roles: ReadonlyArray<string>
  }
>() {}

export class AuthMiddleware extends HttpApiMiddleware.Tag<AuthMiddleware>()(
  "AuthMiddleware",
  {
    failure: Unauthorized,
    provides: AuthContext,
    security: {
      bearer: HttpApiSecurity.bearer,
    },
  }
) {}
```

## Auth Middleware Implementation

```typescript
// apps/server/src/middleware/AuthMiddlewareLive.ts
import { Effect, Layer, Redacted } from "effect"
import { AuthMiddleware, AuthContext, Unauthorized } from "@my-app/api/definition"
import { AuthService } from "@my-app/core"

export const AuthMiddlewareLive = Layer.effect(
  AuthMiddleware,
  Effect.gen(function* () {
    const auth = yield* AuthService

    return {
      bearer: (token) =>
        Effect.gen(function* () {
          const tokenValue = Redacted.value(token)

          if (!tokenValue) {
            return yield* Effect.fail(
              new Unauthorized({ message: "Missing authorization token" })
            )
          }

          const payload = yield* auth.verifyToken(tokenValue).pipe(
            Effect.catchTags({
              AuthTokenExpired: () =>
                Effect.fail(new Unauthorized({ message: "Token expired" })),
              AuthTokenInvalid: () =>
                Effect.fail(new Unauthorized({ message: "Invalid token" })),
            })
          )

          return AuthContext.of({
            userId: payload.userId,
            roles: payload.roles,
          })
        }),
    }
  })
)
```

## Auth Endpoints

```typescript
// packages/api/src/definition/groups/AuthGroup.ts
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Schema as S } from "effect"

const LoginRequest = S.Struct({
  email: S.String.pipe(S.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
  password: S.String.pipe(S.minLength(8)),
})

const TokenResponse = S.Struct({
  accessToken: S.String,
  refreshToken: S.String,
  expiresIn: S.Number,
})

export class InvalidCredentials extends S.TaggedError<InvalidCredentials>()(
  "InvalidCredentials",
  { message: S.String },
  HttpApiSchema.annotations({ status: 401 })
) {}

export const AuthGroup = HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.post("login", "/login")
      .setPayload(LoginRequest)
      .addSuccess(TokenResponse)
      .addError(InvalidCredentials)
  )
  .add(
    HttpApiEndpoint.post("refresh", "/refresh")
      .setPayload(S.Struct({ refreshToken: S.String }))
      .addSuccess(TokenResponse)
      .addError(InvalidCredentials)
  )
  .prefix("/auth")
```

## Using Auth Context in Handlers

```typescript
// apps/server/src/handlers/SessionGroupLive.ts
import { AuthContext } from "@my-app/api/definition"

export const SessionGroupLive = HttpApiBuilder.group(
  AppApi,
  "sessions",
  (handlers) =>
    Effect.gen(function* () {
      const sessions = yield* SessionService

      return handlers.handle("create", ({ payload }) =>
        Effect.gen(function* () {
          // Get current user from auth context
          const auth = yield* AuthContext

          return yield* sessions.create({
            ...payload,
            ownerId: auth.userId,
          })
        })
      )
    })
)
```

## Key Points

1. **JWT with jose**: Use jose library for JWT operations
2. **Bun.password**: Use Bun's built-in password hashing
3. **HttpApiSecurity**: Defines auth schemes in OpenAPI
4. **AuthContext**: Middleware provides user info to handlers
5. **Typed errors**: AuthTokenExpired, AuthTokenInvalid for specific failures
6. **Config.redacted**: Secure secret loading
