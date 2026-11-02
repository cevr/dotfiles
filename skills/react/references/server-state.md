# Server State and Providers

Rules for reading and changing server data in React through a query library (TanStack Query) and an SDK whose query options are inferred from the API. The API side (one operation per client outcome, the SDK admission test) lives in the `effect` skill's `references/ARCHITECTURE.md`.

## Effects and promises

- Effects stay out of feature code: no `useEffect` or `useLayoutEffect` in a feature's components or hooks. Server reads and writes use the query library. A live subscription reaches React through an SDK adapter, such as `useSyncExternalStore` over a vanilla controller. Syncing with the DOM, a native view, or a non-React widget happens in one named host adapter hook that cleans up and says why no other primitive fits. The effect examples in [state.md](state.md) and [events.md](events.md) are such adapters.
- Never track a promise with `setState`. A simple action uses `useTransition` and its pending flag; data work uses `useQuery` or `useMutation`. Read the primitive's lifecycle directly. Moving the `try`/`finally` bookkeeping into a custom hook or reducer does not change this.
- A custom hook still runs during render. Extracting logic into a hook changes where it lives, not whether a side effect may run there. Retry, backoff, sequencing, and protocol parsing that another client would also need belong in the vanilla SDK.

## One cache, many observers

The app owns one browser `QueryClient` and mounts one `QueryClientProvider` at its root. A new feature, page, or modal reuses it. A second client splits deduplication and cross-feature invalidation, so create one only for a stated isolation reason (an embedded app, a security boundary). Server-rendering clients stay per request, and tests get their own.

Three providers, three jobs:

| Provider | Supplies |
| --- | --- |
| `QueryClientProvider` | The shared request, cache, and mutation infrastructure |
| `ClientSDKProvider` | The SDK client and its inferred operations; name the values `sdkClient` and `queryClient` when both are in scope |
| Feature providers (`ChatWorkspaceProvider`) | Observers, controllers, or local editable state that use the shared cache |

The SDK client's lifetime follows its credentials and resources, not the query client's hydration recipe.

In Next.js, mount the query client by the official TanStack Advanced Server Rendering guide for the installed version, wrapped once. Top-level server component shells stay synchronous: they never await data, params, or prefetch; a prefetch registers pending queries without awaiting, and the feature works without it.

## Derived options and one mutation policy

- Query options and keys come from the inferred operation: `query.users.byId.getOptions({ id })`. `.key` is the operation prefix; `getOptions(input).queryKey` is the full key. Keep no second key registry, and pass `exact: true` for an exact invalidation.
- A key carries the non-secret scope a result depends on (account, workspace, team), and the app clears the cache when that identity changes (sign-out, account switch), so one person's results never render for another.
- Register mutation defaults (invalidation, cache updates) once, where the shared client is built. Hooks and call sites do not repeat or override them, and a call site does not pass a long inline `onSuccess`.
- Consumers get types from the operation in front of them (`InputOf<typeof op>`, `OutputOf<typeof op>`), not from hand-written aliases, explicit generics, or tag strings.

## Feature data hooks

Wrap each query or mutation once at the feature's boundary, in the feature's folder, never in a global `hooks/` folder:

```ts
// features/projects/use-project.ts
export const useProject = (id: ProjectId) => useQuery(useQueryApi().projects.get.getOptions({ id }))
```

- Return the query result unchanged so property tracking keeps working; narrow its type, not its value. Never spread or normalize it into a new object.
- A mutation hook returns the whole `useMutation` result.
- Components take flat props (`<UserDetails id={id} />`) whose types derive from the hook's input.
- When several parts need one shared observer, call the hook once in a headless provider and pass the result down. Calling the same hook in several components creates several observers, not one shared one.
- Destructure stable functions (`const { mutate, reset } = useSend()`) at render scope before using them in handlers, so the compiler tracks the function, not the changing result. Never rest-destructure a tracked query result.

## Provider boundaries

- Put each independently updating owner in its own provider. A parent that nests them has no hooks and passes `children` through, so one resource's update does not rerun the others.
- Name headless providers with a `Provider` suffix; keep `Screen`, `Frame`, and `Panels` for visual components.
- The context contract is the `state` / `actions` / `meta` shape from the `composition-patterns` skill (`state-context-interface`), with one difference: request lifecycle and derived values go in `meta`, not `state`. Its example puts `isSubmitting` in `state`; here `state` holds only what the consumer controls (the draft), and `meta` holds `canSubmit`, the submission status, typed errors, and handles, none of which consumers write. Prefer `patch`, `replace`, and `reset` over a setter per field, and keep real operations like `submit` as named actions.
- A handle in a shared contract is a semantic capability (`{ focus(): void }`), never a DOM element or a React Native `TextInput` type.
- A missing provider throws from the accessor. A mock provider is an explicit implementation, never a silent no-op default.
- Swap implementations by mounting a different provider. Never call hooks conditionally or pass hook functions through context; pass values, promises, or stores.
- A different provider type at the same position remounts its subtree. When a transition must keep a draft, focus, or scroll (new chat becoming an existing chat), keep one provider type at a stable position holding a discriminated session, or persist and restore that state on purpose.
- A hook that branches on a mode argument (`useSurface({ kind })`) becomes explicit hooks or providers that share parts underneath.

## Minimal state

The general rule (derive, don't store) is in [state.md](state.md#you-might-not-need-state). For server data:

- Store IDs (`selectedUserId`) and resolve the entity from query data. Handle an ID that does not resolve.
- An edit form keeps the entity's ID and the user's overrides only. Display values and the submit input combine fetched data with those overrides, so a refetch never overwrites an edit. Track which fields are overridden so an empty string or `false` stays an override.
- A chat composer allocates the message ID on submit, not on each keystroke, and clears at once on an optimistic send. A failed message keeps its own retry in the transcript, read from the mutation cache with a scoped `useMutationState`; a retry never overwrites newer input.

## Rendering states

- A view decides from its data first: `data === undefined` means no data. An empty list or zero is data. Keep data on screen while refetching or after a refresh error, and show the error beside it. The presentation rules are in the `ui` skill's `references/async-states.md`.
- A disabled query is not loading. `isPending` alone does not mean a request is in flight.
- A workflow state (`connecting | connected | failed`) is a discriminated union whose variant fields live on their variant. Render it with an exhaustive `switch`, then `state satisfies never; return null`. No `default`, and no throwing `assertNever` in components. Do not force a query result into a universal `loading | error | success` wrapper; it loses combinations such as data plus a refresh error.
- Suspense is an explicit choice (`useSuspenseQuery`) with a pending, error, and reset boundary above the reader. Keep the suspending read near its consumer: pass a stable promise through context and `use()` it in the leaf. The suspending and ordinary readers share the same content, pending, and error parts.

## React Compiler

New React code targets React 19+ with the compiler on. Run its diagnostics (`eslint-plugin-react-hooks`, recommended preset) in CI and after React edits: a green build can hide a component the compiler declined to optimize. Fix the cause instead of disabling the rule or adding memoization. A `"use no memo"` opt-out carries a reason and a follow-up.

---

Adapted from Fernando Rojo's [nando-skill](https://github.com/nandorojo/nando-skill) (restated, not copied: the source has no license).
