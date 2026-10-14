# Solid 2

Read this before writing code for any `ui` task in a project whose `package.json` has `solid-js` (2.0 beta, rc or later). Every rule in the skill still holds: the values, the motion budget, accessibility, the theme-first order. Only the idiom changes. The skill's examples are React. This file maps each React idiom to Solid 2. It was checked against `solid-js` and `@solidjs/web` `2.0.0-rc.11`, as well as `2.0.0-beta.19` and `2.0.0-beta.20`. When unsure about an API, read the installed `node_modules/solid-js/CHEATSHEET.md`. It is the upstream 2.0 reference and lists the 1.x APIs that were removed. Solid 1 APIs and Solid 1 tutorials are wrong here.

## 1. Components and primitives

| React | Solid 2 |
| --- | --- |
| shadcn/ui, Radix, Base UI React, React Aria | The project's primitive package, e.g. `@bible/ui` (Base UI parts ported to Solid 2, one subpath per part: `import { Menu } from '@bible/ui/menu'`). The `shadcn` skill does not apply: there is no `components.json`, CLI, or registry. |
| `asChild` (Radix), `render={<a />}` (Base UI React) | `render={(props, state) => <a {...props} href="/x" />}`. Spread the merged props onto your element. |
| `className={(state) => …}` | `class={(state) => …}`. `style` takes a value or a function of state too. |
| `data-[state=open]:` (Radix) | Base UI names: `data-open`/`data-closed`, `data-starting-style`/`data-ending-style`, `data-highlighted`, `data-pressed`, `data-side`, `data-align`, `data-instant`. The package README lists each part's attributes. That list is the styling contract. |
| `var(--transform-origin)` (Base UI) | `@bible/ui` leaves the positioner CSS variables out. Derive the origin from `[data-side][data-align]` in CSS, or port the variable into the package first. |
| `lucide-react` | Inline SVG components that spread props, using `currentColor`. `lucide-solid` peer-locks to Solid 1. |

**When the package lacks a part:** (1) port the upstream Base UI part into the primitive package, keeping upstream's attribute names (the `@bible/ui` README: "a part returns with its first consumer"); (2) only then consider a third-party Solid library. Its health check has two steps: the peer range must accept `solid-js@2`, and a grep of its `dist` must find none of the removed APIs: `solid-js/web`, `solid-js/store`, `createResource`, `mergeProps`, `splitProps`, `createComputed`, `onMount`, `Suspense`, `classList`. As of 2026-10, Kobalte, Corvu, `solid-sonner`, `@solid-primitives/*`, `solid-transition-group`, `solid-motionone` and `lucide-solid` all peer-lock to `^1.x`.

**shadcn's composition rules still apply in concept:** items sit inside their group (`Menu.Item` inside `Menu.Group` with a `Menu.GroupLabel`); every dialog and drawer has a title (`Dialog.Title`, visually hidden if needed); 2–7 options use `ToggleGroup` + `Toggle`; overlays own their z-index; call-site `class` is for layout only, while color and type come from tokens.

## 2. Reactivity: what React performance advice means here

A component function runs once. Each JSX expression is its own subscription and writes only its DOM node. Nothing re-renders.

