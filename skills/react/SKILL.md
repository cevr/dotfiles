---
name: react
description: React best practices for state management, composition patterns, async patterns (use, useTransition, useOptimistic, Suspense), and avoiding common pitfalls. Use when writing React components, managing state, handling async operations, or structuring component hierarchies.
allowed-tools: [Read, Grep, Glob, Edit, Write]
---

# React Best Practices

## 1. You Might Not Need an Effect

Effects are for **synchronizing with external systems**. Most other uses are antipatterns.

### Derived State: Calculate During Render

```tsx
// BAD: useEffect to derive state
const [fullName, setFullName] = useState('');
useEffect(() => {
  setFullName(firstName + ' ' + lastName);
}, [firstName, lastName]);

// GOOD: Calculate during render
const fullName = firstName + ' ' + lastName;
```

### Expensive Calculations: Use useMemo

```tsx
// GOOD: Memoize expensive computations
const visibleTodos = useMemo(
  () => getFilteredTodos(todos, filter),
  [todos, filter]
);
```

### Resetting State: Use key Prop

```tsx
// BAD: useEffect to reset state on prop change
useEffect(() => {
  setComment('');
}, [userId]);

// GOOD: Use key to reset entire component
<Profile userId={userId} key={userId} />
```

### Event Logic: Keep in Event Handlers

```tsx
// BAD: Effect triggered by event
const [submitted, setSubmitted] = useState(false);
useEffect(() => {
  if (submitted) {
    post('/api/submit', data);
  }
}, [submitted]);

// GOOD: Logic in event handler
function handleSubmit() {
  post('/api/submit', data);
  showNotification('Submitted!');
}
```

### When Effects ARE Appropriate

- Fetching data on mount (but prefer React Query/SWR)
- Setting up subscriptions (WebSocket, event listeners)
- Syncing with non-React widgets (maps, video players)
- Sending analytics on page view

---

## 2. You Might Not Need State

State is a last resort. Prefer computing values and using the platform.

### Compute Over Store

Don't store what you can derive:

```tsx
// BAD: Storing derived state
const [items, setItems] = useState<Item[]>([]);
const [totalPrice, setTotalPrice] = useState(0);

useEffect(() => {
  setTotalPrice(items.reduce((sum, item) => sum + item.price, 0));
}, [items]);

// GOOD: Compute during render
const [items, setItems] = useState<Item[]>([]);
const totalPrice = items.reduce((sum, item) => sum + item.price, 0);
```

### Use the Platform: Forms

Use uncontrolled inputs with `FormData` instead of controlled state:

```tsx
// BAD: Controlled inputs for simple form
function ContactForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');

  return (
    <form onSubmit={e => {
      e.preventDefault();
      submit({ name, email, message });
    }}>
      <input value={name} onChange={e => setName(e.target.value)} />
      <input value={email} onChange={e => setEmail(e.target.value)} />
      <textarea value={message} onChange={e => setMessage(e.target.value)} />
      <button type="submit">Send</button>
    </form>
  );
}

// GOOD: Uncontrolled with FormData
function ContactForm() {
  return (
    <form onSubmit={e => {
      e.preventDefault();
      const formData = new FormData(e.currentTarget);
      submit({
        name: formData.get('name') as string,
        email: formData.get('email') as string,
        message: formData.get('message') as string,
      });
    }}>
      <input name="name" required />
      <input name="email" type="email" required />
      <textarea name="message" required />
      <button type="submit">Send</button>
    </form>
  );
}
```

### Use the Platform: Browser Validation

Let the browser validate instead of custom state:

```tsx
// GOOD: Native validation attributes
<input
  name="email"
  type="email"
  required
  pattern="[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$"
/>

<input
  name="age"
  type="number"
  min={18}
  max={120}
  required
/>

<input
  name="username"
  minLength={3}
  maxLength={20}
  required
/>
```

### Use the Platform: URL State

Store filter/sort/pagination state in the URL:

