# UI State Management

Union state, derived values, and avoiding common antipatterns.

## Union State Over Booleans

```typescript
// BAD: Multiple booleans create impossible states
const [isLoading, setIsLoading] = createSignal(false)
const [isError, setIsError] = createSignal(false)
const [data, setData] = createSignal<Data | null>(null)
// Can have isLoading=true AND isError=true (invalid!)

// GOOD: Discriminated union makes impossible states unrepresentable
type DataState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: Data }
  | { status: "error"; error: Error }

const [state, setState] = createSignal<DataState>({ status: "idle" })

// Usage - exhaustive pattern matching
function DataView() {
  const s = state()

  switch (s.status) {
    case "idle":
      return <button onClick={load}>Load</button>
    case "loading":
      return <Spinner />
    case "success":
      return <DataDisplay data={s.data} />
    case "error":
      return <ErrorDisplay error={s.error} />
  }
}
```

## Derived Values Over State

```typescript
// BAD: Storing derived state
const [items, setItems] = createSignal<Item[]>([])
const [total, setTotal] = createSignal(0)
const [filtered, setFiltered] = createSignal<Item[]>([])

createEffect(() => {
  setTotal(items().reduce((sum, i) => sum + i.price, 0))
  setFiltered(items().filter((i) => i.active))
})

// GOOD: Compute during render
const [items, setItems] = createSignal<Item[]>([])
const [filter, setFilter] = createSignal("")

// Derived - recalculated when dependencies change
const total = () => items().reduce((sum, i) => sum + i.price, 0)
const filtered = () =>
  items().filter((i) => i.name.toLowerCase().includes(filter().toLowerCase()))

// Memoize only if expensive
const expensiveComputation = createMemo(() =>
  items()
    .filter((i) => complexCheck(i))
    .map((i) => expensiveTransform(i))
    .sort(complexSort)
)
```

## No Effect for Derived State

```typescript
// BAD: useEffect/createEffect to derive state
function Component() {
  const [firstName, setFirstName] = createSignal("")
  const [lastName, setLastName] = createSignal("")
  const [fullName, setFullName] = createSignal("")

  createEffect(() => {
    setFullName(`${firstName()} ${lastName()}`)
  })

  return <div>{fullName()}</div>
}

// GOOD: Calculate during render
function Component() {
  const [firstName, setFirstName] = createSignal("")
  const [lastName, setLastName] = createSignal("")

  // Derived value - no state needed
  const fullName = () => `${firstName()} ${lastName()}`

  return <div>{fullName()}</div>
}
```

## Key Prop for State Reset

```typescript
// BAD: Effect to reset state on prop change
function Editor(props: { sessionId: string }) {
  const [content, setContent] = createSignal("")

  createEffect(() => {
    // Reset on session change
    setContent("")
    loadContent(props.sessionId)
  })
}

// GOOD: Use key to reset entire component
function Page() {
  const [sessionId, setSessionId] = createSignal("abc")

  return <Editor sessionId={sessionId()} key={sessionId()} />
}

function Editor(props: { sessionId: string }) {
  // Component remounts when key changes, fresh state
  const [content, setContent] = createSignal("")

  onMount(() => loadContent(props.sessionId))
}
```

## Event Logic in Handlers

```typescript
// BAD: Effect triggered by event flag
const [submitted, setSubmitted] = createSignal(false)

createEffect(() => {
  if (submitted()) {
    submitForm(formData())
    showNotification("Submitted!")
  }
})

function handleSubmit() {
  setSubmitted(true)
}

// GOOD: Logic in event handler
function handleSubmit() {
  submitForm(formData())
  showNotification("Submitted!")
}
```

## URL State for Shareable Data

```typescript
// BAD: Local state for filters (lost on refresh/share)
const [filter, setFilter] = createSignal("all")
const [sort, setSort] = createSignal("date")

// GOOD: URL state (shareable, bookmarkable, back-button works)
import { useSearchParams } from "@solidjs/router"

function ProductList() {
  const [params, setParams] = useSearchParams()

  const filter = () => params.filter ?? "all"
  const sort = () => params.sort ?? "date"

  const setFilter = (value: string) =>
    setParams({ filter: value })

  return (
    <>
      <FilterSelect value={filter()} onChange={setFilter} />
      <ProductGrid filter={filter()} sort={sort()} />
    </>
  )
}
```

## Platform APIs Over State

```typescript
// BAD: Controlled inputs for simple form
function ContactForm() {
  const [name, setName] = createSignal("")
  const [email, setEmail] = createSignal("")
  const [message, setMessage] = createSignal("")

  const handleSubmit = () => {
    submit({ name: name(), email: email(), message: message() })
  }

  return (
    <form onSubmit={handleSubmit}>
      <input value={name()} onInput={(e) => setName(e.target.value)} />
      <input value={email()} onInput={(e) => setEmail(e.target.value)} />
      <textarea value={message()} onInput={(e) => setMessage(e.target.value)} />
    </form>
  )
}

// GOOD: Uncontrolled with FormData
function ContactForm() {
  const handleSubmit = (e: Event) => {
    e.preventDefault()
    const form = e.target as HTMLFormElement
    const data = new FormData(form)
    submit({
      name: data.get("name") as string,
      email: data.get("email") as string,
      message: data.get("message") as string,
    })
  }

  return (
    <form onSubmit={handleSubmit}>
      <input name="name" required />
      <input name="email" type="email" required />
      <textarea name="message" required />
      <button type="submit">Send</button>
    </form>
  )
}
```

## When Effects ARE Appropriate

- Fetching data on mount
- Setting up subscriptions (WebSocket, SSE)
- Syncing with non-framework code (maps, charts)
- Analytics/logging on view

```typescript
// Appropriate effect - syncing with external system
function Map(props: { center: LatLng }) {
  let mapRef: HTMLDivElement

  createEffect(() => {
    const map = new google.maps.Map(mapRef)
    map.setCenter(props.center)

    onCleanup(() => {
      google.maps.event.clearInstanceListeners(map)
    })
  })

  return <div ref={mapRef} />
}
```

## Key Points

1. **Union state**: Impossible states unrepresentable
2. **Derived values**: Compute during render, not in effects
3. **Key for reset**: Remount component instead of effect
4. **Event handlers**: Put logic where it happens
5. **URL state**: Shareable, persistent filter/sort state
6. **Platform APIs**: FormData, native validation over state
