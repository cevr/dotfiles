# claude

Claude Code uses one profile (`~/.claude`) on each machine. TeamClaude manages the account pool. Settings and mods are shared by the laptop and workbox; every new session picks up edits here.

| Path | What it is |
| --- | --- |
| `bin/claude` | Executable shim that launches Claude Code through the machine-local TeamClaude proxy. |
| `settings.json` | The one user `settings.json`. `install.sh` (laptop) and `workbox/bootstrap.sh` / `apply-agent-settings` (workbox) symlink `~/.claude/settings.json` to it. |
| `mods/` | Mods (function-hook plugins). `settings.json` → `env.CLAUDE_CODE_PLUGIN_DIRS` lists each folder, `:`-separated with `~` paths, so they load on both machines with no install step; sessions watch the folders, so a saved edit reloads. |
| `hooks/guard-agent.ts` | PreToolUse on `Agent`: a `general-purpose`, `claude` or untyped agent runs as the lean `orchestrate-worker` (`agents/orchestrate-worker.md`), and a new agent is refused while orchestrate's `budget.ts` reports the pool at its cap. `CLAUDE_FULL_AGENT=1` lets a full agent through. |
| `install-herdr-hook.sh` | Installs herdr's Claude hook script into `~/.claude/hooks` without letting herdr edit the shared `settings.json`, which already registers the hook. |

## Launching Claude

On the laptop and workbox, shell startup puts `claude/bin` first on `PATH`, so `claude` runs `teamclaude run -- --dangerously-skip-permissions` in interactive shells and subprocesses. The shim leaves the flag out when the caller passes it or `--permission-mode`. Other arguments, input, output and exit status pass through unchanged. Each machine uses its own TeamClaude service and account pool. If its proxy is unavailable, the launch fails instead of silently bypassing it.

The native Claude Code binary stays at `~/.local/bin/claude`, where its updater manages it. The shim puts that directory first for TeamClaude's child process, avoiding recursion. Keep the shim in `claude/bin`; do not replace the native binary with it.

New shells pick up the launcher automatically. Run `source ~/.zshrc` in an existing shell to load it and clear the retired `claude2` alias. Old second-profile sessions and credentials remain in `~/.claude2`.

## Rules for `settings.json`

- **Portable.** Paths are `~/…` or `$HOME/…`, never `/Users/cvr` or `/home/exedev`. A hook that needs a machine-only tool checks for it first (`if command -v moshi-hook …`).
- **No secrets.** The repo is public. Machine-local secrets go in `~/.config/secrets.env` (mode 600), which `zshrc` and `workbox/zshenv` source; Claude inherits them from the shell.
- **One copy.** Tools that write settings (`/config`, `claude plugin install`, the auto-mode setup) write through the symlink into this file. Review those writes with `git diff` and commit them, or move them out when they are machine- or repo-specific.

## Adding a mod

Create `mods/<name>/` with `.claude-plugin/plugin.json`, `hooks/hooks.json` and the hooks module, then add `:~/Developer/personal/dotfiles/claude/mods/<name>` to `CLAUDE_CODE_PLUGIN_DIRS`. Check it with `claude plugin validate` and `claude plugin test` on the folder.