```tsx
// BAD: Local state for filters (lost on refresh/share)
const [filter, setFilter] = useState('all');
const [sort, setSort] = useState('date');

// GOOD: URL state (shareable, bookmarkable, back-button works)
function ProductList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = searchParams.get('filter') ?? 'all';
  const sort = searchParams.get('sort') ?? 'date';

  return (
    <>
      <select
        value={filter}
        onChange={e => setSearchParams(prev => {
          prev.set('filter', e.target.value);
          return prev;
        })}
      >
        <option value="all">All</option>
        <option value="active">Active</option>
      </select>
      <ProductGrid filter={filter} sort={sort} />
    </>
  );
}
```

For complex URL state with validation, use libraries like **nuqs**:

```tsx
import { parseAsStringEnum, useQueryState } from 'nuqs';

const filterParser = parseAsStringEnum(['all', 'active', 'completed']).withDefault('all');

function ProductList() {
  const [filter, setFilter] = useQueryState('filter', filterParser);
  // filter is typed as 'all' | 'active' | 'completed', never null
  // Invalid URL values fall back to 'all'
}
```

### When You DO Need State

- **Controlled inputs**: Real-time validation, input masking, character counts
- **Optimistic updates**: Show change before server confirms
- **Multi-step forms**: Wizard-style flows with back/forward
- **Animations**: Transitioning between values
- **Derived state that's expensive**: Use `useMemo` instead of recalculating

---

## 3. State Colocation

Keep state as close to where it's used as possible.

### Extract Components With Their Own State

When a piece of UI has its own state, extract it into a component. This prevents parent re-renders from affecting it.

```tsx
// BAD: Search state causes entire list to re-render
function ProductPage() {
  const [search, setSearch] = useState('');
  const [products] = useState(initialProducts);

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

  return (
    <input
      value={search}
      onChange={e => {
        setSearch(e.target.value);
        onSearch(e.target.value);
      }}
    />
  );
}

function ProductPage() {
  const [products] = useState(initialProducts);
  const [query, setQuery] = useState('');

  return (
    <div>
      <SearchInput onSearch={setQuery} />
      <ProductList products={filterProducts(products, query)} />
    </div>
  );
}
```

### State Location Hierarchy

1. **Local state**: Default choice. `useState` in the component that uses it.
2. **Lifted state**: When siblings need to share. Lift to nearest common parent.
3. **Context**: When distant components need access. Use Provider pattern.
4. **External store**: When state needs to persist across routes or sync externally.

---

## 4. Composition Over Configuration

Avoid monolithic components with boolean props. Use composition.

### The Antipattern: Boolean Prop Explosion

```tsx
// BAD: Monolithic component with flags
<UserForm
  isUpdateUser
  hideWelcome
  skipOnboarding
  onlyEditName
  isSlugRequired={false}
/>
```

### The Solution: Compound Components

```tsx
// GOOD: Composition - render to opt-in
function ChannelComposer() {
  return (
    <ComposerProvider>
      <ComposerFrame>
        <ComposerHeader />
        <ComposerInput />
        <ComposerDropZone /> {/* Just render to enable feature */}
        <ComposerFooter>
          <CommonActions />
          <SubmitButton />
        </ComposerFooter>
      </ComposerFrame>
    </ComposerProvider>
  );
}
```

### Decouple State From UI

Provider defines the interface, implementation can vary:

```tsx
// Local state provider
function LocalComposerProvider({ children }: { children: React.ReactNode }) {
  const [text, setText] = useState('');

  const value = {
    text,
    updateText: setText,
    submit: () => { /* local submit logic */ }
  };

  return (
    <ComposerContext.Provider value={value}>
      {children}
    </ComposerContext.Provider>
  );
}

// Synced state provider - same interface, different implementation
function SyncedComposerProvider({ children }: { children: React.ReactNode }) {
  const { text, updateText, submit } = useSyncedComposer();

  return (
    <ComposerContext.Provider value={{ text, updateText, submit }}>
      {children}
    </ComposerContext.Provider>
  );
}
```

### Lift Provider for Flexible Layouts

Access context from outside the main UI:

```tsx
function ForwardMessageModal() {
  return (
    <ForwardMessageProvider>
      <ComposerUI />
      <MessagePreview /> {/* Accesses composer state */}
      <div className="modal-footer">
        <ForwardButton /> {/* Can call submit() */}
      </div>
    </ForwardMessageProvider>
  );
}
```