| React advice | In Solid 2 |
| --- | --- |
| `memo`, `useMemo`, `useCallback`, stable identities, "memoized leaf for a perpetual animation" | Not needed. Prefer CSS for perpetual motion anyway, because it runs off the main thread. Use `createMemo` only for an expensive derivation read in several places. |
| "Don't animate through state" | Still bites, for a different reason. A signal write per frame re-renders nothing, but it is queued, flushed on a microtask, and then updates every subscriber. In `pointermove`, `scroll` or rAF loops, write `el.style.transform` directly. A signal is fine for a value with one or two bindings that changes a few times a second. |
| `useMotionValue` / `useTransform` | A plain `let` plus a direct style write. `transform(inRange, outRange)` from `motion` returns the mapping function. |
| Still bites in Solid | A per-frame signal read by many nodes. A CSS variable on a parent that descendants read. A `<For>` over an array rebuilt every frame. A memo that allocates a new object every frame. Reading layout right after writing it. |
| `setX(v); x` reads the new value on the next render | `setX(v); x()` still returns the **old** value until the microtask flush. Use `flush()` or `flush(() => setX(v))` to apply it to the DOM synchronously (FLIP, View Transitions, focusing a just-shown element). Writes batch by default. `batch` is gone. |
| `useEffect(() => setB(f(a)), [a])` | Write `createMemo(() => f(a()))` or a plain function. Writing a signal in a component body, memo or effect compute **throws in dev**, and `untrack` does not exempt the write. |
| `useState(props.x)` plus a reset effect | `const [v, setV] = createSignal(() => props.x)`. This is a writable derived value that resets whenever `props.x` changes. |
| `key={v}` to remount (to replay an entrance) | `<Show when={v()} keyed>{(v) => <span class="pop">{v}</span>}</Show>` recreates the node whenever `v` changes. |
| Handler chosen per render: `onClick={a ? f : g}` | Handlers bind **once**. Put the choice inside a stable handler: `onClick={(e) => (a() ? f : g)(e)}`. |
| `useId` | `createUniqueId()` |

## 3. Classes, attributes, styling

| React | Solid 2 |
| --- | --- |
| `className` | `class`. There is no `className`. |
| `cn({ a: x })`, `classList` | `class={["base", props.class, { active: active() }]}`. Arrays and objects are native, and `classList` was removed. Don't concatenate class strings or use template literals. |
| `cn()` (clsx + tailwind-merge) | Use `cn()` when a caller's Tailwind class must override a utility in the same group. Only tailwind-merge resolves that conflict. clsx accepts Solid's array and object values. `cva` works unchanged. |
| `style={{ fontSize: 12 }}` | `style={{ "font-size": "12px" }}`. Keys are kebab-case and numbers get no `px`. CSS variables: `style={{ "--i": i() }}`. |
| `htmlFor`, `tabIndex`, `onDoubleClick` | `for`, `tabindex`, `onDblClick`. Built-in attribute names are lowercase. Event handlers stay camelCase. |
| `value` + `onChange` (controlled input) | `value={v()}` + `onInput`. `onChange` is the native change event, which fires on commit. There are no controlled-input warnings. |
| `data-active={on ? '' : undefined}` | `data-active={on()}`: `true` renders `""` and `false` removes the attribute. This matches the skill's data-attribute rule and `data-[active]:` variants. |
| `aria-pressed={pressed}` | **`aria-pressed={pressed() ? "true" : "false"}`**. A boolean `false` removes the attribute, and `aria-pressed`, `aria-expanded`, `aria-checked` and `aria-selected` need the literal `"false"`. |

A variant component, Solid style:

```tsx
import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/cn";

const button = cva("inline-flex items-center gap-2 transition-transform duration-150 ease-out enabled:active:scale-[0.96]", {
  variants: { tone: { primary: "bg-accent text-on-accent", quiet: "bg-transparent text-fg" } },
  defaultVariants: { tone: "primary" },
});

type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>;

export function Button(props: ButtonProps) {
  const rest = omit(props, "class", "tone"); // a live view; never destructure props
  return <button type="button" {...rest} class={cn(button({ tone: props.tone }), props.class)} />;
}
```

## 4. Refs, DOM access, lifecycle

