# Memory eval: our memory tools against Anthropic's native memory tool

The owner asked for a measured comparison before redesigning memory. In 105
Mac sessions since memory went live, 4 called `memory_save` and 2
`memory_search`. Three hypotheses: (1) nothing prompts the agent to use it
(discovery, triggers), (2) the weights expect Anthropic's native file memory
tool, (3) the use cases are weak. This note gives the eval, its results and a
recommendation. The script is `scripts/memory-eval/`; the design of memory
itself is `notes/memory.md`.

Three rounds ran. Round 1 compared our tools, a pointer line, the native tool
and no memory. Round 2 took up round 1's three follow-ups: string tags, a
`kernel` arm for the production surface, and a trigger for gotchas. Round 3
measured the fix round 2 proposed and production shipped in 9535f78: the
memory tools offered directly beside the kernel (`kernel+direct`). The newest
round comes first below.

## Round 3: the memory tools beside the kernel

### Recommendation (round 3)

1. **Keep `direct` as cmd/kernel's default; it works.** Over 24 episodes per
   arm on Haiku 5.5, offering `memory_save`, `memory_search` and
   `memory_forget` beside the kernel nearly tripled the facts saved in
   session 1, from 19% (14 of 72) to 54% (39 of 72). Session 2 then had a
   digest in 79% of episodes instead of 29%, and honoured 46% of the facts
   instead of 35% (measured). Every one of the 20 `kernel+direct` saves was a
   direct call. No cell of that arm named `tools.memory_*`, so the model uses
   the definition when it has one. The `kernel` arm's 7 saves all came from
   cells. The cost: 12% more per episode ($0.0162 against $0.0144 at API
   prices) and about 2 more requests per session (measured).
2. **Gotchas are now the gap, and a better tool surface does not close
   it.** Both arms saved almost no gotcha from tool output: 0 of 24 with
   `kernel`, 1 of 24 with `kernel+direct`. Corrections went from 7 to 19 of
   24 saved and preferences from 7 to 19 of 24. Rounds 1 and 2 found the
   same with direct tools (`ours`) on Haiku 4.5. The next round should test
   the candidates round 2 named: an imperative line that names the fix, or a
   sentence in `memory_save`'s description about a command that only worked
   once it was run another way.
3. **Session 2 recalls through the digest, not through search.** In neither
   arm did a session-2 agent read memory before acting (0 of 24 each). Six
   `kernel+direct` and three `kernel` session-2 episodes searched later on.
   The digest carries recall, so what gets saved in session 1 is what counts.
   When a fact was saved, it was honoured 77% of the time with
   `kernel+direct` (30 of 39) and 71% with `kernel` (10 of 14).

### How round 3 ran (measured)

- **Model `claude-haiku-5-5`**, through the pool. A one-episode probe
  answered at once. With the API key it had only ever answered 429 (rounds 1
  and 2). Rounds 1 and 2 ran on Haiku 4.5, so compare this round's two arms
  with each other, not with those rounds. One cross-model point anyway: the
  `kernel` arm saved 0 of 21 facts on Haiku 4.5 and 14 of 72 on Haiku 5.5.
- **Through the pool, not the API key**, which had no credit left. The
  transport is `scripts/memory-eval/pool.ts`: the 7 gent accounts, each
  request shaped as the Anthropic auth plugin shapes it, and a local
  `AccountPool` seeded from the live pool's `status`. Before every episode
  the run asked the live pool's `pace` and its own accounts' pace. Both said
  "within its weekly pace" all the way through. No request was refused (no
  401 or 429) and no episode failed: 48 of 48 graded.
- **Size: 1,794 requests and 20.4M cache-read tokens** (93–94% of input
  read from the cache), 1.45M cache writes and 699k output tokens. At API
  prices that is $0.73, plus $0.01 for the probe. Over the 20-minute run
  the accounts' 5-hour readings rose by 0 to 4 points and the weekly ones
  moved by at most 1. Those readings were taken by the pool before and after,
  and they include the owner's live sessions in the same window.
