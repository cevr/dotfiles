# Queue

The agent keeps a live list of what it has going: the `queue` tool sets it, patches it by item id and answers the list as it stands; each item has a state (`needs-you`, `running`, `waiting`, `scheduled`, `next`, `done`), an owner and optionally the subagent session doing it. The `dotfiles-opencode.queue` RPC answers a session's queue with a revision that rises with every change, a subagent's queue is its own, a reload keeps it, and a deleted session's queue goes. An item may name what it waits on (`after`) and what follows each of its outcomes (`on`), the unit it belongs to (`unit`) and a level (`red`, `amber`, `green`; `""` clears either). Each item a change adds, changes or removes is one line in the host's digest log (`~/.local/state/opencode-digest`, through the digest plugin's RPC); a digest that is not up never fails the tool. The sidebar's Queue section draws the root session's items; in the Prime look the dock under the composer counts them (`4 queued, 1 needs you`) and `/queue` (or `/ledger`), or a click on that count, opens the composer panel's Queue tab: the queue as a plan, each item with its outcomes (`on accepted ⇥ …`) and what waits on it nested under it.

## Sub-features

- `queue-set`: `{ set: [...] }` replaces the calling session's list and answers it.
- `queue-patch`: `{ upsert, remove }` patches it by id; the same change twice records nothing.
- `queue-refuse`: an unknown state, a duplicate or an unknown id is a tool error that changes nothing.
- `queue-rpc`: `get({ sessionID })` answers `{ revision, items }`.
- `queue-own`: a subagent's queue is apart from its parent's.
- `queue-keep`: a reload keeps it; a deleted session's queue goes.
- `queue-sidebar`: the sidebar's Queue section, one line an item, a linked subagent's live state as its mark.
- `queue-links`: `after` and `on` are stored as written, kept when a patch leaves them out, cleared by `[]` and `{}`.
- `queue-stale`: every 10 minutes (the first pass 5 minutes after start) the server sweeps this location's root sessions changed in the last day; one whose queue holds stale items (a linked subagent ended or gone while the item runs or waits, a wake or monitor it names ended, a needs-you with no open question, an item untouched 6 h) or more than 25 open items gets one steered `Queue check` note listing them with why, waking it when idle, else read at its next turn; at most one note an hour per session, the same ask again after 6 h, 3 notes a pass. It never changes a queue; an upsert that restates an item marks it checked without a new revision.
- `queue-tab`: the dock's `N queued` count and the Queue tab (`/queue`, `/ledger`, a click on the count), the plan drawn there and none of it in the transcript; ctrl+o on a linked item opens its subagent's session.
- `queue-answer`: an item may carry `choices` (at most 4 `{label, description?}`, `[]` clears). Enter (or a click) on an item in the Queue tab, or a click on a sidebar row, opens the host's question form with its choices, else `Done / no longer needed` and `Still needed`, and `Type your own answer`; the submit reaches the session that owns the queue as one steered message `Owner on queue item <id> (<text>): <answer>` that wakes it (metadata kind `answer`, notice `Queue answer: <id>`). The item only records `answered` (the tab adds `· answered: <answer>`) until the agent's next write of it.

## How to get to it (user POV)

- The agent calls `queue` directly (it is a direct tool, offered without code mode).
- From a kernel cell, `tools.queue(...)`, when the kernel plugin is loaded.
- The user reads it in the Queue tab: `/queue` or `/ledger`, or a click on the dock's `N queued` (Prime, with the queue's server plugin loaded).
- The user reads it in the sidebar's Queue section (the TUI plugin `cmd/queue`; `bun run daily` leaves it out of the owner's `cli.json`, the scratch root's has it).

## Driving it with the world