---

## 5. Union State Modeling

Prefer discriminated unions over multiple booleans.

### The Problem: Boolean State

```tsx
// BAD: Multiple booleans create impossible states
const [isLoading, setIsLoading] = useState(false);
const [isError, setIsError] = useState(false);
const [data, setData] = useState<Data | null>(null);

// Can accidentally have isLoading=true AND isError=true
```

### The Solution: Union State

```tsx
// GOOD: Discriminated union - impossible states are unrepresentable
type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: Data }
  | { status: 'error'; error: Error };

const [state, setState] = useState<State>({ status: 'idle' });

// Usage with exhaustive matching
switch (state.status) {
  case 'idle':
    return <button onClick={fetch}>Load</button>;
  case 'loading':
    return <Spinner />;
  case 'success':
    return <DataView data={state.data} />;
  case 'error':
    return <ErrorView error={state.error} />;
}
```

### With useReducer

```tsx
type Action =
  | { type: 'FETCH_START' }
  | { type: 'FETCH_SUCCESS'; data: Data }
  | { type: 'FETCH_ERROR'; error: Error };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'FETCH_START':
      return { status: 'loading' };
    case 'FETCH_SUCCESS':
      return { status: 'success', data: action.data };
    case 'FETCH_ERROR':
      return { status: 'error', error: action.error };
  }
}
```

### Key Benefits

- **Type safety**: Each state variant carries only its relevant context
- **Impossible states**: Can't have `loading` and `error` simultaneously
- **Exhaustive checks**: TypeScript ensures all cases handled
- **Self-documenting**: State machine is explicit in the types

---

## 6. Async React Patterns

Modern React patterns for handling async operations with Suspense, transitions, and optimistic updates.

### The `use()` API

`use` reads values from Promises or Context. Unlike hooks, it CAN be called in conditionals and loops.

```tsx
import { use } from 'react';

function MessageComponent({ messagePromise }) {
  const message = use(messagePromise);  // Suspends until resolved
  const theme = use(ThemeContext);       // Also works with context
  // ...
}
```

**Key Rules:**
- Must be called inside a Component or Hook (not regular functions)
- Cannot be called in try-catch blocks (use Error Boundaries instead)
- CAN be called in conditionals and loops (unlike useContext)

**Conditional Context (preferred over useContext):**

```tsx
function HorizontalRule({ show }) {
  if (show) {
    const theme = use(ThemeContext);  // Conditionally read context
    return <hr className={theme} />;
  }
  return null;
}
```

**Server vs Client Components:**
- In Server Components: prefer `async`/`await` over `use`
- Create Promises in Server Components, pass to Client Components
- Client Component Promises are recreated on every render (unstable)

**Error Handling (cannot use try-catch):**

```tsx
// Option 1: Error Boundary
<ErrorBoundary fallback={<p>Error</p>}>
  <Suspense fallback={<p>Loading...</p>}>
    <Message messagePromise={messagePromise} />
  </Suspense>
</ErrorBoundary>

// Option 2: Promise.catch for fallback value
const messagePromise = fetchMessage().catch(() => "No message found");
```

**IMPORTANT: Avoiding Unnecessary Fallbacks**

For library authors/cached data: set `status`, `value`, `reason` fields to let React synchronously read settled Promises without suspending.

```tsx
// Simple approach: augment the promise
function preloadData(id) {
  const value = cachedData[id];
  const promise = Promise.resolve(value);

  // Set fields so React can read synchronously
  promise.status = "fulfilled";
  promise.value = value;
  return promise;
}

// Full subclass for pending promises
class PromiseWithStatus<T> extends Promise<T> {
  status: "pending" | "fulfilled" | "rejected" = "pending";
  value?: T;
  reason?: unknown;

  constructor(executor: (
    resolve: (value: T) => void,
    reject: (reason: unknown) => void
  ) => void) {
    let resolve: (v: T) => void;
    let reject: (e: unknown) => void;
    super((_resolve, _reject) => {
      resolve = _resolve;
      reject = _reject;
    });
    executor(
      (value) => {
        this.status = "fulfilled";
        this.value = value;
        resolve(value);
      },
      (reason) => {
        this.status = "rejected";
        this.reason = reason;
        reject(reason);
      }
    );
  }
}
```

