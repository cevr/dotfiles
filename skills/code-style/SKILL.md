---
name: code-style
description: >
  Code style guidelines for sound, simple, consistent, disciplined, and far-seeing architecture.
  Use when writing new code, reviewing code, or ensuring codebase consistency.
  Invoked automatically by other skills (effect, react, architect) for generated code.
allowed-tools: [Read, Grep, Glob, Edit, Write, Bash, Skill]
---

# Code Style

Guidelines for writing **sound, simple, consistent, disciplined, and far-seeing** code.

## Core Principles

### 1. Soundness
Types make illegal states unrepresentable.
- Prefer discriminated unions over boolean flags or optional fields
- Use Schema.TaggedError for typed errors
- No `any` casts or non-null assertions

### 2. Simplicity
Fewer concepts, fewer moving parts.
- One obvious way to do things
- No unnecessary abstractions
- Less code to maintain

### 3. Consistency
Same patterns throughout.
- If one place uses X, all similar places use X
- Follow established project conventions
- Type imports use `import type { X }` syntax

### 4. Discipline
No shortcuts that create tech debt.
- Fix root causes, not symptoms
- No ESLint violations
- Clean imports, no unused code

### 5. Far-seeing
Consider future readers and maintainers.
- Will this be obvious in 6 months?
- Self-documenting code
- Minimal comments (code should speak for itself)

## Cognitive Cost

Avoid patterns that increase mental overhead:

| Avoid | Prefer | Why |
|-------|--------|-----|
| `x: string \| string[]` | `x: string[]` | Callers must check type before use |
| `{ data?, error?, loading }` | Discriminated union | Impossible states are unrepresentable |
| `enabled?: boolean` | Omit prop, or discriminated union | Unclear what false vs undefined means |
| Mutable state + effects | Derived state from single source | Fewer places for bugs to hide |

## Performance Patterns

Language-agnostic optimizations that reduce computational overhead.

### Early Exit

Return immediately when the result is determined:

```ts
// BAD: Continues checking after finding invalid
function validateAll(items: Item[]): boolean {
  let valid = true;
  for (const item of items) {
    if (!isValid(item)) {
      valid = false;
    }
  }
  return valid;
}

// GOOD: Exit on first failure
function validateAll(items: Item[]): boolean {
  for (const item of items) {
    if (!isValid(item)) return false;
  }
  return true;
}
```

### Combine Iterations

Single loop instead of chained filter/map:

```ts
// BAD: Three iterations over the array
const active = items.filter(x => x.active);
const pending = items.filter(x => x.pending);
const archived = items.filter(x => x.archived);

// GOOD: Single iteration
const active: Item[] = [];
const pending: Item[] = [];
const archived: Item[] = [];

for (const item of items) {
  if (item.active) active.push(item);
  else if (item.pending) pending.push(item);
  else if (item.archived) archived.push(item);
}
```

### Set/Map for Repeated Lookups

O(1) instead of O(n) for membership checks:

```ts
// BAD: O(n) per lookup
const allowedIds = ['a', 'b', 'c'];
items.filter(item => allowedIds.includes(item.id));

// GOOD: O(1) per lookup
const allowedIds = new Set(['a', 'b', 'c']);
items.filter(item => allowedIds.has(item.id));
```

### Pre-build Index Maps

Build once, lookup many times:

```ts
// BAD: O(n) find for each order
orders.map(order => ({
  ...order,
  user: users.find(u => u.id === order.userId)
}));

// GOOD: O(1) lookup after O(n) build
const userMap = new Map(users.map(u => [u.id, u]));
orders.map(order => ({
  ...order,
  user: userMap.get(order.userId)
}));
```

### Cache Pure Function Results

Module-level memoization for repeated calls:

```ts
// BAD: Recalculates on every call
function slugify(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '-');
}

// GOOD: Cache results
const slugCache = new Map<string, string>();

function slugify(text: string): string {
  if (slugCache.has(text)) return slugCache.get(text)!;
  const slug = text.toLowerCase().replace(/\s+/g, '-');
  slugCache.set(text, slug);
  return slug;
}
```

### Hoist Constants

Move static values outside hot paths:

```ts
// BAD: RegExp created on every call
function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// GOOD: RegExp created once
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isEmail(s: string): boolean {
  return EMAIL_RE.test(s);
}
```

**Note:** Avoid global flag (`/g`) on hoisted RegExp—it maintains mutable `lastIndex` state.

### Parallel Async

`Promise.all` for independent operations:

```ts
// BAD: Sequential, 3 round trips
const user = await fetchUser(id);
const posts = await fetchPosts(id);
const comments = await fetchComments(id);

// GOOD: Parallel, 1 round trip
const [user, posts, comments] = await Promise.all([
  fetchUser(id),
  fetchPosts(id),
  fetchComments(id)
]);
```

### Avoid Barrel Imports

Import directly from source files, not index re-exports:

```ts
// BAD: Imports entire library (thousands of modules)
import { Button, Input } from '@ui/components';
import { formatDate } from 'date-fns';

// GOOD: Import specific modules
import { Button } from '@ui/components/Button';
import { Input } from '@ui/components/Input';
import formatDate from 'date-fns/formatDate';
```

Barrel files cause 200-800ms import overhead and defeat tree-shaking. Common offenders: lucide-react, @mui/material, lodash, date-fns, react-icons, @radix-ui/react-*.

## Auto-invoke Skills

Before applying style, detect and invoke relevant skills:
- **Effect files**: Files importing from `effect` or `@effect/*` → invoke `effect` skill
- **React/Solid files**: `.tsx` files → invoke `react` skill
- **Bun projects**: `bun.lock` present → invoke `bun` skill. Prefer Bun APIs over Node.

## Scope Detection

Determine which files to apply style guidelines to:

1. **Default**: Branch changes vs main (`git diff --name-only main...HEAD`)
2. **User-specified**: Files/directories passed as arguments
3. **Fallback**: Staged changes if no branch diff exists

## Workflow

### Phase 1: Analyze

Go back to first principles. Enumerate and document:

- **Features**: What does this code do? What behaviors does it enable?
- **Constraints**: What requirements or invariants must be maintained?
- **Architecture**: How is it structured? What are the key abstractions?

### Phase 2: Apply Style

With the full picture in mind, apply style principles:

#### Targets

- **Code surface area** - less code to maintain
- **Code complexity** - simpler logic, fewer abstractions
- **Duplication** - DRY violations, copy-paste patterns

#### Patterns to Avoid

- Extra comments inconsistent with the rest of the file
- Unnecessary defensive checks or try/catch blocks
- Casts to `any` or non-null assertions to bypass type checking
- Type imports not using `import type { X }` syntax
- Lazy variable reassignments (e.g. `x = newX` instead of refactoring)
- Union types where a single type suffices (e.g. `string | string[]` → `string[]`)
- Optional fields that should be required or use discriminated unions
- ESLint violations

### Phase 3: Lint

After applying style, find and run the project's lint command:

1. Check `package.json` for available lint scripts (e.g., `lint`, `lint:fix`, `lint:app`)
2. Run the appropriate lint command with auto-fix enabled
3. Fix any remaining issues flagged by the linter

## Constraints

- No feature regression
- No performance regression
- No experience regression

## Summary

Report at the end with a 1-3 sentence summary of what you changed.
