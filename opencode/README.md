# OpenCode mods

Our orchestration harness and Prime look on OpenCode 2.x. The fork's public
plugin hooks supply the UI; orchestration policy lives in this repository.

## Your daily `opencode`

```sh
bun run daily            # build the fork, write ~/.local/bin/opencode, merge the config
bun run daily --skip-build
```

`scripts/daily.ts` builds the fork in `OPENCODE_DEV` (default: the
`prime-look` Rift) as a release binary named `<version>-prime.<commit>`,
copies it to `~/.local/share/opencode-prime/`, and writes
`~/.local/bin/opencode`, a launcher that runs it without `ANTHROPIC_BASE_URL`,
so OpenCode's Claude traffic never routes through TeamClaude's proxy, even when
an agent session on TeamClaude starts it. `~/.local/bin` precedes `~/.bun/bin`,
so a new terminal runs it, and `opencode2` stays the stock release. As a `latest`
build it shares the stock release's database, logins and background
service; the version change restarts that service as ours. It merges into
`~/.config/opencode/opencode.json` the Anthropic auth plugin, the pool (on
the Claude logins in `~/.local/share/opencode-prime/pool-auth`, gent's store format, when it exists), orchestrate, the kernel and status, the role
models and `autoupdate: false`, and into `cli.json` Prime, status and the
Prime theme. Every other key and plugin there is kept. Rerun it after a fork
change.

Why a fork: stock OpenCode's plugin API covers the pool, the `/pool` pane,
the orchestrate guard, the Sabbath and the pace hold. It has no hook for the
transcript's message and tool rows, header, layout or composer chrome,
which the Prime look replaces, and no per-agent compaction window. The fork adds only those.

`/pool` opens a host-owned panel, which becomes fullscreen on a narrow
terminal. It shows pool accounts, holds, 5-hour and 7-day usage and reset
times; live agents with their call-log descriptions; and each orchestrate
run's unit states. Reads refresh every two seconds while open, retain the
last reading on errors, and stop when closed. The pane takes focus when it
opens; Esc or `q` closes it, and `/pool` from the prompt toggles it.

`bun run gamut up sim` loads these server and TUI plugins with a scripted
model and a scratch home. See [the gamut testbed](testbeds/gamut/README.md).
It makes no live model request.

## The code kernel

`mods/kernel` gives the model a `kernel` tool, `{ code, reset? }`, ported
from gent's `cell`. It runs TypeScript in one Bun process per session, so
top-level bindings persist from call to call, and returns what the code
printed, then its last expression's value. Inside the code,
`await tools.<id>(input)` runs another tool of the session through the tool's
own `execute`, with the kernel call's context, so permissions and abort work
as for a direct call; `tools.list()` lists them. After each call the JSON-safe
bindings are stored with the session, so a worker that timed out, crashed,
went idle or came back after a restart starts with them; `reset: true` drops
them. The worker is the running OpenCode binary acting as Bun
(`BUN_BE_BUN=1`), so it needs no separate Bun install.

| Option | Default | Effect |
| --- | --- | --- |
| `idleMs` | `1800000` (30 min) | Kill a session's worker after this long without a call. Its stored bindings stay. |
| `timeoutMs` | `30000` | One call's compute limit, paused while its tool calls run. Past it the worker is killed. |
| `viewChars` | `8000` | Characters of output the model sees per call: the head and the tail. The worker keeps 64 KiB at most. |
| `denyExecute` | `true` | Deny code mode's `execute` to every agent, so the kernel is the only code tool and every other tool is offered directly. |

Limits of the port: a tool called from the kernel skips the
`tool.execute.before` and `execute.after` hooks, which only OpenCode's
registry can trigger. So the kernel offers no `subagent`: orchestrate's role
guard, the pace hold and the Sabbath stop run in those hooks. Start agents
with the direct tool. `denyExecute` reaches agents that plugins define; an agent
defined only in a config file arrives after the plugins' transforms and keeps
code mode.

## The other model family

Every role is an OpenCode subagent; its family is its model. `bun run daily`
binds the planner and the implementor to the newest Claude Opus and the
verifier to the newest GPT sol, on the ChatGPT subscription OpenCode signs in
to itself (`opencode auth login openai`). To move a role to the other family
for one call, pass the subagent tool's `model` (`provider/model#variant`).
No Codex bridge, MCP server or thread tools are involved.

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
The OpenAI provider is not pooled. A new subagent on it asks the Codex
account's pace instead: the orchestrate skill's `budget.ts --codex --admit
--model <id> --role <role>`, the admission the Claude-side Codex bridge asks
before each turn. A hold denies the call with the same background waiter,
timed to the hold's `opens about` time. Only the script's own `admit`/`hold`
answer counts; anything else fails open. That budget measures Codex's own
transcripts, so OpenCode's GPT tokens reach it only through the account's
weekly use. The orchestrate mod's `codex` option names the providers and
the script; `false` turns it off.

`bun run agents` copies role prompts from the orchestrate skill and reads
the Claude-family effort from its role table: planner `high`, implementor
`medium`, verifier `medium`. The orchestrate mod runs each role at that
effort on whichever model it gets. No generated prompt is edited by hand.

## Checks

```sh
export OPENCODE_DEV=~/Developer/personal/.rifts/opencode/prime-look
bun run typecheck
bun run test
bun run agents -- --check
```

There is no separate lint script. `git diff --check` checks patch whitespace.
The typecheck links plugins to the fork's installed host packages; install
only when changing the lock file. If working in a Rift, set
`OPENCODE_ANTHROPIC_AUTH` and `GENT_SOURCE` to their source checkouts so the
pool integration tests run instead of skipping.

The deterministic acceptance seams are the session API (the guard, compaction
per role, the Sabbath, held starts and subagent pace), the pool RPC and quota
calculation, the generated agent config, `bun run daily`'s config merge, and
opencode-drive frames (`scenarios/pool.ts`). The pane scenario covers
populated, loading, empty and failed-refresh states, and closing it.

## Remaining Claude mod features

The status mod's burn forecast, approaching-limit warning, login toasts,
project labels, account rotation and adaptive compaction tuning are not
ported. The existing role compaction windows and Sabbath guard remain.
