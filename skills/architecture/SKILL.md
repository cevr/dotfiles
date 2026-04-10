---
name: architecture
description: >
  Effect-first TypeScript application architecture patterns. Use when designing module
  structure, wiring services/DI, defining error strategies, modeling domain types, designing
  APIs, organizing monorepos, or architecting multi-client applications with shared core logic.
  Covers Context.Service, Layer composition, TaggedErrorClass, Config, Schema.Class, HttpApi, testing,
  auth, storage, event bus, transport, plugins, and client templates (TUI, web, desktop, bot).
  Triggers on "architect", "architecture", "design", "structure", "module layout", "monorepo".
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion, Skill
---

# Architecture Patterns

Effect-first patterns for TypeScript application architecture.

## Core Principles

1. **Schema is source of truth** — types, validation, serialization from Effect Schema
2. **Services are interfaces, layers are implementations** — Context.Service + Layer
3. **Errors are types** — TaggedError with typed error channel
4. **Config fails fast** — invalid config = startup failure
5. **Branded strings everywhere** — monotonic IDs (ULID/KSUID), no integer IDs
6. **Server is single source of truth** — clients are thin presentation adapters

## Navigation

```
What are you doing?
├─ Designing an app from scratch    → §Multi-Client Architecture + patterns/monorepo.md
├─ Organizing a monorepo            → references/structure.md + patterns/monorepo.md
├─ Defining module boundaries       → references/boundaries.md
├─ Wiring up services/DI            → references/services.md
├─ Handling errors                   → references/errors.md
├─ Managing configuration            → references/config.md + patterns/config-layered.md
├─ Modeling domain types             → references/domain.md
├─ Designing APIs                    → references/api.md
├─ Implementing HTTP server          → patterns/http-server.md
├─ Building HTTP client              → patterns/http-client.md
├─ Adding authentication             → patterns/auth.md
├─ Event bus / pub-sub               → patterns/bus.md
├─ Storage / database                → patterns/storage.md
├─ Transport abstraction             → patterns/transport.md
├─ Plugin system                     → patterns/plugins.md
├─ Exhaustive type patterns          → patterns/exhaustive-types.md
├─ UI composition                    → patterns/ui-composition.md
├─ UI state management               → patterns/ui-state.md
├─ Building a TUI client             → clients/tui.md
├─ Building a web client             → clients/web.md
├─ Building a desktop client         → clients/desktop.md
├─ Building a bot integration        → clients/bot.md
├─ Writing tests                     → references/testing.md
├─ Code quality checklist            → reference/code-style.md
└─ Avoiding pitfalls                 → references/gotchas.md
```

## Topic Index

### References (foundational patterns)

| Topic             | File                         | When to Read                              |
| ----------------- | ---------------------------- | ----------------------------------------- |
| Project structure | `references/structure.md`    | Package layout, monorepo patterns         |
| Module boundaries | `references/boundaries.md`   | Import rules, isolation, barrel files     |
| Services & DI     | `references/services.md`     | Context.Service, Layer, test factories, lazy |
| Error handling    | `references/errors.md`       | TaggedError, catchTag, retry, recovery    |
| Configuration     | `references/config.md`       | Effect Config.*, redacted secrets         |
| Domain modeling   | `references/domain.md`       | Schema.Class, branded types, unions       |
| API design        | `references/api.md`          | HttpApi, endpoints, middleware, OpenAPI   |
| Testing           | `references/testing.md`      | Test layers, mocking, fixtures            |
| Common mistakes   | `references/gotchas.md`      | Effect-specific pitfalls                  |

### Patterns (concrete implementations)

| Topic             | File                              | When to Read                           |
| ----------------- | --------------------------------- | -------------------------------------- |
| Auth              | `patterns/auth.md`                | JWT, HttpApiMiddleware, AuthService    |
| Event bus         | `patterns/bus.md`                 | PubSub, SSE streaming, event sourcing |
| Layered config    | `patterns/config-layered.md`      | Multi-source config merge, hot reload  |
| Exhaustive types  | `patterns/exhaustive-types.md`    | assertNever, Match, discriminated      |
| HTTP client       | `patterns/http-client.md`         | HttpApiClient, SolidJS context         |
| HTTP server       | `patterns/http-server.md`         | HttpApiBuilder, server wiring          |
| Monorepo          | `patterns/monorepo.md`            | package.json, tsconfig, turbo.json     |
| Plugins           | `patterns/plugins.md`             | Plugin interface, hook types           |
| Storage           | `patterns/storage.md`             | Drizzle, repository pattern, SQL       |
| Transport         | `patterns/transport.md`           | Protocol-agnostic event protocol       |
| UI composition    | `patterns/ui-composition.md`      | Provider, compound components          |
| UI state          | `patterns/ui-state.md`            | Union state, derived values, URL state |

