# Code Style Reference

Guidelines for sound, simple, consistent, disciplined, and far-seeing code.

## Core Principles

### 1. Soundness

Types make illegal states unrepresentable.

```typescript
// BAD: Multiple optional fields create ambiguity
interface User {
  name?: string
  email?: string
  isGuest?: boolean
}

// GOOD: Discriminated union
type User =
  | { type: "guest"; sessionId: string }
  | { type: "registered"; name: string; email: string }

// BAD: Boolean flags create impossible states
const [isLoading, setIsLoading] = useState(false)
const [error, setError] = useState<Error | null>(null)
const [data, setData] = useState<Data | null>(null)
// Can have isLoading=true AND error set (invalid!)

// GOOD: Union state
type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: Data }
  | { status: "error"; error: Error }
```

### 2. Simplicity

Fewer concepts, fewer moving parts.

```typescript
// BAD: Unnecessary abstraction
class SessionManager {
  private sessions: Map<string, Session> = new Map()

  getSession(id: string) {
    return this.sessions.get(id)
  }

  setSession(session: Session) {
    this.sessions.set(session.id, session)
  }
}

// GOOD: Use built-in data structures
const sessions = new Map<string, Session>()

// BAD: Over-engineered configuration
interface ButtonProps {
  variant: "primary" | "secondary" | "tertiary"
  size: "sm" | "md" | "lg"
  disabled?: boolean
  loading?: boolean
  icon?: ReactNode
  iconPosition?: "left" | "right"
  fullWidth?: boolean
  // ... 10 more props
}

// GOOD: Fewer props, compound components for flexibility
interface ButtonProps {
  variant?: "primary" | "ghost"
  disabled?: boolean
  children: ReactNode
}
```

### 3. Consistency

Same patterns throughout the codebase.

```typescript
// Pick ONE pattern and use it everywhere

// Services: Always use Context.Service + Layer
export class SessionService extends Context.Service<...>()("SessionService") {
  static layer = Layer.effect(...)
  static layerTest = Layer.succeed(...)
}

// Errors: Always use Schema.TaggedErrorClass
export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()(
  "SessionNotFound",
  { sessionId: Schema.String }
) {}

// Imports: Always use type imports for types
import type { Session, UserId } from "@my-app/shared"
import { SessionService } from "@my-app/core"
```

### 4. Discipline

No shortcuts that create tech debt.

```typescript
// BAD: Type assertions to silence compiler
const user = data as User  // Could be wrong at runtime

// GOOD: Schema validation
const user = Schema.decodeSync(User)(data)

// BAD: Non-null assertions
const name = user!.name  // Crashes if user is null

// GOOD: Handle the null case
const name = user?.name ?? "Anonymous"

// BAD: any to skip type checking
function process(data: any) { ... }

// GOOD: Unknown + narrowing
function process(data: unknown) {
  if (isSession(data)) { ... }
}
```

### 5. Far-seeing

Consider future readers and maintainers.

```typescript
// BAD: Magic numbers
if (sessions.length > 100) { ... }

// GOOD: Named constants
const MAX_SESSIONS = 100
if (sessions.length > MAX_SESSIONS) { ... }

// BAD: Clever one-liner
const result = arr.reduce((a, b) => ({ ...a, [b.id]: b }), {})

// GOOD: Clear intent
const sessionsById = new Map(sessions.map(s => [s.id, s]))

// BAD: Comments explaining what
// Loop through sessions and filter active ones
const active = sessions.filter(s => s.active)

// GOOD: Code is self-documenting (no comment needed)
const activeSessions = sessions.filter(session => session.isActive)
```

## Cognitive Cost

Minimize mental overhead for readers:

| Pattern | Cognitive Cost | Better Alternative |
|---------|---------------|-------------------|
| `x: string \| string[]` | Must check type before use | `x: string[]` |
| `enabled?: boolean` | undefined vs false unclear | Discriminated union |
| Mutable state + effects | Track dependencies mentally | Derived state |
| Deep nesting | Hard to follow flow | Early returns |
| Implicit dependencies | Hidden coupling | Explicit injection |

## Effect-Specific Style

```typescript
// Service definition - consistent pattern
export class MyService extends Context.Service<MyService, {
  readonly method: (arg: Arg) => Effect.Effect<Result, MyError>
}>()("MyService") {
  static layer = Layer.effect(MyService, Effect.gen(function* () {
    const dep = yield* DependencyService
    return MyService.of({
      method: (arg) => Effect.gen(function* () {
        // Implementation
      }),
    })
  }))
}

// Error definition - always Schema.TaggedErrorClass
export class MyError extends Schema.TaggedErrorClass<MyError>()(
  "MyError",  // Tag matches class name
  { field: Schema.String }
) {}

// Generator style - prefer over pipe for readability
Effect.gen(function* () {
  const a = yield* getA()
  const b = yield* getB(a)
  return yield* combine(a, b)
})

// Pipe style - for simple transformations
getA().pipe(
  Effect.map(transform),
  Effect.flatMap(getB)
)
```

## UI-Specific Style

```typescript
// Union state for async
type ViewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: Data }
  | { status: "error"; error: Error }

// Derived values over stored state
const total = () => items().reduce((sum, i) => sum + i.price, 0)

// Uncontrolled forms
const handleSubmit = (e: Event) => {
  const form = e.target as HTMLFormElement
  const data = new FormData(form)
  submit({ name: data.get("name") as string })
}

// Data attributes for styling
<div
  class="bg-gray-100 data-[active]:bg-blue-500"
  data-active={isActive ? "" : undefined}
/>

// Composition over configuration
<SessionList>
  <SessionList.Header>
    <SessionList.CreateButton />
  </SessionList.Header>
  <SessionList.Content />
</SessionList>
```

## Anti-Patterns to Avoid

1. **Effect for derived state**: Compute during render instead
2. **Prop drilling**: Use context providers
3. **Boolean flags**: Use discriminated unions
4. **any/as casts**: Use proper types or Schema validation
5. **Comments explaining what**: Make code self-documenting
6. **Premature abstraction**: Wait for patterns to emerge
7. **Magic strings/numbers**: Use constants or enums
8. **Deep nesting**: Use early returns and helpers
9. **Implicit state**: Make dependencies explicit
10. **Mixed concerns**: Separate data fetching from UI
