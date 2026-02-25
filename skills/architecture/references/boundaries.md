# Module Boundaries

Rules for imports, isolation, and preventing dependency tangles.

## Core Rule

**Imports flow one direction: definition → implementation, never reverse.**

```
shared/types    ← api/definition  ← server/handlers
     ↑                ↑                   ↑
   (types)        (contracts)      (implementation)
```

## Decision Tree

```
Where should this code live?
├─ Used by multiple packages     → shared/
├─ Defines API contract          → api/definition/
├─ Implements API handlers       → server/api/
├─ Database queries              → server/db/ or db/
├─ Domain logic (no I/O)         → core/ or domain/
└─ Utility, single package       → local utils.ts
```

## Boundary Patterns

### 1. Package Isolation

Each package has explicit public API via `index.ts`:

```typescript
// packages/shared/src/index.ts
export { UserId, UserIdSchema } from "./user"
export { OrderId, OrderStatus } from "./order"
export type { Config } from "./config"
```

**Rule:** Other packages import from package root, never internal paths.

```typescript
// Good
import { UserId } from "@org/shared"

// Bad - reaches into internals
import { UserId } from "@org/shared/src/user"
```

### 2. Definition vs Implementation

**API definition package** (contracts only):

```
packages/api/src/
├── definition/
│   ├── WarpApi.ts           # API composition
│   ├── groups/
│   │   ├── HealthGroup.ts   # Endpoint schemas
│   │   └── UsersGroup.ts
│   ├── middleware/
│   │   └── AuthMiddleware.ts # Middleware types
│   └── errors.ts            # Error schemas
└── index.ts
```

**Server implementation** (handlers):

```
apps/server/src/
├── api/
│   ├── groups/
│   │   ├── HealthGroupLive.ts   # Handler impl
│   │   └── UsersGroupLive.ts
│   └── middleware/
│       └── AuthMiddlewareLive.ts
├── db/
└── main.ts
```

**Import direction:**

```typescript
// server/api/groups/UsersGroupLive.ts
import { UsersGroup, UserNotFoundError } from "@org/api" // ✓ definition
import { UserId } from "@org/shared" // ✓ shared types

// packages/api - NEVER imports from server
```

### 3. Namespace Aggregates

Group related exports under namespaces:

```typescript
// packages/shared/src/user/index.ts
import * as Schema from "./schema"
import * as Queries from "./queries"
import * as Commands from "./commands"

export { Schema, Queries, Commands }

// Usage
import { User } from "@org/shared"
User.Schema.UserIdSchema
User.Queries.findById
User.Commands.create
```

**When:** Domain has schema + queries + commands that belong together.

### 4. Layered Imports

Enforce layer hierarchy:

```
Layer 0: shared/        # Types, schemas (no deps)
Layer 1: api/           # Contracts (depends on shared)
Layer 2: db/            # Data access (depends on shared)
Layer 3: server/        # Implementation (depends on all above)
```

**Rule:** Lower layers never import from higher layers.

```typescript
// shared/ - imports nothing from project
// api/ - imports from shared/
// db/ - imports from shared/
// server/ - imports from api/, db/, shared/
```

### 5. Cross-Cutting Concerns

Place shared infrastructure at appropriate layer:

```
shared/
├── errors.ts      # Base error types
├── config.ts      # Config schema
└── logging.ts     # Logger interface

api/
├── errors.ts      # API-specific errors (extend shared)
└── middleware/    # Middleware types
```

**Pattern:** Define interface in shared, implement in higher layer.

## Import Rules Enforcement

### TypeScript Path Aliases

```json
// tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "@org/shared": ["./packages/shared/src"],
      "@org/api": ["./packages/api/src"]
    }
  }
}
```

### ESLint Import Boundaries

```javascript
// eslint.config.js
{
  rules: {
    'import/no-restricted-paths': ['error', {
      zones: [{
        target: './packages/shared',
        from: './packages/api'
      }, {
        target: './packages/api',
        from: './apps/server'
      }]
    }]
  }
}
```

## Barrel Files

**index.ts pattern:**

```typescript
// Explicit exports (preferred)
export { UserId, UserIdSchema } from "./user"
export { OrderId } from "./order"

// Namespace re-export
export * as User from "./user"
export * as Order from "./order"
```

**Avoid:** `export * from './everything'` - hides what's public.

## Tradeoffs

| Approach                 | Pros              | Cons               |
| ------------------------ | ----------------- | ------------------ |
| Strict package isolation | Clear boundaries  | More boilerplate   |
| Namespace aggregates     | Organized imports | Extra abstraction  |
| Layer enforcement        | Prevents tangles  | Rigidity           |
| Barrel files             | Clean imports     | Can hide internals |

## See Also

- `structure.md` - package organization
- `services.md` - how services cross boundaries
- `gotchas.md` - circular dependency issues
