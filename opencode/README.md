# OpenCode mods

Our orchestration harness and Prime look on OpenCode 2.x. The fork's public
plugin hooks supply the UI; orchestration policy lives in this repository.

## Load the plugins

Use absolute paths from your checkout in `opencode.json`:

```json
{
  "plugins": [
    "~/Developer/personal/dotfiles/opencode/mods/orchestrate",
    "~/Developer/personal/dotfiles/opencode/mods/codex",
    "~/Developer/personal/dotfiles/opencode/mods/status",
    "~/Developer/personal/dotfiles/opencode/mods/pool"
  ]
}
```

Keep the existing Anthropic auth plugin before the pool when using Claude
subscription accounts. The pool's `sources` option can also read gent's
accounts in place: `[{ "kind": "gent", "dir": "/absolute/path/.gent/auth" }]`.
No credentials travel over the status RPC.

In `cli.json`, load `mods/prime` and `mods/status` by absolute path.
`/pool` opens a host-owned panel, which becomes fullscreen on a narrow
terminal. It shows pool accounts, holds, 5-hour and 7-day usage and reset
times; live agents with their call-log descriptions; the current session's
Codex threads; and each orchestrate run's unit states. Reads refresh every
two seconds while open, retain the last reading on errors, and stop when
closed. The panel uses the current theme. Prime owns the dock counts.

`bun run gamut up sim` loads these server and TUI plugins with a scripted
model and a scratch home. See [the gamut testbed](testbeds/gamut/README.md).
It makes no live model request.

## Codex workers

The direct tools are `codex_start`, `codex_send`, `codex_interrupt` and
`codex_threads`: the Claude mod's schemas and operations, with OpenCode's
`codex_` prefix so the Sabbath guard recognizes them. `start` takes
`description` and `prompt`, plus optional `role` (`planner`, `implementor`,
`verifier`, or the former `reviewer`), `unit`, `round`, `model`, `effort`,
`cwd` and `sandbox`. The other turn tools take `thread`; `send` also takes
`prompt`.

The server calls the installed `codex-bridge ensure`, then its Unix-socket
HTTP API. The daemon owns model-family resolution, role instructions,
Codex budget latches, restart recovery and Sabbath interruption. A start
held beyond its patience returns the daemon's fallback instruction; a
latched turn starts automatically. No app-server is implemented here.

Every thread belongs to the initiating OpenCode session. `experimental.idle`
checks for a ready completion; a five-second timer handles a completion
arriving later. `session.synthetic` with `delivery: "queue", resume: true`
wakes that session with the final message. A stable message id prevents a
lost bridge acknowledgement from duplicating the notice. Owners persist
in plugin storage. Send and interrupt enforce ownership.

The Codex plugin's `socket` and `pollMs` options support deterministic
fixtures. Production uses the installed daemon and its default polling
interval.

## Pace and effort

A new subagent passes `dotfiles-opencode.pool`'s `pace` RPC in the
`tool.execute.before` hook. Follow-ups keep running. Models outside the
pool and unavailable pace RPCs fail open, as the Claude hook does for an
unreachable host.

The shared Claude `budget.ts` scans `~/.claude/projects` transcripts, so it
cannot measure OpenCode's load or estimate its agent costs. Instead, this
pool reads provider quotas, including spend by other harnesses on the same
accounts. It holds new starts when pooled weekly use exceeds a 99% even
weekly allowance plus five percentage points of leeway, or all available
accounts have no short/weekly-window room. The result names a background
`shell` command running `scripts/pace.ts --wait <epoch-ms>`. When it exits,
retry the same agent and description; admission is checked again. A waiter
never reserves a stale slot.

Cost of this choice: this is quota pacing, without Claude Code's calibrated
per-role cost prediction, fair ticket queue, cross-host reservations or
Sabbath-adjusted working-hour budget. Quota updates can lag a wave of starts.
Codex uses its own plan's admission in the existing bridge, including its
shared budget integration and automatic release of latched turns.

`bun run agents` copies role prompts from the orchestrate skill and reads
the Claude-family effort from its role table: planner `high`, implementor
`medium`, verifier `medium`. Codex role effort stays the daemon's policy
(luna implementor `max`). No generated prompt is edited by hand.

## Checks

```sh
export OPENCODE_DEV=/Users/cvr/Developer/personal/.rifts/opencode/prime-look
bun run typecheck
bun run test
bun run agents -- --check
```

There is no separate lint script. `git diff --check` checks patch whitespace.
The typecheck links plugins to the fork's installed host packages; install
only when changing the lock file. If working in a Rift, set
`OPENCODE_ANTHROPIC_AUTH` and `GENT_SOURCE` to their source checkouts so the
pool integration tests run instead of skipping.

The deterministic acceptance seams are the session API (Codex final-message
wake-up, ownership isolation, lost-ack retry, ready-at-idle delivery, held
starts and subagent pace), the pool RPC and quota calculation, the generated
agent config, and opencode-drive frames (`scenarios/pool.ts`). The pane
scenario covers populated, loading, empty and failed-refresh states.

## Remaining Claude mod features

Codex tool rows and footer lines do not yet draw live commands, edits,
plans, context fill and compactions, and there is no separate `/codex` pane.
The status mod's burn forecast, approaching-limit warning, login toasts,
project labels, account rotation and adaptive compaction tuning are not
ported. The existing role compaction windows and Sabbath guard remain.
