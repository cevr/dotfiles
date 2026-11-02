# State Modeling

Model state transitions explicitly. Impossible states should be unrepresentable.

## No Boolean Explosions

Each boolean doubles the state space. Five booleans = 32 combinations, most invalid.

```tsx
// BAD: 8 possible states, most are bugs
const [isLoading, setIsLoading] = useState(false)
const [isError, setIsError] = useState(false)
const [isSuccess, setIsSuccess] = useState(false)
// What does isLoading=true + isError=true + isSuccess=true mean?

// GOOD: exactly 4 valid states
type FetchState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: Error }
```

```tsx
// BAD: boolean pairs with implicit coupling
const [isOpen, setIsOpen] = useState(false)
const [isAnimating, setIsAnimating] = useState(false)
const [isClosing, setIsClosing] = useState(false)

// GOOD: explicit lifecycle
type ModalState = 'closed' | 'opening' | 'open' | 'closing'
```

## Discriminated Unions

Use `status` (or `_tag`) as discriminant. TypeScript narrows automatically in switch/if.

```tsx
type FormState =
  | { status: 'editing'; values: FormValues; errors: Record<string, string> }
  | { status: 'submitting'; values: FormValues }
  | { status: 'submitted'; result: SubmitResult }
  | { status: 'failed'; values: FormValues; error: Error }

function FormStatus({ state }: { state: FormState }) {
  switch (state.status) {
    case 'editing':    return <EditForm values={state.values} errors={state.errors} />
    case 'submitting': return <Spinner />
    case 'submitted':  return <Success result={state.result} />
    case 'failed':     return <RetryForm values={state.values} error={state.error} />
  }
}
```

Each branch has exactly the fields it needs. No `data ?? null` guards.

## Reducers Over useState

Once state has more than ~3 fields or transitions depend on current state, switch to `useReducer`. A reducer models a workflow the UI owns. A request's pending, success, and error states come from `useMutation`, `useQuery`, or a transition, never from reducer actions ([server-state.md](server-state.md#effects-and-promises)).

```tsx
// BAD: the request's lifecycle mirrored into local state, one setter per field
function useCheckout() {
  const [items, setItems] = useState<Item[]>([])
  const [total, setTotal] = useState(0) // derivable from items
  const [status, setStatus] = useState<'idle' | 'processing' | 'done'>('idle')
  const [error, setError] = useState<Error | null>(null)

  async function submit() {
    setStatus('processing')
    setError(null) // easy to forget
    try {
      await api.checkout(items)
      setStatus('done')
      setItems([]) // easy to forget
      setTotal(0)  // easy to forget
    } catch (e) {
      setError(e as Error)
      setStatus('idle') // easy to forget
    }
  }
}

// GOOD: the reducer owns the cart; the mutation owns the request
type CartAction =
  | { type: 'item_added'; item: Item }
  | { type: 'item_removed'; id: string }
  | { type: 'emptied' }

function cartReducer(items: Item[], action: CartAction): Item[] {
  switch (action.type) {
    case 'item_added':
      return [...items, action.item]
    case 'item_removed':
      return items.filter((i) => i.id !== action.id)
    case 'emptied':
      return []
  }
  action satisfies never
  return items
}

function useCheckout() {
  const [items, dispatch] = useReducer(cartReducer, [])
  const total = items.reduce((s, i) => s + i.price, 0) // derived, not stored
  const checkout = useMutation({
    ...mutation.orders.checkout.mutationOptions(),
    onSuccess: () => dispatch({ type: 'emptied' }),
  })
  return { items, total, dispatch, checkout } // checkout.isPending, checkout.error
}
```

## Transition Protection

Not every action is valid in every state. Guard transitions at the reducer level.

```tsx
// State machine: stopped → playing ⇄ paused → stopped
function playerReducer(state: PlayerState, action: PlayerAction): PlayerState {
  switch (action.type) {
    case 'played':
      // Playing again is a no-op; play from stopped starts at 0
      if (state.status === 'playing') return state
      return { status: 'playing', position: state.status === 'paused' ? state.position : 0 }

    case 'paused':
      if (state.status !== 'playing') return state
      return { status: 'paused', position: action.position }

    case 'stopped':
      return { status: 'stopped' }
  }
  action satisfies never
  return state
}
```

Transition guard pattern:
```tsx
// Generic guard — reusable across reducers
function guardTransition<S extends { status: string }>(
  state: S,
  allowedFrom: S['status'][],
): boolean {
  return allowedFrom.includes(state.status)
}

// Usage
case 'paused':
  if (!guardTransition(state, ['playing'])) return state
  return { status: 'paused', position: action.position }
```

## State Machines with useReducer

For complex flows, define the machine as a transition table:

```tsx
const transitions = {
  idle:       { FETCH: 'loading' },
  loading:    { SUCCESS: 'success', ERROR: 'error', CANCEL: 'idle' },
  success:    { RESET: 'idle', REFETCH: 'loading' },
  error:      { RETRY: 'loading', RESET: 'idle' },
} as const satisfies Record<string, Record<string, string>>

type Status = keyof typeof transitions
type Event = { [K in Status]: keyof (typeof transitions)[K] }[Status]

function machineReducer(state: { status: Status }, action: { type: Event }) {
  const nextStatus = transitions[state.status]?.[action.type]
  if (!nextStatus) return state // invalid transition — no-op
  return { ...state, status: nextStatus }
}
```

## When to Use What

| Complexity | Tool | Signal |
|-----------|------|--------|
| 1-2 independent values | `useState` | Toggle, input value |
| 3+ related fields | `useReducer` | Form state, multi-step flow |
| Complex transitions | Reducer + transition guards | Checkout, auth flow |
| Many states + side effects | State machine library | Wizards, media players, WebSocket |

## Gotchas

- **Don't mix paradigms** — if using a reducer, ALL state transitions go through `dispatch`. No side `useState` for "just this one field."
- **Exhaustive switches** — end the `switch` with `value satisfies never` and a plain return, with no `default`, so a new variant fails the typecheck. No throwing `assertNever` in components.
- **Derived state is not state** — `total` computed from `items` should be a `useMemo`, not in the reducer.
- **Events, not setters** — name actions after what happened (`'submit'`, `'item_added'`), not what to do (`'set_loading'`, `'set_items'`).