Without these fields, even already-resolved Promises cause unnecessary fallback flickers.

---

### useTransition for Async Actions

Wrap async operations in transitions to track pending state and keep UI responsive.

```tsx
// BAD: No pending state feedback
function Button({ onClick, children }) {
  return <button onClick={onClick}>{children}</button>;
}

// GOOD: useTransition tracks pending state
function Button({ action, children }) {
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      await action();
    });
  }

  return (
    <button onClick={handleClick} disabled={isPending}>
      {isPending ? <Spinner /> : children}
    </button>
  );
}

// Usage - consumer just provides async function
<Button action={async () => {
  await login(credentials);
  router.navigate('/');
}}>
  Login
</Button>
```

---

### useOptimistic for Instant Feedback

Show UI updates immediately, before async operations complete.

```tsx
// BAD: Wait for server to update UI
function CompleteButton({ complete, onToggle }) {
  const [isPending, setIsPending] = useState(false);

  async function handleClick() {
    setIsPending(true);
    await onToggle();
    setIsPending(false);
  }

  return (
    <button onClick={handleClick} disabled={isPending}>
      {complete ? '✓' : '○'}
    </button>
  );
}

// GOOD: Optimistic update with immediate feedback
function CompleteButton({ complete, action }) {
  const [optimisticComplete, setOptimisticComplete] = useOptimistic(complete);

  function handleClick() {
    startTransition(async () => {
      setOptimisticComplete(!optimisticComplete);  // Update immediately
      await action();  // Server catches up
    });
  }

  return (
    <button onClick={handleClick}>
      {optimisticComplete ? '✓' : '○'}
    </button>
  );
}
```

**Optimistic Input with Pending Detection:**

```tsx
function SearchInput({ value, onSearch }) {
  const [inputValue, setInputValue] = useOptimistic(value);
  const isPending = inputValue !== value;  // Detect pending state

  function handleChange(e) {
    const newValue = e.target.value;
    startTransition(async () => {
      setInputValue(newValue);  // Optimistic update
      await onSearch(newValue);  // Actual search
    });
  }

  return (
    <div>
      <input value={inputValue} onChange={handleChange} />
      {isPending && <Spinner />}
    </div>
  );
}
```

---

### Suspense + Transitions

Suspense fallbacks only show on initial load. Transitions keep showing current content while loading.

```tsx
function Home() {
  const [tab, setTab] = useState('all');

  function changeTab(newTab) {
    startTransition(() => {
      setTab(newTab);  // Wrapped in transition
    });
  }

  return (
    <>
      <TabList activeTab={tab} onChange={changeTab} />
      {/*
        Fallback shows on initial load only.
        Tab switches show pending state instead of fallback
        because the state update is wrapped in a transition.
      */}
      <Suspense fallback={<SkeletonList />}>
        <LessonList tab={tab} />
      </Suspense>
    </>
  );
}

function LessonList({ tab }) {
  const lessons = use(getLessons(tab));  // Suspends on new data
  return (
    <ul>
      {lessons.map(lesson => <li key={lesson.id}>{lesson.title}</li>)}
    </ul>
  );
}
```

---

### Action Prop Pattern

Design components that accept async `action` props and handle transitions internally.

```tsx
// Design component handles all async complexity
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
      <TabsTrigger value="all">
        All {isPending && optimisticTab === 'all' && <Spinner />}
      </TabsTrigger>
      <TabsTrigger value="active">
        Active {isPending && optimisticTab === 'active' && <Spinner />}
      </TabsTrigger>
      {children}
    </Tabs>
  );
}

// Consumer provides simple async action
function Page() {
  const router = useRouter();

  function tabAction(tab) {
    router.setParams('tab', tab);  // Router handles transition
  }

  return (
    <TabList activeTab={router.query.tab} changeAction={tabAction}>
      <Content />
    </TabList>
  );
}
```

---

### Suspense-Enabled Data Fetching

Cache promises for Suspense, revalidate after mutations, prefetch before navigation.

