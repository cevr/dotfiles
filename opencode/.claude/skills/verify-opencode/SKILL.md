---
name: verify-opencode
description: Verify our OpenCode mods (opencode/mods, cmd: the server plugins orchestrate, rift land, pool, mail, wake and latches, guard, queue, questions, and the TUI plugins prime, status, escape) as an agent and a user meet them. Drive a feature on the simulated world (sim/, seeded and deterministic, the default) or on a real scratch OpenCode with its TUI in pilotty, keep the evidence, and turn the drive into the merge receipt (scripts/receipt.ts). Use to check a change to a mod, verify a batch, or show that a mod works.
---

# Verify the OpenCode mods

Our mods are OpenCode plugins: server plugins that add tools, hooks and RPCs, and TUI plugins that draw. A user or an agent meets them through a session: a prompt, a tool call, a key, a frame. This skill drives them that way, on two paths:

1. **The world** (`sim/`), the default. Our real composition roots (`cmd/<mod>/server.ts`) run together on a simulated host: one seed, a virtual clock, memory alone, a scripted model. The host laws (`sim/host-laws.ts`) hold it to real OpenCode. A drive is a `*.sim.test.ts` journey, played on its fixed seeds and then on fresh ones; it takes milliseconds and no wall time, so load cannot break it.
2. **A real scratch OpenCode**, only for what the world cannot show: the host laws' real run, the TUI's real frames, and a behaviour the feature file marks as real. It is the fork at `OPENCODE_DEV` (the `prime-look` Rift), on its own data dir, home, port and secret, with the verify model, and its TUI in a pilotty session.

Both paths use one model, the **verify model** (`sim/verify-model.ts`): a prompt's lines say what it does, so a journey found on the world is typed into the real TUI word for word.

```
verify: call <tool> <json object>   the next request calls that tool with that input, in order
verify: say <text>                  once every call has its answer, end the turn with this text
```

With no `say`, the turn ends `verify: <n> call(s) done; the last answered: <its last line>`. A title request is answered `Verify run`.

Run every command from `opencode/`, with `OPENCODE_DEV=$HOME/Developer/personal/.rifts/opencode/prime-look` (write `$HOME`, not `~`). Read `features/README.md` before the first drive.

## Launch

**The world** needs no launch: the fork linked (`bun run link-fork`, which `bun run typecheck` and the gate run) is all. `bun run verify:doctor` says so.

**A real scratch OpenCode**, from an empty scratch root to a server that answers:

```sh
ROOT=$(mktemp -d /tmp/verify-opencode-XXXXXX)          # one per run; never under a checkout
PORT=47$((RANDOM % 900 + 100))                          # a free loopback port, never the owner's service port
bun run verify:seed $ROOT                               # work repo, home, config, secret; --plugins a,b to widen
bun run verify:launch --root $ROOT --port $PORT         # run it in the background: it prints one ready line, then holds
bun run verify:doctor --root $ROOT                      # before the first drive
pilotty spawn --name verify-$PORT bun run verify:tui --root $ROOT
pilotty wait-for -s verify-$PORT "Ask anything" -t 60000
```

`verify:launch` runs until `verify:stop` (or its shell is killed): start it as a background shell, read its ready line (`{"ok":true,"ready":true,…}`), and leave it. Ready means the line *and* `GET /api/info` answering with the run's secret, which the launch waits for. The server loads the plugins `verify:seed` named (by default orchestrate, status, queue, wake with `backstop: "off"`, guard, mail, questions, escape, tool-names, skills); `update`, `rift`, `pool` and `anthropic-auth` are refused, since they act on the owner's checkouts or logins: drive those on the world. Every TUI plugin of `cmd/` loads through the run's `cli.json`, Prime first.

## Doctor

`bun run verify:doctor` (the world) or `bun run verify:doctor --root $ROOT [--commit <sha>]` (a launched server) is read-only and prints one JSON line: `ok`, the first check that `failed`, and each check. Run it before the first drive and again after any surprising result.

- World: `fork` (the fork is at `OPENCODE_DEV`), `linked` (`sim/node_modules/@opencode/plugin`), `head`, `load`.
- Real, in order: `seed` (`verify.json` parses), `config` (`work/opencode.json` parses), `launched` (`launch.json`), `pid` (the port is held by the recorded server's process group), `head` (this checkout's HEAD is the launched one, and the commit under test with `--commit`), `fork` (the fork has not moved since the launch), `answers` (`GET /api/info`), `log` (`server.log` holds no failure line), `audio` (n/a: neither path opens a browser), `load`.
- `load` never fails: past the core count it says timings claim nothing (`explain-the-number`). The world reads no wall time; a loaded host only plays fewer fresh seeds in a swarm's box.

## Drive

**On the world**, `bun run verify:drive`:

- `--feature <id>` (repeatable): the feature file's `World suites`, each on its fixed seeds (the 20, and the seeds `sim/seeds.json` keeps for it) and then `--swarm-ms` (default 3000) of fresh seeds numbered from the head's hash, so a head always plays the same fresh seeds.
- `--changed <base>`: every feature whose `Code` a change since `base` touches. A batch verifier runs `--changed <the batch's base>`.
- `--all`: every feature.
- `--scenario <file>` (repeatable): your own journey, a `*.sim.test.ts` under `opencode/` (put it in `out/verify/`, which git ignores, so it imports `sim/` as the suites do). Copy `cmd/queue/queue.sim.test.ts`: `World.make({ seed, script: worldScript })`, `load` the plugins from `sim/plugins.ts`, `prompt` a session with verify directives, `until` it is idle, then read what a user would see: the tool's answers (`Read.answers`), the model's texts, the synthetic messages (letters, wakes, reports), the plugin's RPC.
- `--real`: also run each chosen feature's `Real` checks: an acceptance test (`tests/*.test.ts`, real OpenCode on a scripted model) through `bun test`, a scenario (`scenarios/*.ts`) through opencode-drive, its frames written to the evidence dir.