### Clients (implementation templates)

| Client  | File              | When to Read                   |
| ------- | ----------------- | ------------------------------ |
| TUI     | `clients/tui.md`  | Terminal UI with @opentui      |
| Web     | `clients/web.md`  | SolidJS with HttpApiClient     |
| Desktop | `clients/desktop.md` | Tauri integration           |
| Bot     | `clients/bot.md`  | Slack/Discord/webhook adapters |

## Quick Decision Trees

```
Defining a service?
├─ Simple value/config          → Layer.succeed
├─ Lazy initialization          → Layer.sync
├─ Async initialization         → Layer.effect (auto-strips Scope in v4)
├─ Resource with cleanup        → Layer.effect (Scope auto-handled)
└─ From existing service        → Layer.effect + yield* dep

Error handling strategy?
├─ Domain/business error        → Schema.TaggedErrorClass
├─ Handle specific error        → Effect.catchTag
├─ Handle multiple errors       → Effect.catchTags
├─ Retry on failure             → Effect.retry + Schedule
└─ Let defects crash            → don't catch them

Modeling a type?
├─ ID (any kind)                → branded string
├─ Constrained value            → Schema with refinements
├─ Serializable data            → Schema.Class
├─ Union of states              → Schema.Union (tagged)
└─ Error type                   → Schema.TaggedError

API endpoint?
├─ Single endpoint              → HttpApiEndpoint.*
├─ Group of endpoints           → HttpApiGroup.make
├─ Full API                     → HttpApi.make
└─ Add authentication           → HttpApiMiddleware.Tag
```

## Multi-Client Architecture

For applications needing multiple clients (TUI, web, desktop, mobile, bot):

```
┌─────────────────────────────────────────┐
│         UI LAYER (Multiple Clients)     │
│   TUI / Web / Desktop / Mobile / Bot    │
└────────────────┬────────────────────────┘
                 │
        HTTP REST + SSE/WebSocket
                 │
┌────────────────▼────────────────────────┐
│         API LAYER (Effect HttpApi)      │
│   HttpApiBuilder / HttpLayerRouter      │
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│         CORE BUSINESS LOGIC             │
│   Effect Services / Layers / Storage    │
└─────────────────────────────────────────┘
```

### Technology Stack

| Layer | Technology |
|-------|------------|
| Runtime | Bun |
| Monorepo | Bun workspaces (simple) or Turborepo (complex) |
| Core Logic | Effect |
| Platform | @effect/platform-bun |
| Validation | @effect/schema |
| HTTP Server | @effect/platform HttpApi |
| HTTP Client | HttpApiClient (auto-generated) |
| Database | @effect/sql + Drizzle |
| Web UI | SolidJS |
| TUI | @opentui/solid |
| Desktop | Tauri |
| Testing | @effect/vitest |
| CLI | @effect/cli |
| Binary | `bun build --compile` |

### Generation Workflow

When asked to architect a multi-client app:

1. **Gather requirements** — app type, target clients, real-time needs, domain entities, database, constraints
2. **Generate architecture** — package structure, data flow, Effect services, file tree
3. **Generate code** — `packages/api` (HttpApi schemas), `packages/core` (services), `apps/server`, `apps/web`, `apps/tui`
4. **Verify** — `bun install`, migrations, `bun run dev`, `bun test`

## Key Imports

```typescript
// v4 imports
import { Effect, Layer, Context, Config, Schema as S } from "effect"
import {
  HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup,
  HttpApiMiddleware, HttpApiSchema, HttpApiSecurity,
} from "effect/unstable/httpapi"
import { HttpClient, HttpServer } from "effect/unstable/http"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
```
