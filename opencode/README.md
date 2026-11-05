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
the Claude logins in `~/.local/share/opencode-prime/pool-auth`, gent's store format, when it exists), orchestrate, the guard, the kernel, status, the queue, git and idle compaction, the role
models and `autoupdate: false`, and into `cli.json` Prime, status, the queue and the
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
pane draws `status`, and the sidebar asks `session` for the login a session
is on (or would go out on next), by its label.

The model, in the domain files at `mods/pool`'s root:

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

`mods/status` draws the `/pool` pane; its plugins are `cmd/status`
(`server.ts` and `tui.tsx`). Its server plugin answers the
`dotfiles-opencode.status` RPC (`status.ts`) with the live
agents from orchestrate's call log and the units of each orchestrate run,
which the orchestrate skill's status script derives. Its options are `log`
and `statusScript`. An absent option takes its default. A malformed one
stops the plugin at setup, with a message that names it. The TUI plugin
registers the pane (`tui/pane.tsx`), which reads this RPC and the pool's
every two seconds. It keeps the last good reading when a read fails or does
not decode, and it draws the rows `pane.ts` projects. It also adds a Pool
section to the session sidebar (`tui/sidebar.tsx`, lines from `sidebar.ts`):
the session's login, its week and 5h use and when each resets, or nothing
when the session's provider is not pooled.

The model, in the domain files at `mods/status`'s root, has no aggregate,
because status decides nothing. It holds a view, values and contracts:

- View: `AgentCalls` (`agent-calls.ts`), a fold of the call
  log's `call` and `done` lines keyed by session and call id. A call is live
  until it returns `completed` or `error`.
- Values: the status script's table as units (`run-table.ts`), the pane's
  rows (`pane.ts`) and the RPC's shapes (`status.ts`).
- Handler: `Status.snapshot` (`model.ts`), which reads both halves on their
  own and names the half it could not read.
- Contracts: the call log (`CallLog`) and the runs with their status
  script tables (`RunTables`), each a `Context.Service` in `service.ts`,
  with what every implementation owes in `laws.ts`. `filestore/` reads the
  call log's JSONL file; `process/` runs `git` and the status script;
  `memory/` holds the in-memory ones the seam test uses.

Status stores nothing. Each RPC call reads the call log and the runs again.

## Queue

`mods/queue` is the agent's live queue, shown in the session sidebar; its
plugins are `cmd/queue` (`server.ts` and `tui.tsx`). The server plugin adds
the `queue` tool: `set` replaces the calling session's list, `upsert` and
`remove` patch it by id, and the answer is the list as it now stands. An
item has an id, one line of text, a state (`needs-you`, `running`,
`waiting`, `scheduled`, `next`, `done`), an owner (`mine` or `other` with
`who`), an optional `at` (required when scheduled), `detail`, and `session`:
the subagent session doing the work. The tool is a direct one, so a kernel
cell calls it as `tools.queue(...)`. Such a call leaves no tool part in the
transcript, so the queue is kept in a store, not read from parts. Its one
option is `dir`, default `$XDG_STATE_HOME/opencode-queue`. A deleted
session's queue goes.

The TUI plugin appends the Queue section to `sidebar.content`. Every two
seconds it reads the route's root session's queue over the
`dotfiles-opencode.queue` RPC (`get({ sessionID })` answers
`{ revision, items }`) and keeps the answer when its revision moved. An
item with a `session` shows that subagent's live state (running, blocked,
done, failed) instead of its own, and a running subagent no item names
joins the Running group under its call's description. Under a subagent's
row a second line gives its role, its one-sentence update and its time, as
the Prime rows do (`  implementor  Check the money… · 1s`). Done items stay
ten minutes.

The model, in the domain files at `mods/queue`'s root:

- Aggregate: `Queue` (`queue.ts`), deciding `SetQueue` and `PatchQueue` into
  `QueueChanged` with the list it leads to, or refusing with `InvalidItem`,
  `UnknownState`, `DuplicateItem`, `UnknownItem` or `UnclearChange`. A change
  that leaves the list as it is records nothing.
- Values: an item and its checks (`item.ts`), the board the sidebar draws
  (`board.ts`), the tool's text (`description.ts`).
