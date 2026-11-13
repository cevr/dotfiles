# OpenCode mods verification map

The maintained source for verifying what our mods do for a user and an agent. Read this index before driving, then use the matching feature file as the recipe. `bun run verify:drive` reads the files' `World suites`, `Real` and `Code` lines (`scripts/verify-map.ts`), and the docs guard (`scripts/verify-docs.test.ts`) holds every path and command they name to the tree.

## Baseline

- **The world**: nothing to seed. A suite makes its world (`World.make({ seed, script })`), loads the plugins from `sim/plugins.ts` and drives sessions by prompts; the verify model (`worldScript`, `sim/verify-world.ts`) does what a prompt's `verify:` lines say.
- **Real OpenCode**: `bun run verify:seed $ROOT` makes a scratch root (a git work repo with `AGENTS.md` and `notes.txt`, a home, a config dir, an owner-only secret) loading the default plugins; `bun run verify:launch --root $ROOT --port $PORT` serves it on `http://127.0.0.1:$PORT` on the verify model; `bun run verify:doctor --root $ROOT` passes before the first drive. Never the owner's service port or his TUIs.
- Each real run makes its own pilotty session, `pilotty spawn --name verify-$PORT bun run verify:tui --root $ROOT`, and kills it at cleanup. Every step is `pilotty type -s verify-$PORT '<prompt>'` then `pilotty key -s verify-$PORT Enter`, or a `pilotty key`; recipes below show the prompt or the key. `$EVIDENCE` is the drive's evidence dir (`out/verify/<head>/` by default). Nothing here plays sound or opens a browser.

## Proof and skip reporting

- A world journey's proof is its run in `drive.json`: the suite, its exit, its fixed and fresh seeds, its log. A failing seed is reported with its replay line.
- A real journey records `pilotty snapshot -s verify-$PORT --format text > $EVIDENCE/<feature>/<step>.txt` after each step, and `server.log` at the end.
- A write is proved by a second view: the plugin's RPC, a reload (`world.restart`), or a reopened session.
- An unreachable entry point is reported with the command tried and the unmet precondition. It never counts as verified through another path.

## Entry contract

Each feature file has an H1, one paragraph of user-visible behavior, then exactly these H2s in order:

1. `Sub-features`: short ids, one line each.
2. `How to get to it (user POV)`: every entry point a user or an agent has.
3. `Driving it with the world`: opens with these lines, then labeled steps that pair an action, the exact prompt or code and the observable result.
   - **Preconditions:** the state the steps need beyond the baseline.
   - **States:** which of default, open, loading, empty, refused and error the steps exercise; mark the rest `n/a`.
   - **World suites:** the `*.sim.test.ts(x)` files `verify:drive --feature <id>` runs, or `none yet` with why. The list must hold every such suite under one of the feature's own `Code` folders, `sim/` aside, so a change there never lands on a receipt that skipped a suite covering it; the docs guard fails on a missing one. When you add a suite under a feature's code, list it here.
   - **Code:** the path prefixes whose change makes the feature due under `--changed`.
4. `Driving it with real OpenCode`: opens with **Real:** (the acceptance tests and scenarios `--real` runs), then the pilotty steps.
5. `Gotchas`: traps that waste or invalidate a run.

Name user paths, tool calls, keys, commands and observable words. Keep source seams out.

## Features

- [Orchestrate's machine and the land](orchestrate.md): role starts, the batch machine's refusals, the land of a batch.
- [Account pool](pool.md): the login each request goes out on, failover on a refused login, resets.
- [Session mail](mail.md): `sessions` and `message`, a woken idle receiver, a steer into a running one, paired hosts.
- [Wake latch](wake-latch.md): a subagent start held as a latch, `wake_list`, the reopen.
- [Guard](guard.md): refused destructive commands, a subagent's long sleep, heavy commands niced.
- [Queue](queue.md): the agent's live queue, the tool, the RPC, the sidebar.
- [Prime's panel](prime-panel.md): the background-work panel and its tabs.
