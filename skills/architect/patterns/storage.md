# Storage & Database Pattern

Database abstraction using @effect/sql with Drizzle ORM.

## Storage Service (Key-Value)

```typescript
// packages/core/src/storage/storage.ts
import { Context, Effect, Layer, Schema as S } from "effect"

export class StorageService extends Context.Tag("StorageService")<
  StorageService,
  {
    readonly get: <A>(key: string) => Effect.Effect<A | null>
    readonly set: <A>(key: string, value: A) => Effect.Effect<void>
    readonly delete: (key: string) => Effect.Effect<void>
    readonly list: <A>(pattern: string) => Effect.Effect<A[]>
    readonly exists: (key: string) => Effect.Effect<boolean>
  }
>() {
  // In-memory implementation for development
  static Memory = Layer.succeed(
    StorageService,
    (() => {
      const store = new Map<string, unknown>()

      return StorageService.of({
        get: (key) =>
          Effect.sync(() => (store.get(key) as any) ?? null),

        set: (key, value) =>
          Effect.sync(() => {
            store.set(key, value)
          }),

        delete: (key) =>
          Effect.sync(() => {
            store.delete(key)
          }),

        list: (pattern) =>
          Effect.sync(() => {
            const prefix = pattern.replace("*", "")
            return [...store.entries()]
              .filter(([k]) => k.startsWith(prefix))
              .map(([, v]) => v as any)
          }),

        exists: (key) =>
          Effect.sync(() => store.has(key)),
      })
    })()
  )
}
```

## Drizzle Schema

```typescript
// apps/server/src/db/schema/sessions.ts
import { pgTable, varchar, timestamp, text } from "drizzle-orm/pg-core"
import type { SessionId } from "@my-app/shared"

export const sessions = pgTable("sessions", {
  id: varchar("id").$type<SessionId>().primaryKey(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
})

// apps/server/src/db/schema/users.ts
import { pgTable, varchar, timestamp, integer } from "drizzle-orm/pg-core"
import type { UserId, Email } from "@my-app/shared"

export const users = pgTable("users", {
  id: varchar("id").$type<UserId>().primaryKey(),
  email: varchar("email", { length: 255 }).$type<Email>().notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
})

// apps/server/src/db/schema/index.ts
export * from "./sessions"
export * from "./users"
```

## SQL Layer Setup

```typescript
// apps/server/src/db/SqlLive.ts
import { Config, Context, Effect, Layer } from "effect"
import { PgClient } from "@effect/sql-pg"
import * as PgDrizzle from "@effect/sql-drizzle/Pg"
import * as Client from "@effect/sql/SqlClient"

const PgLive = Layer.scopedContext(
  Effect.gen(function* () {
    const host = yield* Config.string("DB_HOST").pipe(
      Config.withDefault("localhost")
    )
    const port = yield* Config.number("DB_PORT").pipe(
      Config.withDefault(5432)
    )
    const database = yield* Config.string("DB_NAME").pipe(
      Config.withDefault("myapp")
    )
    const username = yield* Config.string("DB_USERNAME").pipe(
      Config.withDefault("postgres")
    )
    const password = yield* Config.redacted("DB_PASSWORD")

    const client = yield* PgClient.make({
      host,
      port,
      database,
      username,
      password,
    })

    return Context.make(PgClient.PgClient, client).pipe(
      Context.add(Client.SqlClient, client)
    )
  })
)

const DrizzleLive = PgDrizzle.layerWithConfig({
  casing: "snake_case",
}).pipe(Layer.provide(PgLive))

export const SqlLive = Layer.mergeAll(PgLive, DrizzleLive)
```

## Repository Pattern

```typescript
// apps/server/src/repositories/session.ts
import { Effect, Option } from "effect"
import { PgDrizzle } from "@effect/sql-drizzle/Pg"
import { eq, desc, gt, lt, and } from "drizzle-orm"
import { sessions } from "../db/schema"
import type { Session, SessionId } from "@my-app/shared"

export const SessionRepository = {
  findById: (id: SessionId) =>
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle
      const results = yield* db
        .select()
        .from(sessions)
        .where(eq(sessions.id, id))
        .limit(1)

      return Option.fromNullable(results[0])
    }),

  findAll: (options: { limit: number; afterId?: SessionId }) =>
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle
      const conditions = options.afterId
        ? [gt(sessions.id, options.afterId)]
        : []

      const results = yield* db
        .select()
        .from(sessions)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(sessions.createdAt))
        .limit(options.limit + 1)

      const hasMore = results.length > options.limit
      const items = results.slice(0, options.limit)

      return { items, hasMore }
    }),

  create: (data: { id: SessionId; title: string }) =>
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle
      const [session] = yield* db
        .insert(sessions)
        .values(data)
        .returning()

      return session
    }),

  update: (id: SessionId, data: Partial<{ title: string }>) =>
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle
      const [session] = yield* db
        .update(sessions)
        .set(data)
        .where(eq(sessions.id, id))
        .returning()

      return Option.fromNullable(session)
    }),

  delete: (id: SessionId) =>
    Effect.gen(function* () {
      const db = yield* PgDrizzle.PgDrizzle
      yield* db.delete(sessions).where(eq(sessions.id, id))
    }),
}
```

## Migrations

```typescript
// apps/server/drizzle.config.ts
import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: "./src/db/schema",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USERNAME ?? "postgres",
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME ?? "myapp",
  },
})
```

```bash
# Generate migrations
bunx drizzle-kit generate

# Apply migrations
bunx drizzle-kit migrate

# Or in code:
```

```typescript
// apps/server/src/db/migrate.ts
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

const sql = postgres(process.env.DATABASE_URL!)
const db = drizzle(sql)

await migrate(db, { migrationsFolder: "./src/db/migrations" })
await sql.end()
```

## Transactions

```typescript
const transferSession = (fromId: SessionId, toUserId: UserId) =>
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle

    // Drizzle transactions
    yield* db.transaction(async (tx) => {
      // All operations in transaction
      await tx.update(sessions).set({ ownerId: toUserId }).where(eq(sessions.id, fromId))
      await tx.insert(auditLog).values({ action: "transfer", sessionId: fromId })
    })
  })
```

## Key Points

1. **Branded types**: Drizzle columns use `$type<BrandedId>()`
2. **Effect wrappers**: All DB operations return Effect
3. **Repository pattern**: Encapsulate queries in namespaces
4. **Layer composition**: SqlLive provides both raw SQL and Drizzle
5. **Type safety**: Schema and queries are fully typed