- Handler: `QueueModel` (`model.ts`), which serializes a session's changes and
  stores the folded list with the next revision.
- Contract: `QueueStore` in `service.ts`, with what every implementation owes
  in `laws.ts`. `filestore/` keeps a JSON file per session, written whole;
  `memory/` holds the one the seam test uses.
- `opencode/subagents.ts` maps the shared subagent rows
  (`@dotfiles/opencode-subagents`: `read` from the TUI's data, then its rows)
  to the board's subagents, every row kept so a linked item outlives the
  shared linger.

## Git

`mods/git` ports gent's `@gent/git`; its plugins are `cmd/git` (`server.ts`
and `tui.tsx`). The TUI plugin adds a Git section to the session sidebar
(`tui/sidebar.tsx`, lines from `sidebar.ts`):

```
Git
main · ↑1 ↓2 origin/main
3 files +40 −12
#123 Title · open · checks ✓ · review required
```

It reads when it mounts, when a step of the session ends and every 10
seconds. A directory in no checkout has no section. A checkout git could not
read is one muted note. The pull request row needs `gh`. Without `gh`, with
`gh` signed out, or with no GitHub remote, there is no row. `/git` opens a
pane (`tui/pane.tsx`, rows from `pane.ts`) that lists the changed files and
the pull request. In the pane, ↑ and ↓ pick a file. Enter hands the terminal
to `hunk diff --watch <base> -- <path>`, or to `git --paginate diff` when
hunk is not on PATH, and the pane says so. The plugin API has no handover,
so the pane suspends the renderer, runs the command and resumes, as
OpenCode's external editor does.

The server plugin answers the `dotfiles-opencode.git` RPC (`git.ts`):
`checkout`, `pullRequest` and `review`, each for one session. It reads the
session's directory from OpenCode on every call, so a session that moves is
read where it is. It takes no options. The model has no aggregate:

- Values: the checkout (`checkout.ts`), parsed from `git status
  --porcelain=v2 --branch -z` and `git diff --numstat -z` against `HEAD`, or
  the empty tree on an unborn branch, with untracked files counted up to 200
  files of 512 KiB each. Also the pull request (`pull-request.ts`) from
  `gh pr view --json`, and the review command (`review.ts`).
- Handler: `Git` (`model.ts`). It keeps `gh`'s answers by the checkout's
  root, branch, upstream and ahead and behind counts, for 60 seconds, or 30
  seconds after a failure. It does not ask again when `gh` is missing.
- Contracts: `SessionDirectories`, `Checkouts`, `PullRequests` and
  `Programs` in `service.ts`, with their laws in `laws.ts`. `opencode/`
  asks the host. `process/` runs git with no optional locks and no index
  refresh, so a read never takes the agent's `index.lock`. It also runs `gh`
  and looks up programs on PATH.

## Herdr

`cmd/herdr` is a TUI plugin that tells [herdr](https://herdr.dev) what the
session on screen is doing, so its pane shows working, blocked and idle like
Claude's. It ports gent's `@gent/herdr` reporter. It judges the current
route's root session and every subagent it started:

- `blocked` while a permission (first) or a question waits, with a short
  message such as `Permission: shell bun test`;
- `working` while the root or any subagent runs or holds queued input, so
  kernel cells and background workers count;
- `idle` otherwise, and `unknown` off a session (the home screen).

Each state report uses source `dotfiles:opencode` and agent `opencode`. It
carries the root session's id and `resume_argv`
`["opencode", "-s", <root id>]`, so herdr reopens the session after a restart.
A `pane.report_metadata` report sets the pane's title to the session's title.
It also sets the working label to what runs now, such as
`kernel: <first line of the cell>`, `shell: <command>` or `3 subagents`, in
60 characters or fewer. That metadata has a 10-minute ttl and is refreshed
every 5 minutes. Closing the TUI releases the pane.

Reports go straight to `HERDR_SOCKET_PATH` from the TUI process, in the
background. Each request has a 500 ms timeout and one retry. Only the newest
state waits, and a failure is never shown. The plugin is inactive (no socket
and no work) unless `HERDR_ENV=1` and both `HERDR_PANE_ID` and
`HERDR_SOCKET_PATH` are set. The server runs as a background service outside
any pane, so only the TUI can report.

## Cache

`cmd/cache` is a TUI plugin that shows when a request paid again for a
prompt prefix the previous request had cached, why, and what it cost. It
ports gent's `@gent/cache`. A turn that lost a large prefix (20k tokens or
$0.10) ends on a row such as:

```
◌ cache miss · 48k tokens · $0.17 · expired during a 4s shell call
```

The causes are a model switch, a prefix that changed inside the cache
lifetime (only on a provider that writes its cache, such as Anthropic), and,
past the lifetime, the response itself, a tool call, an approval wait, a
pause, a subagent's report or idle time between turns. The lifetime is the
model's or provider's `settings.cache.ttl`, else 5 minutes for Anthropic and
30 minutes for OpenAI. A provider with neither counts only model switches. A
miss is priced at the cache-write rate for the tokens the request wrote back
and the input rate for the rest, less the read rate it would have paid.

The sidebar shows `Cache 91% · missed $0.42`: the share of prompt tokens
read from the cache, and the sum of every miss, for the session and its
subagents. Everything comes from the session's messages in the TUI; there is
no server half. Approval waits are seen only while the TUI runs, so a wait
from before it opened reads as the tool call it held up.

## Guard

`cmd/guard` is a server plugin that refuses a shell command that loses work
for good, as Claude Code's `claude/hooks/guard-destructive.ts` does. It runs
in the tool registry's `execute.before` hook for `shell` (and `bash`), so it
sees a direct call and a kernel cell's `tools.shell`, which the runtime runs
through the same hooks. The model reads the refusal as the tool's error:
`guard-destructive: <reason>.`

It refuses:

- a recursive `rm` (with or without `-f`) of the root, your home or a
  directory holding it, the directory the command runs in or one above it, a
  `.git` directory, or a repository's root;
- `git reset --hard`;
- a forced `git clean` that also takes directories or ignored files (`-d`,
  `-x`, `-X`), unless it is a dry run.

A force-push passes. Paths resolve against the session's directory, the
call's `workdir` and each `cd` before the command, with `~` and `$HOME`
expanded. It reads every command of a line (after `;`, `&&`, `||`, `|`, a
newline or a subshell), skips `sudo`, `env`, `VAR=1`, `nohup` and `command`
prefixes, takes neither quoted text nor a heredoc body for a command, and reads the script of
`sh -c`, `bash -c` and `eval`, as gent's guard floor does. When it cannot
tell where a call runs, or whether a path is a repository, it refuses. Its
one option, `home`, defaults to the user's home.