- **Preconditions:** none beyond the baseline.
- **States:** default (an empty queue), refused, and a reload. Loading and error are `n/a` (a memory store).
- **World suites:** `cmd/queue/queue.sim.test.ts`
- **Code:** `mods/queue/`, `cmd/queue/`, `sim/`; `scenarios/queue-panel.ts`, `tests/queue-panel.test.ts` (the Queue tab in a real TUI); `tests/owned.ts`, `tests/scratch.ts` (the spawn helper and scratch folders its real checks run through: a change to them is due on every such check)
- **Regression:** `cmd/queue/server.test.ts` (the seam), `mods/queue/queue.test.ts` (the aggregate), `mods/queue/item.test.ts` (the links), `mods/queue/plan.test.ts` (the plan the Queue tab draws), `mods/queue/stale.test.ts` (which items look stale, the cadence, the note), `mods/queue/memory/fresh.test.ts` (the sweep on the test clock), `mods/queue/opencode/host.test.ts` (what the sweep reads of the host), `mods/queue/answer.test.ts` (the answer form and its reply), `mods/queue/memory/answer.test.ts` (choices and the answer's delivery on the model), `mods/queue/opencode/answer.test.ts` (opening the form).

1. **Set.** Prompt `verify: call queue {"set":[{"id":"pool","text":"Sidebar pool worker","state":"running"},{"id":"panes","text":"Close old Claude panes","state":"needs-you"}]}`. The tool answers `Queue (2):` with `● pool [running]: Sidebar pool worker` and `! panes [needs-you]: Close old Claude panes`; the RPC answers revision 1.
2. **Patch.** Prompt `verify: call queue {"upsert":[{"id":"panes","state":"done"}]}`. The RPC answers revision 2, `panes` done.
3. **Refuse.** Prompt `verify: call queue {"upsert":[{"id":"pool","state":"blocked"}]}` then `verify: say refused as it should be`. The tool's error names `unknown state "blocked"`; the revision stays 2.
4. **Own, keep, go.** A child session's `set` stays in its own queue; after `world.restart` the root's queue is the same; after `world.remove(root)` the RPC answers revision 0, no items.

## Driving it with real OpenCode

- **Real:** `tests/queue.test.ts`, `tests/queue-panel.test.ts`, `scenarios/queue-panel.ts`

1. **Set.** Type `verify: call queue {"set":[{"id":"pool","text":"Sidebar pool worker","state":"running"},{"id":"panes","text":"Close old Claude panes","state":"needs-you"}]}` and press Enter. Wait for `call(s) done`. The call shows folded as `+ 1 tool`, and the turn's last line reads `verify: 1 call(s) done; the last answered: ! panes needs-you: Close old Claude panes` (the markdown view drops the answer's brackets around the state).
2. **Sidebar.** With the sidebar open (the TUI's own toggle; it opens by itself on a wide terminal: `pilotty resize -s verify-$PORT 200 50`), its Queue section lists `pool` and `panes`, one line each.
3. **Patch.** Type `verify: call queue {"upsert":[{"id":"panes","state":"done"}]}`, Enter. The turn ends `the last answered: ✓ panes done: Close old Claude panes`, and within the sidebar's two-second read its `panes` line turns from `!` to `✓`. Every turn says `1 call(s)`: wait on `✓ panes done`, not on a count.
4. **Queue tab.** Type `/queue`, Enter. The composer panel opens on `Queue 1` and lists `● Sidebar pool worker · running` above `✓ Close old Claude panes · done`, none of it in the transcript. Escape puts it away; a click on the dock's `1 queued` opens it again.
5. **Answer.** In the Queue tab, Enter on `Sidebar pool worker`: the question form shows `Done / no longer needed`, `Still needed` and `Type your own answer`; pick `Still needed`. The agent's next turn reads `Owner on queue item pool (Sidebar pool worker): Still needed`, and `/queue` shows `· answered: Still needed` on that item.
6. **Proof.** After steps 1, 3, 4 and 5, `pilotty snapshot -s verify-$PORT --format text > $EVIDENCE/queue/<step>.txt`.

## Gotchas

- Items are matched by `id`; `upsert` of an unknown id adds it, `remove` of an unknown id is refused.
- A `scheduled` item needs `at` (ISO 8601); without it the call is refused.
- The sidebar shows the route's root session's queue only: a subagent's items never draw there.
- A change to `cmd/queue/server.ts` or a file it imports runs `tests/queue-panel.test.ts` among its focused checks: a server plugin that fails to load shows nowhere else (the tool call folds to `+ 1 tool`, the dock never counts), and the seam tests start it on a stand-in host. The server's log says why: `failed to load plugin … cmd/queue`.
- At run time OpenCode gives the plugin only `effect` and `@opencode/plugin`; any other package resolves through the checkout's node_modules links, which point nowhere in a copy (a verifier's or a workspace's before `scripts/link-fork.ts`). Import other packages for types only; `cmd/queue/server.test.ts` checks it.
- On the world, a child that ends wakes its parent with a report, so the parent's turn count grows: wait for "at least" the texts you expect, not an exact count, once a child has run.
