# State Management

## You Might Not Need an Effect

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

## You Might Not Need State

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

## Union State Modeling

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

## State Colocation

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

## Functional setState Updates

When next state depends on current state, use updater functions to avoid stale closures:

```tsx
// BAD: Stale closure in async
setItems([...items, ...newItems]);

// GOOD: Always reads current state
setItems(curr => [...curr, ...newItems]);
```
