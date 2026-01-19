---
name: architect
description: >
  Design and generate multi-client application architectures with shared core logic.
  Use when asked to architect, design, or structure an application that needs multiple
  clients (TUI, web, desktop, mobile, bots) sharing common business logic. Ideal for
  AI agents, SaaS apps, developer tools, and any project needing consistent behavior
  across platforms. Uses Effect TypeScript for core logic.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion, Skill
---

# Architect Skill

Design multi-client TypeScript applications with shared core logic using Effect.

## When This Skill Applies

- User asks to "architect", "design", or "structure" an application
- Project needs multiple clients (TUI, web, desktop, mobile, bot)
- Building AI agents, SaaS apps, or developer tools
- Need to share business logic across different interfaces

## Core Architecture

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

**Principle:** Server is single source of truth. Clients are thin presentation adapters.

## Integrated Skills

Before generating code, invoke these skills for their patterns:

1. **Effect skill** (`/effect`) - Core business logic:
   - `effect-solutions show services-and-layers`
   - `effect-solutions show error-handling`
   - `effect-solutions show data-modeling`

2. **React skill** - UI layer patterns (applies to Solid too):
   - Composition over configuration
   - Union state modeling
   - No effect antipatterns

3. **Code-style skill** (`/code-style`) - Code quality:
   - Soundness, simplicity, consistency
   - Disciplined, far-seeing architecture

## Workflow

### Step 1: Gather Requirements

Ask about:
- **Application type**: AI agent, SaaS, utility, developer tool, etc.
- **Target clients**: TUI, web, desktop, mobile, bot
- **Real-time needs**: SSE, WebSocket, polling
- **Domain entities**: Users, sessions, projects, etc.
- **Database**: SQLite, PostgreSQL, in-memory
- **Existing code**: Constraints or patterns to follow

### Step 2: Generate Architecture

Create:
- Package structure diagram
- Data flow diagram (server is source of truth)
- Key Effect services and their Layer dependencies
- File structure with paths

### Step 3: Generate Code

Create working code using:
- **packages/api**: HttpApi schema definitions (no runtime code)
- **packages/shared**: Branded types, validators
- **packages/core**: Effect services, layers, storage
- **apps/server**: HttpApiBuilder implementations, BunHttpServer
- **apps/web**: SolidJS with HttpApiClient
- **apps/tui**: @opentui/solid or similar

### Step 4: Verify

Provide commands to:
- `bun install` - Install dependencies
- Database migrations if needed
- `bun run dev` - Start server
- `bun run --cwd apps/web dev` - Start web client
- `bun test` - Run tests

## Technology Stack

| Layer | Technology |
|-------|------------|
| Runtime | Bun |
| Monorepo | Bun workspaces (simple) or Turborepo (complex builds) |
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
| Process | `Bun.spawn` (prefer over node:child_process) |

## Quick Reference

See supporting files for detailed patterns:

**Core Patterns:**
- [Monorepo Setup](patterns/monorepo.md)
- [Effect Services](patterns/effect-services.md)
- [Effect Errors](patterns/effect-errors.md)
- [Event Bus](patterns/bus.md)
- [Transport Abstraction](patterns/transport.md)
- [Storage & Database](patterns/storage.md)
- [Authentication](patterns/auth.md)
- [Layered Config](patterns/config.md)
- [Plugin System](patterns/plugins.md)
- [Exhaustive Types](patterns/exhaustive-types.md)

**HTTP Patterns:**
- [HttpApi Schema](patterns/http-api.md)
- [HttpApiBuilder Server](patterns/http-server.md)
- [HttpApiClient](patterns/http-client.md)

**UI Patterns:**
- [Composition](patterns/ui-composition.md)
- [State Management](patterns/ui-state.md)

**Client Templates:**
- [TUI Client](clients/tui.md)
- [Web Client](clients/web.md)
- [Desktop Client](clients/desktop.md)
- [Bot Integration](clients/bot.md)

**Reference:**
- [OpenCode Patterns](reference/opencode.md)
- [Effect API Example](reference/effect-api-example.md)
- [Code Style](reference/code-style.md)
