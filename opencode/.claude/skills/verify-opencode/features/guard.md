# Guard

A shell call that would lose work for good never runs: a recursive `rm` of the root, the home, the working directory, a `.git` or a repository root, `git reset --hard`, a forced wide `git clean`, a kill by pattern that would reach OpenCode, and `kill -1` are refused as the tool's error `guard-destructive: <reason>.`, direct or from a kernel cell. A subagent's foreground call that opens by sleeping 30 seconds or more is refused as `guard-sleep: <reason>.`, naming a background shell to wait on instead; a root's runs. A heavy command (tests, typechecks, gates, builds) runs through a launcher at `nice -n 10`, its text kept as written.

## Sub-features

- `guard-destructive`: the destructive commands above are refused in the guard's words.
- `guard-pass`: a force-push, a dry-run clean and an ordinary `rm` pass.
- `guard-kill`: a pattern kill reaching OpenCode, and `kill -1`, are refused; a kill by PID passes.
- `guard-sleep`: a subagent's opening `sleep` of 30 s or more is refused; the root's runs.
- `guard-worktree`: `git worktree add` in a checkout a workspace can copy is refused, naming the work tool's `create` and `workrift create <branch>`.
- `guard-work-gc`: `work gc` is refused while its base has a workspace whose record says creating and whose folder exists, naming it (`cmd/guard/server.test.ts`); it runs when none is.
- `guard-keychain`: refuses Chrome launched for DevTools or headless without both `--use-mock-keychain` and `--password-store=basic`, pointing to Playwright or browse. It follows wrappers, runtime startup modules and statically named entry points in execution order, through at most six child edges. A historical Git selection followed by a non-inert command in the affected worktree requires `CHROME` set to `claude/bin/chrome-mock-keychain`; the selector list does not include pull, merge, or plain rebase. The planner reads literal shell bindings. An unresolved selector operand needs evidence of history: an iteration feeding it, a Git history producer, or explicit historical Git syntax. A launch uses the checkout targeted by its runner options or the invoked file in a known checkout, not necessarily the caller's directory. Child shell code shares the revision walk at its call site: its working directory stays local, but its Git changes persist. A shell with only a selector is allowed. For a JS/TS/Python program with evidence of a historical selection, the refusal says the guard cannot tell what the program runs next. Unknown selector options or working-tree identity are also reported as uncertainty. `git bisect run`, named bisect drivers and `git rebase --exec` can execute on intermediate commits themselves. Dynamic or missing child code, ordinary module imports, and code beyond the depth bound supply no evidence. A plain tag name is indistinguishable from a branch name by syntax. A one-off computed target without history evidence can also hold an old commit the guard cannot see. Pass `--detach` or the shim when you mean an old commit. Tests: `mods/guard/chrome.test.ts`, `mods/guard/fixtures/keychain-scripts.test.ts`, `cmd/guard/server.test.ts`.
- `guard-heavy`: a heavy command runs under the launcher, niced.

For `guard-keychain`, history provenance follows the stream across pipeline stages and nested substitutions, without classifying the filters in between. The same shell walk resolves `read`, loop variables and assignments in compound commands, including groups and called functions. The provenance is evidence only when the resulting value reaches a Git selector operand.

At a control-flow join, the guard keeps each reaching path's bindings, directory and selected worktrees together. Paths that terminate do not feed the next command. The guard does not evaluate or correlate separate conditions, even complementary tests of the same variable; it uses the most restrictive result over the paths it sees. If there are more than 64 possible path states, it reports that it cannot tell rather than selecting an arm. Substitutions carry history from captured stdout, not from diagnostics routed only to stderr.

## How to get to it (user POV)

- The agent's `shell` (or `bash`) call, direct.
- A kernel cell's `tools.shell({ command })`, when the kernel plugin is loaded.
- A subagent's shell call (the sleep rule is a subagent's only).

## Driving it with the world

- **Preconditions:** none beyond the baseline; the world's machine holds the process table, the repositories and the launchers.
- **States:** refused and default (a command that passes). Loading is `n/a`; error is the guard-faults suite (a store or a process listing that fails, which refuses).
- **World suites:** `cmd/guard/guard.sim.test.ts`, `cmd/guard/guard-faults.sim.test.ts`, `cmd/guard/admission.sim.test.ts`
- **Code:** `mods/guard/`, `cmd/guard/`, `sim/`; `tests/owned.ts`, `tests/scratch.ts` (the spawn helper and scratch folders its real checks run through: a change to them is due on every such check)
- **Regression:** `mods/guard/*.test.ts` (the verdicts, line by line).

1. **Refusals.** The suites drive each destructive form through the registry's `execute.before` hook and read the tool's error, `guard-destructive: …`, and that nothing reached the world's shell.
2. **Sleep.** A subagent's `shell` call `sleep 60` is refused `guard-sleep: …`; the root's same call runs.
3. **Heavy.** A heavy command reaches the shell's `create.before` hook and runs with the launcher as its program, the command text unchanged (`world.spawned()`).

## Driving it with real OpenCode

- **Real:** `tests/guard.test.ts`

Drive the sleep rule, which is harmless whatever happens; the destructive forms stay on the world and in `tests/guard.test.ts`, which runs them against scratch repositories.

1. **Subagent sleep.** Type `verify: call subagent {"agent":"general","description":"guard probe","prompt":"verify: call shell {\"command\":\"sleep 60\"}","background":false}` and press Enter. Wait for `guard-sleep`. The child's shell call is refused in the guard's words, naming `background: true` and the shell's `wait`; it never ran (no 60-second wait).
2. **Root sleep.** Type `verify: call shell {"command":"sleep 1"}`, Enter. It runs: the call's answer comes, no refusal.
3. **Proof.** `pilotty snapshot -s verify-$PORT --format text > $EVIDENCE/guard/sleep.txt` after step 1.

## Gotchas

- Never type a destructive command into a real TUI to see it refused. The world proves the refusals; the real test runs them in scratch repositories it owns.
- Never run a bare headless Chrome on the Mac to see the keychain rule refuse it: a run that slips past would put a keychain dialog on the owner's screen. The seam test proves it with memory scripts.
- The sleep rule is for a subagent's foreground call only: a root's `sleep 60` runs, and a background shell passes.
- The niceness is real only on real OpenCode; the world proves the launcher is the program, not the priority it runs at.
