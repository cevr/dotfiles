# Performance

## Re-render Optimization

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

**Use refs for transient values** — mutate DOM directly for high-frequency updates:

```tsx
// BAD: useState causes re-render on every mousemove
function Tracker() {
  const [x, setX] = useState(0);
  useEffect(() => {
    const onMove = (e: MouseEvent) => setX(e.clientX);
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);
  return <div style={{ position: 'fixed', left: x }} />;
}

// GOOD: useRef + direct DOM mutation, zero re-renders
function Tracker() {
  const dotRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dotRef.current) dotRef.current.style.transform = `translateX(${e.clientX}px)`;
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);
  return <div ref={dotRef} style={{ position: 'fixed', top: 0, left: 0 }} />;
}
```

**Don't useMemo simple expressions:**

```tsx
// BAD: memo overhead exceeds savings for a boolean OR
const isLoading = useMemo(() => user.isLoading || notifications.isLoading,
  [user.isLoading, notifications.isLoading]);

// GOOD: just compute inline
const isLoading = user.isLoading || notifications.isLoading;
```

**useMemo inside parent vs memo on child** — `useMemo` still runs when parent early-returns; extract to `memo()`:

```tsx
// BAD: useMemo runs even when loading=true
function Profile({ user, loading }: Props) {
  const avatar = useMemo(() => computeAvatar(user), [user]);
  if (loading) return <Skeleton />;
  return <Avatar id={avatar} />;
}

// GOOD: memo'd child skips entirely when not rendered
const UserAvatar = memo(function UserAvatar({ user }: { user: User }) {
  const id = useMemo(() => computeAvatar(user), [user]);
  return <Avatar id={id} />;
});

function Profile({ user, loading }: Props) {
  if (loading) return <Skeleton />;
  return <UserAvatar user={user} />;
}
```

**useTransition over manual isLoading:**

```tsx
// BAD: manual loading state, won't reset on error
const [isLoading, setIsLoading] = useState(false);
const handleSearch = async (q: string) => {
  setIsLoading(true);
  const data = await fetchResults(q);
  setResults(data);
  setIsLoading(false); // won't run if fetchResults throws
};

// GOOD: isPending resets automatically, even on error
const [isPending, startTransition] = useTransition();
const handleSearch = (q: string) => {
  startTransition(async () => {
    const data = await fetchResults(q);
    setResults(data);
  });
};
```

## Rendering Optimization

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

**Animate div wrapper, not SVG** — many browsers lack GPU acceleration for CSS on SVG:

```tsx
// BAD: no GPU acceleration
<svg className="animate-spin" width="24" height="24"><circle cx="12" cy="12" r="10" /></svg>

// GOOD: GPU-accelerated wrapper
<div className="animate-spin">
  <svg width="24" height="24"><circle cx="12" cy="12" r="10" /></svg>
</div>
```

**SSR hydration — prevent flicker** with inline script for client-only data:

```tsx
// BAD: flickers — renders 'light', then switches after hydration
function ThemeWrapper({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState('light');
  useEffect(() => { setTheme(localStorage.getItem('theme') ?? 'light'); }, []);
  return <div className={theme}>{children}</div>;
}

// GOOD: inline script sets class before React hydrates
<div id="theme-wrapper">{children}</div>
<script dangerouslySetInnerHTML={{ __html: `
  (function() {
    try { document.getElementById('theme-wrapper').className = localStorage.getItem('theme') || 'light'; } catch(e) {}
  })();
`}} />
```

**suppressHydrationWarning** for expected mismatches (dates, random IDs):

```tsx
// Suppress only on elements with known server/client divergence
<span suppressHydrationWarning>{new Date().toLocaleString()}</span>
```

**CSS content-visibility** for long lists without full virtualization:

```css
.list-item {
  content-visibility: auto;
  contain-intrinsic-size: 0 80px;
}
```

## Extract Default Non-Primitives to Constants

Inline functions/objects in props break `memo()`:

```tsx
// BAD: New function ref every render, defeats memo
<MemoizedButton onClick={() => {}} />

// GOOD: Stable reference
const NOOP = () => {};
<MemoizedButton onClick={NOOP} />
```

## Initialize App Once

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

## Bundle Optimization

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

### Conditional Imports

Load heavy modules only when a feature is activated:

```tsx
// BAD: always in initial bundle
import { frames } from './animation-frames';

// GOOD: load on demand
function AnimationPlayer({ enabled }: { enabled: boolean }) {
  const [frames, setFrames] = useState<Frame[] | null>(null);
  useEffect(() => {
    if (enabled && !frames) {
      import('./animation-frames').then(mod => setFrames(mod.frames));
    }
  }, [enabled, frames]);
  if (!frames) return <Skeleton />;
  return <Canvas frames={frames} />;
}
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

**Don't define components inside components:**

```tsx
// BAD: InnerList remounts on every Parent render (new reference each time)
function Parent({ items }) {
  function InnerList() {
    return items.map(i => <Item key={i.id} item={i} />);
  }
  return <InnerList />;
}