- 6 repeats × 4 scenarios × 2 arms, concurrency 4. Raw data:
  `~/.cache/memory-eval/2026-11-09-run3/` (log
  `~/.cache/memory-eval/run3.log`), probe `…-run3-probe55/`.

### Round 3 results (24 episodes per arm, Haiku 5.5)

| arm | n | facts saved (s1) | s2 digest | s2 facts honoured | s2 all honoured | honoured when saved | off-list notes s1/s2 | requests s1/s2 | $/episode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| kernel | 24 | 19% (14/72) | 29% (7/24) | 35% (25/72) | 4% (1/24) | 71% (10/14) | 0.0 / 0.0 | 19.9 / 15.7 | $0.0144 |
| kernel+direct | 24 | 54% (39/72) | 79% (19/24) | 46% (33/72) | 4% (1/24) | 77% (30/39) | 0.0 / 0.0 | 21.8 / 17.4 | $0.0162 |

| arm | correction saved → honoured | gotcha saved → honoured | preference saved → honoured |
| --- | --- | --- | --- |
| kernel | 7/24 → 12/24 | 0/24 → 3/24 | 7/24 → 10/24 |
| kernel+direct | 19/24 → 14/24 | 1/24 → 4/24 | 19/24 → 15/24 |

Per fact, saved in session 1 → honoured in session 2 (of 6 each):

| fact | kernel | kernel+direct |
| --- | --- | --- |
| webapp/branch-prefix (preference) | 3 → 3 | 6 → 6 |
| webapp/unit-env (gotcha) | 0 → 0 | 0 → 0 |
| webapp/stage-by-path (correction) | 3 → 5 | 6 → 6 |
| dotfiles/gate-home (gotcha) | 0 → 1 | 0 → 1 |
| dotfiles/no-config (correction) | 1 → 4 | 6 → 3 |
| dotfiles/no-push (preference) | 1 → 6 | 6 → 6 |
| billing/uv-run (gotcha) | 0 → 2 | 1 → 3 |
| billing/autogenerate (correction) | 0 → 0 | 1 → 0 |
| billing/ticket-prefix (preference) | 0 → 0 | 1 → 1 |
| orders/go-short (gotcha) | 0 → 0 | 0 → 0 |
| orders/staging-first (correction) | 3 → 3 | 6 → 5 |
| orders/reviewer (preference) | 3 → 1 | 6 → 2 |

What the cells show:

- In webapp, dotfiles and orders, `kernel+direct` saved the correction and the
  preference in all 6 episodes. `kernel` saved them in 1 to 3.
- **Billing is a harness limit, not a memory result.** Both arms saved almost
  nothing there (`kernel+direct`: 1 save in 6 episodes). In the transcripts,
  Haiku 5.5 doubts the fake shell: "The tool results don't match what the
  commands should do, so I've stopped". It gives up before the owner's
  correction can be acted on. The fake git in that scenario needs work before
  its numbers mean anything on Haiku 5.5.
- Saving a fact is not the same as honouring it. dotfiles/no-config was saved
  6 times and honoured 3 times. orders/reviewer was saved 6 times and
  honoured 2 times. The `kernel` arm honoured dotfiles/no-push 6 times with
  1 save, so session 2 can get that fact right without memory. With 6
  episodes per cell, a difference of one or two is noise.

## Round 2: the kernel arm, the gotcha trigger, string tags

### Recommendation (round 2)

1. **The kernel hides memory completely. Fix that before anything else.** In
   7 kernel episodes no agent saved a note (0 of 21 facts) and none touched
   memory at all: no `tools.memory_*` call, no `tools.docs` of it. In the same
   run, `ours` saved 9 of 15 facts (round 1: 49 of 66). After the owner's
   correction a kernel agent answered "Got it! I'll remember: 1. Never stage
   `codex/config.toml` …" and saved nothing. Session 2 then had no digest and
   honoured 2 of 15 facts (`none` in round 1: 9%). This is the likeliest
   cause of the 4 saves in 105 production sessions (measured here on Haiku
   4.5; production runs other models, so the size of the effect there is
   inferred). The simplest fix to try next:
   offer `memory_save`, `memory_search` and `memory_forget` as direct tools
   beside the kernel even in `codeOnly`. Round 1 measured that shape as
   `ours`. That puts three small definitions in the cached prefix. Measure it
   as a `kernel+direct` arm before it ships; the API credit ran out before
   this round could.