| React | Solid 2 |
| --- | --- |
| `const ref = useRef<HTMLDivElement>(null)` + `ref={ref}` | `let el!: HTMLDivElement;` + `ref={el}`. The compiler turns that into an assignment for a single ref only. Or use `ref={(el) => …}`. |
| `useRef` holding a mutable value | A plain `let` in the component body, since the body runs once. |
| `forwardRef`, merging refs | `ref` is an ordinary prop, and a parent's `ref={el}` arrives as a callback. Combine with `ref={[(n) => (el = n), props.ref]}`. Array entries must be callbacks, and falsy entries are skipped. The beta types reject an `undefined` entry and the rc types accept it. |
| `useEffect(fn, [])` (mount and teardown) | `onSettled(() => { …; return cleanup; })`. It runs once the first render settles, never on the server. |
| `useEffect(fn, [dep])` | `createEffect(() => dep(), (value, prev) => { …; return cleanup; })`. The compute tracks dependencies and the apply runs untracked. `{ defer: true }` skips the first run. The one-argument form is an error. |
| `useLayoutEffect` (measure before paint) | A `createEffect` apply runs after the DOM writes of the same flush, so the element is in place. Use `createRenderEffect` only for renderer plumbing. |
| Cleanup | Return a function from the apply or from `onSettled`. `onCleanup` is for reactive internals. |
| `use:directive` (Solid 1) | A ref factory: `ref={tooltip({ content })}`, or an array to compose several. |
| `addEventListener` with options | `ref={(el) => el.addEventListener("wheel", h, { passive: false })}` |

Observers belong in `onSettled`, which receives the element from a ref. Writing a signal from an observer callback, a ref callback or an effect apply is allowed.

```tsx
import { createSignal, onSettled, type ParentProps } from "solid-js";

function Reveal(props: ParentProps) {
  let el!: HTMLDivElement;
  const [seen, setSeen] = createSignal(false);
  onSettled(() => {
    const io = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) { setSeen(true); io.disconnect(); } // once
    }, { rootMargin: "0px 0px -100px 0px" });
    io.observe(el);
    return () => io.disconnect();
  });
  return <div ref={el} class="reveal" data-visible={seen()}>{props.children}</div>;
}
```

## 5. Motion

Choose the tool in the skill's order: CSS transition, then `@starting-style`, then CSS animation, then WAAPI (`el.animate()`), then **Motion's framework-agnostic `animate()`** from `motion`, never `motion/react`. `motion@14.2` has an optional React peer and exports `animate`, `stagger`, `spring`, `inView`, `scroll`, `hover`, `press`, `transform`, `animateView` and `animateLayout` from its root. `motion` also exports a `createEffect`, so import Solid's from `solid-js`. Solid 1 animation libraries do not run on Solid 2.

