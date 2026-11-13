# Guard

A shell call that would lose work for good never runs: a recursive `rm` of the root, the home, the working directory, a `.git` or a repository root, `git reset --hard`, a forced wide `git clean`, a kill by pattern that would reach OpenCode, and `kill -1` are refused as the tool's error `guard-destructive: <reason>.`, direct or from a kernel cell. A subagent's foreground call that opens by sleeping 30 seconds or more is refused as `guard-sleep: <reason>.`, naming a background shell to wait on instead; a root's runs. A heavy command (tests, typechecks, gates, builds) runs through a launcher at `nice -n 10`, its text kept as written.

## Sub-features

- `guard-destructive`: the destructive commands above are refused in the guard's words.
- `guard-pass`: a force-push, a dry-run clean and an ordinary `rm` pass.
- `guard-kill`: a pattern kill reaching OpenCode, and `kill -1`, are refused; a kill by PID passes.
- `guard-sleep`: a subagent's opening `sleep` of 30 s or more is refused; the root's runs.
- `guard-worktree`: `git worktree add` in a checkout Rift serves is refused, naming the rift tool.
- `guard-heavy`: a heavy command runs under the launcher, niced.

## How to get to it (user POV)

- The agent's `shell` (or `bash`) call, direct.
- A kernel cell's `tools.shell({ command })`, when the kernel plugin is loaded.
- A subagent's shell call (the sleep rule is a subagent's only).

## Driving it with the world

- **Preconditions:** none beyond the baseline; the world's machine holds the process table, the repositories and the launchers.
- **States:** refused and default (a command that passes). Loading is `n/a`; error is the guard-faults suite (a store or a process listing that fails, which refuses).
- **World suites:** `cmd/guard/guard.sim.test.ts`, `cmd/guard/guard-faults.sim.test.ts`
- **Code:** `mods/guard/`, `cmd/guard/`, `sim/`
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
- The sleep rule is for a subagent's foreground call only: a root's `sleep 60` runs, and a background shell passes.
- The niceness is real only on real OpenCode; the world proves the launcher is the program, not the priority it runs at.
