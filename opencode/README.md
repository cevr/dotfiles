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
`~/.config/opencode/opencode.json` the Anthropic auth plugin (`cmd/anthropic-auth`), the pool (on
the Claude logins in `~/.local/share/opencode-prime/pool-auth`, gent's store format, when it exists, and with Claude's cache life as `cacheLifeMs`), orchestrate, the guard, the kernel, status, the queue, git, idle compaction, session mail and background questions, the role
models, a one-hour prompt cache for Claude
(`providers.anthropic.settings.cache.ttl: "1h"`) and `autoupdate: false`, and into `cli.json` Prime, status, the queue, background questions and the
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

## Prime

`cmd/prime` is the Prime look's TUI plugin (`gent.prime`), the composition
root of `mods/prime`. `daily` loads it first in `cli.json`, with the Prime
theme. The mod has three parts.

- The domain is the mod's root files, plain TypeScript with no OpenCode,
  OpenTUI or Solid. It covers what each row says: a tool group's header
  and tree rows (`group.ts`), a call's preview, counts and time (`call.ts`),
  a kernel cell's calls (`kernel.ts`), diffs (`diff.ts`), notices
  (`notice.ts`), a step's end row (`step-end.ts`), the pinned ask
  (`ask.ts`), subagent navigation (`subagent.ts`), the top bar and dock
  (`chrome.ts`), and the detail levels with their row gaps (`detail.ts`).
  `session.ts` holds the session data it reads, typed as plain values.
- The components are in `tui/`. They read the host only through the `Host`
  contract in `tui/host.ts`.
- `opencode/host.ts` builds that `Host` from the plugin context. Each read
  goes straight to the context, so it stays reactive.

A compaction reads as one line below All, such as
`◇ Compacted automatically · 171k → 6k tokens · 12.0s` (`compaction.ts`,
`tui/compaction.tsx`). A manual one says `Compacted`. A failed or cancelled
one says so in the warning tone, and a running one is the live spinner
line. The two numbers are the compaction request's own tokens: its prompt
(the context it compacted), then its output (the summary). The time runs to
the next message the run writes, because the host keeps no end time on a
compaction. At All (Ctrl+O) it is the host's whole block, with its rule and
the summary. This needs the fork's `session.message.compaction` slot. A host
without the slot draws its own block at every level, but then Prime's
typecheck fails on the unknown slot name.

`.oxlintrc.json` fences both layers. The domain may import only `effect`,
`@dotfiles/opencode-subagents/*` and its own root files. `tui/` may not
import `opencode/` or `@opencode/*`.

`mods/prime/tui.tsx` re-exports `cmd/prime/tui.tsx`. It is there for a
`cli.json` written before the move, which still loads `mods/prime`. The
next `bun run daily` replaces that entry with `cmd/prime`, and then the
shim can go.

## Orchestrate

`mods/orchestrate` holds the orchestrate skill's rules; its plugin is
`cmd/orchestrate`. It defines the role agents, their compaction windows and
their five-minute prompt cache (`ROLE_CACHE_TTL`, through the fork's per-agent
`request.settings.cacheTTL`; the main session keeps the provider's hour),
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
`providers`, `sweepMinutes`, `cacheLifeMs`, `sources` and `refreshOutageMinutes`. An absent option takes its
default. A malformed one stops the plugin at setup, with a message that
names it. Other mods read it over its `dotfiles-opencode.pool` RPC
(`status.ts`, `@dotfiles/opencode-pool/status`): orchestrate asks `pace`, and the `/pool`
pane draws `status`, and the sidebar asks `session` for the login a session
is on (or would go out on next), by its label, and `alerts` for gent's lost logins
and failing refreshes.

A gent login is lost while its file holds a refresh token the token endpoint
refused; `alerts` names it with the gent command that signs it in again. A
gent store's refreshes are failing when every one has failed for
`refreshOutageMinutes` (default 10), a paused trade included; `alerts` names
how long, how many tries and what the endpoint last said. A successful
refresh ends both (`alerts.ts`, `gent/store.ts`).

A prompt cache is per login, so a session moved to another login writes its
whole prompt again. While a session's cache lives (from its newest request
or priced step, for its agent's own `request.settings.cacheTTL` when it sets
one, such as the roles' 5 minutes, else `cacheLifeMs`: default 5 minutes, and
`daily` sets it from the TTL it gives Claude), its next run stays on that
login. It leaves only
when the login is held, or has a quota window at its share while another
login has room. Load, live sessions and pace place only a run whose cache is
gone.

