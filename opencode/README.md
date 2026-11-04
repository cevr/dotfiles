# OpenCode mods

Our orchestration harness and Prime look on OpenCode 2.x. The fork's public
plugin hooks supply the UI; orchestration policy lives in this repository.

## Your daily `opencode`

```sh
bun run daily            # build the fork, write ~/.local/bin/opencode, merge the config
bun run daily --skip-build
```

`scripts/daily.ts` installs the mods' dependencies (`bun install
--frozen-lockfile`; OpenCode loads the plugins in place and installs nothing),
builds the fork in `OPENCODE_DEV` (default: the
`prime-look` Rift) as a release binary named `<version>-prime.<commit>`,
copies it to `~/.local/share/opencode-prime/`, and writes
`~/.local/bin/opencode`, a launcher that runs it without `ANTHROPIC_BASE_URL`,
so OpenCode's Claude traffic never routes through TeamClaude's proxy, even when
an agent session on TeamClaude starts it. `~/.local/bin` precedes `~/.bun/bin`,
so a new terminal runs it, and `opencode2` stays the stock release. As a `latest`
build it shares the stock release's database, logins and background
service; the version change restarts that service as ours. It merges into
`~/.config/opencode/opencode.json` the Anthropic auth plugin (`mods/anthropic-auth`), the pool (on
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

## Orchestrate

`mods/orchestrate` holds the orchestrate skill's rules; its plugin is
`cmd/orchestrate`. It defines the role agents and their compaction windows,
routes each subagent call to a role, holds new starts on the pace, and stops
agent work over the Sabbath. Its options are `windows`, `log`, `now`,
`place`, `fullAgent` and `codex`. An absent option takes its default. A
malformed one stops the plugin at setup, with a message that names it.

The model (the domain files at `mods/orchestrate/`):

- Facts: `SubagentStarted` (the agent, why it was routed there, and its
  model) and `SubagentFinished` (the child session and how it ended).
- Commands: `StartSubagent`, `UseTool` (any other tool call) and
  `FinishSubagent`. Each one is decided only from inputs gathered
  beforehand: the clock, the place, the asked agent, the child's agent, the
  role's model and the pace hold.
- Rejections: `SabbathRest` (when work resumes) and `PaceHeld` (whose pace,
  the reason, and when to retry). The call log records each one as a
  `denied` line.
- Aggregate: `ToolCall`, keyed by the session and call id, with its
  commands, facts and their rejections in `tool-call.ts`. Every command
  goes through its `decide`; `model.ts` holds the handlers. A kernel cell's
  tool calls share the outer call's id, so `decide` never reads state.
- Values: the Sabbath and `SabbathRest` (`sabbath.ts`), role routing
  (`role.ts`, over `agents.json`), the compaction windows (`compaction.ts`)
  and the pace answers and `PaceHeld` (`pace.ts`).
- Views: the call log, `~/.cache/orchestrate/opencode-agents.jsonl`. It has
  one line per fact or rejection (`call-line.ts`), and the status pane reads
  it.
- Contracts: the pool's pace (`PoolPace`), the Codex admission script
  (`CodexAdmission`), sessions, models, the compaction windows file and the
  call log, each a `Context.Service` in `service.ts`, with what every
  implementation owes in `laws.ts`. They are implemented in `filestore/`
  (the call log and compact.json), `opencode/` (sessions, models and the
  pool's pace over OpenCode's plugin context and RPC) and `codex/` (the
  admission script); `memory/` holds the doubles the plugin's seam test
  runs on.

The aggregate stores events, not state. The status pane reads the history
as the call log, and no command needs the folded state.

## Pool

`mods/pool` pools a provider's OAuth logins; its plugin is `cmd/pool`. It chooses the login each
request goes out on, holds a login its provider refuses, and turns a refused
primary request into an immediate retry on another login. Its options are
`providers`, `sweepMinutes` and `sources`. An absent option takes its
default. A malformed one stops the plugin at setup, with a message that
names it. Other mods read it over its `dotfiles-opencode.pool` RPC
(`status.ts`, `@dotfiles/opencode-pool/status`): orchestrate asks `pace`, and the `/pool`
pane draws `status`.

The model (`src/domain/`):

- Facts: `LoginsListed`, `RequestPlaced`, `RequestRefused` (with its hold),
  `ReadingTaken` (with the hold it sets, if any), `StepRecorded` (a priced
  step), `RunReleased` and `LedgerPruned`.
- Commands: `ListLogins`, `PlaceRequest`, `RefuseRequest`, `TakeReading`,
  `RecordStep`, `ReleaseRun` and `PruneLedger`. Each one is decided only
  from the pool's state, its input and the clock.
- Rejections: `NoAccount` (a request on a pool that lists no login). The
  plugin then names no login on the request.
- Aggregate: `AccountPool`, keyed by its integration (`PoolId`), with its
  commands, facts and rejection in `account-pool.ts`. Every command goes
  through its `decide`; `model.ts` holds the handlers.
- Values: placement ranking (`placement.ts`), holds, failover and each
  account's status (`accounts.ts`), quota readings and the quota RPC's
  contract (`quota.ts`), pace admission (`pace.ts`) and the pool's own RPC
  (`status.ts`).
- Contracts: the integration's logins and a gent store's (`Logins`), the
  auth plugin's quota RPC (`Quota`) and the ledger in the plugin's storage
  (`Ledger`), each a `Context.Service` in `service.ts`, with what every
  implementation owes in `laws.ts`. `opencode/` implements them over the
  plugin's integration, RPC and storage; `memory/` holds the in-memory
  ones the seam tests use. `gent/store.ts` reads and refreshes gent's
  store in place, under gent's lock, byte-compatible with gent.

The aggregate stores folded state, not events: no one reads its history.
The ledger keeps its holds, readings and priced steps under
`<pool>/hold/<id>`, `<pool>/reading/<id>` and `<pool>/step/<at>/<session>`,
the keys earlier processes wrote, so a new process starts where the last
one stopped. Decisions read Effect's `Clock`; the seam tests move it with
`TestClock`.

## Status

`mods/status` draws the `/pool` pane. Its server plugin answers the
`dotfiles-opencode.status` RPC (`src/domain/Status.ts`) with the live
agents from orchestrate's call log and the units of each orchestrate run,
which the orchestrate skill's status script derives. Its options are `log`
and `statusScript`. An absent option takes its default. A malformed one
stops the plugin at setup, with a message that names it. The TUI plugin
(`src/Status.tui.tsx`) reads this RPC and the pool's every two seconds. It
keeps the last good reading when a read fails or does not decode, and it
draws the rows `src/domain/Pane.ts` projects.

The model (`src/domain/`) has no aggregate, because status decides nothing.
It holds a view, values and externals:

- View: `AgentCalls` (`Agents/AgentCalls.view.ts`), a fold of the call
  log's `call` and `done` lines keyed by session and call id. A call is live
  until it returns `completed` or `error`.
- Values: the status script's table as units (`RunTable.ts`), the pane's
  rows (`Pane.ts`) and the RPC's shapes (`Status.ts`).
- Externals: the call log (`CallLog`) and the runs with their status
  script tables (`RunTables`). Each one is a `Context.Service` in `domain/`,
  with a live layer and a test layer in `host/`.

Status stores nothing. Each RPC call reads the call log and the runs again.

## The code kernel

`mods/kernel` gives the model a `kernel` tool, `{ code, reset? }`, ported
from gent's `cell`. It runs TypeScript in one Bun process per session, so
top-level bindings persist from call to call, and returns what the code
printed, then its last expression's value. Its options are `idleMs`,
`timeoutMs`, `viewChars`, `codeOnly` and `denyExecute` (below). An absent
option takes its default. A malformed one stops the plugin at setup, with a
message that names it.

Code only, as Prime Agent's REPL: the kernel registers as the agent's
runtime (the fork's `options.runtime`), so the model is offered the kernel
alone, and its description lists every other tool as
`tools.<name>(input: …)` with the tool's own text. Inside the code,
`await tools.<name>(input)` runs that tool through OpenCode's registry with
the kernel call's context: permissions, abort and the
`execute.before`/`execute.after` hooks apply as for a direct call, so
`tools.subagent` passes orchestrate's role guard, pace hold and Sabbath stop.
Deny `kernel` to an agent to give it its usual tools. After each call the
bindings are stored with the session, so a worker that timed out, crashed,
went idle or came back after a restart starts with them; `reset: true` drops
them. Top-level imports, function and class declarations, and `const`/`let`/`var`
bound to a function or class expression are kept as their TypeScript source
(parsed with oxc) and run again first, imports before declarations, the latest
declaration of a name winning. Every other binding is a structured clone
(cycles, BigInt, Map, Set, Date, RegExp, typed arrays, errors, and instances of
the kept classes with their prototype back; 16 MiB per binding, 256 MiB in all).
Closures made inside a function, instances of classes with `#private` members,
and live objects such as promises are not stored: the call names each one it
left out and why. The worker is the running OpenCode binary acting as Bun
(`BUN_BE_BUN=1`), so it needs no separate Bun install.

