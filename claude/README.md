# claude

Claude Code config shared by both accounts (`~/.claude`, `~/.claude2`) on the laptop and the workbox. Edit it here; every new session on either machine picks it up.

| Path | What it is |
| --- | --- |
| `settings.json` | The one user `settings.json`. `install.sh` (laptop) and `workbox/bootstrap.sh` / `apply-agent-settings` (workbox) symlink both accounts' `settings.json` to it. |
| `mods/` | Mods (function-hook plugins). `settings.json` → `env.CLAUDE_CODE_PLUGIN_DIRS` lists each folder, `:`-separated with `~` paths, so they load on both machines with no install step; sessions watch the folders, so a saved edit reloads. |
| `install-herdr-hook.sh` | Installs herdr's Claude hook script into `~/.claude/hooks` without letting herdr edit the shared `settings.json`, which already registers the hook. |

## Launching Claude

On the laptop and workbox, `claude` runs `teamclaude run --`; `claude2` does the same with `CLAUDE_CONFIG_DIR="$HOME/.claude2"` to keep its separate sessions. Arguments pass through to Claude Code unchanged. Each machine uses its own TeamClaude service and account pool. If its proxy is unavailable, the launch fails instead of silently bypassing it.

New shells pick up the aliases automatically. Run `source ~/.zshrc` in an existing shell to load them.

## Rules for `settings.json`

- **Portable.** Paths are `~/…` or `$HOME/…`, never `/Users/cvr` or `/home/exedev`. A hook that needs a machine-only tool checks for it first (`if command -v moshi-hook …`).
- **No secrets.** The repo is public. Machine-local secrets go in `~/.config/secrets.env` (mode 600), which `zshrc` and `workbox/zshenv` source; Claude inherits them from the shell.
- **One copy.** Tools that write settings (`/config`, `claude plugin install`, the auto-mode setup) write through the symlink into this file. Review those writes with `git diff` and commit them, or move them out when they are machine- or repo-specific.

## Adding a mod

Create `mods/<name>/` with `.claude-plugin/plugin.json`, `hooks/hooks.json` and the hooks module, then add `:~/Developer/personal/dotfiles/claude/mods/<name>` to `CLAUDE_CODE_PLUGIN_DIRS`. Check it with `claude plugin validate` and `claude plugin test` on the folder.
