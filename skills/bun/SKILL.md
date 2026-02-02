---
name: bun
description: >
  Bun runtime and tooling conventions. Use when working in projects with bun.lock
  or Bun-based package.json scripts.
allowed-tools: Bash, Read, Grep, Glob
---

# Bun

Default to Bun over Node.js for all runtime, tooling, and testing.

## Reference

Run `primer bun` for the full guide, or drill into topics:

```bash
primer bun              # Overview + quick reference
primer bun runtime      # Bun.file, Bun.$, env
primer bun serve        # Bun.serve(), routes, WebSockets
primer bun data         # SQLite, Redis, Postgres
primer bun testing      # bun test
primer bun frontend     # HTML imports, bundling, HMR
primer bun gotchas      # Node compat gaps
```

## Quick Rules

- `bun <file>` not `node <file>`
- `bun test` not `jest`/`vitest`
- `bun install` not `npm`/`yarn`/`pnpm install`
- `bunx <pkg>` not `npx <pkg>`
- Auto-loads .env — no dotenv
