---
name: react
description: React best practices for state management, composition patterns, state modeling (discriminated unions, reducers, state machines), async patterns (use, useTransition, useOptimistic, Suspense), performance optimization, and avoiding common pitfalls. Use when writing React components, managing state, handling async operations, or structuring component hierarchies.
allowed-tools: Read, Grep, Glob, Edit, Write
---

# React Best Practices

## Navigation

```
What are you working on?
├─ Too many boolean props / component API     → references/composition.md
├─ State modeling / booleans / state machines  → references/state-modeling.md
├─ State management / where to put state      → references/state.md
├─ Async / loading / optimistic / Suspense    → references/async.md
├─ Slow renders / re-renders / bundle size    → references/performance.md
├─ Event listeners / subscriptions            → references/events.md
└─ Data fetching / waterfalls                 → references/async.md §Eliminate Waterfalls
```

## Topic Index

| Topic | File | When to Read |
|-------|------|--------------|
| Composition | `references/composition.md` | Boolean prop explosion, compound components, render props, providers, React 19 |
| State modeling | `references/state-modeling.md` | Discriminated unions, useReducer, transition guards, state machines |
| State management | `references/state.md` | useEffect abuse, unnecessary state, URL state, colocation, functional setState |
| Async patterns | `references/async.md` | use(), useTransition, useOptimistic, Suspense, caching, waterfalls |
| Performance | `references/performance.md` | Re-renders, memo, refs, hydration, SVG, bundle, JS patterns |
| Events | `references/events.md` | Handler refs, useLatest, dedup listeners, passive events |

## Quick Rules

### Composition
- No boolean props — explicit variant components with their own providers
- `children` over render props — except when parent passes data to child
- Compound components with shared context (`state` / `actions` / `meta`)
- Decouple state from UI — swappable providers, same consumer components

### State Modeling
- No boolean explosions — discriminated unions with `status` discriminant
- `useReducer` once state has 3+ related fields or transitions depend on current state
- Guard transitions — not every action is valid in every state
- Name actions after events (`'submitted'`), not setters (`'set_loading'`)

### State Management
- Compute during render, don't `useEffect` to derive state
- Use the platform: FormData, URL state (`nuqs`), `key` prop to reset
- Colocate state: local → lifted → context → external store
- Functional `setState` when next state depends on current

### Async
- `use()` for promises and context — can be called conditionally
- `useTransition` over manual `isLoading` state — auto-resets on error
- React 19: `useOptimistic` for instant UI feedback during mutations
- Suspense fallbacks for initial load, transitions for subsequent

### Performance
- `useState(() => init)` not `useState(init)` for expensive initialization
- `memo()` extracted component > `useMemo` inside parent with early return
- Refs + direct DOM mutation for high-frequency values (mouse, scroll)
- Don't `useMemo` simple expressions — inline boolean OR is cheaper
- Don't define components inside components — remounts on every parent render
- Barrel files pull everything — use direct imports
- `.toSorted()` not `.sort()` on prop arrays
- `suppressHydrationWarning` for dates/random IDs; inline script for theme
- Cache repeated function results in module-level Maps, not hooks
- Cache `localStorage`/`sessionStorage` reads — synchronous I/O is expensive
- Combine multiple `.filter()` into a single loop
- Check `.length` before expensive array comparisons — O(1) bail-out
- Loop for min/max, not `.sort()` — O(n) vs O(n log n)

### Events
- Store handlers in refs for stable subscriptions
- Deduplicate global listeners with shared registry
- `{ passive: true }` on scroll/touch unless you need `preventDefault()`

## Gotchas

- `{count && <Badge />}` renders `"0"` — use `count > 0 ? <Badge /> : null`
- `useEffect` to sync state up = code smell — lift to provider instead
- `stateRef` hack for submit-time reads = loses reactivity — lift to provider
- Animate `<div>` wrapper not `<svg>` directly — GPU acceleration
- `React.cache()` uses `Object.is` — inline objects always miss
- React 19: `forwardRef` unnecessary — `ref` is a regular prop
- Global regex (`/g`) has mutable `lastIndex` — alternating `.test()` calls flip true/false
