# gamut

A live run of OpenCode with our plugins against a red fixture app, driven
from the shell. The scenario tests in `tests/` check the look with a scripted
model; gamut is the layer above them: real models, a real pty, real tools.

```sh
bun run gamut list                       # presets, their models, the login each needs
bun run gamut up deepseek --prompt "Fix README task 1 and run bun test tests/money.test.ts"
bun run gamut wait                       # until no turn is open and the screen is still
bun run gamut read                       # rows added since the last read; --full for the screen
bun run gamut status                     # sessions, turns, models, tool calls, errors, bun test
bun run gamut send "now task 2"          # type a message and press Enter
bun run gamut keys esc down enter        # named keys; `interrupt` is one ctrl+c
bun run gamut restart                    # quit and resume the newest session
bun run gamut down                       # quit, stop the host, remove the run
```

## What `up` does

1. Copies `fixture/` (ledgerline, a small Bun app with 4 red tests) into a
   scratch root, renames `.gitignore.fixture`, runs `bun install`, and commits
   it with git.
2. Writes the run's `opencode.json` (the preset's models per agent, plus a
   `reviewer` subagent), `config/cli.json` (our plugins by absolute path,
   `plugins/prime` first, and the Prime theme), and the roster block of the
   fixture's `AGENTS.md`.
3. Gives OpenCode a home, database and config directory of the run's own. Its
   environment is built from an allowlist: the terminal basics and the proxy
   variables. No API key in the caller's shell reaches it.
4. Copies each login the preset needs from the owner's `opencode2` into the
   run's database: `auth export` piped to `auth import`, through stdin only.
5. Starts OpenCode with `--auto` on a detached terminal host (`pty-host.ts`)
   that later commands reach over a Unix socket. The host's config, which
   holds the environment, is written owner-only and removed once read.

OpenCode runs from the fork's source at `OPENCODE_DEV` (default: the
`prime-look` Rift), so there is nothing to build; `--installed` runs
`opencode2` instead.

## Presets

Presets are data in `gamut.ts` (`PRESETS`): a model and an effort for each
role. The orchestrator is OpenCode's `build` agent, the worker the `general`
and `explore` subagents, the reviewer the run's `reviewer` subagent. A
family such as `opencode-go/glm` resolves to its newest release in the model
catalog when the run starts.

- `sim`: `sim-model.ts`, a scripted OpenAI-compatible model on a loopback
  port. No network, no login. The e2e test in `tests/gamut.test.ts` uses it.
- `deepseek`: DeepSeek flash in every role on the OpenCode Go plan.
- `glm-deepseek`: GLM orchestrates and reviews, DeepSeek flash implements.

The live presets need the OpenCode Go login: `opencode2 auth login opencode-go`.
No preset uses an Anthropic or OpenAI account.

## State

The run's state file is `$TMPDIR/opencode-gamut-opencode-gent.json`;
`GAMUT_STATE` overrides it, so the e2e test can run beside a live run. The
scratch root holds a copy of the login, so `down` deletes it.