A fork (`session.fork`, as `/btw` makes) sends its source's cache key, so
its first request reads the source's cache on the login that holds it. A
session with no cache of its own goes where its fork source's cache lives
(`cmd/pool/server.ts` reads the session's `fork`; `rank`'s `cacheOf`).

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
  store in place, under gent's lock, byte-compatible with gent. It
  refreshes a token five minutes (plus up to two, fixed per label) before
  it expires, serves a still-good token when the refresh cannot happen
  now, spaces trades from one store three seconds apart, and gives the
  usage sweep a read that never refreshes (`peek`).

The aggregate stores folded state, not events: no one reads its history.
The ledger keeps its holds, readings, priced steps and session caches under
`<pool>/hold/<id>`, `<pool>/reading/<id>`, `<pool>/step/<at>/<session>` and
`<pool>/cache/<session>`, so a new process starts where the last one
stopped. A ledger from before caches were kept restores none. Decisions read Effect's `Clock`; the seam tests move it with
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
when the session's provider is not pooled. The pool's alerts come first in
that section, whatever the provider: `tui/alerts.tsx` asks the pool's
`alerts` every five seconds, and toasts each new one once, for ten seconds,
with an OS notification when the TUI config allows them (`alert.ts` holds
the text).

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
done, failed) as its mark instead of its own state, still one line. The
section shows only the queue's items: a subagent no item names is not drawn
there, and no row carries a subagent's role, update or time; Prime's rows
beneath the composer show the subagents, sidebar open or closed. Done items
stay ten minutes.

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
  to each session's live state, every row kept so a linked item outlives the
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

## Btw

`mods/btw` ports gent's `/btw`; its plugin is `cmd/btw` (`tui.tsx`, with no
server half). `/btw <question>` (alias `/side`, or the palette's "Ask on the
side") forks the session on screen as it is now, a running turn included,
and asks the fork the question in the session's panel, beside the
transcript. The session keeps working and its transcript gets nothing:

```
btw: Why is the check slow?

Why is the check slow?
It sleeps on purpose, to hold the session busy.

ask › a follow-up
enter open · ctrl+s bring back · esc close
```

In the pane, Enter asks the line as a follow-up (one at a time, once the
fork has answered); Enter on an empty line opens the fork as the session on
screen; ctrl+s brings the newest answer back into the session once, as a
steered message its model reads at its next step (an idle session wakes on
it), drawn as one notice row (`◈ btw · <question>`); Esc closes the pane.
`/btw` alone opens the session's last fork again (Enter picks it from the
slash list, a second Enter runs it); `/btw <question>` always forks afresh.

The fork is an OpenCode session of its own, titled `btw: <question>`, kept
like any other. It copies the session's history, so its request is the
session's request with a hidden note (what the fork is, and that an
unanswered request above is not its work) and the question after it, with
the session's cache key: it reads the session's prompt cache, and with the
pool on, it goes out on the login that holds it. The note goes with the
fork's first question only.

The pane reads the fork from the server's message list
(`opencode/readings.ts`), when it opens, after each question, and a moment
after each host event about the fork while it is open. The TUI's own
message cache keeps only the sessions it retains (on screen, in tabs, viewed
last) and evicts a fork's. The fork's built-in `/btw` (`opencode.btw`, an
ephemeral answer in a dialog) is off: `daily` and gamut list
`-opencode.btw` in `cli.json`.

The model, in the domain files at `mods/btw`'s root:

- Commands: `RecordFork`, `FollowUp` and `BringBack`; facts `ForkOpened`,
  `FollowUpAsked` and `ReplyBroughtBack`; rejections `NoFork`, `ForkBusy`,
  `NoReply`, `AlreadyBroughtBack`, `QuestionEmpty` and `QuestionTooLong`.
- Aggregate: `SideQuestion` (`side-question.ts`), one per session: the fork
  its `/btw` opened last and the replies brought back from it. `model.ts`
  holds the handlers (`Btw`: `ask`, `followUp`, `bringBack`, `read`).
- Values: the question, its note and the fork's name (`question.ts`), the
  fork's own turns (`turns.ts`: its messages made after it), the pane's rows
  and hints (`pane.ts`) and the bring-back message (`bring-back.ts`).
