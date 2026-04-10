# Monorepo Setup

Effect-native monorepo structure based on TeamWarp/effect-api-example.

## Directory Structure

```
my-app/
├── packages/
│   ├── api/               # API schema definitions (NO runtime code!)
│   │   ├── src/
│   │   │   ├── definition/
│   │   │   │   ├── groups/
│   │   │   │   │   ├── SessionGroup.ts
│   │   │   │   │   ├── UserGroup.ts
│   │   │   │   │   └── HealthGroup.ts
│   │   │   │   ├── middleware/
│   │   │   │   │   └── AuthMiddleware.ts
│   │   │   │   ├── Api.ts
│   │   │   │   └── Pagination.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── shared/            # Branded types & validators
│   │   ├── src/
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── core/              # Business logic (Effect services)
│       ├── src/
│       │   ├── services/
│       │   ├── storage/
│       │   ├── bus/
│       │   └── config/
│       └── package.json
│
├── apps/
│   ├── server/            # HTTP server implementation
│   │   ├── src/
│   │   │   ├── handlers/
│   │   │   ├── middleware/
│   │   │   ├── db/
│   │   │   │   ├── schema/
│   │   │   │   └── migrations/
│   │   │   └── main.ts
│   │   └── package.json
│   │
│   ├── web/               # Web application
│   │   ├── src/
│   │   │   ├── api/
│   │   │   ├── components/
│   │   │   ├── context/
│   │   │   └── app.tsx
│   │   └── package.json
│   │
│   └── tui/               # Terminal UI
│       └── ...
│
├── package.json
├── turbo.json
├── tsconfig.json
└── bunfig.toml
```

## Root package.json

```json
{
  "name": "my-app",
  "private": true,
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "lint": "turbo run lint"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.8.0"
  }
}
```

## turbo.json

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["build"]
    },
    "typecheck": {
      "dependsOn": ["^typecheck"]
    },
    "lint": {}
  }
}
```

## Root tsconfig.json

```json
{
  "compilerOptions": {
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noPropertyAccessFromIndexSignature": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "moduleResolution": "bundler",
    "module": "ESNext",
    "target": "ESNext",
    "lib": ["ESNext"],
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

## packages/api/package.json

```json
{
  "name": "@my-app/api",
  "version": "0.0.1",
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./definition": "./src/definition/index.ts"
  },
  "dependencies": {
    "effect": "^4.0.0"
  }
}
```

## packages/shared/package.json

```json
{
  "name": "@my-app/shared",
  "version": "0.0.1",
  "type": "module",
  "main": "./src/index.ts",
  "dependencies": {
    "effect": "^4.0.0"
  }
}
```

## packages/core/package.json

```json
{
  "name": "@my-app/core",
  "version": "0.0.1",
  "type": "module",
  "main": "./src/index.ts",
  "dependencies": {
    "@my-app/shared": "workspace:*",
    "effect": "^4.0.0"
  }
}
```

## apps/server/package.json

```json
{
  "name": "@my-app/server",
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/main.ts",
    "build": "bun build src/main.ts --outdir dist --target bun",
    "test": "bun test"
  },
  "dependencies": {
    "@my-app/api": "workspace:*",
    "@my-app/core": "workspace:*",
    "@my-app/shared": "workspace:*",
    "@effect/platform-bun": "^0.79.0",
    "@effect/sql": "^0.49.0",
    "@effect/sql-drizzle": "^0.48.0",
    "@effect/sql-pg": "^0.50.0",
    "@effect/opentelemetry": "^0.60.0",
    "effect": "^4.0.0",
    "drizzle-orm": "^0.40.0"
  },
  "devDependencies": {
    "@effect/vitest": "^0.17.0",
    "drizzle-kit": "^0.30.0"
  }
}
```

## apps/web/package.json

```json
{
  "name": "@my-app/web",
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@my-app/api": "workspace:*",
    "@my-app/shared": "workspace:*",
    "effect": "^4.0.0",
    "solid-js": "^1.9.0"
  },
  "devDependencies": {
    "vite": "^6.0.0",
    "vite-plugin-solid": "^2.11.0",
    "tailwindcss": "^4.0.0"
  }
}
```

## Key Separation

| Package | Purpose | Dependencies |
|---------|---------|--------------|
| `packages/api` | Schema-only, shareable | effect |
| `packages/shared` | Branded types | effect |
| `packages/core` | Business logic | shared, effect |
| `apps/server` | HTTP implementation | api, core, shared, @effect/platform-bun |
| `apps/web` | Web UI | api, shared, solid-js |

**Rule**: `packages/api` has NO runtime code - only Schema definitions. Server implements, clients consume via HttpApiClient.