The model (the domain files at the root of `mods/guard`): `verdict.ts`
decides a command from where it runs and which of its targets are
repositories, and `shell-line.ts` reads a command line. `model.ts` asks the
contracts in `service.ts`: `RepoRoots` (`filesystem/`: a path holding `.git`)
and `SessionDirectories` (`opencode/`: the session's directory), with
`memory/` implementations for tests and the laws in `laws.ts`.

## Idle compaction

`cmd/idle-compact` is a server plugin that compacts a large session that has
gone idle shortly before its prompt cache expires, as Claude Code does. While
the cache is warm the compaction reads the long prefix from cache; once it
expires, the next message would write the whole context again. It runs
OpenCode's own compaction (`session.compact`), so the next message starts
from the summary.

A session compacts at its cache's expiry less a margin when all of these hold:

- it is a main session (a subagent's only with `subagents: true`);
- it does not run, and none of its subagents runs (a session waiting on a
  permission prompt counts as idle);
- its last request read from or wrote to the cache, and its prompt (input,
  cache read and cache write) is above the threshold: 30% of the model's
  window or 60,000 tokens, whichever is smaller;
- no compaction came after that request, and the cache has not expired.

The cache's life counts from the last request's start (title requests
aside), as Anthropic counts it. Its length is the model's or provider's
configured `cache.ttl`, else the provider's default: 5 minutes for Anthropic,
30 minutes for OpenAI GPT-5.6 and later, 5 minutes for older OpenAI models.
Other providers are not compacted unless `ttlSeconds` is set. The margin is
60 s for a cache of 5 minutes or less and 5 minutes for a longer one. A new
request, a queued message or a started execution cancels the session's
timer; it is set again when the session settles. At start the plugin decides
the recent main sessions. It logs each decision at debug level and each
compaction at info, with the session, the prompt's tokens and the cache's age.

Options: `ttlSeconds`, `shortMarginSeconds` (60), `longMarginSeconds` (300),
`thresholdRatio` (0.3), `thresholdTokens` (60000), `subagents` (false). An
absent option takes its default; a malformed one stops the plugin.

The compaction is OpenCode's manual one, so the transcript shows it as a
plain compaction: the plugin API has no way to mark it automatic. Orchestrate's
compaction windows trigger the fork's automatic compaction inside a request
as the context nears the window; idle compaction runs only between requests,
so the two never run at once, and orchestrate's `compaction` hook adds what it
keeps to both.

The model (the domain files at the root of `mods/idle-compact`): `idle.ts`
decides from a session's facts (`due`), `cache.ts` holds the providers'
lifetimes and the margins, and `model.ts` is the `IdleCompactor`, one timer
per session. It asks the `Sessions` contract in `service.ts`, implemented in
`opencode/`, with the laws in `laws.ts`. `tests/idle-compact.test.ts` runs it
in real OpenCode on a 20 s cache.

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

To look at an image, a cell calls `attach(...paths)`, as Prime Agent's
`attach_image`: each path, resolved against the session's directory, is
recorded (32 per cell at most), and the call answers "attached N images: …".
Only the paths cross the worker's pipe. After the cell the plugin reads each
file, sniffs PNG, JPEG, GIF or WebP from its first bytes, and adds it to the
result as a `data:` URI file part after the text; OpenCode resizes it to the
model's limits. A missing file, a non-image or one over 20 MB is a
`[not attached: <path>: <reason>]` line in the text. A cell that throws
attaches nothing. An image in a nested tool's result (`tools.read` on a PNG)
reaches the cell as `{ type: "image", mime, name?, note: "not shown; call
attach(path) to see it" }`, never as base64.

| Option | Default | Effect |
| --- | --- | --- |
| `idleMs` | `1800000` (30 min) | Kill a session's worker after this long without a call. Its stored bindings stay. |
| `timeoutMs` | `30000` | One call's compute limit, paused while its tool calls run. Past it the worker is killed. |
| `viewChars` | `8000` | Characters of output the model sees per call: the head and the tail. The worker keeps 64 KiB at most. |
| `codeOnly` | `true` | Make the kernel the agents' only tool, as above. `false` offers it beside the direct tools. |
| `denyExecute` | `true` | Without `codeOnly`: deny code mode's `execute` to every agent, so the kernel is the only code tool and every other tool is offered directly. |

Without `codeOnly` a cell's call runs the tool's own `execute` and skips
those hooks, which only the registry triggers, so the kernel then offers no
`subagent` and no `shell` (the guard's hook); start agents and run commands
with the direct tools. `denyExecute` reaches agents
that plugins define; an agent defined only in a config file arrives after the
plugins' transforms and keeps code mode. A call made inside a cell shows as
the kernel's row in the transcript, not as its own tool row.

The model (the domain files at the root of `mods/kernel`):

- Facts: `KernelReset`, `KernelStarted` (with the bindings it restored),
  `CellRan` (the cell's output, its display, the bindings it bound that the
  store left out, whether its bindings were stored, and the files it
  attached), `KernelLost` (why
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
  and tail (`output.ts`), the limits (`limits.ts`), an attached image, why a
  path was not attached and the reply they make (`attachment.ts`), and the
  worker protocol:
  its frames as schemas (`frame.ts`) and their framing on the pipes
  (`wire.ts`).
- Contracts (`service.ts`, with their laws in `laws.ts`): the worker
  processes (`Workers`), the stored bindings (`Snapshots`), sessions and
  agents' rules (`Sessions`), the attached files' bytes (`Files`), and the
  call's tools (`Toolbox`, provided per call: the runtime's, else the
  registry's). `worker/` implements `Workers`; `filestore/` implements
  `Files` over `node:fs`;
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