```tsx
// Simple promise cache
let cache = new Map();

export function revalidate() {
  cache = new Map();
}

export function getData(key) {
  if (cache.has(key)) {
    return cache.get(key);  // Return cached promise
  }

  const promise = fetch(`/api/data?key=${key}`).then(r => r.json());
  cache.set(key, promise);
  return promise;
}

// Prefetch before navigation (with timeout)
export function prefetchData(key) {
  const promise = getData(key);
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(resolve, 1000))
  ]);
}

// Usage: Prefetch then navigate
async function handleLogin() {
  await login(credentials);
  await prefetchData('dashboard');  // Load data before navigation
  router.navigate('/dashboard');
}

// Revalidate after mutation
async function handleToggle(id) {
  await toggleItem(id);
  revalidate();  // Clear cache
  router.refresh();  // Re-fetch data
}
```

---

## 7. Tailwind Data Attribute Styling

Use data attributes for conditional styling instead of `classnames` object syntax. Data attributes have higher specificity than regular classes, making style precedence predictable.

```tsx
// BAD: cn/clsx/classnames object - order-dependent, verbose
<div className={cn({
  'bg-blue-500': !isActive,
  'bg-red-500': isActive,
})} />

// GOOD: data attributes - base style + conditional override
<div
  className="bg-blue-500 data-[active]:bg-red-500"
  data-active={isActive ? '' : undefined}
/>
```

**Caveat with `group`:** When using Tailwind's `group` with `group-data-*` selectors, parent data attributes affect all descendants. Use unique attribute names if children have the same states as parents.

---

## 8. Re-render Optimization

Minimize unnecessary re-renders for better performance.

### Lazy State Initialization

Pass a function to `useState` for expensive initial values:

```tsx
// BAD: Expensive call runs every render
const [data, setData] = useState(parseLocalStorage());

// GOOD: Function runs only on initial render
const [data, setData] = useState(() => parseLocalStorage());
```

Use lazy initialization for:
- localStorage/sessionStorage parsing
- Building data structures (indexes, maps)
- DOM reads
- Heavy computational transformations

### Extract to Memoized Components

Extract expensive work into `memo()` components to enable early returns:

```tsx
// BAD: useMemo still executes before early return
function UserCard({ user, loading }) {
  const avatar = useMemo(() => generateAvatar(user), [user]);

  if (loading) return <Skeleton />;
  return <div><img src={avatar} /></div>;
}

// GOOD: Memoized component skips work entirely
const Avatar = memo(function Avatar({ user }) {
  const avatar = generateAvatar(user);
  return <img src={avatar} />;
});

function UserCard({ user, loading }) {
  if (loading) return <Skeleton />;
  return <div><Avatar user={user} /></div>;
}
```

### Subscribe to Derived State

Subscribe to booleans, not continuous values:

```tsx
// BAD: Re-renders on every pixel change
function Sidebar() {
  const { width } = useWindowSize();
  const isMobile = width < 768;
  // ...
}

// GOOD: Re-renders only when threshold crossed
function Sidebar() {
  const isMobile = useMediaQuery('(max-width: 767px)');
  // ...
}
```

### Narrow Effect Dependencies

Use primitives in dependency arrays, not objects:

```tsx
// BAD: Runs when any user property changes
useEffect(() => {
  fetchUserData(user.id);
}, [user]);

// GOOD: Runs only when id changes
useEffect(() => {
  fetchUserData(user.id);
}, [user.id]);
```

Compute derived values outside effects:

```tsx
// BAD: Logic inside effect
useEffect(() => {
  if (width < 768) {
    setLayout('mobile');
  }
}, [width]);

// GOOD: Derive outside, effect only responds to meaningful changes
const isMobile = width < 768;
useEffect(() => {
  setLayout(isMobile ? 'mobile' : 'desktop');
}, [isMobile]);
```

### Defer State Reads

Read values on-demand instead of subscribing:

```tsx
// BAD: Re-renders on every searchParams change
function ShareButton() {
  const [searchParams] = useSearchParams();

  function handleClick() {
    share(searchParams.get('id'));
  }

  return <button onClick={handleClick}>Share</button>;
}

// GOOD: Read on-demand, no subscription
function ShareButton() {
  function handleClick() {
    const params = new URLSearchParams(window.location.search);
    share(params.get('id'));
  }

  return <button onClick={handleClick}>Share</button>;
}
```

