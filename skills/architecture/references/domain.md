# Domain Modeling

Patterns for schemas, branded types, aggregates, and domain objects using Effect.

## Decision Tree

```
Modeling a type?
├─ ID (any kind)                → branded string (monotonic)
├─ Constrained value            → Schema with refinements
├─ Serializable data            → Schema.Class
├─ Union of states              → Schema.Union (tagged)
├─ Error type                   → Schema.TaggedError
└─ Simple enum                  → Schema.Literal union

Organizing domain code?
├─ Single entity                → schema + service in one file
├─ Entity + operations          → namespace aggregate
├─ Rich domain                  → separate schema, queries, commands
└─ Event-sourced                → events + state machine
```

## Core Principle

**Schema is single source of truth.** Types, validation, serialization, documentation—all derived from schema.

## Patterns

### 1. Branded Types (Always Strings)

Use monotonic string IDs everywhere—external, internal, database:

```typescript
import { Brand, Schema as S } from "effect"

// Nominal brand (no validation, just type safety)
type UserId = string & Brand.Brand<"UserId">
const UserId = Brand.nominal<UserId>()

// Schema version for parsing/validation
const UserIdSchema = S.String.pipe(S.pattern(/^usr_[a-zA-Z0-9]{12}$/), S.brand("UserId"))
type UserIdFromSchema = S.Schema.Type<typeof UserIdSchema>

// Usage - compiler prevents mixing IDs
declare function findUser(id: UserId): User
declare function findOrder(id: OrderId): Order

const userId = UserId("usr_abc123def456")
const orderId = OrderId("ord_xyz789ghi012")

findUser(userId) // ✓
findUser(orderId) // ✗ Type error - can't pass OrderId to UserId
```

**Why strings everywhere:**

- Monotonic IDs (ULID, KSUID, nanoid) sort naturally
- No int overflow concerns
- Same type internal/external - no mapping needed
- URL-safe, log-safe, JSON-safe

### 2. Common ID Patterns

```typescript
// ULID-style (sortable, 26 chars)
const UserId = S.String.pipe(S.pattern(/^usr_[0-9A-HJKMNP-TV-Z]{26}$/), S.brand("UserId"))

// Prefix convention
const OrderId = S.String.pipe(S.startsWith("ord_"), S.brand("OrderId"))
const ProductId = S.String.pipe(S.startsWith("prd_"), S.brand("ProductId"))
const SessionId = S.String.pipe(S.startsWith("ses_"), S.brand("SessionId"))

// Generate new IDs
import { ulid } from "ulid"
const newUserId = (): UserId => `usr_${ulid()}` as UserId
const newOrderId = (): OrderId => `ord_${ulid()}` as OrderId
```

### 3. Constrained Values

Schema refinements for business rules:

```typescript
// Email with validation
const Email = S.String.pipe(S.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/), S.brand("Email"))

// Positive amount
const PositiveAmount = S.Number.pipe(S.positive(), S.brand("PositiveAmount"))

// Percentage (0-100)
const Percentage = S.Number.pipe(S.between(0, 100), S.brand("Percentage"))

// Non-empty trimmed string
const NonEmptyString = S.String.pipe(S.trim, S.minLength(1), S.brand("NonEmptyString"))
```

### 4. Schema.Class (Serializable Data)

For entities and value objects:

```typescript
class User extends S.Class<User>("User")({
  id: UserIdSchema,
  email: Email,
  name: S.String,
  role: S.Literal("admin", "user", "guest"),
  createdAt: S.DateTimeUtc,
  updatedAt: S.DateTimeUtc,
}) {}

class Group extends S.Class<Group>("Group")({
  id: GroupIdSchema,
  name: S.String,
  members: S.Array(UserIdSchema),
}) {}

// Instantiate
const user = new User({
  id: "usr_01234567890123456789abcdef" as UserId,
  email: "alice@example.com" as Email,
  name: "Alice",
  role: "admin",
  createdAt: DateTime.unsafeNow(),
  updatedAt: DateTime.unsafeNow(),
})
```

### 5. Schema.TaggedError (Domain Errors)

Errors with schema validation and HTTP mapping:

```typescript
import { HttpApiSchema } from "@effect/platform"

class UserNotFoundError extends S.TaggedError<UserNotFoundError>()(
  "UserNotFoundError",
  {
    userId: UserIdSchema,
    message: S.String,
  },
  HttpApiSchema.annotations({ status: 404 }),
) {}

class ValidationError extends S.TaggedError<ValidationError>()(
  "ValidationError",
  {
    field: S.String,
    message: S.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

class UnauthorizedError extends S.TaggedError<UnauthorizedError>()(
  "UnauthorizedError",
  { message: S.String },
  HttpApiSchema.annotations({ status: 401 }),
) {}

// Usage
Effect.fail(
  new UserNotFoundError({
    userId: id,
    message: `User ${id} not found`,
  }),
)
```

### 6. Namespace Aggregates

Group related schema, queries, commands under namespace:

