# Event Handling Patterns

## Store Event Handlers in Refs

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

## useLatest for Stable Callbacks

```tsx
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => { ref.current = value; });
  return ref;
}

// The debounce runs in the event handler; useLatest is the only effect, inside the adapter
function Search({ onSearch }) {
  const onSearchRef = useLatest(onSearch);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  return (
    <input
      onChange={(e) => {
        const query = e.target.value;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => onSearchRef.current(query), 300);
      }}
    />
  );
}
```

Hooks like `useLatest` are host adapters: keep them in one shared place, and keep effects out of feature components ([server-state.md](server-state.md#effects-and-promises)).

## Deduplicate Global Event Listeners

Single listener shared across component instances:

```tsx
const callbacks = new Map<string, Set<(e: KeyboardEvent) => void>>();

function subscribe(key: string, cb: (e: KeyboardEvent) => void) {
  if (!callbacks.has(key)) callbacks.set(key, new Set());
  const set = callbacks.get(key)!;
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) callbacks.delete(key);
  };
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

## Passive Event Listeners

Use `{ passive: true }` on `touchstart`/`wheel` to enable immediate scrolling. Don't use when you need `preventDefault()`.
