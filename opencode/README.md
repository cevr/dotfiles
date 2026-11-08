# OpenCode mods

Our orchestration harness and Prime look on OpenCode 2.x. The fork's public
plugin hooks supply the UI; orchestration policy lives in this repository.

## Your daily `opencode`

```sh
bun run daily            # build the fork, write ~/.local/bin/opencode, merge the config
bun run daily --skip-build
bun run daily --no-upstream  # skip the upstream merge
bun run daily --dry-run      # fetch upstream, say what would merge, change nothing
```

On the Mac, the host that owns the fork, `daily` first merges upstream
OpenCode into the fork (`scripts/upstream.ts`): it fetches `upstream/dev`
and, when `prime-look` lacks some of its commits, merges it (`--no-edit`) in
a worktree of the fork of its own (`~/.local/state/opencode-daily/upstream-merge`,
kept between runs so its `node_modules` stay warm), never in the checkout
`OPENCODE_DEV` builds. A clean merge must then install as its lockfile says,
typecheck `packages/tui`, `packages/core` and `packages/plugin`, and pass the
acceptance tests most exposed to host changes (`tests/prime-*`, `tui-cpu`,
`mail`, `orchestrate`) with `OPENCODE_DEV` at the merge, niced and without
`ANTHROPIC_BASE_URL`. Green, `prime-look` fast-forwards to the merge (its
working tree too, where it is checked out), goes to origin, and this build
is of it. A conflict (aborted) or a red check leaves `prime-look` as it was,
prints the conflicting files or the failing check, writes them to
`~/.local/state/opencode-daily/upstream-conflict.md` for an agent to resolve
(a red merge is kept on branch `daily/upstream-merge`), and the install goes
on with the fork as it is. The report goes once `prime-look` is current
again. The workbox skips the step and pulls origin `prime-look`.

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
the Claude logins in `~/.local/share/opencode-prime/pool-auth`, gent's store format, when it exists, and with Claude's cache life as `cacheLifeMs`), orchestrate, the guard, the kernel, status, the queue, git, idle compaction, session mail, background questions, wakes, skills, the cache and the web tools, the role
the Claude logins in `~/.local/share/opencode-prime/pool-auth`, gent's store format, when it exists, and with Claude's cache life as `cacheLifeMs`), orchestrate, the guard, the kernel, status, the queue, git, idle compaction, session mail, background questions, wakes, skills, the rift tool and tool names, the role
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
  (`chrome.ts`), the dock's wake item (`wakes.ts`), the goal line
  (`goal.ts`), and the detail levels with their row gaps (`detail.ts`).
  `session.ts` holds the session data it reads, typed as plain values.
- The components are in `tui/`. They read the host only through the `Host`
  contract in `tui/host.ts`.
- `opencode/host.ts` builds that `Host` from the plugin context. Each read
  goes straight to the context, so it stays reactive. The wakes come from
  the wake mod's RPC (`opencode/wakes.ts`, ids from its protocol file
  `@dotfiles/opencode-wake/wake`, decoded with Prime's own schema). A part
  of a step (`partOf` in `session.ts`) and the context usage (`usage.ts`)
  are worked out from the session's messages and the location's models; the
  goal comes from OpenCode's goal RPC (`opencode/goal.ts`: read on a
  session's first read and on reconnect, kept current from its `changed`
  events).

The dock under the composer counts the session's work:

```
◆ 0 subagents  ·  1 shell  ·  1 wake
```

Beneath it, one row per subagent (`mods/subagents`) names the orchestrate
step it runs by the role's noun, as the skill and the agents name it, not a
gerund: the state is the leading diamond, so `implementing` beside a done
diamond would contradict it. A worker started before the guard routed by
the description reads as the role its description names, the role word
dropped from the unit; any other worker reads `worker`:

```
◈ implementor opus  pkg-lower                  (was: ◈ worker opus  pkg-lower implementor)
◈ verifier    opus  closure-flake r1 (Opus)    (was: ◈ worker opus  closure-flake verifier r1 (Opus))
```

The wake item shows only while the session has wakes pending or notices
unread, in the success colour while any is pending (the warning colour with
only notices); its parts drop from the right as the row narrows. It is read
again on the wake mod's `changed` event and every 2 seconds.

