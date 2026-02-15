---
name: react
description: React best practices for state management, composition patterns, async patterns (use, useTransition, useOptimistic, Suspense), performance optimization, and avoiding common pitfalls. Use when writing React components, managing state, handling async operations, or structuring component hierarchies.
allowed-tools: Read, Grep, Glob, Edit, Write
---

# React Best Practices

## Navigation

```
What are you working on?
├─ Component has too many boolean props    → §1 Composition
├─ State management / where to put state   → §2 State
├─ Async operations / loading / optimistic → §3 Async Patterns
├─ Slow renders / unnecessary re-renders   → §4 Performance
├─ Bundle size / code splitting            → §5 Bundle
├─ Event listeners / subscriptions         → §6 Events
└─ Data fetching / waterfalls              → §3 + §7 Async Perf
```

---

## 1. Composition Over Configuration

Avoid monolithic components with boolean props. Use composition with compound components and injectable context.

### Boolean Prop Explosion → Explicit Variants

Each boolean doubles possible states. Five booleans = 32 branches to reason about.

```tsx
// BAD: Monolithic component with flags
<Composer isThread isEditing={false} showAttachments channelId="abc" />

// GOOD: Explicit variant components
<ThreadComposer channelId="abc" />
<EditComposer messageId="123" />
```

### Compound Components

Structure complex UIs as composable subcomponents with shared context:

```tsx
const Composer = {
  Provider: ComposerProvider,
  Frame: ComposerFrame,
  Input: ComposerInput,
  DropZone: ComposerDropZone,
  Submit: ComposerSubmit,
}

// Usage: render to opt-in
function ChannelComposer() {
  return (
    <Composer.Provider state={state} actions={actions}>
      <Composer.Frame>
        <Composer.Input />
        <Composer.DropZone /> {/* Just render to enable */}
        <Composer.Submit />
      </Composer.Frame>
    </Composer.Provider>
  );
}
```

### Generic Context Interface

Three-part contract: `state`, `actions`, `meta`. Any provider can implement it.

```tsx
interface ComposerContextValue {
  state: { input: string; attachments: File[]; isSubmitting: boolean }
  actions: { update: (text: string) => void; submit: () => void }
  meta: { inputRef: RefObject<HTMLTextAreaElement> }
}
```

### Decouple State From UI

Provider defines how state is managed. UI components only consume the interface. Different providers, same UI:

```tsx
// Local state provider
function LocalComposerProvider({ children }: { children: React.ReactNode }) {
  const [text, setText] = useState('');
  return (
    <ComposerContext value={{ state: { input: text }, actions: { update: setText, submit: () => {} } }}>
      {children}
    </ComposerContext>
  );
}

// Synced state provider — same UI, different backing store
function SyncedComposerProvider({ children }: { children: React.ReactNode }) {
  const { text, updateText, submit } = useSyncedComposer();
  return (
    <ComposerContext value={{ state: { input: text }, actions: { update: updateText, submit } }}>
      {children}
    </ComposerContext>
  );
}
```

### Lift Provider for Flexible Layouts

Components outside the main UI but inside the provider can access state/actions:

```tsx
function ForwardMessageModal() {
  return (
    <ForwardMessageProvider>
      <ComposerUI />
      <MessagePreview /> {/* Accesses composer state via context */}
      <div className="modal-footer">
        <ForwardButton /> {/* Can call submit() from context */}
      </div>
    </ForwardMessageProvider>
  );
}
```

### React 19 API Changes

- `ref` is a regular prop — no `forwardRef` wrapper needed
- `use(MyContext)` replaces `useContext(MyContext)` — can be called conditionally

---

## 2. State Management

### You Might Not Need an Effect

Effects are for **synchronizing with external systems**. Most other uses are antipatterns.

```tsx
// BAD: useEffect to derive state
const [fullName, setFullName] = useState('');
useEffect(() => setFullName(first + ' ' + last), [first, last]);

// GOOD: Calculate during render
const fullName = first + ' ' + last;
```

```tsx
// BAD: useEffect to reset state on prop change
useEffect(() => setComment(''), [userId]);

// GOOD: Use key to reset entire component
<Profile userId={userId} key={userId} />
```

```tsx
// BAD: Effect triggered by event
const [submitted, setSubmitted] = useState(false);
useEffect(() => { if (submitted) post('/api/submit', data); }, [submitted]);

// GOOD: Logic in event handler
function handleSubmit() {
  post('/api/submit', data);
  showNotification('Submitted!');
}
```

**When effects ARE appropriate:** Subscriptions (WebSocket, event listeners), syncing with non-React widgets (maps, video players), analytics on page view.

### You Might Not Need State

Prefer computing values and using the platform.

**Compute over store:**

```tsx
// BAD
const [totalPrice, setTotalPrice] = useState(0);
useEffect(() => setTotalPrice(items.reduce((s, i) => s + i.price, 0)), [items]);

// GOOD
const totalPrice = items.reduce((sum, item) => sum + item.price, 0);
```

**Expensive computations — useMemo:**

```tsx
const visibleTodos = useMemo(() => getFilteredTodos(todos, filter), [todos, filter]);
```