| Option | Default | Effect |
| --- | --- | --- |
| `idleMs` | `1800000` (30 min) | Kill a session's worker after this long without a call. Its stored bindings stay. |
| `timeoutMs` | `30000` | One call's compute limit, paused while its tool calls run. Past it the worker is killed. |
| `viewChars` | `8000` | Characters of output the model sees per call: the head and the tail. The worker keeps 64 KiB at most. |
| `codeOnly` | `true` | Make the kernel the agents' only tool, as above. `false` offers it beside the direct tools. |
| `denyExecute` | `true` | Without `codeOnly`: deny code mode's `execute` to every agent, so the kernel is the only code tool and every other tool is offered directly. |

Without `codeOnly` a cell's call runs the tool's own `execute` and skips
those hooks, which only the registry triggers, so the kernel then offers no
`subagent`; start agents with the direct tool. `denyExecute` reaches agents
that plugins define; an agent defined only in a config file arrives after the
plugins' transforms and keeps code mode. A call made inside a cell shows as
the kernel's row in the transcript, not as its own tool row.

The model (the domain files at the root of `mods/kernel`):

- Facts: `KernelReset`, `KernelStarted` (with the bindings it restored),
  `CellRan` (the cell's output, its display, the bindings it bound that the
  store left out, and whether its bindings were stored), `KernelLost` (why
  the worker went) and `KernelStopped` (idle or deleted).