2. **Do not build the gotcha trigger as tested.** The line was appended to
   the result of a shell retry that fixed a failure. It fired at the gotcha
   in 4 of 5 session-1 episodes, and the agent saved the gotcha in none of
   them (0 of 4 pure gotchas; billing's `uv run` is confounded, see round 1).
   Each time it read the line and went on to commit. Junk stayed at zero (no
   off-list notes) and the other facts did not suffer (corrections 5 of 5,
   preferences 5 of 5 saved), so the line is harmless, but it does not help.
   The detector (`scripts/memory-eval/retry.ts`, unit-tested) stays in the
   eval and is not in the plugin. One more point against building it at
   the shell seam: kernel agents reached for `child_process`, `fs` and `Bun`
   far more than for `tools.shell` and `tools.read`. In the kernel
   transcripts, 151 lines name `execSync`, `readFileSync` or `Bun.` and 21
   name `tools.shell` or `tools.read`. In production those calls bypass the
   shell tool, so a `tool.execute.after` hook on `shell` would miss most
   retries (inferred from the eval; the real kernel really runs them). Candidates for a later
   round: an imperative line that names the fix ("Save this with
   memory_save: <the changed command>"), or a sentence in the save
   description about "a command that failed until you changed how you ran
   it".
3. **String tags: done.** `memory_save` accepts `tags` as a comma-separated
   string. It splits on commas, trims each tag and drops empty ones
   (`mods/memory/notebook.ts`, `Tags`; tests in `notebook.test.ts`). The
   JSON Schema offers `string[] | string`. In this round's run Haiku sent
   tags as a string in 8 of its 11 saves, and none was refused. Round 1 had
   14 refusals for this.

### How round 2 ran (measured)

- **Model `claude-haiku-4-5-20251001`.** One probe of `claude-haiku-5-5`
  got 429s for 5 s and no answer, as in round 1.
- **Spend: $1.17 of the $3 cap**: two dry runs ($0.08, $0.23) and the run
  ($0.86). Then the run stopped: from its 16th episode on, every request
  answered `400 invalid_request_error: Your credit balance is too low`.
  So the run graded 15 of 48 planned episodes, 5 per arm, about one per
  scenario, and 33 failed to start. Treat the per-fact cells as anecdotes.
  Only the kernel result (0 notes in 7 episodes against 9 of 15 facts
  saved) and the trigger's 0 of 4 are clear.
- Raw data: `~/.cache/memory-eval/2026-11-08-run2/` (the run, its log at
  `~/.cache/memory-eval/run2.log`), `…-run2-dry/` and `…-run2-dry2/`. The
  first dry run's kernel episode used a harness that still answered direct
  tool calls in the kernel arm, so it is left out. The second dry run's
  `kernel` and `kernel+nudge` episodes ran on the final harness, except for
  `stdio: "inherit"` and `process.exit`. Both saved nothing and are counted
  in the "7 kernel episodes" above, with the run's 5.

### The new arms

- **`kernel`**: the agent's only tool is `kernel`, with the real description
  (`mods/kernel/description.ts` in runtime mode) over the real 50-tool
  catalog of 2026-11-08. Each line's name and summary come from
  `mods/kernel/catalog.fixture.ts` through `firstSentence`, and the shell's
  line from `IN_A_CELL`. Each input is as a frozen production description
  printed it (`scripts/memory-eval/kernel-inputs.ts`, taken from a
  read-only copy of the Mac's `opencode.db`, `kernel-catalog:` entry).
  Memory's three lines are rendered by the real `catalog()` from the real
  schemas. A cell is compiled as the worker compiles it (`Bun.Transpiler`,
  `replMode`) and runs in a `vm` context that persists for the session.
  `tools.<name>(input)` reaches the eval's fake world and our memory store,
  and `tools.shell` resolves to a real handle (`worker/shell-handle.ts`).
  `tools.list`, `tools.docs` and `tools.docs.search` work as in the worker.
  Production cells also reach `child_process`, `fs` and `Bun`, and the
  agents used them first, so small stand-ins route those to the fake world
  as `shell`, `read` and `write` calls, which the graders see. A direct
  call of any other tool name is refused with OpenCode's words ("Tool is
  not available for this request: read"). Haiku tried that 20 times in 5
  episodes. Session 2 gets the same digest as `ours`.
- **`ours+nudge`**: `ours`, plus one line appended to a successful shell
  result when it is a changed retry of a failure among the last 3 commands
  (most of the shorter command's words in the other, not the same command):
  "A retry fixed a failure: if the fix is a durable fact about this repo or
  machine, memory_save it." It goes in the tool result, never the system
  prompt.
- `kernel+nudge` exists, with the line on the cell's answer. It ran once,
  in a dry run.

### Round 2 results (15 episodes, Haiku 4.5)

| arm | n | facts saved (s1) | s2 digest | s2 facts honoured | honoured when saved | off-list notes s1/s2 | requests s1/s2 | $/episode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ours | 5 | 60% (9/15) | 80% (4/5) | 47% (7/15) | 78% (7/9) | 0.0 / 0.0 | 16.8 / 14.0 | $0.047 |
| kernel | 5 | 0% (0/15) | 0% (0/5) | 13% (2/15) | – | 0.0 / 0.0 | 15.8 / 15.8 | $0.054 |
| ours+nudge | 5 | 73% (11/15) | 100% (5/5) | 67% (10/15) | 91% (10/11) | 0.0 / 0.0 | 16.8 / 14.0 | $0.046 |

| arm | correction saved → honoured | gotcha saved → honoured | preference saved → honoured |
| --- | --- | --- | --- |
| ours | 4/5 → 3/5 | 1/5 → 1/5 (billing, confounded) | 4/5 → 3/5 |
| kernel | 0/5 → 2/5 | 0/5 → 0/5 | 0/5 → 0/5 |
| ours+nudge | 5/5 → 5/5 | 1/5 → 1/5 (billing, confounded) | 5/5 → 4/5 |

The gotcha trigger in `ours+nudge`: 4 tool results carried the line in
session 1 (4 of 5 episodes, each time at the scenario's gotcha: `TEST_ENV=unit
npm test`, `OPENCODE_DEV=$HOME/… bun run gate`, `go test -short …`) and 2 in
session 2. The 6 memory writes in session 1 all came after the owner's
correction; none followed the line.

One `ours` episode (webapp #0) saved nothing at all, which round 1 never
saw (22 of 22 saved). With 5 episodes that is one sample. It is not a
change from round 1.

## Round 1: recommendation

The sections from here to "Running it" are round 1's.

1. **Keep our shape: three tools and the start-of-session digest.** It beat
   the native tool on every kind of fact the owner states: corrections were
   saved in 43 of 43 episodes and honoured in 41 of 43 (native: 14 of 20
   saved, 10 of 20 honoured). Session 2 never needed `memory_search`: the
   digest put the notes in front of it (1 search in 43 sessions).
2. **Skip the pointer line.** With the tools offered directly, one extra
   system line changed nothing measurable (60% against 61% of facts
   honoured, the same save timing). The tool descriptions already carry the
   trigger.
3. **The trigger that matters is the owner's correction, and it already
   works.** Every save in our arms came in the turn right after the owner
   corrected the agent or stated a preference; none came during the work.
4. **The trigger that is missing is the gotcha that surfaces in tool output.**
   Our arms saved none of the three pure tool-output gotchas (0 of 33
   episodes): the agent read the hint, retried, succeeded and moved on, so
   session 2 failed the same way. Native saved some of them (5 of 15) only
   because its progress log happened to record the working command. Worth
   building: a nudge when a command failed and a changed retry succeeded (a
   hook, or the save description naming "a command that failed until you
   changed how you ran it"). (Round 2 tested the hook's line: no gotcha
   was saved.)
5. **Test the production surface next.** This eval offers the memory tools as
   direct tools with their full descriptions. In production the kernel is the
   agents' only tool (`codeOnly`, the default): memory is one catalog line in
   the kernel's description and its words come through `tools.docs`. That gap
   is the likeliest cause of 4 saves in 105 sessions (inferred, not
   measured here): the same model saved on every correction when it could see
   the tool. A `kernel` arm, which renders the real catalog line and runs
   `tools.memory_save(...)` from a cell, is the next arm to add; or register
   the memory tools beside the kernel and measure the sessions. (Round 2
   added the `kernel` arm: 0 notes in 7 episodes.)
6. **Small fixes the transcripts show.** Haiku passed `tags` as a
   comma-separated string in 14 calls and was refused (`Expected array`); accept a
   string and split it (done in round 2). Notes bundle two or three facts in one line ("public
   repo: never stage codex/config.toml; stage by path; never push"), against
   "one fact per note"; harmless for the digest, worse for search and for
   correcting one fact by id.

## How it ran (measured)

- **Model: `claude-haiku-4-5-20251001`, not Haiku 5.5.** Every request to
  `claude-haiku-5-5` with this key answered `429 rate_limit_error`, also a
  single 8-token probe, while the model list names it and Haiku 4.5 answered
  at once. The script defaults to Haiku 5.5 and takes
  `--model claude-haiku-4-5-20251001`; it refuses any model that is not one of
  the two Haikus.
- **Spend: $4.36 for the run, $0.61 for three dry runs; $4.97 in all.** At
  Haiku 4.5's price (ten times Haiku 5.5's) the cap stopped the run after 85
  of 128 episodes: 5 or 6 repeats per arm × scenario, not 8. The same run on
  Haiku 5.5 would cost about $0.7.
- 2,644 requests, 528k uncached input tokens, 770k cache writes, 13.8M cache
  reads (93–97% of the input of the memory arms was read from the cache),
  299k output tokens. Concurrency 4.

## What the eval does

An episode is two sessions on one memory store. Session 2 starts a fresh
context, with no hint of what session 1 learned.

- **Session 1**: a coding task in a fake repository, driven by a scripted
  user. The agent learns three durable facts: a gotcha in tool output (a
  command fails and its output says why), an owner correction, and a stated
  preference. The user's second message depends on what the agent did ("No:
  never `git commit -a` … redo it" when it staged everything, "… like you
  did" when it did not). The third is "Thanks, that's all for now."
- **Session 2**: a new task where the facts matter. It is graded from the
  recorded tool calls alone.
- **Tools**: a fake `shell` (git, files, `cd`, pipes, package scripts and the
  scenario's commands, all canned; nothing real runs) and 11 distractors with
  OpenCode's descriptions (read, edit, write, grep, glob, webfetch,
  websearch, todowrite, question, subagent, skill), then the arm's memory.
- **Arms**:
  - `none`: no memory. It runs session 2 only.
  - `ours`: `memory_save`, `memory_search`, `memory_forget` with their real
    names, descriptions, inputs and answers (`mods/memory/notebook.ts`) over
    the real model and SQLite store (`mods/memory/model.ts`,
    `sqlite/store.ts`) in a scratch file, and the session's digest
    (`MemoryModel.digest`, which is `digestOf` under `HEADING`) last in the
    system prompt, nothing when there are no notes, as `cmd/memory/server.ts`
    wires them. The composition root is not imported: it pulls in the fork's
    plugin sources, which the root project cannot typecheck.
  - `ours+pointer`: the same, plus one line in the system prompt even with no
    notes: "Memory: memory_save keeps one-line notes across sessions. Save one
    when the user corrects you or states a preference, or when you learn a
    non-obvious fact about this project (a command that only works one way);
    memory_search before guessing this project's conventions."
  - `native`: `{"type":"memory_20250818","name":"memory"}` with a handler
    over a scratch directory (paths outside `/memories` refused); the API adds
    its own instruction.
- **Prompt caching**: the system prompt's last block carries a breakpoint and
  the request sets the top-level `cache_control`, so tools, system and the
  conversation so far are read from the cache.

### Scenarios and their facts

| scenario | gotcha (in tool output) | correction (owner) | preference (owner) |
| --- | --- | --- | --- |
| webapp (TS) | tests need `TEST_ENV=unit`, else the e2e project fails | never `git commit -a` / `git add -A`; stage by path | branches are `cvr/<topic>` |
| dotfiles (the owner's) | the gate needs `OPENCODE_DEV=$HOME/…`; `~` fails | never stage `codex/config.toml` (public repo) | never push; the owner pushes |
| billing (Python) | run through `uv run` (bare `pytest` fails) | never hand-write migrations; `alembic revision --autogenerate` | commit subjects start with the branch's ticket id |
| orders (Go) | `go test -short` (integration tests need docker) | deploy with `make deploy ENV=staging`, never straight to production | request review from mlee on every PR |

**Grading**, all deterministic. A fact is *saved* when one note (ours) or one
memory file (native) matches all of the fact's key patterns after session 1.
Session 2 *honours* a fact by its tool calls: the first test or gate command
was the working one, every commit staged by path, the first commit subject
starts `BILL-207`, no deploy went to production, and so on. *Read before
acting* is a search or view before the first other tool call. *Off-list
notes* are notes (ours) or memory-file lines (native) that touch no fact.

**Two facts are confounded; read them apart.** `dotfiles/no-push`: session 2
says "then ship it", which every arm read as an order to push (0 of 16 memory
episodes honoured it, even with the note in the digest). `billing/uv-run`: the
owner's migration correction itself says `uv run alembic …`, so the note that
holds the correction holds this gotcha too.

## Results (85 episodes, Haiku 4.5)

Without the two confounded facts (10 facts per arm):

| arm | facts honoured in session 2 | corrections saved → honoured | preferences saved → honoured | gotchas saved → honoured |
| --- | --- | --- | --- | --- |
| none | 9% (5/55) | – → 23% (5/22) | – → 0% (0/16) | – → 0% (0/17) |
| ours | 64% (35/55) | 22/22 → 95% (21/22) | 16/16 → 88% (14/16) | 0/17 → 0% (0/17) |
| ours+pointer | 62% (33/53) | 21/21 → 95% (20/21) | 16/16 → 81% (13/16) | 0/16 → 0% (0/16) |
| native | 40% (20/50) | 14/20 → 50% (10/20) | 11/15 → 40% (6/15) | 5/15 → 27% (4/15) |

All twelve facts, as `report.ts` prints them:

| arm | n | facts saved (s1) | s2 read before acting | s2 digest | s2 facts honoured | s2 all honoured | honoured when saved | off-list notes (s1/s2) | requests s1/s2 | turns cut at the 30-step cap s1/s2 | $/episode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 22 | – | – | – | 9% (6/66) | 0% (0/22) | – | – | – / 17.3 | 0 / 3 | $0.044 |
| ours | 22 | 74% (49/66) | 0% (0/22) | 100% (22/22) | 61% (40/66) | 23% (5/22) | 82% (40/49) | 0.0 / 0.0 | 17.7 / 15.6 | 0 / 0 | $0.051 |
| ours+pointer | 21 | 75% (47/63) | 0% (0/21) | 100% (21/21) | 60% (38/63) | 19% (4/21) | 81% (38/47) | 0.0 / 0.0 | 18.6 / 15.2 | 0 / 1 | $0.050 |
| native | 20 | 63% (38/60) | 100% (20/20) | – | 40% (24/60) | 20% (4/20) | 58% (22/38) | 7.2 / 6.9 | 21.3 / 16.2 | 0 / 0 | $0.056 |

| fact | none | ours | ours+pointer | native |
| --- | --- | --- | --- | --- |
| webapp/branch-prefix (preference) | 0/6 | 6/6 saved → 6/6 | 6/6 → 6/6 | 2/5 → 2/5 |
| webapp/unit-env (gotcha) | 0/6 | 0/6 → 0/6 | 0/6 → 0/6 | 0/5 → 0/5 |
| webapp/stage-by-path (correction) | 2/6 | 6/6 → 6/6 | 6/6 → 6/6 | 1/5 → 3/5 |
| dotfiles/gate-home (gotcha) | 0/6 | 0/6 → 0/6 | 0/5 → 0/5 | 3/5 → 2/5 |
| dotfiles/no-config (correction) | 3/6 | 6/6 → 5/6 | 5/5 → 5/5 | 4/5 → 3/5 |
| dotfiles/no-push (preference, confounded) | 1/6 | 6/6 → 0/6 | 5/5 → 0/5 | 4/5 → 0/5 |
| billing/uv-run (gotcha, confounded) | 0/5 | 5/5 → 5/5 | 5/5 → 5/5 | 4/5 → 4/5 |
| billing/autogenerate (correction) | 0/5 | 5/5 → 5/5 | 5/5 → 5/5 | 4/5 → 4/5 |
| billing/ticket-prefix (preference) | 0/5 | 5/5 → 5/5 | 5/5 → 4/5 | 4/5 → 4/5 |
| orders/go-short (gotcha) | 0/5 | 0/5 → 0/5 | 0/5 → 0/5 | 2/5 → 2/5 |
| orders/staging-first (correction) | 0/5 | 5/5 → 5/5 | 5/5 → 4/5 | 5/5 → 0/5 |
| orders/reviewer (preference) | 0/5 | 5/5 → 3/5 | 5/5 → 3/5 | 5/5 → 0/5 |

When the saves happen (count of memory writes by the user turn they follow,
turn 1 being the task):

| arm | after turn 1 (the work) | after turn 2 (correction, preference) | after turn 3 ("thanks") | episodes with a write |
| --- | --- | --- | --- | --- |
| ours | 0 | 30 | 1 | 22/22 |
| ours+pointer | 0 | 33 | 0 | 21/21 |
| native | 31 | 9 | 12 | 19/20 |

Notes per store after session 1: ours 1.05, ours+pointer 1.29, every one on
the fact list. Native's files held 7 off-list lines on average: progress
logs ("✅ Committed", "## Status: COMPLETED").

## What the transcripts show

**Ours saves at the correction, and the digest carries it.** dotfiles, ours,
episode 0, session 1, the turn after the owner's correction:

```
→ memory_save {"text":"dotfiles repo is public: never stage codex/config.toml (private settings).
   Stage files by exact path. Never push; user reviews and pushes themselves.","scope":"project",...}
```

Session 2's system prompt ended with that note under `# Memory`, and the
agent staged `opencode/mods/notes/text.ts` by path without being told.

**Ours does not save a gotcha the agent fixed itself.** The same session 1:

```
→ shell OPENCODE_DEV=~/Developer/opencode bun run gate
← gate: OPENCODE_DEV is '~/Developer/opencode', which does not exist: the ~ reached the gate
  unexpanded. Write the path with $HOME (OPENCODE_DEV=$HOME/Developer/opencode).
→ shell OPENCODE_DEV=$HOME/Developer/opencode bun run gate
← link ✓ … gate green
```

No save followed. Session 2: `bun run gate` → `OPENCODE_DEV is not set`, then
a search of the repository, then lint and tests run by hand instead of the
gate.

**The digest note did not beat the user's words in session 2.** Same
episode: the digest said "Never push", the user said "ship it", and the
agent ran `git push`. Every memory arm did the same (0 of 16), so this fact
measures the scenario, not memory.

**Native writes a progress log, and session 2 overwrites it.** webapp, native,
episode 0: the only memory file after session 1 was `progress.md`
("# Price Formatting Task … ## Status ✅ COMPLETED … Branch:
fix/price-formatting"), written during the work and never updated with the
owner's `cvr/` branch rule or the staging correction. orders, native: session
2 viewed a file that began "## IMPORTANT RULES - Always deploy to staging
FIRST", then ran `make deploy ENV=staging` and, in the same turn,
`make deploy ENV=production`; episode 1 rewrote the old task's status
heading as the new task's and deployed with `./scripts/deploy.sh production`.
The native instruction ("record status / progress / thoughts … ASSUME
INTERRUPTION") turns memory into a task journal, which is what our save
description forbids, and the durable rules drown in it.

**Without memory the agent rediscovers and still guesses.** none, webapp,
episode 0: `git checkout -b fix/slugify-trailing-dashes`, `npm test
src/lib/slug.test.ts` (fails with the `TEST_ENV=unit` hint),
`TEST_ENV=unit npm test`, `git add -A && git commit …`. It learns the gotcha
again each session, and never the owner's branch name or staging rule.

## Hypotheses

1. **Discovery and triggers**: supported, with a twist. When the tools are
   visible with their descriptions, the owner's correction is enough of a
   trigger: 43 of 43 episodes saved right after it, unprompted, and the
   pointer line added nothing. What never triggers a save is a gotcha the
   agent fixed by itself. Production hides the tools behind the kernel's
   catalog, which this eval did not reproduce (see recommendation 5).
2. **The weights expect the native tool**: not supported. Haiku used it
   eagerly (read before acting in 20 of 20 sessions, a write in 19 of 20) but
   wrote task journals, overwrote them and honoured fewer facts (40% against
   64%). Its one edge, gotchas (4 of 15 against 0 of 33), is a side effect of
   journaling the working command.
3. **Weak use cases**: not supported for corrections and preferences (from
   23% and 0% without memory to 95% and 88% with ours). Gotchas found in tool
   output are the weak case only because nothing saves them.

## Limits

- One model, Haiku 4.5 rather than Haiku 5.5; 5 or 6 repeats per cell, not 8
  (the spend cap). Differences of a fact or two per cell are noise.
- A fake shell: commands it does not know answer `(no output)`. The world
  was fixed through three dry runs until the transcripts read as real work
  (absolute paths, `cd`, pipes, `find`, package scripts, a real autogenerated
  migration).
- Direct tools only; no kernel; no compaction; a 30-step cap per user turn
  (it cut 4 of 148 sessions).

## Running it

From `opencode/`:

```
bun scripts/memory-eval/eval.ts --dry                      # one episode per arm
bun scripts/memory-eval/eval.ts --repeats 8 --cap 5        # the full run
bun scripts/memory-eval/eval.ts --model claude-haiku-4-5-20251001 --repeats 8 --cap 4.35
bun scripts/memory-eval/eval.ts --arms ours,kernel,ours+nudge --repeats 4 --cap 2.5   # round 2's run
bun scripts/memory-eval/eval.ts --arms kernel,kernel+direct --repeats 6 --cap 3        # round 3's run
bun scripts/memory-eval/report.ts <out>/episodes.jsonl     # regrade and summarize a run
bun scripts/memory-eval/show.ts <out>/episodes.jsonl native orders --s2   # read transcripts
```

Since round 3 requests go out on the pool's Claude accounts
(`scripts/memory-eval/pool.ts`): the accounts gent signed in to, in the store
the pool plugin reads (`~/.local/share/opencode-prime/pool-auth`, or
`--gent-dir`), each request shaped as the Anthropic auth plugin shapes it and
placed by a local copy of the pool's `AccountPool` seeded from the live
pool's `status`. Before each episode the run asks the live pool's `pace` and
its own accounts' pace, and stops on a no. `--api-key` sends with
`anthropic.key` in `~/.local/share/opencode/auth.json` instead, as rounds 1
and 2 did. No token or key is printed. The `$` figures are API prices: on the
pool they measure size, not money. Each run writes `out/memory-eval/<stamp>/`
(ignored by git): `episodes.jsonl` (one line per episode: the calls, a
compact transcript, the stores, the usage) and `report.md`. This run's data
(1.9 MB) is kept outside the repository at
`~/.cache/memory-eval/2026-11-08-run1/`. `report.ts` grades every episode
again from what it recorded, so a fixed grader applies to an old run: the
tables above are regraded after the reviewer grader learned to read a PR body
with newlines (+2 for ours on orders/reviewer).