**Use the platform — FormData over controlled inputs:**

```tsx
// GOOD: Uncontrolled with FormData
function ContactForm() {
  return (
    <form onSubmit={e => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      submit(Object.fromEntries(fd));
    }}>
      <input name="name" required />
      <input name="email" type="email" required />
      <button type="submit">Send</button>
    </form>
  );
}
```

**Use the platform — URL state:**

```tsx
// BAD: Local state (lost on refresh/share)
const [filter, setFilter] = useState('all');

// GOOD: URL state with nuqs (typed, validated, shareable)
import { parseAsStringEnum, useQueryState } from 'nuqs';
const [filter, setFilter] = useQueryState('filter',
  parseAsStringEnum(['all', 'active', 'completed']).withDefault('all')
);
```

**When you DO need state:** Controlled inputs (real-time validation, masking), optimistic updates, multi-step forms, animations.

### Union State Modeling

Prefer discriminated unions over multiple booleans.

```tsx
// BAD: Multiple booleans create impossible states
const [isLoading, setIsLoading] = useState(false);
const [isError, setIsError] = useState(false);
const [data, setData] = useState<Data | null>(null);

// GOOD: Discriminated union
type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: Data }
  | { status: 'error'; error: Error };

const [state, setState] = useState<State>({ status: 'idle' });

switch (state.status) {
  case 'idle': return <button onClick={fetch}>Load</button>;
  case 'loading': return <Spinner />;
  case 'success': return <DataView data={state.data} />;
  case 'error': return <ErrorView error={state.error} />;
}
```

### State Colocation

Keep state as close to where it's used as possible.

**Extract components with their own state** to prevent parent re-renders:

```tsx
// BAD: Search state causes entire list to re-render
function ProductPage() {
  const [search, setSearch] = useState('');
  return (
    <div>
      <input value={search} onChange={e => setSearch(e.target.value)} />
      <ExpensiveProductList products={products} />
    </div>
  );
}

// GOOD: Search input is its own component
function SearchInput({ onSearch }: { onSearch: (q: string) => void }) {
  const [search, setSearch] = useState('');
  return <input value={search} onChange={e => { setSearch(e.target.value); onSearch(e.target.value); }} />;
}
```

**State location hierarchy:**

1. **Local state** — default. `useState` in the component that uses it.
2. **Lifted state** — siblings need to share. Lift to nearest common parent.
3. **Context** — distant components need access. Provider pattern.
4. **External store** — persist across routes or sync externally.

### Functional setState Updates

When next state depends on current state, use updater functions to avoid stale closures:

```tsx
// BAD: Stale closure in async
setItems([...items, ...newItems]);

// GOOD: Always reads current state
setItems(curr => [...curr, ...newItems]);
```

---

## 3. Async React Patterns

### The `use()` API

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

### useTransition

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

### useOptimistic

Show UI updates immediately, before async operations complete:

```tsx
function CompleteButton({ complete, action }) {
  const [optimisticComplete, setOptimisticComplete] = useOptimistic(complete);

  function handleClick() {
    startTransition(async () => {
      setOptimisticComplete(!optimisticComplete);
      await action();
    });
  }

  return <button onClick={handleClick}>{optimisticComplete ? '✓' : '○'}</button>;
}
```

### Suspense + Transitions

Suspense fallbacks only show on initial load. Transitions keep showing current content while loading new data:

```tsx
function Home() {
  const [tab, setTab] = useState('all');

  return (
    <>
      <TabList activeTab={tab} onChange={t => startTransition(() => setTab(t))} />
      <Suspense fallback={<SkeletonList />}>
        <LessonList tab={tab} />
      </Suspense>
    </>
  );
}
```

### Action Prop Pattern

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

### Suspense-Enabled Data Fetching

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

### Per-Request Deduplication with React.cache()

```tsx
import { cache } from 'react';

export const getCurrentUser = cache(async () => {
  const res = await fetch('/api/user');
  return res.json();
});
// Multiple components calling getCurrentUser() in the same render share one fetch
```

**Caveat:** Uses `Object.is` for args. Inline objects always miss cache. Use primitives or stable references.

---

## 4. Performance

### Re-render Optimization

**Lazy state initialization:**

```tsx
// BAD: Expensive call runs every render
const [data, setData] = useState(parseLocalStorage());

// GOOD: Function runs only on initial render
const [data, setData] = useState(() => parseLocalStorage());
```

**Extract to memoized components** to enable early returns:

```tsx
const Avatar = memo(function Avatar({ user }) {
  const avatar = generateAvatar(user);
  return <img src={avatar} />;
});

function UserCard({ user, loading }) {
  if (loading) return <Skeleton />;
  return <div><Avatar user={user} /></div>;
}
```

**Subscribe to derived state, not continuous values:**

```tsx
// BAD: Re-renders on every pixel
const { width } = useWindowSize();
const isMobile = width < 768;

// GOOD: Re-renders only on threshold cross
const isMobile = useMediaQuery('(max-width: 767px)');
```

**Narrow effect dependencies — use primitives, not objects:**

