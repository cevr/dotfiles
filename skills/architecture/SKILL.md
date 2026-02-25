---
name: architecture
description: Effect-first TypeScript application architecture patterns. Use when designing module structure, wiring services/DI, defining error strategies, modeling domain types, designing APIs, or organizing monorepos. Covers Context.Tag, Layer composition, TaggedError, Config, Schema.Class, HttpApi, and testing patterns.
---

# Architecture Patterns

Effect-first patterns for TypeScript application architecture.

## Core Principles

1. **Schema is source of truth** — types, validation, serialization from Effect Schema
2. **Services are interfaces, layers are implementations** — Context.Tag + Layer
3. **Errors are types** — TaggedError with typed error channel
4. **Config fails fast** — invalid config = startup failure
5. **Branded strings everywhere** — monotonic IDs (ULID/KSUID), no integer IDs

## Navigation

```
Building something?
├─ Organizing a monorepo        → references/structure.md
├─ Defining module boundaries   → references/boundaries.md
├─ Wiring up services/DI        → references/services.md
├─ Handling errors              → references/errors.md
├─ Managing configuration       → references/config.md
├─ Modeling domain types        → references/domain.md
├─ Designing APIs               → references/api.md
├─ Writing tests                → references/testing.md
└─ Avoiding pitfalls            → references/gotchas.md
```

## Topic Index

| Topic             | File                         | When to Read                         |
| ----------------- | ---------------------------- | ------------------------------------ |
| Project structure | `references/structure.md`    | Setting up monorepo, package layout  |
| Module boundaries | `references/boundaries.md`   | Deciding import rules, isolation     |
| Services & DI     | `references/services.md`     | Context.Tag, Layer composition       |
| Error handling    | `references/errors.md`       | TaggedError, catchTag, recovery      |
| Configuration     | `references/config.md`       | Config.*, redacted secrets           |
| Domain modeling   | `references/domain.md`       | Schema.Class, branded types          |
| API design        | `references/api.md`          | HttpApi, endpoints, middleware       |
| Testing           | `references/testing.md`      | Test layers, mocking                 |
| Common mistakes   | `references/gotchas.md`      | Effect-specific pitfalls             |

## Quick Decision Trees

```
Defining a service?
├─ Simple value/config          → Layer.succeed
├─ Lazy initialization          → Layer.sync
├─ Async initialization         → Layer.effect
├─ Resource with cleanup        → Layer.scoped
└─ From existing service        → Layer.effect + yield* dep

Error handling strategy?
├─ Domain/business error        → Schema.TaggedError
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

## Key Imports

```typescript
import { Effect, Layer, Context, Config, Schema as S } from "effect"
import {
  HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup,
  HttpApiMiddleware, HttpApiSchema, HttpApiSecurity,
} from "@effect/platform"
import { NodeRuntime, NodeHttpServer } from "@effect/platform-node"
```
