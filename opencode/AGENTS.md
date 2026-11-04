# OpenCode mods

Our harness work, ported onto OpenCode 2.x: the Prime Agent look, orchestration, the account pool, the code kernel.

This folder lives in the PUBLIC dotfiles repo: stage by exact path, keep tokens, account labels and run evidence out of it (`out/` and `media/` are ignored). Run every command from `opencode/`.

Before changing a mod, read `ARCHITECTURE.md`: every mod is an Effect program modeled like an alchemy-domain model and laid out like a Go service. A mod is one context and one workspace package (`mods/<mod>`): domain files at its root that own their contracts, implementation folders inside it named after their dependency, and a `cmd/<mod>` package per plugin as the only composition root. oxlint fences the imports (`bun run lint`); `tests/layout.test.ts` checks the names and lists the mods not yet moved as pending.

## Layout
- `scenarios/`: opencode-drive scenarios. Each runs OpenCode headless with a scripted model and writes frames (text) and screenshots. They are the deterministic check for every UI or plugin change.
- `themes/`, `mods/`: what OpenCode loads from us. `mods/prime` is the Prime look with fx's rail composer and tool-call groups (a header over a `├`/`└` tree per step, after `vercel-labs/fx` as gent copied it), a TUI plugin package loaded by path through the config's `plugins`. Steps that only start background agents, each within a minute of the last, share one group, and worker completion notices that land side by side fold into one line (through the fork's `session.message.completion` slot). It imports only `@opencode/plugin`, `@opentui/*` and `solid-js`; OpenCode provides them and compiles the TSX at load time.
- `mods/orchestrate`: the orchestrate skill's rules, a server plugin. It defines the role agents (planner, implementor, verifier, worker) from `src/agents.json`, runs untyped and general subagent calls as the worker and former role names as the role (logging each call to `~/.cache/orchestrate/opencode-agents.jsonl`), gives each role its compaction window from `~/.cache/orchestrate/compact.json`, and stops agent work over the Sabbath. The window takes effect through the fork's per-agent compaction threshold (`request.settings.compactionWindow`).
  Its model is in the README's Orchestrate section.
- `decider/` (`@dotfiles/decider`): what the mods' domains share. `decider.ts` is the aggregate's `Decider` type and `fold`; `story.ts` runs a Decider's stories (`Story.make(decider)(given, clock, when, then, rejected, state, view)`).
- `cmd/`: one workspace package per plugin OpenCode loads (`server.ts`, `tui.tsx`); `bun run daily` loads a plugin from `cmd/<mod>` once it exists, else from `mods/<mod>`.
- `mods/anthropic-auth`: the Claude subscription login, vendored from `@ex-machina/opencode-anthropic-auth` (MIT) with our quota readings and the seam the pool chooses each request's credential through; provenance in its README. Its tests run without `ANTHROPIC_BASE_URL`.
- `mods/kernel`: the code kernel, a server plugin ported from gent's `cell`. The `kernel` tool runs TypeScript in a Bun worker per session (`src/worker.ts`, framed over fd 3 and 4) whose bindings persist and are stored after each call; `tools.<name>()` inside it runs the session's other tools (`src/host-tools.ts`). By default it is the agent's runtime (the fork's `options.runtime`): the model sees only the kernel, and calls go through the registry's hooks. Options and limits are in the README.
- `scripts/agents.ts`: `bun run agents` writes `mods/orchestrate/src/agents.json` from the orchestrate skill (`~/.claude/skills/orchestrate`), so the prompts are Claude Code's word for word; `--check` fails when it is stale. Edit the skill, never the JSON.
- `tests/`: `prime.test.ts` runs `scenarios/prime-demo.ts` and asserts on its frames' text and colours; `workers.test.ts` runs `scenarios/prime-workers.ts` for the background-worker group and completion line. `gamut.test.ts` and `pty-host.test.ts` cover gamut. `orchestrate.test.ts` checks the role agents against the skill and runs real OpenCode through its SDK (`tests/orchestrate/run.ts`) on a scripted model (`tests/orchestrate/sim.ts`) for the guard, compaction and the Sabbath. `kernel.test.ts` does the same for the kernel (`tests/kernel/`).
- `testbeds/gamut/`: `bun run gamut`, a live run of OpenCode with our plugins against a red fixture app, driven from the shell (`up`, `send`, `wait`, `read`, `status`, `down`). See its README.
- The fork lives at `~/Developer/personal/opencode` (remote `cevr/opencode`, upstream `anomalyco/opencode`), based on the v2.2.5 release commit `4878a0e30f`. Branch `prime-look` carries the TUI plugin hook points the look uses. Keep the fork's diff small and generic (hook points OpenCode lacks); the look itself belongs here.

## Checks
All of them need `OPENCODE_DEV` pointing at the fork checkout.
- `bun run lint`: oxlint; errors are the layout fence.
- `bun run typecheck`: links the fork's `packages/tui/node_modules` entries into every workspace package's `node_modules` (`bun run link-fork`), then checks the root and each `mods/*` and `cmd/*` project. Link before `bun install`.
- `bun run test`: the scenario tests. Without `OPENCODE_DEV` they skip and say so.

## Running a scenario
`OPENCODE_DEV=<opencode checkout or rift> SCENARIO_OUT=out OPENCODE_DRIVE_MEDIA_DIR=$PWD/media bunx opencode-drive run scenarios/<name>.ts`
- Without `OPENCODE_DEV` it drives the installed `opencode2`.
- `SCENARIO_LABEL` names the frame and screenshot; `SCENARIO_THEME` picks the theme; `SCENARIO_DUMP=1` writes each model request as `request-<n>.json`.
- The simulated model is offered `patch`, not `edit`, and `shell`, not `bash`.

## Reference
- Prime Agent (MIT, Rust, ratatui): renders of its current UI and the design notes are the target for the look.
