# Memory eval: our memory tools against Anthropic's native memory tool

The owner asked for a measured comparison before redesigning memory. In 105
Mac sessions since memory went live, 4 called `memory_save` and 2
`memory_search`. Three hypotheses: (1) nothing prompts the agent to use it
(discovery, triggers), (2) the weights expect Anthropic's native file memory
tool, (3) the use cases are weak. This note gives the eval, its results and a
recommendation. The script is `scripts/memory-eval/`; the design of memory
itself is `notes/memory.md`.

Five rounds ran. Round 1 compared our tools, a pointer line, the native tool
and no memory. Round 2 took up round 1's three follow-ups: string tags, a
`kernel` arm for the production surface, and a trigger for gotchas. Round 3
measured the fix round 2 proposed and production shipped in 9535f78: the
memory tools offered directly beside the kernel (`kernel+direct`). Round 4
fixed the billing scenario's fake world and tested two fixed-text levers for
saving gotchas against `kernel+direct`. Round 5 ran round 4's harmless lever
on Opus 5.5, the model production runs, and shipped it. The newest round
comes first below.

## Round 5: the gotcha sentence on Opus

### Recommendation (round 5)

1. **Ship the sentence; done in 74b5780.** On Opus 5.5, the sentence in
   `memory_save`'s description took gotchas saved in session 1 from 3 of 24
   to 11 of 24 (measured). The two gotchas nothing on screen gives away moved
   most: webapp/unit-env from 0 to 3 of 6 saved, dotfiles/gate-home from 1
   to 5 of 6. Session 2 then honoured them 7 times against 1. No arm wrote an
   off-list or task-state note (0 in every session). Corrections and
   preferences were saved 48 of 48 times in both arms. The sentence is now
   `GOTCHA_SENTENCE` in `mods/memory/notebook.ts`, inside `SAVE_DESCRIPTION`,
   with a test that pins where it sits. In the eval, every arm on our tools
   now offers the sentence. `kernel+direct+describe` is the same as
   `kernel+direct`, and the new `kernel+direct+plain` keeps the words from
   before (`VARIANTS` in `scripts/memory-eval/memory.ts`).