It prints one JSON line: `ok`, the `head`, the `features`, each run (`file`, `kind`: world, swarm, scenario or real, `exit`, `ms`, `log`, the fresh `seeds` a swarm passed), the `red` ones, and `unreachable`: a chosen feature with no world suite, which is driven on real OpenCode or reported, never passed. A failing seed's line in its log is its replay: `SIM_SEED=<n> bun test <file>`. Add the seed to `sim/seeds.json` with its fix, so the gate replays it.

**On real OpenCode**, through the launched TUI, as the user does: type the feature file's prompt with `pilotty type -s verify-$PORT '<prompt>'`, send it with `pilotty key -s verify-$PORT Enter`, wait on the words the feature file names with `pilotty wait-for -s verify-$PORT '<words>' -t 30000`, and read the frame with `pilotty snapshot -s verify-$PORT --format text`. Keys go through `pilotty key` (`Down`, `Escape`, `Ctrl+Enter`, `Left`); never an RPC or a file write to reach a state.

Each feature file says its entry points, its suites and checks, and its pilotty journey. A proof that drives one entry point is incomplete while the map lists others.

## Evidence

The drive writes its proof outside every tracked path: `out/verify/<head>/` by default (git-ignored; `--evidence <dir>` for another), holding each run's log (`<file>.<kind>.log`), `drive.json` (the result line, whole), and a scenario's frames. A real TUI journey adds, under the same dir, `<feature>/<step>.txt` from `pilotty snapshot --format text` after each step, and the server's `server.log` copied from `$ROOT` at the end.

- A write is proved by a second view: on the world, the plugin's RPC or the store after a restart (`world.restart`); on real OpenCode, the RPC answer the TUI reads, or a reopened session.
- A flaky step is reported as n/n trials with the load beside it; a world seed never flakes (a failure replays).
- A failure is rerun on the base (a fresh Rift at the base, the same `SIM_SEED=<n>` or the same journey on another port) to tell new from pre-existing.
- An unreachable entry point is reported with the command tried and its unmet precondition.

## Receipt

A drive on the merged head is the receipt a merge needs (`mods/rift/receipt.ts`, read by a land's `rift.mergeCheck`), in place of the long suites. In the checkout under test, at its head, with nothing uncommitted:

```sh
bun scripts/receipt.ts -- "bun run verify:drive --changed <base>"            # runs the drive and receipts it
bun scripts/receipt.ts --attest "verify-opencode: <evidence>/drive.json ok at <head>; batch-<k> accepted" --code 0
```

The first form runs the drive itself and records its exit; use it. The second receipts a proof made already: a batch verifier's verdict with its findings file, a real TUI journey's evidence dir. A red drive is a red receipt (exit 1), and the land runs the Rift's focused gate or stops. The receipt names the head and the tree of tracked files; a commit after it voids it.

## Cleanup

```sh
bun run verify:stop --root $ROOT          # SIGTERM to the recorded launch, whose scope stops the server's group; port freed
pilotty kill -s verify-$PORT
rm -r $ROOT
```

Kill by the recorded PID only (`verify:stop` checks the pid still runs this launch before it signals); never `pkill`, which reaches the owner's OpenCode. After a heavy or real drive, list your processes with `ps` and kill what you started that is left. Evidence stays.

## Helpers

All in `scripts/verify.ts` (Effect CLI on Bun), one JSON line each, exit 1 on a red result, 2 on a usage error:

| Command | What it prints |
| --- | --- |
| `bun run verify:seed <dir> [--plugins a,b]` | `{ ok, root, work, plugins, dotfiles, forkHead, next }` |
| `bun run verify:launch --root <dir> --port <p> [--timeout s]` | `{ ok, ready, url, launchPid, serverPid, port, modelPort, dotfiles, forkHead, log, tui, stop }`, then holds |
| `bun run verify:tui --root <dir>` | the TUI, in this terminal; `{ ok, tui: "exited", code }` at its end |
| `bun run verify:doctor [--root <dir>] [--commit <sha>]` | `{ ok, path, failed, checks }` |
| `bun run verify:drive [--feature id]… [--changed base] [--all] [--scenario file]… [--real] [--swarm-ms n] [--evidence dir]` | `{ ok, head, features, unreachable, evidence, runs, red }` |
| `bun run verify:stop --root <dir>` | `{ ok, stopped, launchPid, serverPid, port, portFree }` |

The verify model is `sim/verify-model.ts` (`worldScript` on the world, `chatAnswer`/`chatEvents` behind `verify:launch`); the map's reader is `scripts/verify-map.ts`; the docs guard is `scripts/verify-docs.test.ts`.

## Hosts

- **Mac**: the fork at `~/Developer/personal/.rifts/opencode/prime-look`; the owner's service and TUIs are his, never driven: pick a port of your own, and never `opencode service` anything.
- **Workbox** (`bite-workbox`): the same commands from its dotfiles checkout, with its fork Rift as `OPENCODE_DEV`; the owner's service there is his too. pilotty runs on the box itself; nothing opens a browser, so no Tailscale address is needed. Unproven there until a run covers it.
