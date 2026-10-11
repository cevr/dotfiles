# UI guidance

For any repo with a UI. The loop's `ui guidance` sweep reads it, UI batches build by it, and their reviewers check against it. It gathers four guides the owner chose (2026-10-11):

- **shadcn**: `~/.claude/skills/shadcn/SKILL.md` and `rules/*.md`. Its design rules, not its CLI. In a repo without `components.json`, never run `shadcn init`, `add` or `apply`. Run `bunx --bun shadcn@latest docs|view <part>` from a scratch directory outside the repo to read a part's anatomy. Its Base UI flavour is the one to read when the repo's primitives are Base UI.
- **Graphical**: `~/Developer/personal/dotfiles/design/graphical-untitled/GUI.md` (→ Rules for UI work) and `gui/interface-judgment.md`, `gui/foundations.md`, `gui/base-ui.md`, `gui/custom-components.md`, with the global skills `graphical-ui`, `graphical-audit` and `graphical-convert`. Its rules apply. Its theme values do not, unless the owner chose a conversion.
- **composition-patterns**: `~/.claude/skills/composition-patterns/` (`AGENTS.md` has every rule).
- **react**: `~/.claude/skills/react/SKILL.md` and `references/*.md`.

**Scope (owner):** "mostly about guidance - i think our ui is fine but this could improve it." The guides improve what exists. Never restyle or restructure working UI only to match them. The project's own design language and `NORTH_STAR.md` win a conflict. Name the conflict, don't count it as a finding.

**Solid (owner: "insofar as it relates to solid"):** composition-patterns and react are written for React. In a Solid repo, take the idea, not the React mechanics, through the map below. A React-only rule with no Solid meaning is skipped, never imitated.

## Design (shadcn, Graphical)

- Use existing parts first. Compose; don't reinvent. A part the kit lacks is added to the kit, not drawn once in a page.
- Use variants before custom styles. A call site sets layout only, never a part's colour or type.
- Semantic tokens only: no raw values, no page-local colours, no hand-written dark overrides, no invented scale steps.
- Spacing comes from `gap`. Truncation uses one kit rule. Overlays own their stacking. Items sit inside their group.
- Every dialog, drawer and sheet has a title. Option sets of 2–7 choices are a toggle group. A busy button is a spinner plus `disabled`. Status uses a badge part, callouts an alert part, empty states an empty part.
- A field groups its label, control, description and error. Invalid is shown by `data-invalid` and `aria-invalid`. An error is visible text, never only a `title`.
- Icons are passed as components. The part places and sizes them. A glyph never names a button.
- Interface judgment: titles that inform, no filler subtitles or slogans, one home per piece of information, `text-wrap: pretty` for interface text.
- Keyboard focus, accessible names, live feedback for failures, and theme in portals are kept intact through every change.

## Composition (composition-patterns → Solid)

| Rule | In Solid |
| --- | --- |
| Avoid boolean props that switch behaviour | Same. Use explicit variant parts or compound parts. A `mode`/`isX` prop that forks a component's body is a finding. |
| Compound components with shared context | Same: `createContext` in the part, with a `state` / `actions` / `meta` interface. Sub-parts read the context, not props threaded down. |
| Decouple state from UI | Same. The provider (or the atom or machine behind it) is the only place that knows how state is held. Parts read through the interface, so a test or a second source can swap it. |
| Lift state for sibling access | Same. Lift into the provider, or into an atom when several pages share it. Never sync siblings through effects. |
| `children` over render props | Same. A render prop is right only when the parent passes data to the child. Base UI's `render` prop for a custom trigger is the documented case. |
| React 19: no `forwardRef`, `use()` over `useContext` | Not applicable. Solid refs are plain props, and context is read with `useContext`. |

## State and async (react → Solid)

| React rule | In Solid |
| --- | --- |
| You might not need an effect: derive during render | Derive with a plain function or a memo. Never write a signal from an effect to mirror another. Effects reach the outside world only: DOM, network, storage. |
| You might not need state | Same. A value derived from props, the URL or another signal is not state. |
| No boolean explosions; discriminated unions; reducers; guarded transitions; events named for what happened | Same. Use a `status`-tagged union, a machine for flows with guarded transitions, and events like `submitted`, not `set_loading`. |
| Colocation: local → lifted → context → store; URL for shareable state | Same order. Shareable, citable state lives in the URL through the repo's URL-state layer. Per-viewer state is named as such. |
| Functional `setState` | Setters take an updater, and stores take a producer. Never read a signal and write it back in two steps. |
| `use()`, Suspense, `useTransition`, `useOptimistic` | Use Solid's async primitives: async memos, the loading/suspense boundary, pending state, optimistic writes. Check the installed Solid version's API before using one. A value the server cannot know is computed on the client by the repo's one pattern for it, never left to mismatch on hydration. |
| `memo`, `useMemo`, `useCallback`, re-render tuning | Not applicable. Components run once and updates are fine-grained. Keep instead: create no components inside components; for per-frame values (scrub, playhead, pointer), write the DOM directly or batch, rather than a signal per frame. |
| Lazy init, barrel imports, `.toSorted()`, one loop over many `.filter()`s, cached storage reads | Same. |
| Stable handlers (`useLatest`, refs) | Mostly unneeded, since components run once. Read props lazily (`props.x` inside the handler). Never destructure props: that drops reactivity. |
| Dedupe global listeners; `{ passive: true }` on scroll and touch | Same. One shared subscription per global event, cleaned up by the owner (`onCleanup`). |
| `{count && <Badge/>}` renders `0` | Use `<Show when={count > 0}>`. |

## For each role

- **Sweep** (`ui guidance`, every pass, one agent): sweep the UI against each section above. Every finding gets an id, its rule, a file:line receipt read in the code, the repair in the repo's terms, a severity (P1: an accessibility break, a state bug or a user-visible inconsistency; P2: a hand-rolled duplicate, a boolean-mode component, or state synced instead of derived; P3: hygiene) and the batch that owns the file. Under the owner's scope, P1s and the P2s that clearly help become batch items. P3s go to the follow-ups.
- **Apply:** UI changes follow this guide. Apply it to the lines you change. Restyle nothing you don't touch.
- **Counsel:** for a UI batch, add the question "Do the changed lines follow `ui-guidance.md`? Name each violation the change adds, with file:line." A violation the change adds is a Minor (a Major if it breaks accessibility or state). One the change found and left alone is out of scope.