### Store Event Handlers in Refs

Stable subscriptions without re-adding listeners:

```tsx
// BAD: Listener removed and re-added when handler changes
function useKeyboard(handler: (e: KeyboardEvent) => void) {
  useEffect(() => {
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handler]); // Re-runs on every handler change
}

// GOOD: Stable subscription, handler accessed via ref
function useKeyboard(handler: (e: KeyboardEvent) => void) {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    const listener = (e: KeyboardEvent) => handlerRef.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []); // Never re-runs
}
```

---

## 9. Rendering Optimization

Optimize what and how React renders.

### Hoist Static JSX

Extract unchanging JSX to module scope:

```tsx
// BAD: SVG recreated every render
function Icon({ active }) {
  const svg = (
    <svg viewBox="0 0 24 24">
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
    </svg>
  );

  return active ? svg : null;
}

// GOOD: SVG created once at module level
const svg = (
  <svg viewBox="0 0 24 24">
    <path d="M12 2L2 7l10 5 10-5-10-5z" />
  </svg>
);

function Icon({ active }) {
  return active ? svg : null;
}
```

### Explicit Conditional Rendering

Use ternary `? :` when condition can be `0` or `NaN`:

```tsx
// BAD: Renders "0" when count is 0
{count && <Badge count={count} />}

// GOOD: Renders null when count is 0
{count > 0 ? <Badge count={count} /> : null}

// Also GOOD: Convert to boolean
{!!count && <Badge count={count} />}
{Boolean(count) && <Badge count={count} />}
```

### Activity Component for Visibility

Preserve state and DOM when toggling visibility:

```tsx
// BAD: Component unmounts, loses state
{isVisible && <ExpensiveEditor />}

// GOOD: State preserved, DOM hidden
<Activity mode={isVisible ? 'visible' : 'hidden'}>
  <ExpensiveEditor />
</Activity>
```

Use for frequently toggled expensive components like editors, charts, or media players.

---

## 10. Bundle Optimization

Reduce initial bundle size for faster page loads.

### Dynamic Imports for Heavy Components

Defer loading until needed:

```tsx
import { lazy, Suspense } from 'react';

// BAD: Monaco bundled with main chunk
import { Editor } from '@monaco-editor/react';

// GOOD: Monaco loaded on demand
const Editor = lazy(() => import('@monaco-editor/react'));

function CodeEditor() {
  return (
    <Suspense fallback={<EditorSkeleton />}>
      <Editor />
    </Suspense>
  );
}
```

### Preload Before Navigation

Load critical data before route transitions:

```tsx
// Preload function with timeout
function preload(key: string) {
  const promise = fetchData(key);
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(resolve, 1000))
  ]);
}

// Preload then navigate
async function handleLogin() {
  await login(credentials);
  await preload('dashboard');  // Start loading before navigation
  router.navigate('/dashboard');
}
```

---

## 11. Event Handling Patterns

Efficient patterns for event subscriptions.

### useLatest for Stable Callbacks

Access current values without effect dependencies:

```tsx
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

// Usage: Debounced search with stable callback
function Search({ onSearch }) {
  const onSearchRef = useLatest(onSearch);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      onSearchRef.current(query);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]); // onSearch not in deps, accessed via ref

  return <input value={query} onChange={e => setQuery(e.target.value)} />;
}
```

### Deduplicate Global Event Listeners

Single listener shared across component instances:

```tsx
// Centralized subscription manager
const callbacks = new Map<string, Set<(e: KeyboardEvent) => void>>();

function subscribe(key: string, callback: (e: KeyboardEvent) => void) {
  if (!callbacks.has(key)) {
    callbacks.set(key, new Set());
  }
  callbacks.get(key)!.add(callback);

  return () => {
    callbacks.get(key)!.delete(callback);
  };
}

// Single global listener
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    callbacks.forEach((set) => {
      set.forEach((cb) => cb(e));
    });
  });
}

// Hook: Multiple components share one listener
function useKeydown(key: string, handler: (e: KeyboardEvent) => void) {
  useEffect(() => {
    return subscribe(key, handler);
  }, [key, handler]);
}
```