| React / `motion/react` | Solid 2 |
| --- | --- |
| `motion.div animate={…}` driven by state | A CSS transition keyed on a `data-*` attribute. |
| `AnimatePresence` around primitive popups | Nothing to add. `@bible/ui` parts set `data-starting-style`/`data-ending-style` and unmount after `getAnimations()` finish, so the skill's popover, menu, modal, drawer and toast CSS recipes apply verbatim. |
| `AnimatePresence` around your own conditional | An element that may stay in the DOM: `hidden={!open()}` with `transition-behavior: allow-discrete` on `display`. One that must unmount: `createPresence` (below). |
| `initial={false}` | This is the default for state swaps when both states are in the DOM: nothing animates at mount. `@starting-style` **does** run on first mount, including server-rendered markup on page load, so reserve it for things that mount later. |
| `mode="popLayout"` (swap without layout shift) | Stack both states in one grid cell (`grid-area: 1/1`) and cross-fade them. |
| `exit={{ … }}` | `[data-ending-style] { … }`, kept shorter and smaller than the enter (the skill's exit values). |
| `layout` | `animateLayout(() => flush(() => setX(v)))` on elements marked `data-layout` (types verified, runtime unverified), or FLIP: measure, `flush(() => set…)`, measure again, `el.animate()` the inverse. |
| `layoutId` (shared element) | View Transitions: `style={{ "view-transition-name": \`card-${id}\` }}` and `document.startViewTransition(() => flush(() => setOpen(id)))`. Without `flush` the DOM is not updated inside the callback. Or Motion's `data-layout-id` with `animateLayout`. |
| `whileTap`, `whileHover` | `enabled:active:scale-[0.96]`. Gate `:hover` behind `@media (hover: hover)`. |
| `useSpring` (cursor-following) | `animate(el, { x }, { type: "spring", … })` from each `pointermove`, or `springValue` (exported, unverified in Solid). |
| `useInView({ once, margin })` | `IntersectionObserver` in `onSettled` (section 4), or `inView(el, cb, { margin: "-100px" })`. It returns its stop function, which `onSettled` can return. |
| `useScroll` | CSS scroll-driven animation (`animation-timeline: view()`), or `scroll()` from `motion`. |
| `staggerChildren` | A CSS delay from the `<For>` index (below), or `animate(els, kf, { delay: stagger(0.05) })`. |
| `<MotionConfig reducedMotion="user">` | CSS `prefers-reduced-motion` and the `motion-safe:` variant. Vanilla `animate()` follows the device setting for transforms by default (`reduceMotion` option). Blur still runs, so branch `filter` on `matchMedia`. |

**Icon cross-fade.** Both icons stay mounted, so the swap animates with no entrance on first render:

```tsx
export function CopyButton(props: { copied: boolean; onCopy: () => void }) {
  return (
    <button type="button" class="icon-swap" data-copied={props.copied}
      aria-label={props.copied ? "Copied" : "Copy"} onClick={() => props.onCopy()}>
      <span class="icon-swap-layer" data-layer="idle"><CopyIcon /></span>
      <span class="icon-swap-layer" data-layer="done"><CheckIcon /></span>
    </button>
  );
}
```

```css
.icon-swap { display: grid; place-items: center; }
.icon-swap-layer { grid-area: 1 / 1; transition: opacity 300ms, scale 300ms, filter 300ms; transition-timing-function: cubic-bezier(0.2, 0, 0, 1); }
.icon-swap:not([data-copied]) [data-layer="done"],
.icon-swap[data-copied] [data-layer="idle"] { opacity: 0; scale: 0.25; filter: blur(4px); }
@media (prefers-reduced-motion: reduce) { .icon-swap-layer { scale: 1; filter: none; } }
```

**Enter and exit of a conditional element** (the `AnimatePresence` equivalent, modeled on `@bible/ui`'s `internals/transitions.ts`). CSS `@starting-style` handles the enter. The primitive keeps the element mounted while `data-ending-style` transitions run:

```tsx
import { type Accessor, createEffect, createSignal, untrack } from "solid-js";

export function createPresence(open: Accessor<boolean>) {
  const [mounted, setMounted] = createSignal(untrack(open));
  let el: HTMLElement | undefined;
  createEffect(open, (isOpen) => {
    if (isOpen) return void setMounted(true);
    const node = el;
    if (!node) return void setMounted(false);
    let live = true;
    // One frame later Solid has flushed data-ending-style; getAnimations() flushes style and sees the exit.
    const frame = requestAnimationFrame(() => {
      const exits = node.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity);
      void Promise.allSettled(exits.map((a) => a.finished)).then(() => live && setMounted(false));
    });
    return () => { live = false; cancelAnimationFrame(frame); }; // reopened mid-exit: stay
  }, { defer: true });
  return { mounted, ending: () => mounted() && !open(), ref: (n: HTMLElement) => void (el = n) };
}

// Usage
const p = createPresence(() => props.open);
<Show when={p.mounted()}>
  <div ref={p.ref} class="notice" data-ending-style={p.ending()}>Saved</div>
</Show>
```

```css
.notice { transition: opacity 200ms var(--ease-out), translate 200ms var(--ease-out); }
@starting-style { .notice { opacity: 0; translate: 0 8px; } }
.notice[data-ending-style] { opacity: 0; translate: 0 -12px; transition-duration: 150ms; }
```

**Staggered list entrance.** The `<For>` index feeds the delay, and the hidden state lives in the keyframe, as in the skill's recipe:

```tsx
<ul>
  <For each={items()}>{(item, i) => <li class="item" style={{ "--i": i() }}>{item.name}</li>}</For>
</ul>
```

```css
.item { animation: fade-in 300ms var(--ease-out) both; animation-delay: calc(min(var(--i), 8) * 50ms); }
@media (prefers-reduced-motion: no-preference) { .item { animation-name: item-in; } }
```

**Press scale.** Write the same CSS with `class` instead of `className`: `class="transition-transform duration-150 ease-out enabled:active:scale-[0.96]"`. Replace the skill's `static` boolean prop with an explicit variant (`tone`, or a `PlainButton`).

**Drag with velocity handoff.** Use pointer events and direct style writes, with no signal per frame, then hand the release velocity to a Motion spring that starts from the on-screen value:

```tsx
import { animate } from "motion";
import type { ParentProps } from "solid-js";

const FLICK = 110; // px/s: the skill's 0.11 px/ms

export function Sheet(props: ParentProps<{ onDismiss: () => void }>) {
  let el!: HTMLDivElement;
  let y = 0, from = 0, lastY = 0, lastT = 0, v = 0;
  let settle: ReturnType<typeof animate> | undefined;
  const down = (e: PointerEvent) => {
    const t = getComputedStyle(el).transform; // interrupt from where it is now
    y = t === "none" ? 0 : new DOMMatrix(t).m42;
    settle?.stop();
    el.setPointerCapture(e.pointerId);
    from = e.clientY - y; lastY = e.clientY; lastT = e.timeStamp; v = 0;
  };
  const move = (e: PointerEvent) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    y = Math.max(0, e.clientY - from);
    if (e.timeStamp > lastT) v = ((e.clientY - lastY) / (e.timeStamp - lastT)) * 1000;
    lastY = e.clientY; lastT = e.timeStamp;
    el.style.transform = `translateY(${y}px)`;
  };
  const up = (e: PointerEvent) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    const commit = Math.abs(v) > FLICK ? v > 0 : y > el.offsetHeight / 2; // velocity sign first
    settle = animate(el, { y: [y, commit ? el.offsetHeight : 0] },
      { type: "spring", velocity: v, bounce: 0, visualDuration: 0.3 });
    if (commit) void settle.then(() => props.onDismiss());
  };
  return (
    <div ref={el} class="sheet touch-none" onPointerDown={down} onPointerMove={move}
      onPointerUp={up} onPointerCancel={up}>{props.children}</div>
  );
}
```

Before hand-rolling a sheet, check the primitive package. `@bible/ui/drawer` already handles swipe-to-dismiss and exposes `--drawer-swipe-movement-y`.

## 6. Async, optimistic UI, URL state

| React | Solid 2 |
| --- | --- |
| `<Suspense>` | `<Loading fallback={…}>`. Once content has rendered, revalidation keeps it visible. `on={id()}` is a dependency list: when it changes and something under the boundary is pending, the fallback shows again. |
| `<ErrorBoundary>` | `<Errored fallback={(err, reset) => …}>`. `err` is an accessor. |
| `use(promise)`, react-query reads | An async memo, `createMemo(() => fetchUser(id()))`, read under `<Loading>`. In bible-tools use `@bible/atom-solid` (`useAtomValue`, `useAtomSuspense`). `@solidjs/router` 2 has `query()` and no `createAsync`. |
| `useTransition`, `isPending` | Transitions are built in. `isPending(() => x())` is true while a **change** is in flight. `latest(x)` keeps the last settled value. Together they give stale-while-revalidate: dim the old rows with `data-pending={isPending(() => rows())}` (see `apps/egw-search/src/app.tsx`). |
| `useOptimistic` | `createOptimistic` / `createOptimisticStore` written inside an `action(function* …)`. The optimistic value reverts when the action settles, and `refresh(source)` reconciles it with the source. A "saving…" label is a co-written `createOptimistic(false)` flag, not `isPending`. |
| `nuqs` | `@bible/url-state`, which follows the nuqs model with Effect Schema codecs and an atom binding, where the repo has it. Otherwise `useSearchParams()` from `@solidjs/router`. 2.0-next adds a typed overload over a Standard Schema path. |

```ts
const [comments, setComments] = createOptimisticStore(() => api.comments(postId()), []);
const post = action(function* (text: string) {
  setComments((s) => { s.push({ id: crypto.randomUUID(), text, pending: true }); }); // shown now
  yield api.addComment(postId(), text);
  refresh(comments);
});
```

`action` from `solid-js` is a different thing from `@solidjs/router`'s form or server `action`. Import the one you mean.

## 7. Portals and theme scope

| React | Solid 2 |
| --- | --- |
| `createPortal(node, target)` | `<Portal mount={target}>` from `@solidjs/web` (default `document.body`). Its only props are `mount` and `children`. It inserts children with **no wrapper element**, so a theme class has nowhere to go but the child's own root. It renders nothing on the server and fills in after hydration. |
| Radix or Base UI `Portal container` | `@bible/ui`'s `X.Portal` renders a `<div>` at the end of `<body>`. Add `inline` to render it where it is written instead: it then inherits the subtree's CSS variables and is included in the server markup. Use it for a `position: fixed` popup under no `transform`, `filter` or `contain`. |

Theming follows the skill's rule: put mode and theme variables on `<html>` (or `:root`) so that portalled popups, dialogs and toasts at the end of `<body>` inherit them. If a theme is scoped to a subtree, use `inline`, or repeat its class or `data-theme` on the portal's root element. Context crosses portals because it follows the owner tree; CSS inheritance does not.

## 8. SSR and hydration

- **`"use client"` maps to nothing.** Components are isomorphic and there are no server components. Browser-only code goes in `onSettled` or a `createEffect` apply; neither runs on the server. The `createRenderEffect` apply *does* run there. Guard anything else with `isServer` from `@solidjs/web`.
- **Hydration does not patch attributes.** While a node hydrates, `class`, `style` and attribute bindings keep the server's value, silently, until the value next changes. A mode, locale, `Date.now()`, `matchMedia` or `localStorage` value that differs on the client therefore leaves stale markup instead of raising a warning. Render a server-safe value and switch to the real one in `onSettled`, or use `@bible/atom-solid`'s `Atom.withServerValue`. Set the theme mode on `<html>` with an inline script before first paint.
- A typed field must never reset when its server value arrives. Bind `value` once and update it through `onInput`.
- No project here uses SolidStart. bible-tools renders with `renderToStream` and `hydrate` (`packages/film/src/lab/page-server.tsx`, `page-client.tsx`). SolidStart on Solid 2 is unverified.

## 9. Composition (the `composition-patterns` rules in Solid 2)

| Rule | Solid 2 |
| --- | --- |
| Compound components | One context and a namespace object: `export const Composer = { Provider, Frame, Input, Submit }` (`@bible/ui` uses `export * as Toast from './index.parts.ts'`). The context is its own provider: `<Ctx value={…}>`. `Ctx.Provider` is gone. |
| Context interface (`state` / `actions` / `meta`) | The same shape, with `state` holding **accessors or a store**, because a context value is not reactive by itself. `createContext<T>()` with no default throws outside its provider, and `useContext` is typed `T`, so write no `useX` null-check wrapper. |
| Decouple state, lift state | The same. The provider is the only code that knows whether state comes from signals, a store, an atom or the URL. |
| Avoid boolean props, explicit variants | The same reasoning. A `cva` variant or a named component (`ThreadComposer`), never `isThread`. |
| Children over render props | The same, for content slots. `@bible/ui`'s `render` prop is the `asChild` replacement for swapping the element, not a content slot. Each read of `props.children` creates new nodes, so resolve once with `children(() => props.children)` when you need to inspect or reuse them. |
| No `forwardRef`, `use()` over `useContext` | `ref` is a plain prop (section 4). `useContext` is the only reader. |
| `mergeProps` / `splitProps` / default props | `merge(defaults, props)` and `omit(props, "class", "tone")`. Both return live views. In `merge`, an explicit `undefined` **overrides** a default. Never destructure props: `function C({ value })` freezes `value` (dev warns). |
| Pass values, not accessors | `<Counter value={count()} />`, not `value={count}`. To forward a getter on purpose, name it as one: `getValue={() => count()}`. |

```tsx
import { createContext, useContext, type Accessor, type ParentProps } from "solid-js";

interface ComposerApi {
  state: { input: Accessor<string>; submitting: Accessor<boolean> };
  actions: { update(text: string): void; submit(): void };
  meta: { inputRef(el: HTMLTextAreaElement): void };
}
const ComposerContext = createContext<ComposerApi>();

function Provider(props: ParentProps<{ value: ComposerApi }>) {
  return <ComposerContext value={props.value}>{props.children}</ComposerContext>;
}
function Input() {
  const { state, actions, meta } = useContext(ComposerContext); // a plain object of functions: safe to destructure
  return <textarea ref={meta.inputRef} value={state.input()} onInput={(e) => actions.update(e.currentTarget.value)} />;
}
```

## 10. Toasts

Sonner is React-only. In Solid use `@bible/ui/toast`, or port its parts into the project's primitive package.

| Sonner | `@bible/ui/toast` |
| --- | --- |
| One `<Toaster />` at the root | One `<Toast.Provider toastManager={manager}>` → `<Toast.Portal>` → `<Toast.Viewport>` → `<For each={Toast.useToastManager().toasts} keyed={(t) => t.id}>` → `<Toast.Root toast={t()}>`. The manager comes from `Toast.createToastManager()` at app scope. |
| `toast("…")`, `toast.success` | `manager.add({ title, type: "success" })` returns the id. `type` becomes `data-type` on every part. |
| Update by id / `toast.dismiss(id)` | `add({ id, … })` updates the toast in place and restarts its timer / `manager.close(id)` |
| `duration` (default 4000), `Infinity` | `timeout` (default 5000), `0` to persist |
| `action: { label, onClick }` | `actionProps: { children: label, onClick }` plus `<Toast.Action />` |
| `description`, `toast.promise`, `loading` | Not ported. Add with `timeout: 0`, then `add` again with the same id and the result. |
| `classNames` + `!important` | Unstyled. Style it with `class` and `data-type`, `data-starting-style`/`data-ending-style`, `data-swiping`, `data-swipe-direction`, `data-expanded`, `data-behind` and `data-limited`. |
| `onDismiss` / `onAutoClose` | `onRemove`, which fires after the exit animation. |

These Sonner rules still apply: mount one provider; fire toasts from event handlers or actions, never from effects; toasts carrying an action or an error persist, and those that time out show for at least 5 s; a toast exits through the edge it entered (`swipeDirection`). The viewport is a polite live region. `@bible/ui` dropped `priority`, so an error that must interrupt needs its own `role="alert"` region.

## 11. Review checklist (Solid-specific)

- Imports: Solid 1 paths (`solid-js/web`, `solid-js/store`) or removed APIs (`createResource`, `createComputed`, `onMount`, `batch`, `mergeProps`, `splitProps`, `Suspense`, `ErrorBoundary`, `Index`, `classList`, `use:`, `Context.Provider`). `<Dynamic>` is deprecated in rc; use `dynamic()`.
- A destructured prop, an accessor passed where a value belongs (`value={count}`), or a reactive read at the top of a component body or `<For>`/`<Show>` callback, which freezes at its first value.
- An effect used to derive state, a one-argument `createEffect`, or a signal written from a component body or memo.
- A boolean `aria-*` that disappears when `false`. A `className`, a camelCase `style` key, or a number style value expecting `px`.
- A handler chosen by a ternary at bind time.
- Per-frame signal writes in pointer, scroll or rAF code where a direct style write would do.
- `motion/react` or `framer-motion` imports, or a Solid 1 animation or component library installed.
- A DOM read straight after a signal write without `flush()`, including inside `startViewTransition`.
- A browser-only value read during render on an SSR page.
- A hand-rolled dialog, menu, toast or drawer where the primitive package has the part, or a portalled surface that lost the theme.
