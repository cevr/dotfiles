# sim: the simulated OpenCode host

A server plugin's behaviour, proved without a real server: our real composition roots
(`cmd/<mod>/server.ts`) run on a host the test drives, on one seed, a virtual clock and
memory alone. An hour of plugin time takes milliseconds (one simulated hour of three
sessions with repeating alarms and idle compaction: 6–12 ms of wall time), a failure prints
the seed that replays it, and no assertion reads wall time, so load cannot break a run.

## The pieces

| File | What it is |
| --- | --- |
| `world.ts` | The driver: `make({ seed, script })`, then `load` a plugin for a directory, `session`, `prompt`, `rpc`, `tool`, `advance`, `until`, `restart`, `down`/`up`, `remove`. Every operation is an Effect that runs the world to rest at this instant; only `advance` and `until` move the clock. Readers: `trace()`, `asked()`, `requests()`, `messages()`, `context()`, `logs()`, `stale()`, `timers()`. |
| `host.ts` | The host's rules: sessions and their inbox, executions and steps, the model's requests (the `model.request` hook first), tools, background shells, compaction (and a held background summary), hooks, events, RPC. Each rule names the fork source it follows. |
| `context.ts` | The plugin context (`Plugin.Context` from the fork's `@opencode/plugin/effect`) onto the host. `OPERATIONS` lists what it offers; a plugin reaching for anything else is recorded, and the world's next operation fails naming it. |
| `runtime.ts` | The scheduler: one seeded generator orders ready fibers and same-instant timers; the clock is virtual; logs and timers are tagged with the plugin copy that made them, so a timer of a closed copy firing after a restart is caught (`stale()`). |
| `plugins.ts` | Our plugins as the world loads them: wake through `make` with the world's shell for checks and no OS jobs; idle compaction and questions as OpenCode loads them; the Anthropic auth plugin and the pool on the world's provider, their login stores on memory slots (`mods/pool/memory/slots.ts`, which keeps the disk's laws in `mods/pool/store/files-laws.ts`) through `stores(slots, provider)`. |
| `provider.ts`, `http.ts` | The world's Anthropic (`ORIGIN`): the messages API, token, usage and claim endpoints with the fake's wire (`tests/fake-anthropic.ts`), as state a test scripts. Model requests go to it over the host's HTTP path, through the `http.request`/`http.response` hooks: a refusal arrives whole at once, a hook that dies ends the turn as an unknown failure, never retried. |
| `locations.ts` | Which copies hear an event: a session's events its location's copies, one of no session every copy (the fork's location-scoped plugin subscriptions); law `located`. |
| `subagents.ts` | A subagent's idle report: an execution of a session with a parent that ends tells the parent in a synthetic `source: subagent` message that wakes it; law `report`. |
| `forms.ts` | The host's forms as a client opens and answers them (`world.form.create`, `world.form.reply`): a reply publishes `form.replied` in its session's location. |
| `faults.ts` | Faults a test puts into the host, outside its contract: `world.faults.failWrites(plugin, count, after)` makes a plugin's storage writes die. |
| `provider-laws.ts` | What the world's provider and the real tier's fake both answer, run on each (`provider-laws.test.ts`). |
| `seed.ts` | The seed runner: `Seed.runner(file).seeded(name, ({ seed, expect }) => effect)` runs a test on 20 seeds; `SIM_SEED=<n>` runs one; a file's seeds share 5 s of CPU time (wall time is reported, never judged: a loaded host's wall time is not the file's); `SIM_EXPECTS=1` prints each test's `expect()` calls for the parity check. `Seed.effect(name, effect)` is a plain Effect test. |
| `host-laws.ts`, `law-names.ts` | The host laws: what OpenCode does for a plugin, over the context's own operations. Every entry of `OPERATIONS` is named by a law. |
| `server.ts` | The law probe: a plugin that runs every law from inside the host it is loaded into and logs `sim-law: kept|broken <name>`. |
| `tests/host-laws/real.ts` (outside `sim/`) | The laws' real run: the fork booted through its SDK on a loopback scripted model, the probe loaded from config (`tests/host-laws.test.ts` starts it). It runs on the root's Effect and Bun's platform layer, reading only `law-names.ts` from here. |

## Writing a simulated test

1. Put it beside the composition root as `cmd/<mod>/<name>.sim.test.ts`.
2. `const { seeded } = Seed.runner("cmd/<mod>/<name>.sim.test.ts")`, then
   `seeded("<the real test's name>", ({ seed, expect }) => Effect.gen(function* () { … }))`.
3. Make the world with the scenario's model as a `script` (each request's kind and text in,
   `say(text)` or `call(id, tool, input)` out), `load` the plugin from `plugins.ts`, drive it,
   and read what the real test read: the requests, the transcript, the plugin's RPC.
4. Time moves only by `advance(ms)` or `until(done, limitMs)`. Never `Date.now`, `setTimeout`,
   `Bun.sleep` or `tests/wait.ts` (`static.test.ts` fails the file).
5. A real test leaves its file only through `tests/parity.json`, in the commit that adds it to
   the simulated file, with at least the baseline's `expect()` calls (`scripts/accept-parity.test.ts`).
6. A new operation in `context.ts` needs a law in `host-laws.ts`; run `tests/host-laws.test.ts`
   against the fork to see real OpenCode keep it.

## What it does not model

Anything not in `OPERATIONS` (the world fails naming it); the TUI (`sim-tui`); a host's
faults other than a failed storage write (an RPC that never answers); a form's field and
answer validation, and the outbox that redelivers a subagent report a stopped server did not
admit; the ChatGPT backend (usage and
reset endpoints), so Codex claims stay real; a second host (the fleet). Behaviour no law
pins yet stays in its real test too, as `tests/parity.json` says ("both"): a copy of a config
plugin per opened Location, the host's held background summary, background shells and their
notice, where a form's reply is heard, a real plugin reload and a real server restart.

## Time is not a fork change

The world's clock is its own Effect `Clock`, given to the plugins' fibers, not the fork's
`packages/simulation` (which drives a real server and has no virtual time). Virtual time in
`packages/simulation` is a later fork unit (`sim-time`) with an upstream feature request.
