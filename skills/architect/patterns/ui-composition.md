# UI Composition Pattern

Compound components and context providers for flexible UIs.

## Provider Pattern

```typescript
// apps/web/src/context/session.tsx
import { createContext, useContext, type JSX } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Session } from "@my-app/shared"

// Define what the context provides
interface SessionContextValue {
  sessions: Session[]
  current: Session | null
  setCurrent: (session: Session | null) => void
  refresh: () => Promise<void>
  create: (title: string) => Promise<Session>
  delete: (id: string) => Promise<void>
}

const SessionContext = createContext<SessionContextValue>()

export function SessionProvider(props: { children: JSX.Element }) {
  const { client } = useApi()
  const runEffect = useRunEffect()

  const [store, setStore] = createStore({
    sessions: [] as Session[],
    current: null as Session | null,
  })

  const refresh = async () => {
    const result = await runEffect(client.sessions.list({ urlParams: { limit: 100 } }))
    setStore("sessions", result.data)
  }

  const create = async (title: string) => {
    const session = await runEffect(client.sessions.create({ payload: { title } }))
    setStore("sessions", (prev) => [...prev, session])
    return session
  }

  const remove = async (id: string) => {
    await runEffect(client.sessions.delete({ path: { id } }))
    setStore("sessions", (prev) => prev.filter((s) => s.id !== id))
  }

  // Initial fetch
  refresh()

  return (
    <SessionContext.Provider
      value={{
        get sessions() { return store.sessions },
        get current() { return store.current },
        setCurrent: (s) => setStore("current", s),
        refresh,
        create,
        delete: remove,
      }}
    >
      {props.children}
    </SessionContext.Provider>
  )
}

export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error("useSession must be used within SessionProvider")
  return ctx
}
```

## Compound Components

```typescript
// apps/web/src/components/SessionList/index.tsx
import { For, Show, type JSX } from "solid-js"
import { SessionProvider, useSession } from "../../context/session"

// Root component with provider
export function SessionList(props: { children?: JSX.Element }) {
  return (
    <SessionProvider>
      <div class="session-list">
        {props.children}
      </div>
    </SessionProvider>
  )
}

// Header subcomponent
SessionList.Header = function Header(props: { children?: JSX.Element }) {
  const { sessions } = useSession()

  return (
    <div class="session-list-header">
      <h2>Sessions ({sessions.length})</h2>
      {props.children}
    </div>
  )
}

// Content subcomponent
SessionList.Content = function Content() {
  const { sessions, current, setCurrent } = useSession()

  return (
    <div class="session-list-content">
      <For each={sessions}>
        {(session) => (
          <SessionList.Item
            session={session}
            active={current?.id === session.id}
            onClick={() => setCurrent(session)}
          />
        )}
      </For>
    </div>
  )
}

// Item subcomponent
SessionList.Item = function Item(props: {
  session: Session
  active?: boolean
  onClick?: () => void
}) {
  return (
    <div
      class="session-item"
      data-active={props.active ? "" : undefined}
      onClick={props.onClick}
    >
      <span class="session-title">{props.session.title}</span>
      <span class="session-date">
        {new Date(props.session.createdAt).toLocaleDateString()}
      </span>
    </div>
  )
}

// Footer subcomponent
SessionList.Footer = function Footer(props: { children?: JSX.Element }) {
  return <div class="session-list-footer">{props.children}</div>
}

// Create button - separate from provider, accesses context
SessionList.CreateButton = function CreateButton() {
  const { create } = useSession()

  const handleCreate = async () => {
    const title = prompt("Session title:")
    if (title) await create(title)
  }

  return (
    <button onClick={handleCreate} class="create-button">
      New Session
    </button>
  )
}
```

## Usage - Composition Over Configuration

```typescript
// Flexible composition - render to opt-in
function MyPage() {
  return (
    <SessionList>
      <SessionList.Header>
        <SessionList.CreateButton />
      </SessionList.Header>
      <SessionList.Content />
      <SessionList.Footer>
        <RefreshButton />
      </SessionList.Footer>
    </SessionList>
  )
}

// Different layout, same components
function CompactPage() {
  return (
    <SessionList>
      <div class="compact-header">
        <SessionList.Header />
      </div>
      <SessionList.Content />
      {/* No footer */}
    </SessionList>
  )
}

// Custom content with same context
function CustomPage() {
  return (
    <SessionList>
      <SessionList.Header />
      <CustomSessionGrid />  {/* Uses useSession() internally */}
      <SessionList.Footer>
        <SessionList.CreateButton />
        <ExportButton />
      </SessionList.Footer>
    </SessionList>
  )
}
```

## Lift Provider for Flexible Access

```typescript
// Provider lifted out for cross-component access
function SessionModal() {
  return (
    <SessionProvider>
      <Modal>
        <ModalHeader>
          <SessionTitle />  {/* Uses useSession() */}
        </ModalHeader>
        <ModalBody>
          <SessionEditor />  {/* Uses useSession() */}
        </ModalBody>
        <ModalFooter>
          <SaveButton />  {/* Uses useSession() */}
        </ModalFooter>
      </Modal>
    </SessionProvider>
  )
}
```

## Data Attribute Styling

```typescript
// Use data attributes for conditional styling
function SessionItem(props: { session: Session; active?: boolean; error?: string }) {
  return (
    <div
      class="session-item bg-gray-100 data-[active]:bg-blue-500 data-[error]:bg-red-100"
      data-active={props.active ? "" : undefined}
      data-error={props.error ? "" : undefined}
    >
      {props.session.title}
    </div>
  )
}
```

## Key Points

1. **Provider wraps compound**: Root component includes provider
2. **Subcomponents access context**: Use hooks to access shared state
3. **Render to opt-in**: Features enabled by rendering subcomponents
4. **Flexible layout**: Same components, different arrangements
5. **Lift provider**: For access outside main UI tree
6. **Data attributes**: For conditional Tailwind styling