↓ on an empty prompt opens the host's composer panel. After the host's
Subagents, Shell and Terminals tabs, Prime adds Wakes and Monitors (through
the fork's `ui.composerTab`; `tui/composer.tsx`, the words in `wakes.ts`).
Each lists the session's pending alarms or monitors, soonest first, one row
each:

```
12:36 in 9m 59s · ALPHA: check the deploy · wake · once           (Wakes: due, note, mode, repeat)
echo still-waiting · every 1s · until /^READY$/ · still-waiting   (Monitors: command, period, stop, newest output)
```

↑/↓ move the highlight, Enter shows the whole entry (its full note, a
monitor's newest output in full), ctrl+d cancels it as `wake_cancel` does,
and ←/→ move between tabs. An empty tab says `No pending wakes` or
`No monitors`. A monitor's newest output is the wake server's memory of
its last check since that server started.

A session goal (the fork's `/goal`) shows only as one line right above the
composer, in its state's colour, and nowhere while there is no goal
(`goal.ts`, `GoalLine` in `tui/chrome.tsx`):

```
● goal · ship the dock · 2↻ · /goal pause · /goal cancel        (active, success)
‖ goal paused · Paused by the user · /goal resume · /goal cancel  (paused, warning)
✓ goal met · ship the dock                                        (met, muted, gone after 10 s)
```

`N↻` counts the continuations sent since the goal was set or last resumed.
The objective truncates first, then the commands drop, then the count. The
continuations themselves draw no rows (the host hides a synthetic message
without a description). `tests/prime-goal.test.ts` runs
`scenarios/prime-goal.ts` for the dock and the goal line.

A model step's tool calls are one group: a header over a `├`/`└` tree,
ended early by answer text. The step's thought is the tree's first node, its
label in a tool name's colour and its first line faint; at All (Ctrl+O) the
whole thought hangs under it. A step that only thinks is a one-node group
headed `Thought` (`Thinking` while it streams, the glyph blinking in the
accent). The Overview shows no thoughts. A finished worker's notice is a
group too, its result the body:

```
● Read 1 file · ran 1 command
├ thinking  Planning the check
├ Read money.py
└ Ran printf '1 passed\n'

● General finished · Fix CSV quoting
└ CSV quoting fixed.
  Quoted fields keep their commas.
```

`tests/prime-thoughts.test.ts` runs `scenarios/prime-thoughts.ts` for both.

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

The shells count is the session's running shell commands. A click on it
opens the session's shell list (`shells.ts`, `opencode/shells.ts`), read
fresh from the host's shell routes each time: running first, then the ones
that ended, newest first, 30 at most. Each shows its description (else its
command's first line), then `state · runtime · last line`:

```
Running
  Blocking sleeper  running · 3s · no output
Ended
  Long sleeper      killed · 3s · tick 1
```

ctrl+k kills the highlighted running command (the host's `shell.kill`) and
lists again; Enter shows its output's tail, and closing that returns to the
list. A shell call the host moved to the background (see Background
shells) ends its row with `moved to the background`, muted, at Details and
All; one started with `background: true` reads `Started <command> in the
background`. A shell call on a handle reads by its action: `check` reads
`Checked sh_…`, `wait` `Waited on sh_…`, `kill` `Killed sh_…`, and `list`
`Listed shells` (`shellAction` in `mods/subagents/shell.ts`, which the
subagent rows read too: `waiting on sh_…`, a wait that only waits); the
row's body is the handle's output, without the header line the row already
says. Older transcripts' flag forms (`{ id }`, `{ id, wait }`, `{ id, kill:
true }`, `{ list: true }`) read the same, and their `shell_list`,
`shell_read` and `shell_kill` calls still read `Listed shells`, `Read sh_…`
and `Killed sh_…`.
`tests/prime-shells.test.ts` runs `scenarios/prime-shells.ts` for all of it.

`.oxlintrc.json` fences both layers. The domain may import only `effect`,
`@dotfiles/opencode-subagents/*` and its own root files. `tui/` may not
import `opencode/` or `@opencode/*`.

## Background shells

The fork (branch `shell-handles`, on `bg-shells`, and `shell-action` for the `action` input) makes every `shell` call
return a handle, and the same tool acts on it: there are no separate
shell tools. A handle is

```
{ id, state: "running" | "exited" | "killed", exitCode?, signal?, timedOut?,
  runtimeMs, output, next, truncated, backgrounded?: "start" | "limit" | "user" }
```

in the call's structured output and its metadata (less `output`), and in
its text as a header line, then the output:

```
sh_1aea1ab24… · exited 0 · 0.2 s
sh_1aea286ba… · running · 2.0 s · moved to the background at its 2 s limit
sh_1aea290bd… · running · 0.0 s · started in the background
sh_1aea2979c… · running · 3.1 s · moved to the background by the user
```

A foreground command that ends before its limit returns its handle already
exited, with the output a shell call has always shown. One still running at
its limit moves to the background and the call returns its running handle,
with the last 20 lines so far and how to act on it. The call's `timeout` is
that limit in milliseconds: it never kills a foreground command. With no
`timeout` the limit is `experimental.shell_background_after` from the
config, else 600000 (10 min); `0` never moves it (`timeout: 0` blocks
until the command ends). `background: true` returns the running handle at
once, and there `timeout` is a kill deadline. ctrl+b (the host's
`session.background`) moves a running call at once (`backgrounded:
"user"`). A `description` on the call names it in the list and the dock's
list.

The input's `action` says what the call does:

| Input | Does | Header notes |
| --- | --- | --- |
| `{ action?: "run", command, workdir?, timeout?, description?, background? }` | runs a command; its handle when it ends or moves. `action` may be left out when `command` is given | `started in the background`, `moved to the background at its N min limit`, `moved to the background by the user` |
| `{ action: "check", id, offset? \| lines? }` | checks it: its state and the output since the last look (its last 40 lines at most), from byte `offset`, or its last `lines` lines; 64 KiB at most | `next N` (the `offset` to read on from), `N earlier bytes not shown`, `the oldest output was dropped` |
| `{ action: "wait", id, ms?, offset? \| lines? }` | waits up to `ms` (600000, 10 min, by default) for it to end, then checks it | `still running after waiting 0.5 s` |
| `{ action: "kill", id }` | stops it, then returns its final handle | `it had already ended` |
| `{ action: "list" }` | `{ shells: [{ …state, size, description, command, started, background }] }`; a line per shell: `sh_1 · running · 2.0 s · 7 bytes · Long sleeper` | |

The schema is one flat object with an `action` enum, not a root union
(Anthropic and OpenAI refuse a tool schema whose root is `anyOf` or
`oneOf`), so the tool checks which fields go with which action: a field
that is not its action's fails naming the fields it takes (`action "kill"
takes id, not lines.`), and a missing `id` or `command` says so. Its rest
is open, so the flag forms before actions reach the tool rather than being
dropped, and fail naming the action form: `{ id, kill: true }` with `The
shell tool has no kill field; use { action: "kill", id: "sh_…" }.`, and
likewise `{ list: true }` and `{ id, wait }`; a bare `{ id }` asks for the
action. An id reaches only the session's own shells; another fails with
`No shell sh_… in this session`. A kill sends SIGTERM to the command's process group, then
SIGKILL to whatever of the group is left after 3 s; the record and output
stay readable.

A background command that ends on its own, or that the reader kills (the
dock's list, the composer's shell tab), notifies the session with its final
handle: the notice's text is the header and the output since the agent's
last look, and its metadata carries `handle`. The agent's own kill returns
the final handle and sends no notice; so does a `wait` that sees the end.

In a kernel cell the shell is methods, not input fields
(`mods/kernel/worker/shell-handle.ts`). `await tools.shell({ command,
workdir?, timeout?, description?, background? })` only runs a command and
resolves to a live handle: `.id`, `.state`, `.exitCode`, `.signal`,
`.runtimeMs`, `.output`, `.next`, and `.refresh()`, `.read({ offset?, lines?
})`, `.wait(ms?)` (10 min by default) and `.kill()`, each a shell call with
its id that updates the handle in place and resolves to it. `await
tools.shell.handle(id)` rebuilds one, and `await tools.shell.list()` gives
one for each of the session's shells from a single list call (with its
`.description`, `.command`, `.started` and `.background`; `.output` empty,
`.next` the output's size, the read position left where it was). The
methods call the tool with its actions (`check` for `.refresh()` and
`.read()`, `wait`, `kill`, `list`). An input with an action other than
`run`, or with `id`, `ms`, `offset`, `lines` or an older flag (`kill`,
`wait`, `list`), throws a TypeError naming the method to use. A kernel
restart keeps a handle's data but not its methods.

```ts
const dev = await tools.shell({ command: "bun dev", background: true, description: "dev server" })
await dev.wait(2_000) // dev.state, dev.output
for (const shell of await tools.shell.list()) if (shell.state === "running") await shell.kill()
```

Output is kept on disk in two files of 8 MiB each: `<id>.out` holds the
newest bytes, and when it fills it becomes `<id>.out.1`, replacing the one
before. So a shell keeps its last 8 to 16 MiB; a check says when the oldest
was dropped. The host keeps the 100 newest ended background shells and the
25 newest ended foreground ones, and sweeps output files after 7 days. The
server has `POST /api/shell/:id/kill` and `GET /api/shell?exited=true`.

## Orchestrate

`mods/orchestrate` holds the orchestrate skill's rules; its plugin is
`cmd/orchestrate`. It defines the role agents, the one compaction window
every role and primary agent runs at (400k tokens, `WINDOW` in
`compaction.ts`; a model whose own window is smaller compacts at its own) and
their five-minute prompt cache (`ROLE_CACHE_TTL`, the per-agent
`request.settings.cacheTTL` that `cmd/anthropic-auth`'s `http.request` hook
writes over the provider-configured lifetime, raised by the pool to the provider's hour once a
role's session outlives it; the main session keeps the provider's hour),
routes each subagent call to a role, starts a new Opus start the pace holds on
Codex instead, latches one both hold, writes each role's start and hand-back to its unit's
`log.md`, stops agent work over the Sabbath, and resumes the subagents a restart cut. Its
options are `log`, `now`, `place`, `fullAgent`, `codex`, `unitLog` and `resume`.
An absent option takes its default. A
malformed one stops the plugin at setup, with a message that names it.

The model (the domain files at `mods/orchestrate/`):

- Facts: `SubagentStarted` (the agent, why it was routed there, its
  model, `fallback`, why it runs on Codex, when it does, and `lowered`, the
  variant a worker asked for and does not run at),
  `SubagentLatched` (a held start kept to start later: what holds it, why,
  when it opens, when it is decided again, and the fallback's hold) and
  `SubagentFinished` (the child session and how it ended).
- Commands: `StartSubagent`, `OpenLatch` (a latched start decided again at
  its time), `UseTool` (any other tool call) and `FinishSubagent`. Each one
  is decided only from inputs gathered beforehand: the clock, the place, the
  asked agent, the child's agent and latch, the role's model and the pace
  hold, and the Codex fallback with its own hold.
- Rejections: `SabbathRest` (when work resumes) and `StillLatched` (a
  follow-up to a child whose latch has not opened). `PaceHeld` (whose pace,
  the reason, and when it opens) refuses a held start only when no latch can
  be kept for it. The call log records each one as a `denied` line.
- Aggregate: `ToolCall`, keyed by the session and call id, with its
  commands, facts and their rejections in `tool-call.ts`. Every command
  goes through its `decide`; `model.ts` holds the handlers. A kernel cell's
  tool calls share the outer call's id, so `decide` never reads state.
- Values: the Sabbath and `SabbathRest` (`sabbath.ts`), role routing
  (`role.ts`, over `agents.json`), the compaction window and keep-list (`compaction.ts`),
  the pace answers and `PaceHeld` (`pace.ts`), and a unit's moves on a role's
  start and hand-back (`unit-log.ts`).
- Views: the call log, `~/.cache/orchestrate/opencode-agents.jsonl`. It has
  one line per fact or rejection (`call-line.ts`), and the status pane reads
  it.
- Contracts: the pool's pace (`PoolPace`), the Codex admission script
  (`CodexAdmission`), sessions, models, the latches (`Latches`: the wakes
  keep a latch, and a latched child starts through the subagent tool), the
  restart's reads and resumes (`Restarts`, below), the call log and the units' logs (`UnitLogs`), each a `Context.Service` in `service.ts`, with what every
  implementation owes in `laws.ts`. They are implemented in `filestore/`
  (the call log, and the units' logs through the skill's log.ts), `opencode/` (sessions, models, the
  latches, the restarts and the pool's pace over OpenCode's plugin context and RPC) and `codex/` (the
  admission script); `memory/` holds the doubles the plugin's seam test
  runs on.

The aggregate stores events, not state. The status pane reads the history
as the call log, and no command needs the folded state.

### Resuming after a restart

OpenCode continues a root session and a background subagent that a shutdown
cut mid-turn by itself, at its next start (a `restart` notice in each). It
leaves a foreground subagent: the parent's call to it ends `Tool execution
interrupted (sessionID: …)`, and the child stays cut until the parent calls it
again by hand. When the plugin starts (a server start, or a plugin reload,
which cuts nothing but finds a cut an earlier start left), it waits 10 s so
OpenCode's own recovery lands first, then reads its location's subagent
sessions active in the last 6 hours (`restart.ts`, through the `Restarts`
contract, `opencode/restarts.ts`):

- Cut: the last step ended aborted and no turn end followed (a shutdown
  writes no `idle` marker). Resumed.
- Interrupted (an `idle` marker `interrupted` after the aborted step): the
  user's Escape or a parent's cancel, left alone, unless the parent's call
  to it was cut by the same shutdown (the parent's own turn has no
  `interrupted` after that call, or was itself cut through its parent).
  The shutdown reaches a foreground child through its parent's call, which
  cancels it, so this is the common case.
- Anything else (ended, running, continued by a prompt or OpenCode's own
  notice, cut before the window or after the start, a root session): left.

Each cut child is prompted, in the background through the subagent tool, in
its parent's call to it: `Your turn ended when OpenCode restarted; continue
where you left off. Any shell you had running was cut by the restart; rerun
the ones you still need.` Its result wakes the parent as a background
subagent's does. A turn resumed in a row waits longer each time (10 s, 2 min,
10 min, the `resume.backoffMs` option); past three it is left to the parent.
Each child is checked again just before its resume, so one its parent or
OpenCode continued meanwhile is not resumed twice, and a reload finds the
resumed ones continued. Each resume is a `resumed` line in the call log
(`{ kind, at, sessionID: parent, callID, child, agent, description, cause:
"restart", attempt }`). The parent gets one steered notice per restart
(`◈ Subagents resumed after a restart`) naming the children resumed and the
ones left, with why; it wakes the parent only when none was resumed. Over the
Sabbath nothing is resumed. `resume: false` turns it off.

A crash (no graceful shutdown) leaves a step unfinished rather than aborted,
which reads the same as a step that runs, so it is left to the parent.

The route (`role.ts`): a role or any other agent asked by name runs as
asked, and a former role name as its role. An untyped or general call runs
as the lean worker (under `fullAgent`, as the general agent). A call that
would run as the worker (untyped, general or `worker`) and whose
`description` names an orchestrate step runs as that role, reason
`described`, at the role's effort and pace: the orchestrator meant the role,
and only the role agent carries the protocol and the effort. The form
(`described.ts`) is the skill's, the role first (`verifier auth r1`), or the
role after a one-word lowercase unit slug with only a round and a note
behind it (`pkg-lower implementor`, `closure-flake verifier r1 (Opus)`).
A role mentioned in prose (`Fix the verifier's timeout`, `Planner prompt
rewrite`) names none. A follow-up asking no particular agent (none, a
general one, or `worker`) keeps its child's agent (`continued`), and a
follow-up never changes agent by its description.

A new start routed to a role (asked by name or described) whose `model` is
the role's own (the model it would run on, at any variant or none, with or
without its provider) runs as if it named none, reason `model-dropped`: at
the role's effort, with the Codex fallback and the latch. Any other model a
call names runs as named, with no fallback.

The units' logs (`unit-log.ts`): a role's start moves its unit, by the
call's `<role> <unit> r<N>` description, to `plan`, `implement` or
`verify`; its hand-back, the first line of its last answer when its session
goes idle (the fork's `experimental.idle` hook), moves it as the machine
says (implementor `ready` to `verify`, verifier `accepted` or `stuck` to
`decide`, `changes` to `implement` the next round, any `blocked` to
`blocked`; a planner's `ready` waits for the orchestrator). Each move goes
through the skill's `log.ts --current` into `<run dir>/<unit>/log.md`, the
unit dir being the one a path in the prompt or the hand-back names, else the
one `tmp/orchestrate/<run>/<unit>` in the session's checkout. None found, a
move the orchestrator already logged, or one log.ts refuses writes nothing.

The worker's ceiling (`capEffort` in `role.ts`): a call that runs as the
worker on a model at `#max`, asked by the call or inherited (a new worker
naming no model runs on its agent's model, else its parent's, at that
model's variant; `StartSubagent.inherited`), runs on that model at its
default effort instead, unless its description ends `(mechanical)`. The
call log's line says `lowered: "max"`, and the parent reads first in the
answer that it runs at the default and why. It lowers rather than refuses: a
root at max would otherwise have every worker refused, and a refusal costs a
turn and teaches the parent to add `(mechanical)` to get through. A role is
never lowered: a verifier at max for a deep unit's round 1 runs at max.

The worker's handoff: like each role, the worker is told (`agents/worker.md`,
through `agents.json`) to stop at its first compaction, write a handoff file
(the task, what is done, what is next) and end with `compacted: <path>. Start
a fresh worker from this handoff; do not continue this session.`

### An idle root with work to do

A root session owns an orchestrate run once it starts a step (`<role> <unit>
r<N>`) of one of the run's units, as the call log records it. When such a root
ends its turn (the fork's `experimental.idle` hook) while its runs hold units
in `plan`, `implement` or `verify` (the status mod's `STATUS` RPC, over the
skill's `status.ts`), it is steered once with one line:

```
idle with units in plan, implement or verify: alpha, beta; start them or name what you wait on.
```

Units in `ready` wait for their batch (the orchestrate skill's Land a batch).
Once the batch is due, the line says to land it, naming each unit's Rift by
its name, the unit (the orchestrator makes `.rifts/<repo>/<unit>` on branch
`<run>/<unit>`), which the rift tool finds:

```
idle with a batch due (3 ready): gamma, delta, eps; land it with rift({ action: "land", rifts: ["gamma", "delta", "eps"] }).
```

A batch is due by each ready unit's cadence: its spec's `Batch cadence` line,
else its plan's, else 3 ready or 30 minutes. Only the line's numbers are read
(`<n> ready`, `<n> min` or `<n> h`); a number it leaves out comes from the
level above. The skill's `status.ts` prints it per unit (`Cadence`, `3 ready
or 30 min`, its `cadence.ts`). It is due once the ready units reach any ready
unit's count, or any ready unit has waited its wait by its `log.md` time.

With both, the batch follows the first line as `… A batch due (…): …`. Units from more than one run read `run/unit`; past eight the rest
are counted (the land call names every one). The line is a steered synthetic message carrying the metadata key
`dotfiles-opencode.orchestrate.idle`, so its own arrival is not new input.

Once per idle period: after a nudge the root is not nudged again until new
input reaches it (the owner's prompt, a wake, a worker's notice). The nudge
is held while any of these stands:

- a subagent or shell still runs under it;
- the owner drafts a prompt to it: the orchestrate TUI plugin
  (`cmd/orchestrate/tui.ts`) reports a composer holding text over the
  `IDLE.draft` RPC, again every 10 s while it stays; the server forgets a
  draft not reported within 30 s, and decides again 2 s after one clears;
- a wake, monitor or latch is set for it;
- a question to the owner is open (a background question, or a `needs-you`
  item in its queue);
- it named its wait: a `waiting` item in its queue;
- the Sabbath.

The aggregate is `IdleRoot` in `idle.ts` (commands `GoIdle`, `Hear`,
`ReportDraft`, `Nudge`; rejection `NotNudged` with its reason), the handler
`IdleRoots` in `model.ts`, over the contracts `StepLog` (the call log's
started units, `filestore/`), `Runs` (`opencode/runs.ts`), `RootHolds`
(the wakes, questions and queue RPCs, `opencode/holds.ts`) and `Steer`
(`opencode/steer.ts`). `tests/idle-root.test.ts` runs
`scenarios/idle-root.ts`: no nudge while the planner runs or a draft stays,
one after the draft clears, the named wait in the queue (read off the
scenario's Queue sidebar, which `bun run daily` does not install), no second
nudge.

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

An agent's own lifetime shorter than `cacheLifeMs` (the roles' 5 minutes)
pays only while its session's requests follow each other closely. A session
that comes back after its own lifetime but within `cacheLifeMs` (a long shell
command, a wait, a role resumed) has outlived it: from its next request on,
the pool gives it `cacheLifeMs` for as long as each request follows the last
within it (`requestCache` in `accounts.ts`). The pool names that lifetime on
the request (`x-opencode-cache-ttl: 1h`), and the auth plugin strips the
header and writes it on every cache breakpoint of the body. A session's cache
mark is kept at least `cacheLifeMs` (`markKept`), so the pool knows the
session when it comes back. Over 43 hours of role steps this saved about $19
of $538 on the Mac and $189 of $898 on the workbox against five minutes
throughout; an hour throughout saved $177 on the workbox and cost $43 on the
Mac.

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

`mods/queue` is the agent's live queue; its plugins are `cmd/queue` (`server.ts` and `tui.tsx`). The server plugin adds
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

The TUI plugin appends the Queue section to `sidebar.content`. It is not
installed: `scripts/daily.ts` leaves it out of `cli.json` (the owner found the
section distracting), so the queue is read by the agent and the RPC only. Every two
seconds it reads the route's root session's queue over the
`dotfiles-opencode.queue` RPC (`get({ sessionID })` answers
`{ revision, items }`) and keeps the answer when its revision moved. An
item with a `session` shows that subagent's live state (running, waiting
(a latched one too), blocked, done, failed) as its mark instead of its own state, still one line. The
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
read where it is. The RPC model has no aggregate:

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

### The pr tool

The server plugin also offers `pr`, a direct tool (`pr.ts`, handlers in
`pulls.ts`), so an agent never polls GitHub with `gh`, `sleep` or a monitor:

- `status`: per request (default: the session's branch's), the head, its
  checks grouped fail, pending, pass and cancelled, each failing Actions job
  with its failing tests and a log excerpt (`failure.ts`, at most 3 logs),
  the review decision, the latest reviews, unresolved threads, requested
  reviewers and mergeability (`report.ts`). A cancelled run is not a failure.
- `watch` (`until` green, reviewed or changed; a `note`), `unwatch`, `list`:
  a watch is the `PrWatch` aggregate (`watch.ts`). Its notice is a steered
  synthetic message, a `◈` row that wakes the session. `green` tells each
  failure and goes on, and ends when the checks pass; any watch ends on a
  merge or a close.
- `create`: `gh pr create` for the session's branch, asking the configured
  reviewers of the repository's owner (`biteinc`: andrewgoupil, antwandaher,
  narminmolina) unless `reviewers` says otherwise.

Once a session family used the tool on a repository, its default branch is
followed for a week, and the family's root hears for a day when it turns red
(once per red spell, with the failing jobs) and green again (the
`DefaultBranch` aggregate, `branch.ts`).

The watcher is per machine. Every directory's plugin in the server process
registers, and the first one alive ticks every `intervalSeconds`. Watches and
followed repositories live in the plugin storage, which every directory
shares and a restart keeps (`opencode/watch-store.ts`). A tick probes each
repository with conditional REST requests, which cost no rate limit when
nothing moved. On a change, or every `refreshSeconds`, it reads all the
repository's watched requests and its default branch in one GraphQL call
(`process/github.ts`). There is no webhook source: the tokens on both
machines lack `admin:repo_hook`. `Pulls.poke(repo)` is the seam a push
source would call.

Options, all optional: `intervalSeconds` (60), `refreshSeconds` (300),
`follow` (repositories always followed; none), `reviewers` (owner or
`owner/name` → logins). `tests/pr.test.ts` runs `scenarios/pr.ts` with a
stand-in `gh` (`process/fake-gh.ts`).

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

## Skills

`mods/skills` ports gent's `$` skill mentions; its plugins are
`cmd/skills` (`server.ts` and `tui.tsx`). Typing `$` at the start of a word
in the composer opens a popup of the skills, beside `/` for commands and `@`
for files, which stay as they were. Typing filters it, and Enter inserts
`$<id>` and attaches the skill, as an `@` mention of it does:

```
$deploy Ship to production                                       global
$review Review this project's change                              local
$review:global Review any change, the user's way      global · shadowed
$
```

Skills have two tiers, as in gent. A local skill is the project's: a
`.opencode/skills`, `.opencode/skill`, `.claude/skills` or `.agents/skills`
folder in the working directory or a parent. A global skill is the user's:
OpenCode's config directory, `~/.claude/skills`, `~/.agents/skills`. When
both hold one id, the local copy wins `$<id>` and the global one stays
reachable as `$<id>:global` (`$<id>:local` names the local one); the popup
lists both, the global one marked shadowed. The skill tool loads either
copy by `<id>:local` or `<id>:global`. A skill a plugin, a URL or a
configured path adds shows without a tier.

On send, each `$<id>`, `$<id>:local` or `$<id>:global` token that names a
skill attaches it, so the turn carries its instructions without a skill
tool call; picking from the popup and typing the token out do the same. The
token stays in the text. A `$` inside a word (`a$b`), before a digit (`$5`),
inside a code span or a fenced block, or before a name no skill has, stays
plain text.

How it is built:

- Rules, Effect-free so the TUI reads them too: `mention.ts` finds the
  tokens, `tier.ts` the tiers and what to register for an id both hold,
  `catalog.ts` the popup's entries and rows, what a token resolves to and
  the skills RPC (`SKILLS`, `catalog`).
- `model.ts` (`SkillsModel`) holds the latest scan and answers the catalog,
  the registry edits and the attachments; the scan is the `SkillFiles`
  contract in `service.ts` (laws in `laws.ts`), implemented in
  `filesystem/skill-files.ts` by OpenCode's discovery rules.
- The server registers a skill transform (`<id>:local`, `<id>:global`, and
  the local copy under `<id>`), a `prompt` hook that attaches the tokens'
  skills, and the RPC; `skill.updated` rescans. The TUI asks the RPC for the
  catalog, because only the server knows the user's folders.
- The popup needs the fork's `ui.autocomplete` (a plugin trigger in the
  composer). Without it there is no popup; typed tokens still attach.

From gent: the skill comes in the prompt as an attachment rather than an
instruction to call the skill tool. OpenCode keeps one skill per id and which
copy holds a plain id two of them share depends on the order its skill
plugins register, so the plain id is held for the local copy only when this
plugin's transform runs last; `$<id>` itself always attaches `<id>:local`.
`tests/skills.test.ts` runs `scenarios/skills.ts`.

## Herdr

`cmd/herdr` is a TUI plugin that tells [herdr](https://herdr.dev) what the
session on screen is doing, so its pane shows working, blocked and idle like
Claude's. It ports gent's `@gent/herdr` reporter. It judges the current
route's root session and every subagent it started:

- `blocked` while a permission (first) or a question form waits, with a
  short message such as `Permission: shell bun test`;
- `working` while the root or any subagent runs or holds queued input, so
  kernel cells and background workers count; an open background question
  (`ask_user_async`) never stops the agent, so it leaves work `working`;
- `blocked` when nothing works and background questions are open, since the
  agent waits on the answers: `Question: <label>`, or `3 questions: <label>`
  naming the oldest. An answered, dismissed or withdrawn question drops out
  on the questions plugin's `changed` event;
- `idle` otherwise, and `unknown` off a session (the home screen).

The background questions live in the questions plugin's server, so the
reporter reads them over its RPC (`open`) when the session's family changes,
on every `changed` event for one of its sessions, and every 10 seconds as a
backstop. A failed read keeps the last one; without the questions plugin none
are open.

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

## Recover

`cmd/recover` is a TUI plugin that returns a session whose directory is gone
(a removed rift or worktree) to where it was before. When the session on
screen is idle and its directory no longer exists, it reads the session's
location-switched messages (every applied move appends one, naming where the
session went and where it left; the oldest one's previous location is where
the session was made), newest first, and moves the session to the newest of
those locations that still exists, through the same `session.move` route the
host's "Choose directory" calls. A toast says so:

```
Moved to ~/Developer/repo: ~/.rifts/repo/feature no longer exists
```

With no such location, the host's own "Session location unavailable" prompt
stays. A failed read or move toasts `Failed to return session` and leaves the
prompt. A directory that exists is looked at again on the next visit; a
missing one is tried once per session and directory. The host draws its
prompt for the moment before the move lands. The TUI checks the directories
on its own machine, as `daily` runs it beside its server.

The model (the domain files at the root of `mods/recover`): `recover.ts`
picks the location (`recoverTarget`) and words the toast, and `model.ts`'s
`recover` reads and moves through the contracts in `service.ts`: `Sessions`
(`opencode/`: the TUI client's message list and move) and `Directories`
(`filesystem/`, with its laws in `laws.ts`); `memory/` holds the world the
model's test runs on. `tests/recover.test.ts` runs `scenarios/recover.ts`:
a session moved into a folder that is then removed goes back where it was
made when the TUI opens it.

## Escape

`cmd/escape` is a TUI plugin that makes one Escape on a busy session take
back the prompt just sent. Within the grace (5 s after the session's newest
prompt with text was sent), Escape with an empty composer stops the run,
reverts the session to before the prompt and puts its text back in the
composer: it runs the host's own `session.undo`. Past the grace it
interrupts (`session.interrupt` with `resume`), and the prompt and its
partial answer stay. A prompt still waiting in the session's inbox (queued,
or a steer the model has not read) comes back whatever the grace. When the
taken-back run called a shell, a toast says
`Cancelled; shell commands it ran are not undone`: a revert restores files,
not what a command did outside them.

A draft in the composer (text or an attachment, read from the focused
editor, `renderer.currentFocusedEditor`) swallows the key while the session
works, so a half-typed message is never replaced. A permission request or a
question keeps its own Escape, an idle session's Escape is the host's, and a
second Escape for the prompt being taken back is swallowed for 10 s. In a
subagent's view Escape interrupts that subagent before the host's Subagents
picker closes. Its one option is `grace`, in milliseconds (default 5000; 0
always interrupts). An absent option takes its default. The grace is timed from when the prompt was sent, so a prompt another client
sent to the session in the last 5 s can be taken back too.

The decision is `decide` in `mods/escape/escape.ts`, over the view
`opencode/view.ts` reads from the TUI's data; `cmd/escape/setup.ts` adds the
two keymap layers on Escape (the base mode at priority 1, above the host's
`session.interrupt` and below the composer's own Escape layers such as shell
mode or a plugin panel; the composer mode at priority 2 in a subagent's
view) and acts. `tests/prime-escape.test.ts` runs `scenarios/prime-escape.ts`.

## Cache

`cmd/cache` is a TUI and a server plugin that show when a request paid again
for a prompt prefix the previous request had cached, why, and what it cost.
The TUI half ports gent's `@gent/cache`. A turn that lost a large prefix (20k tokens or
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
auth plugin applies it, else that setting, else 5 minutes for Anthropic and 30
minutes for OpenAI. A provider with neither counts only model switches. A
miss is priced at the cache-write rate for the tokens the request wrote back
and the input rate for the rest, less the read rate it would have paid.

The sidebar shows `Cache 91% · missed $0.42 · expired`: the share of prompt
tokens read from the cache, the sum of every miss for the session and its
subagents, and the cause that cost the most (`expired` for every wait,
`prefix at system[1] ¶4`, `login moved`, `cache lost`, `compaction`, `model
switch`). The rows and the sidebar come from the session's messages and the
location's agents in the TUI, and the login of each step from the pool's
`logins` RPC. Approval waits are seen only while the TUI runs, so a wait from
before it opened reads as the tool call it held up.

The server half (`cmd/cache/server.ts`, loaded by `bun run daily` beside the
other server plugins) keeps the ledger. Its `http.request` hook fingerprints
each primary and compaction request a session sends (`fingerprint.ts`: each
tool, each system paragraph, each message part, hashed; the first words of a
system paragraph, never a message's text), with the pool's login header and
the lifetime the request asks for (its `cache_control` markers' `ttl`, an
OpenAI body's `prompt_cache_options.ttl`, the pool's lifetime header over
both). When the step ends it judges the request against the session's one
before (`request-log.ts`): `first`, `hit`, `uncached`, `model`, `expired`,
`login` (with both logins), `compaction`, `prefix` (the first segment that
changed and about how many tokens in) or `unchanged` (the prompt held and
the cache lost it anyway). The TUI asks for those causes over the
`dotfiles-opencode.cache` RPC, so a row inside the lifetime reads `prefix
changed at system[1] ¶4, 3k tokens in` or `the cache lost an unchanged
prefix`; without the server half the TUI's own causes stand.

Each judged request is a line of `~/.cache/opencode-cache-ledger/ledger.jsonl`
(options: `dir`, `host`). `bun scripts/cache-ledger.ts [--since 24h] [--host
<name>] [--top 10] [--json] [--file <ledger.jsonl>]...` sums it: cache writes
by cause, by first changed segment, the unexplained part (`login`, `prefix`,
`unchanged`) per host and day, and the costliest session-hours.

`bun scripts/cache-audit.ts [--since 7d] [--host <name>] [--top 10] [--json]
[--static] [--primary build,plan] [--file <ledger.jsonl>]...` audits it for
the weekly dream (`mods/cache/audit.ts`). The north star is the hit rate,
`read / (read + write + uncached)`, overall and per host, agent and model,
with the writes' share of the prompt and of its cost (Anthropic's list
multipliers: read 0.1×, 5-minute write 1.25×, 1-hour write 2×), and the
wasted writes. A break is a request whose read fell against the session's
request before by more than the 1,024-token floor and a fifth of the prompt
both share, found from the tokens, classified first match wins: `model-switch`,
`compaction`, `ttl-expiry` (a gap past the previous request's lifetime),
`login-move`, `restart` (the server judged it first although the ledger holds
an earlier request), `tool-set`, `system-prompt` or `message-edit` (by the
first changed segment), else `dropped`. A session's first request is a cold
start: `subagent-first` on an agent outside `--primary`, else
`session-start`. It ranks the causes and sessions by the tokens written
again, and weighs lifetimes under an hour (the roles' 5 minutes): the hour's
dearer writes against the expiries an hour would have covered. `--static`
holds the setup against the six caching rules and the lifetime fit
(`mods/cache/rules.ts`): probes of our plugins, the fork (`OPENCODE_DEV`) and
the config's model and MCP server names, with the window's breaks as the
evidence, `pass`, `warn` or `fail` per rule with the file responsible.

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
tell where a call runs, or whether a path is a repository, it refuses.

It refuses a kill by pattern that would reach OpenCode: `pkill`, `killall`
and `kill $(pgrep …)` (with `-f`, `-i`, `-x` read as those tools read them)
whose pattern matches this server's process or one whose name or program
starts with `opencode` (a TUI, another server). It lists the processes with
`ps -A -ww` for such a call only, and refuses when it cannot list them or
cannot read the pattern as a regular expression. `kill -1`, which signals
every process you own, is refused outright. The reason names the
alternative: find the PID you mean (`pgrep -fl <pattern>`, `ps`) and
`kill <pid>`. A kill by PID, signal 0, `pkill -P`/`-F` and a `pgrep` that
only lists pass.

It also refuses a subagent's foreground shell call that opens by sleeping 30
seconds or more (`sleep 60`, `sleep 60 && tail log`, `sleep 1m; gh run
view`; units and summed operands as GNU `sleep` reads them), as
`guard-sleep: <reason>.`. The reason names the replacement: start what it
waits on with `background: true` and wait on the handle with
`shell({ action: "wait", id, ms })`, or run a check of outside state as a
background `until` loop and wait on that (wake and monitor refuse a
subagent). A root session's sleep runs, a call with `background: true` runs,
and a sleep later in the line or inside a loop is not read. When the host
cannot say whether the session is a subagent, the sleep runs: a sleep loses
nothing. `sleep.ts` holds the rule; `Subagents` (`opencode/`: a session with
a parent) is its contract.

The model (the domain files at the root of `mods/guard`): `verdict.ts`
decides a command from where it runs and which of its targets are
repositories, `kill.ts` decides a kill from the process table, `sleep.ts` a
subagent's sleep, `heavy.ts` and `launcher.ts` pick and write a heavy
command's launcher, and `shell-line.ts` reads a command line. `model.ts`
asks the contracts in `service.ts`: `RepoRoots` (`filesystem/`: a path
holding `.git`), `SessionDirectories` and `Subagents` (`opencode/`),
`Processes` (`process/`: `ps`), `Launchers` (`filesystem/`) and `Scopes`
(`process/`: the `systemd-run` probe), with `memory/` implementations for
tests and the laws in `laws.ts`.

### Shell policy

A heavy command runs at a lower CPU priority and, on Linux, under a memory
cap, so one runaway test cannot take the machine and the server down (on
2026-11-06 one `bun test` on the workbox grew to 38.5 GB and the OpenCode
server died with it). It is no cap on agents or on load: a light command
runs as before, and a heavy one runs at once.

A command is heavy when one of its simple commands opens with a pattern of
the `heavy` option: by default `bun test`, `bun run test`, the gate, check,
typecheck and accept scripts, `npm`/`pnpm`/`yarn` test, `tsc`, `tsgo`,
`tsgolint`, `vitest`, `jest`, `playwright test`, `turbo`, `go test`,
`go build`, `go vet`, `golangci-lint` and `cargo` test, build, check,
clippy, nextest and bench (`heavy.ts`). `go run` and `cargo run` are not:
what they start usually lives on, and their build is mostly cached.
A pattern's last word also matches its `:` scripts (`bun run test:e2e`).
The launchers agents put in front are read through, with their options and
`VAR=value` assignments: `npx`, `bunx`, `pnpm exec`, `timeout`, `flock`,
`setsid`, `nohup`, `env`, `nice`, `ionice` and `stdbuf`; so are the scripts
of `sh -c`, `eval`, `flock -c` and `env -S`. The content of a script file
(`bash gate.sh`) is not, and neither is `systemd-run`: the unit it starts
runs outside the launcher (a service at nice 0 in a cgroup of its own), so
the line runs as written. Workers do not wrap their checks in units of their
own (the orchestrate protocol's Shell); how many heavy checks run on one
machine at once is the orchestrator's to size (the orchestrate skill's
"Heavy checks fit the machine"), not this policy's.

The policy rides the shell's `create.before` hook, which sees every command
OpenCode spawns, the user's `!` too. For a heavy one it swaps only the shell
for a launcher of the same file name (`~/.cache/opencode/guard-launchers/<hash>/zsh`),
which runs `exec nice -n 10 '/bin/zsh' "$@"`; where `systemd-run --user
--scope` works (probed once), it runs the shell in a transient scope with
`MemoryMax=12G` and `CPUWeight=20` (`nice` has no effect between cgroups).
The command, its echo in the transcript and the permission check stay as
written. The niceness adds to the caller's, up to 19. On a Mac it is `nice`
alone: there is no memory cap. When a launcher cannot be written, the
command runs as it would have, and a warning is logged.

Options (all optional; a malformed one stops the plugin and says which):

| Option | Default | Meaning |
| --- | --- | --- |
| `home` | the user's home | the directory `~` and `$HOME` name |
| `heavy` | the list above | the heavy commands' patterns; `[]` turns the policy off |
| `nice` | `10` | the niceness added, 0 to 19 |
| `memoryMax` | `12G` | the scope's `MemoryMax` (`512M`, `12G`, `50%`, `infinity`) |
| `cpuWeight` | `20` | the scope's `CPUWeight`, 1 to 10000 |
| `launchers` | `~/.cache/opencode/guard-launchers` | where the launchers are written |

The guard does not strip secrets from a command's environment: the shell
calls on record carry no API key to strip (the only `env -u` in them drops
Claude Code's markers).

## Rift

`cmd/rift` is a server plugin that adds the `rift` tool (a direct tool, so a
kernel cell reaches it as `tools.rift`) and takes OpenCode's worktree tools
(`opencode_worktree_create`, `_list`, `_remove`) out of the registry: they
make Git worktrees, and on Rifts they failed (10 times in 7 sessions on the
workbox in a week). One input, with an `action`:

- `{ action: "create", branch, name?, source? }` makes a Rift of the warm
  source the session's directory (or `source`) belongs to, on `branch` (the
  local branch, else `origin/<branch>`, else a new one from the source's
  HEAD; default: the name), named after the branch as `workrift` names it
  (`feat/x` → `feat-x`). It answers the Rift's directory and branch and how
  to move there (`session_move`); it never moves the session itself. On the
  Mac it runs `rift create <source> --copy-all --name <name>` and switches the
  branch; on the workbox, `workrift create <branch>` from the session's
  directory with `WORKRIFT_SOURCE` set, which refreshes the source, imports
  gh stack metadata and names the Rift itself.
- `{ action: "list" }` lists the source's Rifts with their branch and their
  unsaved work (`clean`, or `2 uncommitted, 1 unpushed, 1 stashed`).
- `{ action: "remove", name | path, force? }` moves a Rift to Rift's trash
  (`rift remove`, `workrift remove` on the workbox). It refuses a Rift that
  holds work found nowhere else, and names it: uncommitted changes (untracked
  files too), stash entries the warm source does not also hold (a Rift
  inherits its source's stash), and commits on no remote and in no branch of its
  source, unless `force: true`. It always refuses a warm source, the Rift the
  session runs in, and a Rift with Rifts of its own. `withChildren: true`
  takes the Rift's own Rifts with it, each still refused while it holds
  unsaved work.
- `{ action: "land", rifts: ["feat-x", "feat-y"] }` lands the Rifts as one
  batch, as the orchestrator's batch landing does by hand. Before touching
  any, it refuses a warm source, a Rift off any branch, a Rift with its own
  uncommitted changes (a file the same as in the warm source does not count)
  and a repository with no gate. Then, in the source's integration Rift
  (`integrate`, made on first use and kept): repair a stale multi-pack index,
  check out origin's newest default branch (dropping any tracked change the
  last gate left, such as a lint fix), merge each Rift's branch in order
  (`git fetch <rift> <branch>`, `git merge FETCH_HEAD`). A conflict in lock
  files and the repository's generated files alone is settled: the Rift's
  side, installed again and regenerated, committed. Any other conflict aborts
  the merge and stops the batch, naming the Rift and the files. Then install
  each lock file the batch changed (committed when rewritten), and, when
  `rift.regenerate` is set, run it once more after every batch, conflict or
  not: a clean merge can still leave a generated file stale (one Rift
  changed what another's generated file is written from). What it rewrote
  among the generated files and the lock files is committed as one `chore:
  regenerate generated files after landing` (nothing changed, no commit); a
  failing regenerate stops the batch before the gate. Then run the gate
  once, push to the default branch when it still holds origin's newest, fetch
  in each landed Rift and trash it unless the removal rule keeps it (it says
  why). The accept check then runs once, in the background, one at a time
  per plugin, in the integration Rift on everything since the batch's base,
  and wakes the calling session (a steered `session.synthetic`) with its
  counts and failures; a red one is fixed forward. The integration Rift takes
  one batch at a time, its accept check included.

  A repository that lands through pull requests (a team repository, where CI
  on the PR is the merge gate) sets `rift.push` false. Land then merges,
  installs, regenerates and runs the gate (and the accept check, in the
  background) in the integration Rift the same way, but never pushes the
  default branch and never removes a Rift. A conflict reds only its own Rift
  and the others merge on; a red gate or accept check reds every Rift it ran
  on, with its log and failures, for the caller to route to the Rift whose
  diff each failure touches. The answer (or, with an accept check, its wake)
  lists each Rift `green`, `red` with why, or `pending`. With
  `rift.pushBranches` true a green Rift's own branch is pushed to the same
  branch on origin, never forced, so its PR runs CI on the gated head; a
  refused push is named and leaves the Rift green.
- On the workbox, `{ action: "init", repository, path? }`, `"refresh"`,
  `"check"` (of the session's or `source`'s warm source), `"deps"` (in the
  named Rift, else the session's directory), `"sources"`, `"prune"` (always
  `--dry-run`) and `"storage"` (`workbox-rift-storage --check` and `df -h` of
  `WORKBOX_RIFT_MOUNT`, else `/workspaces`) run the workbox's own script as it
  is and answer what it printed. Elsewhere they say they need the workbox.

A repository names its checks in its warm source's Git config, so the tool
knows no repository's commands:

| Key | Meaning |
| --- | --- |
| `rift.gate` | the fast check run before the push; required |
| `rift.accept` | the slow check run after it, with `RIFT_LAND_BASE` set to the batch's base |
| `rift.generated` | one value per generated file (repository-relative): its conflict is settled by writing it again, and its rewrite after every batch is committed |
| `rift.regenerate` | the shell line, run at the repository root, that writes them again: on such a conflict, and after every batch's merges and install, before the gate |
| `rift.push` | a Git boolean, default true; false checks the batch without pushing the default branch or removing a Rift |
| `rift.pushBranches` | a Git boolean, default false; with `rift.push` false, push each green Rift's own branch |
| `workrift.main` | the default branch; else origin's HEAD, else `main` |

The gate and the acceptance run always run heavy, through the guard's
launcher (`heavyArgv` in `mods/guard/launcher.ts`): `nice -n 10`, and where
`systemd-run --user --scope` works (Linux with a user systemd), a scope with
`MemoryMax=12G` and `CPUWeight=20`. On the Mac they run niced alone.

This repository's warm source sets:

```sh
git config rift.gate 'cd opencode && OPENCODE_DEV=$HOME/Developer/personal/.rifts/opencode/prime-look GENT_SOURCE=$HOME/Developer/personal/.rifts/gent/untrack-local-settings bun run gate'
git config rift.accept 'cd opencode && env -u ANTHROPIC_BASE_URL OPENCODE_DEV=$HOME/Developer/personal/.rifts/opencode/prime-look GENT_SOURCE=$HOME/Developer/personal/.rifts/gent/untrack-local-settings bun run accept:affected "$RIFT_LAND_BASE"'
git config rift.generated opencode/mods/orchestrate/agents.json
for role in planner implementor verifier; do
  git config --add rift.generated agents/$role.md
  git config --add rift.generated codex/agents/$role.toml
done
git config rift.regenerate 'bun skills/orchestrate/scripts/agents.ts && cd opencode && bun scripts/agents.ts'
```

A path in these values is written with `$HOME`, never `~`: `sh` leaves a
`~` after `=` in a command's argument as it is, so `env OPENCODE_DEV=~/…`
hands the run a literal `~` directory (the first real land's accept run
failed on it).

The workbox's Bite warm source, `/workspaces/bite` (origin
`biteinc/maitred`, default branch `master` from origin's HEAD), lands
through pull requests. Its batch gate is `bite gate` over the batch's diff
against `origin/master` (`--branch`), with the DB-backed unit suites forced
on the workbox's local Mongo and Redis (`--require-db`, `--with-infra`
starts what is missing); CI on the PR, triggered by a `/pipeline <suites>`
comment on a stack's top PR, stays the thorough gate. `bite gate` lints with
auto-fix, so the gate line fails when the gate rewrote a file: the branch
still holds what CI's lint would reject. Set it once in the warm source:

```sh
git -C /workspaces/bite config rift.push false
git -C /workspaces/bite config rift.pushBranches true
git -C /workspaces/bite config rift.gate 'bun bite gate --branch --with-infra --require-db --failures-only && git diff --exit-code --stat'
```

Bite needs no `rift.generated` or `rift.regenerate` (its one lock file,
`bun.lock`, is settled by installing again) and no `rift.accept`.

The gate and accept logs are `${XDG_CACHE_HOME:-~/.cache}/rift-land/<rift>.<gate|accept>.log`.

There is no `gc` action: `rift gc` empties the trash of every repository at
once, for good, and the workbox's nightly `workrift prune` already runs it.

The model (the domain files at the root of `mods/rift`): `rift.ts` is the
tool's input and the words of each answer, `workspace.ts` what a Rift holds
and the rule for removing one (`removal`), `land.ts` a land's rules and
words, and `model.ts` the handler. The contracts are in `service.ts`:
`Rifts` (`process/`: the `rift`, `workrift` and `git` commands; `memory/`
for tests), `Landing` (`process/`: Git and the repository's checks),
`Workbox` (`process/`: the workbox's scripts), `Notices` and
`SessionDirectories` (`opencode/`), with the Rifts laws in `laws.ts`. The
plugin's one option, `workrift`, defaults to whether `workrift` is on PATH.
`tests/rift.test.ts` proves the flow and a land in real OpenCode on real
Rift; `mods/rift/process/landing.test.ts` runs Landing on real Git
repositories; `mods/rift/process` runs the
laws on `rift` and on the workbox's own `workrift` script (with a no-op
`flock`), in a scratch HOME. Both need macOS.

## Tool names

`cmd/tool-names` is a server plugin that answers a call of a tool that does
not exist when its name is a case or one-edit miss (a letter added, dropped,
changed, or two swapped) of exactly one real tool, or of that tool's alias on
the Claude login (`mcp_T<base64url>`, `mods/anthropic-auth/tool-alias.ts`):
`There is no "shll" tool; did you mean "shell"? Call "shell" with the same
input.` It answers rather than runs the real tool, because other plugins'
`execute.before` hooks (the guard, orchestrate) have read the wrong name by
then, and a renamed call would pass them unseen. Every other unknown name gets
OpenCode's own answer. A kernel cell's `tools.<name>` misses are the kernel's
to answer: they never reach the registry's hooks. The rule is `nearest` in
`mods/tool-names/near-miss.ts`.

## Web

`cmd/web` is a server plugin that makes the built-in `websearch` and
`webfetch` tools work where they failed. It replaces neither tool: it adds a
search provider and wraps webfetch's execute through the tool transform.

**websearch.** The built-in tool asks a consent form when no provider is
chosen. In a subagent nobody answers it, and after a minute the call fails
`Web search cancelled` (measured over 7 days: 7 of 7 calls on the workbox,
7 of 51 on the Mac, all in subagents). The plugin registers a provider, `web`,
that asks the host's providers by id in `order` (a query by id never asks the
form) and answers with the first that has results; a provider that fails or
finds nothing passes to the next. `web` becomes the default unless the config
chose one (`websearch` in `opencode.json`, a provider id or `false`). That
default also outranks a choice saved from an earlier form, so a saved choice
that now fails no longer breaks search. No key is needed: each built-in
provider answers without one (probed on both hosts); with `EXA_API_KEY`,
`TAVILY_API_KEY` and the rest set, the host sends the key. When every provider
fails, the tool's error names each one's failure (`Unable to search the web
for <query>: every web search provider failed: exa: HTTP 429; ...`).

**webfetch.** The built-in runs first, untouched; the plugin acts only on its
failure:

- a PDF (`Unsupported fetched file content type: application/pdf`, or a
  generic binary type from a `.pdf` path) is fetched again, up to `pdfMB`, and
  answered as its text through `pdftotext -layout` (Homebrew's `poppler`,
  `poppler-utils` on Linux), cut to `cutKB` with a note; without pdftotext the
  error says what to install;
- a body over the built-in's 5 MB limit is fetched again, only its first
  `cutKB`, and answered under a first line `[webfetch: the body cut to the
  first 512 KB of 6.2 MB. For the rest, download it (curl ...) and read the
  file in parts.]`; cut HTML is reduced to its text unless the call asked for
  `html`;
- a 404 or 410 fails with what to do instead of guessing again: for a
  `raw.githubusercontent.com` or GitHub blob URL, `okra repo fetch
  <owner/repo>` and read the checkout; elsewhere, websearch for the real page
  or `okra repo fetch`.

Any other failure (a timeout, a 406, a 500) is the built-in's. The refetch
follows redirects without the built-in's per-redirect permission check, which
matters only to a config that denies some webfetch URLs.

Options: `order` (default `exa, parallel, tavily, firecrawl, tinyfish`),
`cutKB` (512), `pdfMB` (50).

The model (the domain files at the root of `mods/web`): `search.ts` holds the
order and the default, `fetch.ts` reads the built-in's failure and writes the
words the agent reads, and `model.ts` handles both over the contracts in
`service.ts`: `Pages` (`http/`), `PdfText` (`process/`) and `SearchProviders`
(`opencode/`), with `memory/` implementations and the laws in `laws.ts`.
`tests/web.test.ts` proves it in real OpenCode: a choice of a failing provider
saved from the form, then a subagent's search that asks no form and answers
from the next provider, and a PDF, a 6 MB body and a 404 from a loopback site.

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
with, resolved as the auth plugin resolves it: the model's `cache.ttl`, else its
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
`reason` records it as manual. Orchestrate's compaction window triggers the
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
reached from a kernel cell as `tools.sessions` and `tools.message`. Its one
option, `listen`, reaches the sessions of a paired host too (Mail between
hosts, below).

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

### Mail between hosts

Two hosts' servers (the Mac and the workbox) pair once and then write to each
other's sessions. Each runs the plugin with `listen: { hostname, port? }`: a
small HTTP listener of the plugin's own on that one address (port 4196 by
default; a wildcard such as `0.0.0.0` is refused and logged, so nothing
listens). `bun run daily` sets it to the host's Tailscale address
(`tailscale ip -4`) on the owner's hosts (`FLEET`), and leaves it off
elsewhere. OpenCode's own server stays on loopback: a peer reaches only the
listener's three routes, never the rest of OpenCode's API.

Pairing, run once by hand (both listeners up):

```
# on the workbox
bun ~/Developer/personal/dotfiles/opencode/cmd/mail/pair.ts invite
# prints, good for ten minutes and once:
#   bun …/cmd/mail/pair.ts join http://100.x.y.z:4196 <code>
# run that on the Mac
```

`invite` keeps only the code's hash; `join` sends the code with this host's
mail name (`--name`, default the host name without `.local`) and listener
address, and the inviter answers with a fresh 32-byte secret, so both hosts
keep each other's name, address and that secret in
`$XDG_STATE_HOME/opencode-mail/pairs.json` (0600). `pair.ts list` shows the
peers (never the secret); `pair.ts forget <name>` drops one (run it on both
hosts to unpair).

Every request between paired hosts is signed with the shared secret
(HMAC-SHA256 over the method, path, time, a random nonce and the body,
`pairing.ts`). The listener refuses with 401, and logs at warning, a request
from an unpaired name, a bad signature, a time more than 60 s off, or a nonce
it saw already; a wrong, used or expired pairing code is refused with 403.
Tailscale (WireGuard) encrypts the traffic.

Once paired, `sessions` also lists each peer's sessions, marked
`· on <host>` (a peer that cannot be reached is named on a last line), and
`message` to an id this server lacks offers it to each peer in turn (titles
name only this server's sessions). The peer composes the letter, naming the
sender `on host <name>` with the id to answer, and delivers it as a local
one, a `✉` notice; an answer at that id comes back the same way. An id no
host has is refused naming the hosts asked and any that could not be.

Why a listener of its own, not OpenCode's server: OpenCode's pairing
(`opencode pair`) issues a session token that is good for its whole API, and
reaching it from the other host means binding the whole server to the tailnet
(`opencode service set hostname`). A mail secret per peer reaches only mail.
The plugin needs no hook in the fork: it runs `Bun.serve` itself. OpenCode
serves the plugin once per directory; one instance binds the port and the
others try again every 30 s.

OpenCode loads a directory's plugins on its first request and unloads them an
hour after its last session event, so a server no client uses would not
listen. The launcher daily writes (`~/.local/bin/opencode`) asks a started or
restarted service for its resident location,
`~/.local/state/opencode-prime/resident`, whose own config keeps it loaded
(`experimental.location_idle_timeout: false`), so the listener runs from the
start for the life of the server. `tests/mail-start.test.ts` starts a service
through that launcher and delivers a signed letter to it with no client.

The model (the domain files at the root of `mods/mail`): `directory.ts`
lists sessions (`select`, `listing`), `address.ts` holds the addressing rules
(`isSessionID`, `byTitle`, `notSelf`) and their refusals, `letter.ts` writes
the header, the transcript line and the receipt, `pairing.ts` the pairing and
request-signing rules, `peer.ts` the listener's routes and bodies, and
`model.ts` is `Mail`, which resolves `to` and `replyTo` and sends, here or to
a peer, and takes a peer's parcel (`receive`). It asks the `Sessions`,
`Peers` and `PairStore` contracts in `service.ts`, implemented in
`opencode/`, `http/` (the peers and the listener), `filestore/` and `node/`
(the crypto), with the laws of `Sessions` in `laws.ts`.
`tests/mail.test.ts` runs two exchanges in real OpenCode: a ping and its
answer between two idle sessions, and a message steered into a running one.
`tests/mail-peer.test.ts` pairs two real OpenCode servers with the real pair
command and sends a message each way. `cmd/mail/pair.test.ts` covers the
pairing and the refusals over real HTTP in one process.

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

## Wakes

`mods/wake` lets a session set itself an alarm or poll a command and be woken
by it, ported from gent's `wake`. Its plugin is `cmd/wake` (`server.ts`;
Prime's dock draws the pending wakes, and its composer panel's Wakes and
Monitors tabs list and cancel them over the `pending` and `cancel` RPCs,
a monitor's row with its newest check's output). The server takes options: `backstop` (`"cron"`, the default, or
`"off"`, which holds the OS jobs in memory, for scenarios and tests), and
`bun` and `opencode`, those programs by path (default the `bun` on PATH, else
`~/.bun/bin/bun`, and `~/.local/bin/opencode`).

The server adds five direct tools (a kernel cell calls them as
`tools.wake(...)` and so on); `job` is in [Jobs](#jobs) below:

- `wake({ afterSeconds | at, everySeconds?, mode?, note, newSession? })` sets
  an alarm on this session, at most a year ahead. `everySeconds` (at least 60)
  repeats it until cancelled. `mode: "notify"` fires without starting a turn:
  the session reads it at its next turn, and the user sees it meanwhile.
  `newSession: { directory?, prompt }` starts a fresh session there at the
  time instead, with `prompt` as its first message.
- `monitor({ command, cwd?, intervalSeconds?, until?, timeoutSeconds?, note, repeat? })`
  runs `command` every `intervalSeconds` (default 30) until its stdout matches
  the regular expression `until` (without it, until it exits 0), or until
  `timeoutSeconds` (default 1800, at most 86400) pass, and then wakes the
  session with the outcome and the last output. With `repeat` it keeps
  checking after a match, until `timeoutSeconds` (default 86400, at most 30
  days) or `wake_cancel`: `repeat: "match"` wakes on each new match (a match
  after a check that did not match), `repeat: "change"` each time a matching
  check's stdout differs from the last matching one's (the first match is the
  baseline; `stepOf` in `wake.ts`). Each such fire is short: `⏰ Monitor <id>
  changed (fire 2): `<command, cut to 80>`.`, how it goes on, the note and the
  output's tail; the deadline ends it with `⏰ Monitor <id> ended: …`. What a
  repeat keeps between checks (`matching`, the stdout's fingerprint `seen`,
  its `fired` count) is stored on the entry, so a restart neither fires an
  old match again nor loses the baseline.
- `wake_cancel({ id })` cancels one; `wake_list({})` lists the pending ones
  and the notices not yet read.

The receipt names the id and the time:

```
Alarm w5tap1r set: it wakes this session at 2026-11-05T15:11:40.891Z (in 3s).
End your turn now unless there is other work: the alarm starts a new turn with your note.
```

A fire goes to the session as a synthetic user message, steered, so a running
session reads it at its next step and an idle one wakes (a notice does not
wake it):

```
⏰ Wake w5tap1r fired: the alarm you set at 2026-11-05T15:11:37.891Z, due 2026-11-05T15:11:40.891Z.
Note: ALPHA: check that the build finished
```

A monitor's says `⏰ Monitor <id> matched: `<command>` printed a match for /…/ after N checks.`
(or `timed out`), where and how often it checked, the note, and the last 2000
characters of its output. A fire that went a minute or more after its time
says so: `It fired 2m late: no OpenCode server was running at <time>, so it
went when one started.` The transcript draws a fire as one notice,
`◈ wake <id> · <note>` (`notice`, `monitor <id> matched`, `· 2m late ·`); its
metadata is `{ source: "wake", id, kind, mode, setAt, tick, firedAt, lateMs }`.

### Latches

A latch is a third kind of entry: a subagent start that orchestrate's pace
or the Sabbath holds (see [Pace and effort](#pace-and-effort)). Orchestrate
asks the server's `latch` RPC with the routed call (agent, description,
prompt, model), what holds it, its reason, `opensAt` and `recheckAt`. The
server keeps the entry under the parent, then makes the child session
(`parentID` the parent, the agent, the description as its title) without
prompting it, and marks the child's `latch` metadata, which the subagent
rows read. At `recheckAt` (never sooner than a second from now, never later
than `opensAt`) it asks orchestrate's opener (`dotfiles-opencode.wake.opener`,
`open`) to decide it again:

- `held`: it waits again, with the answer's reason and times, and its mark
  says so.
- `opened`: the entry goes; orchestrate has started the subagent in the
  background on the child, and its result wakes the parent as any
  background subagent's does.
- `failed`: the entry goes, the mark reads failed, and the parent gets a
  letter saying why.

An opener that cannot be asked (orchestrate not loaded yet) is asked again 5
seconds later. A latch survives a restart or downtime as an alarm does: it
is kept in storage, armed on start, fired at once when overdue, and has an
OS job at `opensAt`. Latches do not count toward the 20 pending entries.
`wake_list` lists one as
`<id>: latch · the worker subagent "<description>" (sessionID: <child>) · held by the pace: <reason> · opens <time> (in 6s)`;
`wake_cancel` drops it, and its child's mark reads cancelled. A deleted
parent or child takes it.

Prime's dock (see Prime) shows, after the shells, one item while the session
on screen has alarms or monitors pending or notices unread. A latch is not
counted there: it shows as its subagent's row instead.

```
2 wakes · 1 monitor · 1 notice
```

`next` is the soonest alarm in local time (a weekday or a date when not
today); with only monitors it reads `until <deadline>`. Parts drop from the
right as the width shrinks. It reads the wakes RPC (`dotfiles-opencode.wake`,
`pending`) on its `changed` event and every 2 seconds.

Entries are kept in the plugin's storage (OpenCode's database). On start, and
after a reload, the plugin arms its directory's entries and fires at once the
ones that came due meanwhile. A fire is recorded under its message id before
it is sent and settled after, so a reload or a resend delivers it once; a
fire that failed goes again 30 seconds later, and one whose session went is
dropped. A deleted session's entries go, with their checks and OS jobs. At
most 20 entries wait per session.

A monitor's check runs as its own process: `/bin/sh -c <command>` in a new
process group, without `BASH_ENV` or `ENV` (so no shell startup file runs),
at most 60 seconds per check, keeping the last 64 KB of its output. Cancel,
the deadline and a deleted session kill its group.

### The OS backstop

A timer fires only while a server runs, so each entry also registers an OS
job through `Bun.cron`, titled `opencode-wake-<id>`: a launchd agent on macOS
(`~/Library/LaunchAgents/bun.cron.opencode-wake-<id>.plist`) or a crontab
line marked `# bun-cron: opencode-wake-<id>` on Linux; no other crontab line
is touched. A job runs at the first whole minute at or after the entry's time
(an alarm's, or a monitor's deadline). A repeat whose period cron can say
exactly (minutes dividing an hour, hours dividing a day, a day, a week) gets
a recurring job; any other entry gets a one-shot for its minute, set again
after each fire.

The job runs `cmd/wake/backstop.ts` with a bare environment, carrying only
`HOME`, the `XDG_*_HOME` variables, `OPENCODE_CONFIG_DIR` and `OPENCODE_DB`.
It reads `$XDG_STATE_HOME/opencode/service.json` and probes the service; when
nothing answers it runs `~/.local/bin/opencode service start` and waits for
it. Then it calls the wakes RPC's `due({ id })` in the entry's directory, and
the server fires the entry, as its own timer would have, under the same
recorded message id: a job that runs after the timer fired delivers nothing.
The server removes the job once the entry fired or went; a job whose entry
is already gone has nothing to fire. A fire at or past the job's minute
(often the start the job itself brought up, which fires the late entry
before the job's call lands) removes the job a few seconds later, since
removing a running launchd job kills it mid-call. Each run appends a line to
`$XDG_STATE_HOME/opencode-wake/backstop.log`. On start the plugin removes the
`opencode-wake-*` jobs that no entry names.

The job calls the server rather than `opencode run --session`: `run` would
add a prompt of its own, under an id the entry never recorded, so a fire the
timer also sent would arrive twice. When a job cannot be registered the tool
still sets the entry and says so (`No OS backstop was set (…): it fires only
while an OpenCode server runs.`).

The model (the domain files at the root of `mods/wake`): `wake.ts` is the
entries and the RPC, `message.ts` the letters and receipts, `tools.ts` the
tools' inputs and descriptions, `backstop.ts` the jobs'
names and schedules, `latch.ts` the latches, their RPC and the child's mark,
`model.ts` the `WakesModel` that keeps, arms, fires, opens and settles. It asks the `WakeStore`, `Courier`, `Checks`, `Backstop`,
`Opener` and `Changes` contracts in `service.ts`, with the laws in `laws.ts`, implemented
in `opencode/` (the plugin's storage, the session inbox), `process/` (the
checks), `cron/` (Bun.cron and the job's side) and `memory/`.
`tests/wake.test.ts` runs `scenarios/wake.ts` (an alarm, a notice, a monitor,
a cancel and a plugin reload) and `scenarios/wake-downtime.ts` (an alarm due
while the server was stopped) in real OpenCode; `tests/prime-latch.test.ts`
runs `scenarios/prime-latch.ts` (a latch held, held again, opened, and its
result waking the parent); `tests/prime-fallback.test.ts` runs
`scenarios/prime-fallback.ts` (a worker the pace holds starts at once on the
Codex fallback, and the call log says why).

Where it departs from gent: a fire that went late still starts a turn and
says how late (gent turns an alarm more than 10 minutes late into a notice);
there is no automatic resume of the turn the alarm interrupted; the monitor's
period is `intervalSeconds` (gent's `everySeconds`); tool names take `_`
where gent's take `.`, which Anthropic refuses; the OS backstop and
`newSession` are new.

A subagent, and so each of orchestrate's roles, is refused: a role answers to
the session that started it and ends with it, so it waits on CI with a
background shell, and its parent (or the root) sets the wake. The root
sessions, the orchestrator included, use them for every wake-up; `okra
schedule` is no longer needed for that.

### OpenCode's schedules are off

OpenCode's own schedule tools (`schedule_create`, `_list`, `_pause`,
`_resume`, `_delete`, offered under `experimental.schedules`) fire a schedule
by prompting its session with its whole action: a real user message each
time, kilobytes for a watch that fires on every change. The wake plugin takes
them out of the registry for every agent (`SCHEDULE_TOOLS` in
`cmd/wake/server.ts`, as the rift plugin takes the worktree tools), so a wake
(`at`, `everySeconds`), a monitor (`until`, `repeat`) or the `pr` tool's watch
does that work as a short synthetic notice. Cron and time zones are not
carried over: no active schedule used them (both machines, 2026-11-06). The
host's `/schedule` command, which tells the model to call those tools, comes
from the same built-in plugin (`opencode.tool.schedule`); a plugin cannot
remove a command, so `bun run daily` turns that plugin off in the server
config (`-opencode.tool.schedule`, `BUILTIN_SCHEDULE_OFF` in
`scripts/daily.ts`), and neither the tools nor `/schedule` are offered.
Stored schedules and their API stay the host's.

`bun scripts/migrate-schedules.ts` moves the active schedules over once: for
each it plans the equivalent wake or monitor for its session (the mapping is
in the script's header), writes a prompt over 200 characters to
`$XDG_STATE_HOME/opencode-wake/schedules/<id>.md` and points the note at it,
and prints the plan. `--apply` sets each entry over the wakes' `set` RPC
(`{ sessionID, wake } | { sessionID, monitor }`, the tools' rules) and pauses
the schedule; what has no equivalent (cron, a Code Mode check, remaining
runs) is skipped and named. `--rows <file>` reads another machine's rows
(the script's `QUERY` through `sqlite3 -readonly -json`).
`tests/wake-repeat.test.ts` runs `scenarios/wake-repeat.ts` in real OpenCode
with `experimental.schedules` on and the built-in schedule plugin off: no
request offers a schedule tool, the server lists no `/schedule`, and a
`repeat: "change"` monitor wakes the session once per change of a file.

### Jobs

`job({ command, cwd?, note, heavy?, timeoutSeconds? })` runs a long command
outside the OpenCode server, so a server restart leaves it running, and wakes
the session when it ends. Use it instead of `nohup`, `setsid`, `systemd-run`
or a background shell for anything past a few minutes, and instead of
polling with `ps`; then end the turn. A subagent may run one too, and waits
for it with `action: "wait"`, since its turn's end hands back to its parent.

- It runs as `/bin/sh -c <command>` in its own process group, its stdout and
  stderr to `$XDG_STATE_HOME/opencode-job/<id>/log`, under a runner
  (`cmd/wake/job.ts`): a `systemd-run --user --unit opencode-job-<id>` unit on
  Linux (a detached process when the user manager refuses, with a warning in
  the receipt), a detached session and process group on the Mac. `heavy` runs
  it through the guard's launcher (`mods/guard/launcher.ts`): `nice -n 10`,
  and where `systemd-run --user --scope` works, a scope with `MemoryMax=12G`
  and `CPUWeight=20`; past `timeoutSeconds` (default a day, at most 7) it is
  stopped with SIGTERM, then SIGKILL 10 s later.
- Lines the command appends to the file `$JOB_DRIP` names reach the session at
  most once a minute, without starting a turn; the rest ride on the end
  letter. `$JOB_ID` is the job's id.
- Its end steers a letter with the exit code (or the timeout, kill or signal),
  the duration, the progress, the log tail and the note. The runner asks the
  service at once (starting it when none runs, unless `backstop: "off"`); the
  server also looks every 10 s, and a start finds one that ended while none
  ran, saying how late. A runner gone without an exit (a reboot) reads lost.
- `job({ action: "check" | "wait" | "kill", id })` reads it, waits up to `ms`
  (default 10 min, at most 60), or stops it; a `wait` or `kill` that sees the
  end takes the letter's place. `job({ action: "list" })` lists the session's
  jobs. `wake_cancel` refuses a job id and names the kill; a deleted session's
  jobs are killed. At most 20 jobs per session.

```
⏰ Job j3k9x0a exited 4 after 4s: `bun run gate`.
It ran in /work/app from 2026-11-06T15:11:37.891Z to 2026-11-06T15:11:41.902Z. Log: ~/.local/state/opencode-job/j3k9x0a/log.
Note: KAPPA: read the result
Log tail:
...
```

`tests/job.test.ts` runs `scenarios/job.ts`: a job whose end wakes the idle
session, and a killed one that wakes nobody.

## Memory

`mods/memory` gives the agent a long-term memory of short notes, kept in one
SQLite file per host (`$XDG_STATE_HOME/opencode-memory/memory.db`, else
`~/.local/state/…`; the Mac and the workbox each have their own, no sync). Its
plugin is `cmd/memory` (`server.ts`); the design and what it took from
Anthropic's "components of agent memory" and OptMem is in
[`notes/memory.md`](notes/memory.md).

A note is one line of at most 400 characters with up to 8 tags, kept
`global` (about the user, true in every project) or `project` (OpenCode's
project id, which every clone, worktree and Rift of a repository shares). The
server adds three direct tools (a kernel cell calls them as `tools.memory_save(...)`):

- `memory_save({ text, scope?, tags?, id? })`: `scope` defaults to
  `project`. A note whose words are at least 60% the same (Jaccard) as a note
  of its bucket updates that note instead of adding one (`Updated #1 (global),
  which said nearly the same: "…"`); with `id`, it corrects that note. Its
  description says what is worth saving (the user's facts, preferences and
  corrections, the project's conventions, hard-won fixes) and what is not
  (task state, plans, what the repository already says, secrets).
- `memory_search({ query, limit? })`: the project's notes and the global
  ones, by FTS5 rank (porter stemming), at most 25.
- `memory_forget({ id })`.

A subagent searches but does not save or forget (OptMem's rule: it cannot judge
what is already known); its refusal tells it to put the fact in its answer.

**The digest.** At a session's first request the plugin picks the notes it
starts with: the highest by `(1 + log2(1 + uses)) · ½^(days since updated / 60)`,
at most `digestNotes` (30) whose lines fit `digestChars` (4,000 characters,
about 1k tokens), laid out global first, then the project's, by id, under a
`# Memory` heading. It goes last in the system prompt through the `context`
hook, and is kept in the file per session, so every request of the session
(and of a server restart) carries the same block and the cached prefix holds;
a note saved mid-session shows from the next session on. A session with no
notes keeps an empty one. `uses` counts searches and repeated saves; `shown`
counts digests and never ranks, so the injected notes cannot keep themselves
in place. `used` is the last time either happened.

Options: `path` (the file), `digestNotes`, `digestChars`.

**The CLI** reads and edits the same file, for the weekly dream or the owner;
reading there counts no use:

```
bun opencode/cmd/memory/cli.ts list|search|show|add|edit|merge|forget|projects|stats [--db <file>] [--json]
```

`stats` gives each note's uses, showings, dates and idle days, the notes idle
30 days or more (`--stale-days`), pairs of one bucket at least 40% alike, and
each project's digest fill (what it holds of what its sessions see, and its
size). `projects` maps project ids to the directories their notes were saved
in, for `add --scope project --project <id>`.

Transcripts are not copied: they stay searchable in OpenCode's own database.
`tests/memory.test.ts` proves it in real OpenCode on the scripted model.

## The code kernel

`mods/kernel` gives the model a `kernel` tool, `{ code, description?, reset? }`, ported
from gent's `cell`. `description` is a few words in the present tense saying
what the cell does (`Merge the skill-dollar worker`), for the transcript;
the tool's input schema and its text ask for one whenever a cell calls tools
or changes anything. It is optional, so calls made before it still decode. It runs TypeScript in one Bun process per session, so
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
characters, a subagent's `sessionID`, a background shell's `shellID` and
whether the host moved it there, `backgrounded`, and a shell handle's `id`,
which tells Prime to drop the handle's header line from the row). At most 100 are kept and the rest
counted in `dropped`. The record is published through the call's progress
while it runs and kept in its result, also when the cell fails; it stops
changing once the call ends. Prime draws a kernel call as these calls, with
fx's header and rows (`Read 2 files · ran 2 commands`, `├ Read a.ts, b.ts`),
never as its code; a call with no record names the tools its code calls
(`Ran a cell calling read, shell`; record-less cells side by side fold into `Ran 3 cells calling shell, write`).
A cell that gave a `description` has it as its group's header instead of the
counts, in the normal text colour and cut to the width (the failures and
cancels after it), over the same rows, even when it made one call; a cell
without one draws as above. `tests/prime-kernel.test.ts` runs
`scenarios/prime-kernel.ts` for both.

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

## Opus first, Codex second

Every role is an OpenCode subagent; its model is the config's.
`bun run daily` binds every role (planner, implementor, verifier, worker)
to the newest Claude Opus. Codex is the fallback, on the ChatGPT
subscription OpenCode signs in to itself (`opencode auth login openai`),
used only when the pace holds a new Opus start.

| Opus | Codex | The start |
| --- | --- | --- |
| admitted | (not asked) | starts on Opus |
| held | admitted | starts at once on Codex; the answer and the call log say why |
| held | held | latches, and opens on whichever opens first (Opus on a tie) |
| Sabbath | (not asked) | latches until work resumes |

The fallback is Codex's newest sol, at `high` (the verifier at `medium`), or
the newest luna at `max` when the description ends in `(light)`, `(direct)`
or `(mechanical)` (`codexFallback` in `role.ts`; `Models.newest` picks the
latest release of the family). A call that names a `model` runs on it as is,
with no fallback. A follow-up never falls back: a role already on Codex stays
there, and the next new start tries Opus first again. The parent's answer
starts with `orchestrate: this agent runs on <model>, the Codex fallback
(<why>).`, and the call log's `call` line carries the same `fallback`.
No Codex bridge, MCP server or thread tools are involved.

## Pace and effort

A new subagent passes `dotfiles-opencode.pool`'s `pace` RPC in the
`tool.execute.before` hook. Follow-ups keep running. Models outside the
pool and unavailable pace RPCs fail open, as the Claude hook does for an
unreachable host.

To see what admitted a start, read its line in `~/.cache/orchestrate/opencode-agents.jsonl`. A new subagent's `call` or `latched` line carries the pool's answer as `pace: { ok, measured, reason }`, or the cause as `pace: { failOpen: "no pool: …" | "timeout: …" | "error: …" | "undecodable: …" }`. When the Codex admission is asked, its answer goes in `codex` the same way, and a fallback's answers go in `fallbackPace` and `fallbackCodex`. A follow-up asks no pace and records none.

The shared Claude `budget.ts` scans `~/.claude/projects` transcripts, so it
cannot measure OpenCode's load or estimate its agent costs. Instead, this
pool reads provider quotas, including spend by other harnesses on the same
accounts. It holds new starts when pooled weekly use exceeds a 99% even
weekly allowance plus five percentage points of leeway, or all available
accounts have no short/weekly-window room.

A held start falls back to Codex first (see
[Opus first, Codex second](#opus-first-codex-second)); one both hold latches,
it is not refused. The wakes keep the latch (a
`latch` entry, see [Wakes](#wakes)) and make its child session at once,
with the agent and the description as its title, but send it nothing. The
call answers at once, foreground or background, and a kernel cell's
`tools.subagent` gets the same answer as a value: the subagent is latched,
why, when it opens (UTC and local time), its session and latch ids, and
that its result will wake the parent. At its time the wakes ask
`openLatch`, which decides it again on the same rules: Opus first, then the
fallback. Still held, it
latches again with the hold's new reason and time. Admitted, it starts in
the background on the child, with the original agent, description, prompt
and model, and its result wakes the parent as a background subagent's
does. A pace hold is decided again at the time it opens or within
`PACE_POLL_MS` (120 seconds), whichever is sooner; the Sabbath's at the
time work resumes. A follow-up to a latched child is refused
(`StillLatched`) until it opens. `wake_list` shows a latch, and
`wake_cancel` cancels it. With no wakes plugin to keep a latch, the call is
refused with the hold's reason and the time it opens (`PaceHeld`).

With the `now` option the rules run on that fixed clock, the pace's times
included, while the wakes keep the system's. A latch's times are moved onto
the system's clock by how far the fixed clock is behind it when they are
handed over.

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
That script reads only this host's `~/.codex` transcripts. A hold latches
the call the same way. The orchestrate mod's `codex` option
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
bun run gate              # lint, agents --check, typecheck and unit tests at once
bun run accept:affected   # the real-OpenCode tests that reach what changed
bun run accept            # all of them, in parallel
```

`bun run gate` (`scripts/gate.ts`) links the fork, then runs four legs at
once: oxlint, `bun run agents -- --check`, `bun check` over the root and
every `mods/*` and `cmd/*` project, and the unit tests (every `*.test.ts`
outside `tests/`) with `bun test --parallel`. A unit test file that passed is
skipped while the key over what it reaches is unchanged: its package, the
packages its `package.json` depends on, and the shared inputs (the root
manifest, lock file, bunfig, tsconfig, the gate's scripts, Bun's version and
the fork's commit, diff and lock file). `scripts/reach.ts` derives that
reach; `bun scripts/gate.ts --all` ignores the cache.

The acceptance tests in `tests/` run real OpenCode, so they are not in the
gate. `bun run accept` runs them all in parallel; `bun run accept:affected
[base]` runs those that reach a file changed since `base` (default: the merge
base with origin/main), following the scenarios, run scripts and plugin
paths they name, and all of them when a shared input changed. A fork change
is outside this repository: run `bun run accept` after one. `bun run test`
still runs every file one after another.

A test starts what it runs (opencode-drive, an OpenCode server, a
`run --standalone`) through `tests/owned.ts`, which stops everything that
child started when it exits, or when the test process does after a failure or
a timeout. opencode-drive puts its server and TUIs in process groups of their
own and leaves them running when it is stopped, so `owned` follows the
child's descendants, not only its group. The accept run is a process group of
its own, followed the same way (`scripts/leaks.ts`): an OpenCode server or
drive run still alive 5 s after the run ends is a leak, which it names, stops
and fails the run on. It only ever names the run's own descendants, never the
owner's servers or TUIs.

`bun run lint` is oxlint: its errors are the layout fence (`.oxlintrc.json`,
one import override per context; see `ARCHITECTURE.md`), and its warnings are
advice. `git diff --check` checks patch whitespace. The typecheck links every
workspace package (`mods/*`, `cmd/*`, `decider`) to the fork's installed host
packages; run `bun run link-fork` before and after `bun install` (an install
drops the links), and install only when changing the lock file. If working in a Rift, set `GENT_SOURCE` to
its source checkout so the gent pool integration tests run instead of
skipping.

The deterministic acceptance seams are the session API (the guard, compaction
at the agents' window, the Sabbath, held starts and subagent pace), the pool RPC and quota
calculation, the generated agent config, `bun run daily`'s config merge, and
opencode-drive frames (`scenarios/pool.ts`). The pane scenario covers
populated, loading, empty and failed-refresh states, and closing it.

## Remaining Claude mod features

The status mod's burn forecast, approaching-limit warning, login toasts,
project labels, account rotation and adaptive compaction tuning are not
ported: OpenCode compacts every role and primary agent at one fixed 400k
window, read from no tuner. The Sabbath guard remains.