```typescript
// domain/user/index.ts
import * as Schema from "./schema"
import * as Queries from "./queries"
import * as Commands from "./commands"
import * as Events from "./events"

export { Schema, Queries, Commands, Events }

// Usage
import { User } from "@/domain"

User.Schema.UserSchema
User.Queries.findById
User.Commands.create
User.Events.UserCreated
```

**File structure:**

```
domain/
└── user/
    ├── index.ts      # Namespace re-exports
    ├── schema.ts     # Type definitions
    ├── queries.ts    # Read operations
    ├── commands.ts   # Write operations
    └── events.ts     # Domain events
```

### 7. Tagged Unions (State Machines)

Model states as discriminated unions:

```typescript
const PendingOrder = S.Struct({
  _tag: S.Literal("Pending"),
  id: OrderIdSchema,
  items: S.Array(OrderItemSchema),
  createdAt: S.DateTimeUtc,
})

const PaidOrder = S.Struct({
  _tag: S.Literal("Paid"),
  id: OrderIdSchema,
  items: S.Array(OrderItemSchema),
  paidAt: S.DateTimeUtc,
  paymentId: PaymentIdSchema,
})

const ShippedOrder = S.Struct({
  _tag: S.Literal("Shipped"),
  id: OrderIdSchema,
  items: S.Array(OrderItemSchema),
  paidAt: S.DateTimeUtc,
  shippedAt: S.DateTimeUtc,
  trackingNumber: S.String,
})

const CancelledOrder = S.Struct({
  _tag: S.Literal("Cancelled"),
  id: OrderIdSchema,
  cancelledAt: S.DateTimeUtc,
  reason: S.String,
})

const Order = S.Union(PendingOrder, PaidOrder, ShippedOrder, CancelledOrder)
type Order = S.Schema.Type<typeof Order>

// Type-safe state transitions
function shipOrder(
  order: S.Schema.Type<typeof PaidOrder>,
  trackingNumber: string,
): S.Schema.Type<typeof ShippedOrder> {
  return {
    _tag: "Shipped",
    id: order.id,
    items: order.items,
    paidAt: order.paidAt,
    shippedAt: DateTime.unsafeNow(),
    trackingNumber,
  }
}
```

### 8. Domain Events

Events as schema-validated types:

```typescript
const BaseEvent = S.Struct({
  id: EventIdSchema,
  occurredAt: S.DateTimeUtc,
  aggregateId: S.String,
})

class UserCreated extends S.TaggedClass<UserCreated>()("UserCreated", {
  ...BaseEvent.fields,
  payload: S.Struct({
    userId: UserIdSchema,
    email: Email,
    name: S.String,
  }),
}) {}

class UserUpdated extends S.TaggedClass<UserUpdated>()("UserUpdated", {
  ...BaseEvent.fields,
  payload: S.Struct({
    userId: UserIdSchema,
    changes: S.Record({ key: S.String, value: S.Unknown }),
  }),
}) {}

const UserEvent = S.Union(UserCreated, UserUpdated)
type UserEvent = S.Schema.Type<typeof UserEvent>
```

### 9. Session/Message as Domain Objects

For conversational AI:

```typescript
class UserMessage extends S.Class<UserMessage>("UserMessage")({
  role: S.Literal("user"),
  content: S.String,
}) {}

class AssistantMessage extends S.Class<AssistantMessage>("AssistantMessage")({
  role: S.Literal("assistant"),
  content: S.String,
  toolCalls: S.optional(S.Array(ToolCallSchema)),
}) {}

class ToolMessage extends S.Class<ToolMessage>("ToolMessage")({
  role: S.Literal("tool"),
  toolCallId: S.String,
  content: S.String,
}) {}

const Message = S.Union(UserMessage, AssistantMessage, ToolMessage)

class Session extends S.Class<Session>("Session")({
  id: SessionIdSchema,
  messages: S.Array(Message),
  model: S.String,
  createdAt: S.DateTimeUtc,
  updatedAt: S.DateTimeUtc,
}) {}
```

## Schema Composition

```typescript
// Extend existing schema
const AdminUser = S.extend(
  User,
  S.Struct({
    permissions: S.Array(S.String),
    adminSince: S.DateTimeUtc,
  }),
)

// Pick fields
const UserSummary = User.pipe(S.pick("id", "name", "email"))

// Omit fields
const CreateUserInput = User.pipe(S.omit("id", "createdAt", "updatedAt"))

// Make optional
const PartialUser = S.partial(User)
```

## Validation at Boundaries

```typescript
// API input validation
const handler = (req: Request) =>
  Effect.gen(function* () {
    const input = yield* S.decodeUnknown(CreateUserSchema)(req.body)
    return yield* createUser(input)
  })

// Database output validation
const findUser = (id: UserId) =>
  Effect.gen(function* () {
    const row = yield* db.query("SELECT * FROM users WHERE id = ?", [id])
    return yield* S.decodeUnknown(UserSchema)(row)
  })
```

## See Also

- `errors.md` - domain errors (TaggedError)
- `api.md` - using schemas in API definitions
- `boundaries.md` - where schemas live