// GOOD: extract to module scope
function InnerList({ items }) {
  return items.map(i => <Item key={i.id} item={i} />);
}
function Parent({ items }) {
  return <InnerList items={items} />;
}
```

## JS Performance Patterns

**Use Map/Set for lookups:**

```tsx
// BAD: O(n) per lookup
orders.map(o => ({ ...o, user: users.find(u => u.id === o.userId) }));

// GOOD: O(1) per lookup
const userById = new Map(users.map(u => [u.id, u]));
orders.map(o => ({ ...o, user: userById.get(o.userId) }));
```

**Immutable sort — `.toSorted()` not `.sort()` on props:**

```tsx
// BAD: mutates the prop array
const sorted = useMemo(() => users.sort((a, b) => a.name.localeCompare(b.name)), [users]);

// GOOD: new array, original unchanged
const sorted = useMemo(() => users.toSorted((a, b) => a.name.localeCompare(b.name)), [users]);
```

**Hoist RegExp:**

```tsx
// BAD: new RegExp every render
const regex = new RegExp(`(${query})`, 'gi');

// GOOD: memoize dynamic, hoist static
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const regex = useMemo(() => new RegExp(`(${escapeRegex(query)})`, 'gi'), [query]);
```

**Batch DOM reads/writes** to avoid layout thrashing in `useEffect`:

```tsx
// BAD: read → write → read → write forces multiple reflows
el1Height = el1.offsetHeight;
el1.style.height = '100px';
el2Height = el2.offsetHeight;
el2.style.height = '100px';

// GOOD: batch reads, then batch writes
el1Height = el1.offsetHeight;
el2Height = el2.offsetHeight;
el1.style.height = '100px';
el2.style.height = '100px';
```

**Cache repeated function results** — bound module-level caches and evict old entries:

```tsx
// BAD: slugify() called 100+ times for same project names
projects.map(p => <Card key={p.id} slug={slugify(p.name)} />);

// GOOD: bounded module-level LRU cache
const MAX_SLUG_CACHE_ENTRIES = 100;
const slugCache = new Map<string, string>();
function cachedSlugify(text: string): string {
  const cached = slugCache.get(text);
  if (cached !== undefined) {
    slugCache.delete(text);
    slugCache.set(text, cached);
    return cached;
  }

  const result = slugify(text);
  if (slugCache.size >= MAX_SLUG_CACHE_ENTRIES) {
    const oldest = slugCache.keys().next().value;
    if (oldest !== undefined) slugCache.delete(oldest);
  }
  slugCache.set(text, result);
  return result;
}
```

Prefer a component/provider-owned cache with cleanup when entries belong to one UI lifetime. Use a process-wide cache only when its size and eviction policy are explicit.

**Cache localStorage/sessionStorage reads** — synchronous I/O is expensive:

```tsx
// BAD: reads storage on every call
function getTheme() { return localStorage.getItem('theme') ?? 'light'; }

// GOOD: in-memory cache, synced on write
const storageCache = new Map<string, string | null>();
function getLocal(key: string) {
  if (!storageCache.has(key)) storageCache.set(key, localStorage.getItem(key));
  return storageCache.get(key);
}
function setLocal(key: string, value: string) {
  localStorage.setItem(key, value);
  storageCache.set(key, value);
}
// Invalidate on cross-tab changes
window.addEventListener('storage', (e) => {
  if (e.storageArea !== localStorage) return;
  if (e.key === null) storageCache.clear();
  else storageCache.delete(e.key);
});
```

**Combine multiple iterations** — multiple `.filter()` calls = multiple passes:

```tsx
// BAD: 3 passes over users
const admins = users.filter(u => u.isAdmin);
const testers = users.filter(u => u.isTester);
const inactive = users.filter(u => !u.isActive);

// GOOD: 1 pass
const admins: User[] = [], testers: User[] = [], inactive: User[] = [];
for (const u of users) {
  if (u.isAdmin) admins.push(u);
  if (u.isTester) testers.push(u);
  if (!u.isActive) inactive.push(u);
}
```

**Check length before expensive comparison:**

```tsx
// BAD: always sorts even when lengths differ
function hasChanges(current: string[], original: string[]) {
  return current.sort().join() !== original.sort().join();
}

// GOOD: O(1) bail-out, then compare
function hasChanges(current: string[], original: string[]) {
  if (current.length !== original.length) return true;
  const a = current.toSorted(), b = original.toSorted();
  return a.some((v, i) => v !== b[i]);
}
```

**Loop for min/max, not sort:**

```tsx
// BAD: O(n log n) to find one value
const latest = [...projects].sort((a, b) => b.updatedAt - a.updatedAt)[0];

// GOOD: O(n) single pass, including the empty case
function findLatestProject(projects: ReadonlyArray<Project>): Project | undefined {
  let latest: Project | undefined;
  for (const project of projects) {
    if (latest === undefined || project.updatedAt > latest.updatedAt) latest = project;
  }
  return latest;
}
```

**Cache property access in hot loops:**

```tsx
// BAD: deep lookup on every iteration
for (let i = 0; i < arr.length; i++) process(obj.config.settings.value);

// GOOD: hoist to local
const value = obj.config.settings.value;
const len = arr.length;
for (let i = 0; i < len; i++) process(value);
```