- Commands: `ResetKernel`, `StartKernel`, `RecordCell`, `LoseKernel` and
  `StopKernel`. A cell that throws and a worker that dies are facts, not
  rejections: the model reads both as the tool's error.
- Aggregate: `KernelSession` (`session.ts`, with its commands and facts),
  keyed by the session. Every command goes through its `decide`; its state is
  whether a worker runs. The handlers are `model.ts`.
- View: `CellAnswer` (`answer.ts`), a fold of one call's facts into what the
  model reads: the notes (`[kernel reset]`, `[new kernel; restored …]`,
  `[not kept across restarts: …]`), then the output, cut to `viewChars`.
- Values: the tool's description and input (`description.ts`), the tools a
  cell reaches and how the model reads them (`tools.ts`), the output's head
  and tail (`output.ts`), the limits (`limits.ts`), and the worker protocol:
  its frames as schemas (`frame.ts`) and their framing on the pipes
  (`wire.ts`).
- Contracts (`service.ts`, with their laws in `laws.ts`): the worker
  processes (`Workers`), the stored bindings (`Snapshots`), sessions and
  agents' rules (`Sessions`), and the call's tools (`Toolbox`, provided per
  call: the runtime's, else the registry's). `worker/` implements `Workers`;
  `opencode/` implements `Snapshots`, `Sessions` and `Toolbox` over the
  plugin context; `memory/` holds the in-memory `Sessions` the seam test
  uses. `cmd/kernel/server.ts` is the plugin and the only composition root.
- The worker itself (`worker/program.ts`, with `codec.ts` and
  `declarations.ts`) is a separate Bun program: it imports only `node:`,
  `bun:` and `oxc-parser`, and from the domain only types and the
  Effect-free `wire.ts`, `output.ts` and `limits.ts`.

The aggregate's state lives in memory, as the worker does; a new process
starts every session with no worker. What persists is the worker's
bindings, stored after every call under `kernel:<sessionID>` in the
plugin's storage as `{ bindings: [{ name, value }] }`, the shape every
earlier version wrote, so stored sessions keep restoring. A deleted
session's entry is removed. The compute limit and the idle timer read
Effect's `Clock`; the worker's own clock stops while its tool calls run.

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
bun run lint
bun run typecheck
bun run agents -- --check
bun run test
```

`bun run lint` is oxlint: its errors are the layout fence (`.oxlintrc.json`,
one import override per context; see `ARCHITECTURE.md`), and its warnings are
advice. `git diff --check` checks patch whitespace. The typecheck links every
workspace package (`mods/*`, `cmd/*`, `decider`) to the fork's installed host
packages; run `bun run link-fork` before and after `bun install` (an install
drops the links), and install only when changing the lock file. If working in a Rift, set `GENT_SOURCE` to
its source checkout so the gent pool integration tests run instead of
skipping.

The deterministic acceptance seams are the session API (the guard, compaction
per role, the Sabbath, held starts and subagent pace), the pool RPC and quota
calculation, the generated agent config, `bun run daily`'s config merge, and
opencode-drive frames (`scenarios/pool.ts`). The pane scenario covers
populated, loading, empty and failed-refresh states, and closing it.

## Remaining Claude mod features

The status mod's burn forecast, approaching-limit warning, login toasts,
project labels, account rotation and adaptive compaction tuning are not
ported. The existing role compaction windows and Sabbath guard remain.
