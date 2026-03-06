# Async React Patterns

## The `use()` API

Reads values from Promises or Context. Unlike hooks, it CAN be called in conditionals and loops.

```tsx
import { use } from 'react';

function MessageComponent({ messagePromise }) {
  const message = use(messagePromise);  // Suspends until resolved
  const theme = use(ThemeContext);       // Works with context too
}
```

**Rules:** Must be inside a Component or Hook. Cannot be in try-catch (use Error Boundaries). CAN be called conditionally.

**Error handling:**

```tsx
<ErrorBoundary fallback={<p>Error</p>}>
  <Suspense fallback={<p>Loading…</p>}>
    <Message messagePromise={messagePromise} />
  </Suspense>
</ErrorBoundary>

// Or: Promise.catch for fallback value
const messagePromise = fetchMessage().catch(() => "No message found");
```

**Avoiding unnecessary fallbacks** — for cached/settled promises, set `status`/`value`/`reason` fields so React reads synchronously:

```tsx
function preloadData(id) {
  const value = cachedData[id];
  const promise = Promise.resolve(value);
  promise.status = "fulfilled";
  promise.value = value;
  return promise;
}
```

## useTransition

Wrap async operations in transitions to track pending state and keep UI responsive:

```tsx
function Button({ action, children }) {
  const [isPending, startTransition] = useTransition();

  return (
    <button onClick={() => startTransition(async () => { await action(); })} disabled={isPending}>
      {isPending ? <Spinner /> : children}
    </button>
  );
}
```

## useOptimistic

Show UI updates immediately, before async operations complete:

```tsx
function CompleteButton({ complete, action }) {
  const [isPending, startTransition] = useTransition();
  const [optimisticComplete, setOptimisticComplete] = useOptimistic(complete);

  function handleClick() {
    startTransition(async () => {
      setOptimisticComplete(!optimisticComplete);
      await action();
    });
  }

  return <button onClick={handleClick} disabled={isPending}>{optimisticComplete ? '✓' : '○'}</button>;
}
```

## Suspense + Transitions

Suspense fallbacks only show on initial load. Transitions keep showing current content while loading new data:

```tsx
function Home() {
  const [tab, setTab] = useState('all');
  const [isPending, startTransition] = useTransition();

  return (
    <>
      <TabList activeTab={tab} onChange={t => startTransition(() => setTab(t))} />
      {isPending ? <Spinner /> : null}
      <Suspense fallback={<SkeletonList />}>
        <LessonList tab={tab} />
      </Suspense>
    </>
  );
}
```

## Action Prop Pattern

Design components that accept async `action` props and handle transitions internally:

```tsx
function TabList({ activeTab, changeAction, children }) {
  const [optimisticTab, setActiveTab] = useOptimistic(activeTab);
  const isPending = optimisticTab !== activeTab;

  function onTabClick(newTab) {
    startTransition(async () => {
      setActiveTab(newTab);
      await changeAction(newTab);
    });
  }

  return (
    <Tabs value={optimisticTab} onValueChange={onTabClick}>
      <TabsTrigger value="all">All {isPending && optimisticTab === 'all' && <Spinner />}</TabsTrigger>
      {children}
    </Tabs>
  );
}
```

## Suspense-Enabled Data Fetching

Cache promises, revalidate after mutations, prefetch before navigation:

```tsx
let cache = new Map();

export function revalidate() { cache = new Map(); }

export function getData(key) {
  if (!cache.has(key)) {
    cache.set(key, fetch(`/api/data?key=${key}`).then(r => r.json()));
  }
  return cache.get(key);
}

// Prefetch with timeout
export function prefetchData(key) {
  return Promise.race([getData(key), new Promise(r => setTimeout(r, 1000))]);
}
```

## Per-Request Deduplication with React.cache()

```tsx
import { cache } from 'react';

export const getCurrentUser = cache(async () => {
  const res = await fetch('/api/user');
  return res.json();
});
// Multiple components calling getCurrentUser() in the same render share one fetch
```

**Caveat:** Uses `Object.is` for args. Inline objects always miss cache. Use primitives or stable references.

## Eliminate Waterfalls

**Defer await until needed:**

```tsx
// BAD: Always awaits even when skipping
async function handle(userId, skip) {
  const data = await fetchData(userId);
  if (skip) return { skipped: true };
  return process(data);
}

// GOOD: Early return before expensive work
async function handle(userId, skip) {
  if (skip) return { skipped: true };
  const data = await fetchData(userId);
  return process(data);
}
```

**Parallelize independent operations:**

```tsx
// BAD: Sequential — each waits for the previous
const user = await fetchUser();
const config = await fetchConfig();
const posts = await fetchPosts();

// GOOD: Parallel
const [user, config, posts] = await Promise.all([
  fetchUser(), fetchConfig(), fetchPosts()
]);
```

**Dependency-based parallelization** — start independent work immediately, chain dependents:

```tsx
const userPromise = fetchUser();
const configPromise = fetchConfig();
const profilePromise = userPromise.then(u => fetchProfile(u.id));

const [user, config, profile] = await Promise.all([
  userPromise, configPromise, profilePromise
]);
```

## Strategic Suspense Boundaries

Wrap async components in `<Suspense>` so the shell renders immediately while data loads:

```tsx
// BAD: Sequential fetching
export default async function Page() {
  const header = await fetchHeader();
  const sidebar = await fetchSidebar();
  return <div><Header data={header} /><Sidebar data={sidebar} /></div>;
}

// GOOD: Parallel via component composition
export default function Page() {
  return (
    <div>
      <Suspense fallback={<HeaderSkeleton />}><Header /></Suspense>
      <Suspense fallback={<SidebarSkeleton />}><Sidebar /></Suspense>
    </div>
  );
}
```