```tsx
// BAD: Runs when any user property changes
useEffect(() => fetchUserData(user.id), [user]);

// GOOD: Runs only when id changes
useEffect(() => fetchUserData(user.id), [user.id]);
```

**Defer state reads — read on-demand instead of subscribing:**

```tsx
// BAD: Re-renders on every searchParams change
function ShareButton() {
  const [searchParams] = useSearchParams();
  return <button onClick={() => share(searchParams.get('id'))}>Share</button>;
}

// GOOD: Read on-demand, no subscription
function ShareButton() {
  return <button onClick={() => share(new URLSearchParams(location.search).get('id'))}>Share</button>;
}
```

**Use transitions for non-urgent updates:**

```tsx
// Scroll tracking without blocking input
const onScroll = (e) => startTransition(() => setScrollY(e.target.scrollTop));
```

**Use refs for transient values** (mouse position, scroll tracking, intervals):

```tsx
const scrollYRef = useRef(0);
const onScroll = (e) => { scrollYRef.current = e.target.scrollTop; };
// Mutate DOM directly — no re-renders
```

### Rendering Optimization

**Hoist static JSX** to module scope:

```tsx
const icon = (
  <svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z" /></svg>
);

function Icon({ active }) {
  return active ? icon : null;
}
```

**Explicit conditional rendering** — ternary when condition can be `0` or `NaN`:

```tsx
// BAD: Renders "0" when count is 0
{count && <Badge count={count} />}

// GOOD
{count > 0 ? <Badge count={count} /> : null}
```

**Activity component** — preserve state/DOM when toggling visibility:

```tsx
// BAD: Unmounts, loses state
{isVisible && <ExpensiveEditor />}

// GOOD: State preserved, DOM hidden
<Activity mode={isVisible ? 'visible' : 'hidden'}>
  <ExpensiveEditor />
</Activity>
```

**CSS content-visibility** for long lists without full virtualization:

```css
.list-item {
  content-visibility: auto;
  contain-intrinsic-size: 0 80px;
}
```

### Extract Default Non-Primitives to Constants

Inline functions/objects in props break `memo()`:

```tsx
// BAD: New function ref every render, defeats memo
<MemoizedButton onClick={() => {}} />

// GOOD: Stable reference
const NOOP = () => {};
<MemoizedButton onClick={NOOP} />
```

### Initialize App Once

Module-level guard for effects that should run once globally, not per mount:

```tsx
let didInit = false;

function App() {
  useEffect(() => {
    if (didInit) return;
    didInit = true;
    initAnalytics();
    loadFeatureFlags();
  }, []);
}
```

---

## 5. Bundle Optimization

### Dynamic Imports for Heavy Components

```tsx
const Editor = lazy(() => import('@monaco-editor/react'));

function CodeEditor() {
  return (
    <Suspense fallback={<EditorSkeleton />}>
      <Editor />
    </Suspense>
  );
}
```

### Avoid Barrel File Imports

Barrel files (`index.js` with `export *`) pull in thousands of unused modules:

```tsx
// BAD: Imports entire library
import { Check, X } from 'lucide-react';

// GOOD: Direct import
import Check from 'lucide-react/dist/esm/icons/check';
import X from 'lucide-react/dist/esm/icons/x';
```

### Preload on User Intent

Warm the cache before the user clicks:

```tsx
<button
  onMouseEnter={() => void import('./HeavyModal')}
  onClick={() => setShowModal(true)}
>
  Open
</button>
```

---

## 6. Event Handling Patterns

### Store Event Handlers in Refs

Stable subscriptions without re-adding listeners:

```tsx
function useKeyboard(handler: (e: KeyboardEvent) => void) {
  const handlerRef = useRef(handler);
  useEffect(() => { handlerRef.current = handler; });

  useEffect(() => {
    const listener = (e: KeyboardEvent) => handlerRef.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
}
```

### useLatest for Stable Callbacks

```tsx
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => { ref.current = value; });
  return ref;
}

function Search({ onSearch }) {
  const onSearchRef = useLatest(onSearch);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => onSearchRef.current(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  return <input value={query} onChange={e => setQuery(e.target.value)} />;
}
```

### Deduplicate Global Event Listeners

Single listener shared across component instances:

```tsx
const callbacks = new Map<string, Set<(e: KeyboardEvent) => void>>();

function subscribe(key: string, cb: (e: KeyboardEvent) => void) {
  if (!callbacks.has(key)) callbacks.set(key, new Set());
  callbacks.get(key)!.add(cb);
  return () => { callbacks.get(key)!.delete(cb); };
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    callbacks.forEach(set => set.forEach(cb => cb(e)));
  });
}

function useKeydown(key: string, handler: (e: KeyboardEvent) => void) {
  useEffect(() => subscribe(key, handler), [key, handler]);
}
```

### Passive Event Listeners

Use `{ passive: true }` on `touchstart`/`wheel` to enable immediate scrolling. Don't use when you need `preventDefault()`.

---

## 7. Async Performance

### Eliminate Waterfalls

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

### Strategic Suspense Boundaries

Wrap async components in `<Suspense>` so the shell renders immediately while data loads. Make parent non-async and let children each fetch independently:

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
