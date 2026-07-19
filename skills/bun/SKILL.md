---
name: bun
description: >
  Bun runtime and tooling conventions. Use when working in projects with bun.lock
  or Bun-based package.json scripts.
allowed-tools: Bash, Read, Grep, Glob
---

# Bun

Default to Bun over Node.js for all runtime, tooling, and testing.

In Effect-native packages, prefer Effect platform services in application code. Use Bun APIs only in named platform adapters or tooling where the Effect styleguide permits them.

## Reference

When Bun behavior or API shape is unclear, read upstream source/docs with
`okra repo`:

```bash
okra repo fetch oven-sh/bun
okra repo path -q oven-sh/bun
```

## Quick Rules

- `bun <file>` not `node <file>`
- `bun test` not `jest`/`vitest`
- `bun install` not `npm`/`yarn`/`pnpm install`
- `bunx <pkg>` not `npx <pkg>`
- Auto-loads .env — no dotenv