- Contracts: the host's sessions (`Forks`), what a fork reads as
  (`ForkReadings`) and where each side question is kept (`SideQuestions`),
  in `service.ts` with their laws in `laws.ts`. `opencode/` implements them
  over the TUI plugin's client, session status and durable storage (key
  `side-questions`, the last 200 sessions); `memory/` holds the ones the
  tests use. `tui/` is the controller and the pane.

From gent: the note is a hidden synthetic message, not part of the prompt;
the bring-back carries the question and the answer, since OpenCode has no
tool that reads another session; the pane is the host's session panel, not
a dock. `tests/btw.test.ts` runs `scenarios/btw.ts`.

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

The causes are a model switch; inside the cache lifetime (only on a provider
that writes its cache, such as Anthropic) the pool moving the step to
another login, a compaction (its summary request, or the step after it
re-reading the new summary) or a prefix that changed; and, past the
lifetime, the response itself, a tool call, an approval wait, a pause, a
subagent's report or idle time between turns. The lifetime is the one the
previous request's agent asked for: its own `request.settings.cacheTTL`
(the roles' 5 minutes) over a model or provider `settings.cache.ttl`, as the
fork applies it, else that setting, else 5 minutes for Anthropic and 30
minutes for OpenAI. A provider with neither counts only model switches. A
miss is priced at the cache-write rate for the tokens the request wrote back
and the input rate for the rest, less the read rate it would have paid.

The sidebar shows `Cache 91% · missed $0.42`: the share of prompt tokens
read from the cache, and the sum of every miss, for the session and its
subagents. Everything comes from the session's messages and the location's
agents in the TUI, and the login of each step from the pool's `logins` RPC;
there is no server half. Approval waits are seen only while the TUI runs, so a wait
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
- it does not run (a session waiting on a permission prompt counts as idle;
  one waiting on a foreground subagent runs, since the subagent is its tool
  call);
- its last request read from or wrote to the cache, and its prompt (input,
  cache read and cache write) is above the threshold: 30% of the model's
  window or 60,000 tokens, whichever is smaller;
- no compaction came after that request, and the cache has not expired;
- that request is not the first after a compaction: the first one only loads
  the summary, so a session that compacted (idle, on the window, or by hand)
  waits for real work before it compacts again;
- compacting costs less than letting the cache expire, at the model's catalog
  prices. Letting it expire, the next request writes the whole prompt again;
  compacting, the summary request reads it from cache and writes a summary
  (estimated at 32,000 output tokens), and the next request writes the
  summary's prompt (estimated at 64,000 tokens). An Anthropic hour's cache is
  written at twice the input rate. On Opus 5.5 with an hour's cache this pays
  above about 148,000 prompt tokens; with a 5-minute cache, above 200,000. A
  model the catalog does not price compacts on the threshold alone.

The cache's life counts from the last request's start (title requests
aside), as Anthropic counts it. Its length is the one the request was sent
with, resolved as the fork resolves it: the model's `cache.ttl`, else its
provider's, replaced by the agent's own `request.settings.cacheTTL` (an
orchestration role's 5 minutes) when one is configured; with none
configured, the provider's default: 5 minutes for Anthropic, 30 minutes for
OpenAI GPT-5.6 and later, 5 minutes for older OpenAI models. Other providers
are not compacted unless `ttlSeconds` is set. When the catalog, the provider
or the agent cannot be read, or the catalog no longer has the model, no
default stands in: the session is skipped as `ttl-unknown` (unless
`ttlSeconds` is set). The margin is 60 s for a cache of 5 minutes or less and
5 minutes for a longer one. A new request, a queued message or a started
execution cancels the session's timer; it is set again when the session
settles.

The plugin decides the recent main sessions once the catalog has been quiet
for 2 s after it starts, and again 2 s after each `provider.updated`,
`model.updated` or `agent.updated`. OpenCode loads its config plugins after
ours, so while it reloads the plugins a provider reads without its
configured `cache.ttl`; deciding then would judge an hour's cache by the
5-minute default and compact it early. The catalog's events come once the
reload is applied, and the decisions they trigger name the right lifetime.

Background subagents and shells do not hold an idle session back. Their
notice wakes the session when they end, and a wake after the cache expired
would write the whole context again, so the timer runs as for any idle
session: work still running when it fires leaves the session compacted, and
its notice lands on the summary; a notice that comes first wakes the session
and cancels the timer.

Each decision is one line: `compaction scheduled` (in how many seconds, the
cache's lifetime, the prompt's tokens, the threshold), `compacting the idle
session`, or `not compacting` with its reason (`running`, `too-small`,
`expired`, `compacted`, `no-new-work`, `costs-more`, `no-cache`,
`ttl-unknown` with what could not be read as `unresolved`, `no-request`,
`subagent-session`, `unreadable`). Scheduled, compacting and not compacting a
session above the threshold log at info; `too-small`, `no-request`,
`no-cache`, and any skip of a session at or below the threshold, at debug.
Each line has the session, what triggered it (`settled`, `timer`, `resume`,
`catalog`), the cache's age,
the background work still running (`busy`), and the price check: `verdict`
(`pays`, `costs-more`, `unpriced`), `avoidedUsd`, `costUsd` and
`breakEvenTokens`.

Options: `ttlSeconds`, `shortMarginSeconds` (60), `longMarginSeconds` (300),
`thresholdRatio` (0.3), `thresholdTokens` (60000), `subagents` (false). An
absent option takes its default; a malformed one stops the plugin.

The compaction is OpenCode's requested one, asked for with the fork's
`reason: "auto"`, so the transcript records it as automatic; a host without
`reason` records it as manual. Orchestrate's compaction windows trigger the
fork's automatic compaction inside a request as the context nears the
window; idle compaction runs only between requests,
so the two never run at once, and orchestrate's `compaction` hook adds what it
keeps to both.

The model (the domain files at the root of `mods/idle-compact`): `idle.ts`
decides from a session's facts (`due`), `cache.ts` holds the providers'
lifetimes and the margins, `price.ts` what compacting costs and avoids, and `model.ts` is the `IdleCompactor`, one timer
per session. It asks the `Sessions` contract in `service.ts`, implemented in
`opencode/`, with the laws in `laws.ts`. `tests/idle-compact.test.ts` runs it
in real OpenCode on a 20 s cache.

## Session mail

`cmd/mail` is a server plugin that lets the sessions on one OpenCode server
write to each other, so two agents can coordinate without the owner relaying.
It adds two direct tools, offered to every session (main and subagent) and
reached from a kernel cell as `tools.sessions` and `tools.message`. It takes
no options.

- `sessions({ search?, children?, limit? })` lists the server's sessions,
  newest activity first: id, title, `running` or `idle`, agent, directory,
  last activity, and the parent of a subagent's session. Main sessions by
  default; `children: true` adds subagents'. `search` matches text in the
  title, directory or id; `limit` is 20 by default, at most 100. Archived
  sessions are left out; the caller's own is marked `(you)`.
- `message({ to, text, wake?, replyTo? })` writes `text` into the session
  `to` names. A `ses_…` id names that session; other text names a title: an
  exact title in any case, else the one title that contains it. More than one
  match is refused with up to five of them named, as are no match, the
  caller's own session and an empty text.

A message is a synthetic user message in the receiver, delivered as a steer.
A running receiver reads it at its next step; an idle one starts a turn to
read it, unless `wake: false`, which leaves it for its next turn. The receipt
says which. The receiver's model reads a header above the text:

```
✉ Message from session "Mail A" (ses_…), sent with the message tool. It is not the user speaking.
To answer, call the message tool with { "to": "ses_…", "text": "…" }; answer only if it asks for something.

<text>
```

`replyTo` (an id or a title, default the sender) sends answers to another
session; the header's second line then names it. The answer line asks for a
reply only when the message asks for something, so two sessions do not answer
each other forever. The transcript shows the message as one line,
`✉ from <sender> · <first 80 characters>`: the fork draws a synthetic
message whose metadata source is `mail` with the `✉` icon, then the
message's description. The message's
metadata is `{ source: "mail", from, replyTo }`. Each delivery is logged at
info as `mail: <sender> → <receiver>`, annotated with both ids, the reply
session, the delivery and the text's first 200 characters.

Sessions on another server are out of reach: the plugin reads and writes
through its own server's sessions.

The model (the domain files at the root of `mods/mail`): `directory.ts`
lists sessions (`select`, `listing`), `address.ts` holds the addressing rules
(`isSessionID`, `byTitle`, `notSelf`) and their refusals, `letter.ts` writes
the header, the transcript line and the receipt, and `model.ts` is `Mail`,
which resolves `to` and `replyTo` and sends. It
asks the `Sessions` contract in `service.ts`, implemented in `opencode/`, with
the laws in `laws.ts`. `tests/mail.test.ts` runs two exchanges in real
OpenCode: a ping and its answer between two idle sessions, and a message
steered into a running one.

## Background questions

`mods/questions` lets an agent ask the owner something without stopping,
ported from gent's `ask_user_async`. Its plugins are `cmd/questions`
(`server.ts` and `tui.tsx`); neither takes options.

The server adds the `ask_user_async` tool, a direct tool (a kernel cell calls
it as `tools.ask_user_async(...)`):

- `ask_user_async({ questions?, withdraw? })` asks 1-3 questions, each
  `{ question, header?, options?, assume }`: a header of at most 30
  characters, at most 4 choices with distinct labels, and the assumption the
  agent works on meanwhile. It returns at once:

  ```
  Asked in the background; nobody has answered yet:
  - q1: Which database should the cache use? · assuming SQLite
  Continue on your assumption now. An answer arrives as a message in this session if the user gives one; if it differs from your assumption, revise the work that rests on it.
  ```

- Ids are `q1`, `q2`, … per session. Asking the same text again replaces the
  open question; `withdraw: ["q1"]` takes questions back; at most 8 stay open
  and a ninth drops the oldest. The receipt names each of these.

The TUI plugin draws, above the composer (the `session.composer.top` slot),
one line while the session or any of its subagents has questions open:

```
? 3 open questions · Cache store, Old endpoint, Test runner · shift+← /answer
```

With one question it reads `? 1 open question · <header> · assuming <assume> · shift+← /answer`;
parts drop from the right as the width shrinks, the hotkey last but one. `/answer`,
or shift+← on an empty composer, opens the pane in the line's place, on the
oldest question. shift+← is also the composer's select-left: with text in the
composer the key stays the composer's and selects (the hotkey's layer sits
above the textarea's and hands the key on); with no question open it does
nothing.

```
? Question 1/3 · Cache store · asked just now
Which database should the cache use?
▸ SQLite  assumed · one file, no server
  Redis
  Type your own answer
↑↓ move · enter answer · type your own · ctrl+x dismiss · esc close
```

The cursor starts on the assumption (a row of its own at the top when no
choice names it); typing answers in your own words. Enter answers, `ctrl+x`
twice dismisses (the agent is not told), Esc closes. A subagent's question
names it: `· from general ·`. The pane closes with the last question.
The cursor, the typed answer and a first `ctrl+x` stay while the questions
are read again; they start over only when another question takes the top
(the shown one was answered, dismissed, withdrawn or asked again, which gives
it a new id): the pane then shows the next oldest, on its assumption.

An answer goes to the session that asked as a synthetic user message,
steered, so a running session reads it at its next step and an idle one wakes:

```
Answer to your background question q1 (asked 2026-11-05T12:54:12.125Z):
Q: Which database should the cache use?
You assumed: SQLite
A: Redis
This differs from your assumption: revise the work that rests on it, and say what you changed.
```

(or `This is what you assumed: carry on.`). The transcript draws it as one
notice, `◈ answered · <question> → <answer>`; its metadata is
`{ source: "questions", answers: [{ id, question, header?, assume, answer, matches }] }`.
The answer is recorded with the message's id before it is sent, so one that
did not go (the server stopped) goes again under the same id when the TUI
next reads or the plugin starts, and the session reads it once. A deleted
session's questions go.

The questions are kept in the plugin's storage (OpenCode's database), one
sheet per session. The TUI reads them over the `dotfiles-opencode.questions`
RPC (`open`, `answer`, `dismiss`), again on its `changed` event and every 2
seconds.

The model (the domain files at the root of `mods/questions`): `question.ts`
is the `Questions` aggregate, deciding `Ask`, `Answer`, `Dismiss` and
`Delivered`; `ask.ts` the tool's input, description and receipt; `reply.ts`
the answer's message; `tray.ts` and `choices.ts` the line and the pane;
`hotkey.ts` when shift+← opens the pane;
`model.ts` the `QuestionsModel` that keeps the sheets and sends the answers.
It asks the `QuestionStore`, `Courier` and `Changes` contracts in
`service.ts`, implemented in `opencode/` and `memory/`, with the laws in
`laws.ts`. `tests/questions.test.ts` runs `scenarios/questions.ts` in real
OpenCode, direct and from a kernel cell, and `scenarios/questions-hold.ts`
for the hotkey and the pane holding its place across readings;
`cmd/questions/tui.test.ts` checks the hotkey's binding on a stand-in TUI.

Where it departs from gent: a subagent may ask (gent refuses it in a child
session), and its question shows in its parent's tray; ids are per session,
not `<call>:<n>`, since every call from one kernel cell shares the cell's id;
`withdraw` is new; questions outlive a restart.

Under `daily`, orchestrate's roles (planner, implementor, verifier, worker)
are not allowed `ask_user_async`: a role answers to the session that started
it, which decides what reaches the owner. So in practice the root sessions
ask, and a subagent asks only outside orchestrate's roles.

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
plugins' transforms and keeps code mode.

Each kernel call records the calls its cell made through `tools.*`, in order,
as `metadata.operations` (`operations.ts`): each one's tool, its input's scalar
fields (strings cut to 400 characters), whether it is running, completed or
failed (with why), the head of its output (2,000 characters) and the result
metadata a transcript reads (`exit`, edited `files` with patches cut to 4,000
characters, a subagent's `sessionID`). At most 100 are kept and the rest
counted in `dropped`. The record is published through the call's progress
while it runs and kept in its result, also when the cell fails; it stops
changing once the call ends. Prime draws a kernel call as these calls, with
fx's header and rows (`Read 2 files · ran 2 commands`, `├ Read a.ts, b.ts`),
never as its code; a call with no record names the tools its code calls
(`Ran a cell calling read, shell`; record-less cells side by side fold into `Ran 3 cells calling shell, write`).

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
per-role cost prediction, fair ticket queue or Sabbath-adjusted working-hour
budget.

A provider the pool measures but does not place goes in the pool's `paced`
option (daily sets `paced: { openai: "openai" }`). OpenAI's pace is then the
ChatGPT account's own usage, the same numbers Codex CLI's `/status` shows:
the `wham/usage` endpoint, then the `x-codex-primary/secondary-*` headers and
`codex.rate_limits` frames on each response
(`mods/pool/chatgpt/usage.ts`). The account counts every place it is spent,
this host or another, OpenCode or Codex CLI. Its requests are never placed,
and its token is never stored or shown. A new subagent on a Codex provider
takes that pace when the orchestrate mod's `codex.pool` is set (daily sets
`codex: { pool: true }`). When the pool has no reading (`measured: false`),
or without `codex.pool`, it asks the orchestrate skill's
`budget.ts --codex --admit --model <id> --role <role>` as before.
That script reads only this host's `~/.codex` transcripts. A hold denies the
call with the same background waiter. The orchestrate mod's `codex` option
names the providers, the script and `pool`; `false` turns it off.

### The fleet

A reading lags the agents just admitted, on every host spending the same
accounts. The pool's `fleet` option closes that gap. Each host records the
subagents orchestrate admits (`started`). It reads its peers' reports every
`pollSeconds` (30), and its pace charges each start in the fleet
`startCost` (0.005 of one account's week) for `settleMinutes` (10). The
hold names the extra: `the pool's weekly pace is over (90.0% spent across 2
accounts, +30.0% for 3 agents started in the last 10 min)`. It opens when the
oldest start settles. A report also carries the host's readings. A peer's
newer reading of a login this pool lists (the same credential id, such as
`gent:<label>`) replaces the older one.

The transport is SSH over the tailnet. No port opens, and no token or
password crosses. A host reads a peer by running
`ssh -o BatchMode=yes <dest> 'bun run -'` with
`mods/pool/ssh/report.ts` on stdin. On the peer, report.ts asks its own
server on loopback (`~/.local/state/opencode/service.json`) for the pool's
`report` and prints it. daily configures the peers: the Mac reads
`bite-workbox`, and the workbox reads `cvr@cristians-macbook-pro`.

OpenCode runs the plugin once per directory it serves. The fleet is kept in
the plugin's storage, which belongs to the host, so every instance counts
the same starts, and a peer is read by one instance per half `pollSeconds`.
A peer that cannot be read is logged once, and the pace goes on without its
new starts. The /pool pane's Fleet section names it: `workbox ·
unreachable since <time>: <message>; the pace goes on without it`.

Gaps: a reading merges only for credential ids both hosts list. An
OpenCode-signed login has a different connection id on each host. A ChatGPT
header reading is credited to the provider's active connection.

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
