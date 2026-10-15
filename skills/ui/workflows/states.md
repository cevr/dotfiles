# States

Render one component on a throwaway harness in every state it can be in. Mock data feeds each state, a switcher flips between them and the harness is deleted in one step when you are done. On the web the harness is a page; on Apple and Android it is a set of previews or a debug screen, per [harness](harness.md).

It is a workbench, not a review. The harness stays up while the user works on the visuals, one state on screen and every other a keypress away. Stacking hostile scenarios on one harness for a single look is [stress-test](stress-test.md), exploring alternative designs is [variants](variants.md) and reviewing finished work is [review](review.md).

## 1. Scope one component

One component per run: the audit log table, the network panel, the billing card. "The settings screen" spans several, so list them and ask which one.

Restate it in one sentence: what the component shows, where it renders in production and where its data comes from.

## 2. Find the states in the code

The states are the branches the component already has. Read it and its data hooks for every one:

| Kind | States |
| --- | --- |
| Data | Loading, empty, error, one item, a typical set, a set long enough to scroll or paginate, some requests resolved and others pending, stale data refetching |
| Account | Plan tier, role and permission checks, an owner versus a member |
| Feature | Flags, trials, limits reached, a disabled or locked feature |

A state the code cannot reach is not a state. Do not add a branch to render one. Where the design shows a state the code lacks, list it as missing and leave it out.

Write the set down before building, one line each, named the way the product talks about it: `empty`, `enterprise`, `member-no-access`. Group them under headings in the product's words, by what changes. Use `Data` and `Account` or narrower ones such as `Connection` or `Access`. The switcher shows these groups. Say which kinds you dropped and why in one line. Combine kinds only where the code branches on the combination, such as `member-empty`, never as a cross product.

## 3. Build the throwaway harness

The harness holds the real component, imported from the project and untouched. [Harness](harness.md#where-it-lives) gives the surface on each platform, what it inherits and the boundary trap that renders fixtures empty: a server/client split on the web, a view that builds its own model on Apple, a ViewModel-owning screen on Android.

Render one instance in a container as wide as the component is in production. The container, the fixtures and the switcher are everything the harness adds, with no fonts, styles or themes of its own. Keep the harness, its fixtures and its switcher in one place (a folder such as `/states/audit-log` on the web, one preview file beside the component on Apple and Android), so removal is one delete.

## 4. Feed each state at the data boundary

Supply the data where the component receives it, from the harness, without editing the component. In order of preference:

1. Inputs, where the component takes its data directly: props on the web, initializer parameters or a model on Apple, parameters or a UI state object on Android.
2. The app's own data seam: a seeded query cache, a mock provider, the project's request mocks, a preview repository or a fake injected through the app's dependency container.

A fixture threaded through inputs five levels down tests a path production never takes. Where the only way in is editing the component, say so and ask before adding a seam.

Make the data look like the product. Real-shaped names, timestamps, amounts and the item counts users actually have. Three rows of "Test item" make every state look fine.

Loading and pending states hold still. Keep them pending until the switcher moves, rather than resolving after a timeout.

## 5. Add the switcher

Every state is addressable, so one is on screen and any other is one step away:

| Web | Apple | Android |
| --- | --- | --- |
| A grouped list beside the component flips the `__state` search param, so every state is a link. Where there is no room beside the component, it moves above it as a select with the same groups. The double underscore keeps it clear of any param the app's layout reads | One `#Preview` per state, named for it; the canvas lists them. In the simulator, a debug screen reads the `__state` launch argument and carries a system picker | One `@Preview` per state, `name` for the state and `group` for its heading; the preview pane lists them. On the emulator, a debug activity reads a `__state` intent extra |

[switcher.md](states/switcher.md) holds the spec.

## 6. Confirm every state renders, then hand over

Render the harness once and flip through every state, using the renderer [harness](harness.md#looking-at-it) names for the platform. The component shows the mock data, not the real data and not a blank region. Mock data that never appears is the common failure here. Live sync, a cache that refetches over the seed, a server boundary dropping the fixture or a view that builds its own model all cause it. Fix the plumbing before handing over.

With no way to render at hand, say so and hand over what the user opens: the URL, or the preview file and names.

Then hand over where the harness is (the URL, the preview file, or the launch command for the debug screen), the state list and the switcher keys. Stop there. Changing how a state looks is the user's next request, not part of this one.

## Re-check every state after each change

After a visual change, flip through every state again, since a fix for one state often breaks another.

## Remove it in one step, on the user's word

Delete the harness (the page folder, the preview file or the debug screen and its entry point) and any seam the user approved. Then search the codebase for the route, preview and fixture names, and check that the diff touches nothing else of the setup. Commit only when asked.

## Before you finish

| Mistake | Fix |
| --- | --- |
| The component edited to accept fixtures | Feed data from the harness through the component's inputs or the app's data seam; ask before adding a seam |
| A rebuilt lookalike component in the harness | Import the real component from the project |
| The harness restyles or re-themes the component | The app's layout, fonts and tokens as they are |
| Fixtures passed as inputs deep in the tree | Supply the data where the component receives it |
| A branch added to the component to show a state | Leave out states the code cannot reach, and list missing ones |
| "Item 1", "Test user", three rows | Product-shaped data in real quantities |
| Loading resolves after a timeout | Hold it until the switcher moves |
| Handed over without loading each state | Load every state; a blank or real-data state means broken plumbing |
| Switcher styled with the project's tokens | Keep it visibly outside the design system |
| One long row of tabs, one per state | Web: a grouped list beside the component that scrolls on its own, a select above it where the list does not fit. Native: one named preview per state, grouped |
| Visuals changed unasked | Hand over and wait |
| Harness deleted in the same turn it was built | Remove it only on the user's word |
| Route, preview or fixture names left behind | Search for each after removal |