2. **The one cell that went the wrong way is the fake shell, not memory.**
   Corrections and preferences were honoured 44 of 48 times without the
   sentence and 39 of 48 with it. Every one of those misses is in a session
   2 that stopped before its commit: 6 episodes with the sentence against
   3 without. In each of them the agent stopped because it no longer trusted
   the shell ("`git` and `gh` stopped working in this session", "the shell
   tool isn't running commands"). Over the episodes that reached their
   commit, both arms honoured every correction and preference: 42 of 42
   without the sentence and 36 of 36 with it (measured from the
   transcripts). The stops come from the eval's world. One is round 4's known
   one: a kernel shell handle's `wait()` returns only the output since the
   last look, so it can be empty. The other was a harness bug, fixed after
   the run: the eval's `spawnSync` stand-ins joined an argv with bare spaces.
   So `Bun.spawnSync(["bash", "-lc", "git add … && git commit …"])` reached
   the fake shell as `bash -lc git add …`, and the fake bash, like a real
   one, ran only `git` (orders #0: "`git` and `gh` stopped working"). Now each
   argument stays whole (`argvLine` in `kernel.ts`). In session 2 the sentence
   changes only `memory_save`'s description and, through the saved gotchas,
   the digest. 3 of the 6 stopped episodes had no gotcha note in their
   digest. Adding the session-1 episodes that
   ran no commit command, the counts are 7 with the sentence and 6 without,
   so the stops look independent of the arm (inferred).
3. **What remains is a gotcha with a side door.** orders/go-short was saved
   0 times in both arms. `go test` names `-short` in its own output, so the
   agent may read it as the tool's documentation rather than something the
   repo taught it. billing/uv-run (2 and 3 of 6 saved) is still mostly
   relearned from the `.venv` in session 2, as in round 4. A next round, if
   any, would look at these two. The open fix with more reach is the shell
   handle's empty `wait()`. That is production behaviour, not the eval's. It
   sets Opus doubting the tools, and here it cost more episodes than any
   memory difference did.

### How round 5 ran (measured)

- `claude-opus-5-5` through the pool, 6 repeats × 4 scenarios × 2 arms,
  concurrency 4. The owner approved this one round on Opus. The script
  refuses Opus unless `--owner-approved-opus` is passed (`api.ts`). 48 of 48
  episodes graded, with no failure and no refusal.
- Before every episode the run asked the live pool's pace and the eval
  accounts' own, and stopped if any eval account's weekly reading rose more
  than 5 points since the start (`--weekly-limit`, `weeklyDrift` in
  `pool.ts`). Neither tripped. Over the 20 minutes the weekly readings moved
  by at most +1 point (one account, 2% → 3%; the other six did not move) and
  the 5-hour readings by 0 to +4. The readings include the owner's own
  sessions.
- 1,598 requests, 16.4M cache-read tokens (93% of input), 1.29M cache writes,
  381k output tokens and 3.6k uncached input: **$17.40 at Opus 5.5's API
  prices** ($4 in, $20 out, $5 cache write, $0.20 cache read per million),
  $0.36 per episode in both arms. Opus costs 40 times Haiku 5.5 per token,
  and it ran about as many requests per session as Haiku did in round 4.
- A grader fix came out of reading the transcripts. Opus often ran its
  commands as `sh -c '…' > file` or `bash -c '…'` and read the file back.
  The graders saw `sh` as the program, so a commit inside the wrapper did
  not count, and neither did a migration generated inside one. In d92b01f
  `shelled` and `commitMessages` read the wrapped command as the shell runs
  it. The fix also checks the redirect on the wrapper for a hand-written
  migration. Regraded, round 5's `kernel+direct` honoured 52 of 72 facts
  (49 before the fix) and `+describe` 52 (51 before). Round 4's tables do not
  change under the new grader.
- Raw data: `~/.cache/memory-eval/2026-11-09-run5/` (log
  `~/.cache/memory-eval/run5.log`; `report-regraded.md` is the regraded
  summary).

### Round 5 results (24 episodes per arm, Opus 5.5, regraded)

| arm | n | facts saved (s1) | s2 digest | s2 facts honoured | s2 all honoured | honoured when saved | off-list notes s1/s2 | task-state notes s1/s2 | requests s1/s2 | $/episode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| kernel+direct | 24 | 71% (51/72) | 100% (24/24) | 72% (52/72) | 29% (7/24) | 92% (47/51) | 0.0 / 0.0 | 0.0 / 0.0 | 17.8 / 15.3 | $0.361 |
| kernel+direct+describe | 24 | 82% (59/72) | 100% (24/24) | 72% (52/72) | 42% (10/24) | 83% (49/59) | 0.0 / 0.0 | 0.0 / 0.0 | 19.4 / 14.0 | $0.364 |

| arm | correction saved → honoured | gotcha saved → honoured | preference saved → honoured |
| --- | --- | --- | --- |
| kernel+direct | 24/24 → 21/24 | 3/24 → 8/24 | 24/24 → 23/24 |
| kernel+direct+describe | 24/24 → 18/24 | 11/24 → 13/24 | 24/24 → 21/24 |

Per fact, saved in session 1 → honoured in session 2 (of 6 each):

| fact | kernel+direct | +describe |
| --- | --- | --- |
| webapp/branch-prefix (preference) | 6 → 6 | 6 → 5 |
| webapp/unit-env (gotcha) | 0 → 0 | 3 → 3 |
| webapp/stage-by-path (correction) | 6 → 6 | 6 → 4 |
| dotfiles/gate-home (gotcha) | 1 → 1 | 5 → 4 |
| dotfiles/no-config (correction) | 6 → 4 | 6 → 4 |
| dotfiles/no-push (preference) | 6 → 6 | 6 → 6 |
| billing/uv-run (gotcha) | 2 → 6 | 3 → 6 |
| billing/autogenerate (correction) | 6 → 6 | 6 → 6 |
| billing/ticket-prefix (preference) | 6 → 6 | 6 → 6 |
| orders/go-short (gotcha) | 0 → 1 | 0 → 0 |
| orders/staging-first (correction) | 6 → 5 | 6 → 4 |
| orders/reviewer (preference) | 6 → 5 | 6 → 4 |

Session-2 episodes that stopped before their commit, and the corrections and
preferences honoured in the ones that did not (counted from the transcripts):

| arm | stopped (s2) | no commit command (s1) | corrections + preferences honoured, finished s2 |
| --- | --- | --- | --- |
| kernel+direct | 3/24 (dotfiles #2, #4; orders #2) | 3/24 | 42/42 |
| kernel+direct+describe | 6/24 (webapp #4, #5; dotfiles #0, #4; orders #0, #1) | 1/24 | 36/36 |

What the cells and transcripts show:

- **The sentence moves saves into the work.** In session 1, every
  `kernel+direct` save (49) came in the turn after the owner's correction,
  as in every round before. With the sentence, 7 saves came during the work
  itself, before any correction, and 49 after it (measured from the
  transcripts). No earlier round had a save during the work except
  `native`'s progress logs. The gotcha notes stand alone. They name the
  working command and why the other one fails, as in webapp #3: "acme-web:
  run unit tests with `TEST_ENV=unit bun run test`; plain `vitest run` also
  runs the Playwright e2e project, which fails when Chromium isn't
  installed."
- **Some gotcha notes carry a remark about the kernel's shell** (dotfiles #0
  and #2: "tools.shell ignores `workdir`, and its cwd carries over between
  calls"). This is the agent's reading of the fake world, saved as a fact
  about the tool. The grader does not count it off-list, since it sits in
  the gate note. In production it would be true or false of the real shell
  handle. It is worth watching in real notes, but it is not junk of the kind
  the description forbids.
- **On Opus, `kernel+direct` saves more than on Haiku.** It saved 71% of
  facts in session 1, against 50% on Haiku 5.5 in round 4, and the digest
  reached all 24 session-2 episodes, against 18. Billing, which Haiku
  rarely saved in, was saved 6 of 6 times for the correction and the
  preference. Rounds on different models are not compared fact by fact.

## Round 4: two gotcha-save levers, and a billing world that holds up

### Recommendation (round 4)

1. **Ship neither lever; production stays as it is.** Neither candidate
   clearly won. Over 24 episodes per arm on Haiku 5.5, gotchas saved in
   session 1 went from 0 of 24 (`kernel+direct`) to 2 of 24 with the
   `memory_save` description sentence (`describe`), and to 0 of 24 with the
   line after the save (`followup`) (measured). Two of 24 is within noise.
   Both `describe` saves rode inside the note on the owner's correction
   ("generate migrations with `uv run alembic revision --autogenerate` …
   plain `alembic` is not on PATH"), not in a note of their own. Neither arm
   added an off-list or task-state note (0 in every session). The other facts
   did not get worse: corrections saved 20/24 in both arms against 18/24, and
   preferences 20/24 against 18/24. So `describe` is harmless and slightly
   up. It is not the clear win the bar asks for, and `mods/memory` is
   unchanged.
2. **Wording does not move gotcha saves on Haiku.** Rounds 2–4 tried
   round 2's shell retry nudge, round 3's direct tools, and this round's
   description sentence and after-save line. Gotcha saves stayed near zero
   every time (0–2 of 24 in rounds 3 and 4). The model saves what the owner says, and it does not treat its own
   recovered failures as worth keeping. A next round should change the
   model (Sonnet or Opus, the models production sessions run on), not the
   words.
3. **The gotcha that the repository shows is relearned anyway.** In session
   2, billing/uv-run was honoured in 5, 6 and 6 of 6 episodes, though at most
   2 of 6 had saved it. The `uv.lock`, the `.venv` and the hint in pytest's
   error lead the model there. The two gotchas that nothing on screen gives
   away (webapp/unit-env, orders/go-short) were honoured 0 times in every
   arm. Saving gotchas matters most for that second kind, and there no arm
   saved any.

### What changed in billing, and why (measured)

Round 3's billing numbers were a harness limit. Haiku 5.5 doubted the fake
shell ("The tool results don't match what the commands should do") and
stopped before the owner's correction. In round 3, 1 of 12 billing session-1
episodes reached the amended `BILL-142:` commit. In round 4, 17 of 18 did.

- **The shell behaves like zsh** (`world.ts`):
  - `&&`, `||` and `;` run as a shell runs them, and `$?` is kept;
  - `sh -c` is unwrapped, heredocs are fed to the command, `>` and `>>`
    write files, `$(…)` is substituted, and an unmatched glob fails as zsh
    does ("zsh: no matches found");
  - rm, mv, cp, touch, test, sed, wc, `ls -l`/`-a`, mkdir, mktemp, date,
    env, which and uname work;
  - there is a little Python (imports, `--version`, `print` of literals and
    a few well-known values);
  - `/tmp`, `$TMPDIR` and a `PATH` exist.
- **Git is a three-tree model** (`git.ts`, new): HEAD, the index and the
  working files, with history, objects, a reflog, `.gitignore` and a stash.
  Committing with nothing staged fails, `--amend` rewrites, and `diff
  --cached` agrees with `status`.
- **Kernel cells** go through the same shell for fs `unlinkSync`, `rmSync`,
  `mkdirSync`, `renameSync`, `copyFileSync`, `appendFileSync` and
  `statSync`, and `process.env` has a `PATH`.
- **The billing repository is a real one:**
  - an app, a conftest and 4 tests that pytest counts;
  - migrations 0006 and 0007 in alembic's own template;
  - a `.gitignore`, a `.venv`, and a `billing.db` at 0007;
  - alembic with heads, current, history, stamp, upgrade, downgrade, check,
    `-c`, and `revision --autogenerate`, which takes its columns and types
    from the model;
  - a `sqlite3` stand-in.
- **The correction no longer names `uv run`.** In rounds 1–3, the owner's
  words were "generate them with `uv run alembic revision --autogenerate`".
  A note that kept the correction also kept the gotcha by accident. The
  correction now says `alembic revision --autogenerate`, and only a note
  that adds `uv run` (or `.venv/bin`) on its own counts as the gotcha.

Changed assertions, all in `scripts/memory-eval/memory-eval.test.ts`:

- **billing/autogenerate is graded on what was written.** It fails only
  when the agent writes a migration file that alembic did not generate,
  through `write`, `>`, `tee`, `cp` or `mv`. Editing the generated file
  passes. The old grader looked for an alembic command and a write in any
  order, and the fake world could not generate a file. The test now has a
  generated case, a heredoc-written case and an edited-generated case.
- **billing/uv-run also passes** for a first test run from `.venv/bin/` or
  after `source .venv/bin/activate`. These run in the project's environment
  too.
- **The orders `ls -la` test expects a long listing** (`total 48`, then
  `-rw-r--r--` rows), since `-l` is now honoured. A plain `ls` keeps the
  list of names.
- **The orders commit test edits and stages before it commits**, since
  committing with nothing staged now fails, as it does in git.

Dry runs (one billing episode per arm, 3 per run, about $0.13 each at API
prices):

- **Dry run 1** (`~/.cache/memory-eval/2026-11-09-run4-dry/`) still showed
  doubt. There was no `/tmp`, no `PATH`, and Python printed nothing. Those
  holes are fixed in d849863.
- **Dry run 2** (`…-run4-dry2/`): all 3 episodes autogenerated the
  migration and amended to `2da40bc BILL-142: add invoice currency`.

Some doubt remains in the full run: 4 of 18 billing transcripts question a
tool result.

- One case is production behaviour, not the fake world. A kernel shell
  handle's `wait()` returns the output "since your last look". That is empty
  when the call that started the command already returned the output, and
  one episode read the empty result as a broken shell.
- The other cases are SQLAlchemy scripts that print nothing, and the
  `write` tool refusing `/tmp`, which is outside the project. In each case
  the model worked around it and finished.

### How round 4 ran (measured)

- `claude-haiku-5-5` through the pool, 6 repeats × 4 scenarios × 3 arms,
  concurrency 4. 72 of 72 episodes graded, with no failure and no refusal.
  The pool's pace said "within its weekly pace" before every episode.
- 2,239 requests, 28.4M cache-read tokens (93–94% of input), 1.97M cache
  writes and 862k output tokens: $0.96 at API prices, in 23 minutes.
  Between the first and last pool readings, the accounts' 5-hour figures
  moved by −13 to +3 points (the 5-hour window rolled during the run), and
  the weekly figures did not move. The readings include the owner's own
  sessions.
- The arms are fixed text, so the system text and the tool definitions stay
  the same for the whole session (cache-safe). They are defined as
  `VARIANTS` in `scripts/memory-eval/memory.ts`:
  - `kernel+direct+describe` adds one sentence to `memory_save`'s
    description, after "a fix that took real effort and its cause.": "A
    command that failed and worked only once you ran it another way (a
    variable, a flag, a wrapper, a path) is such a fix: save the way that
    works, so the next session does not fail first."
  - `kernel+direct+followup` puts a fixed line after `memory_save`'s
    answer: "If this session also taught you something a later session
    would need, such as a command that failed until you ran it another way,
    save that too, one fact per note." This line only appears after a save,
    so it can only add a second note.
- Raw data: `~/.cache/memory-eval/2026-11-09-run4/` (log
  `~/.cache/memory-eval/run4.log`).

### Round 4 results (24 episodes per arm, Haiku 5.5)

| arm | n | facts saved (s1) | s2 digest | s2 facts honoured | s2 all honoured | honoured when saved | off-list notes s1/s2 | task-state notes s1/s2 | requests s1/s2 | $/episode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| kernel+direct | 24 | 50% (36/72) | 75% (18/24) | 63% (45/72) | 17% (4/24) | 97% (35/36) | 0.0 / 0.0 | 0.0 / 0.0 | 20.5 / 12.8 | $0.0152 |
| kernel+direct+describe | 24 | 58% (42/72) | 83% (20/24) | 64% (46/72) | 17% (4/24) | 95% (40/42) | 0.0 / 0.0 | 0.0 / 0.0 | 19.7 / 10.1 | $0.0127 |
| kernel+direct+followup | 24 | 56% (40/72) | 83% (20/24) | 58% (42/72) | 8% (2/24) | 88% (35/40) | 0.0 / 0.0 | 0.0 / 0.0 | 17.5 / 12.6 | $0.0122 |

| arm | correction saved → honoured | gotcha saved → honoured | preference saved → honoured |
| --- | --- | --- | --- |
| kernel+direct | 18/24 → 18/24 | 0/24 → 8/24 | 18/24 → 19/24 |
| kernel+direct+describe | 20/24 → 19/24 | 2/24 → 8/24 | 20/24 → 19/24 |
| kernel+direct+followup | 20/24 → 17/24 | 0/24 → 7/24 | 20/24 → 18/24 |

Per fact, saved in session 1 → honoured in session 2 (of 6 each):

| fact | kernel+direct | +describe | +followup |
| --- | --- | --- | --- |
| webapp/branch-prefix (preference) | 6 → 6 | 6 → 6 | 6 → 6 |
| webapp/unit-env (gotcha) | 0 → 0 | 0 → 0 | 0 → 0 |
| webapp/stage-by-path (correction) | 6 → 6 | 6 → 6 | 6 → 6 |
| dotfiles/gate-home (gotcha) | 0 → 3 | 0 → 2 | 0 → 1 |
| dotfiles/no-config (correction) | 5 → 5 | 6 → 6 | 6 → 6 |
| dotfiles/no-push (preference) | 5 → 6 | 6 → 6 | 6 → 6 |
| billing/uv-run (gotcha) | 0 → 5 | 2 → 6 | 0 → 6 |
| billing/autogenerate (correction) | 1 → 1 | 2 → 2 | 2 → 1 |
| billing/ticket-prefix (preference) | 1 → 1 | 2 → 2 | 2 → 2 |
| orders/go-short (gotcha) | 0 → 0 | 0 → 0 | 0 → 0 |
| orders/staging-first (correction) | 6 → 6 | 6 → 5 | 6 → 4 |
| orders/reviewer (preference) | 6 → 6 | 6 → 5 | 6 → 4 |

What the cells show:

- **Billing now finishes, but the model rarely saves there.** Session 1
  reached the amended commit in 17 of 18 episodes, but at most 2 of 6 per
  arm saved the correction or the preference. In the other three scenarios
  every arm saved them 5 or 6 times. The billing correction comes with a
  redo (regenerate the migration, re-run, amend). In the transcripts the
  model finishes the redo and ends without a save (inferred from the 18
  billing transcripts, not counted by the grader). This is a memory
  result, not a harness one: the task is done and nothing in the world
  stops a save.
- **`followup` cannot reach an episode that never saves**, and it rarely
  added a second note in the episodes that did save. Its line followed the
  first save in 20 episodes. A second note followed in only one of them
  (billing #1), and that note held the commit prefix, not the gotcha. Every
  arm had about one two-note episode: 1, 2 and 1 (measured).
- Round 3's `kernel+direct` saved 54% (39/72) of facts and this round's
  saved 50% (36/72). The billing world changed in between, so compare this
  round's arms with each other.

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
bun scripts/memory-eval/eval.ts --arms kernel+direct,kernel+direct+describe,kernel+direct+followup --repeats 6 --cap 3   # round 4's run
bun scripts/memory-eval/eval.ts --model claude-opus-5-5 --owner-approved-opus --arms kernel+direct,kernel+direct+describe --repeats 6 --cap 50 --weekly-limit 5   # round 5's run (owner-approved, once)
bun scripts/memory-eval/eval.ts --arms kernel+direct+plain,kernel+direct --repeats 6 --cap 3   # since round 5: the words before it against production's
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
