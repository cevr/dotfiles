# Project Structure

How to organize TypeScript projects from single apps to complex monorepos.

## Decision Tree

```
Project scope?
├─ Single application
│   ├─ Small (< 10 files)      → flat src/
│   └─ Medium/large            → domain folders in src/
├─ Multiple apps, shared code  → monorepo with packages/
└─ Library + examples          → packages/ + apps/ or examples/
```

## Patterns

### 1. Flat Source (Small Projects)

```
project/
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── db.ts
│   └── handlers.ts
├── package.json
└── tsconfig.json
```

**When:** < 10 files, single concern, quick scripts/tools.

### 2. Domain Folders (Single App)

```
project/
├── src/
│   ├── domain/
│   │   ├── users/
│   │   │   ├── schema.ts
│   │   │   ├── service.ts
│   │   │   └── handlers.ts
│   │   └── orders/
│   ├── shared/
│   │   ├── errors.ts
│   │   └── config.ts
│   ├── infra/
│   │   ├── db.ts
│   │   └── http.ts
│   └── main.ts
├── package.json
└── tsconfig.json
```

**When:** Single app with distinct domains. Co-locates related code.

**Pattern from terminal.shop:**

```
src/
├── api/           # HTTP handlers
├── cart/          # Cart domain
├── order/         # Order domain
├── product/       # Product domain
├── subscription/  # Subscription domain
├── common/        # Shared utilities
└── index.ts
```

### 3. Layered Monorepo

```
project/
├── packages/
│   ├── shared/        # Domain types, schemas
│   ├── api/           # API definition (contracts)
│   └── db/            # Database layer
├── apps/
│   ├── server/        # HTTP server
│   ├── worker/        # Background jobs
│   └── cli/           # CLI tool
├── package.json
└── turbo.json         # or nx.json
```

**When:** Multiple apps share code. Clear contracts between layers.

**Pattern from effect-api-example:**

```
packages/
├── api/              # API definition (schemas, endpoints)
│   └── src/definition/
├── shared/           # Domain types (branded IDs, enums)
└── *-config/         # Shared ESLint/TS configs

apps/
└── server/           # Implementation
    └── src/
        ├── api/      # Handler implementations
        ├── db/       # Database layer
        └── main.ts
```

**Key insight:** `packages/api` defines _what_, `apps/server` implements _how_.

### 4. Core + Delivery Pattern

```
project/
├── packages/
│   ├── core/          # Business logic, no I/O
│   ├── ai/            # AI provider abstraction
│   ├── agent/         # Agent runtime
│   └── tui/           # Terminal UI library
├── apps/
│   ├── cli/           # CLI application
│   ├── web/           # Web interface
│   └── bot/           # Chat bot
└── package.json
```

**When:** Same core logic, multiple delivery mechanisms (CLI, web, bot).

**Pattern from pi-mono:**

```
packages/
├── ai/             # Unified LLM API (multi-provider)
├── agent/          # Agent runtime + tools
├── tui/            # Terminal rendering
└── web-ui/         # Web components

apps (as packages)/
├── coding-agent/   # CLI/TUI app
├── mom/            # Slack bot
└── pods/           # Deployment CLI
```

**Build order matters:** `tui → ai → agent → coding-agent`

### 5. Feature Modules (opencode pattern)

```
src/
├── app/
│   ├── conversation.ts
│   ├── session.ts
│   └── message.ts
├── provider/
│   ├── index.ts
│   ├── anthropic.ts
│   ├── openai.ts
│   └── ...
├── tool/
│   ├── index.ts
│   ├── bash.ts
│   ├── edit.ts
│   └── ...
├── tui/
│   ├── app.tsx
│   └── components/
└── index.ts
```

**When:** Clear feature boundaries within single package.

## Tradeoffs Table

| Pattern          | Pros                         | Cons                         |
| ---------------- | ---------------------------- | ---------------------------- |
| Flat source      | Simple, fast iteration       | Doesn't scale                |
| Domain folders   | Co-location, easy navigation | Can become tangled           |
| Layered monorepo | Clear contracts, testable    | Package overhead             |
| Core + delivery  | Reusable logic, multiple UIs | Abstraction cost             |
| Feature modules  | Feature isolation            | Cross-feature deps get messy |

## Package Naming

```
@org/shared       # Shared types/utilities
@org/api          # API definition
@org/db           # Database layer
@org/core         # Business logic
@org/cli          # CLI application
@org/web          # Web application
```

**Convention:** Noun-based, lowercase, describe the layer/domain.

## Workspace Configuration

**pnpm (recommended):**

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
  - "apps/*"
```

**bun:**

```json
// package.json
{
  "workspaces": ["packages/*", "apps/*"]
}
```

## See Also

- `boundaries.md` - import rules between packages
- `services.md` - how packages wire together
- `gotchas.md` - circular dependency pitfalls
