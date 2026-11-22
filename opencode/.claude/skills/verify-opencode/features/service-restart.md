# Service restart and background shells

An install restarts the OpenCode service (`opencode service restart`, the handoff the update runs), and a background shell a session started keeps running under the new server: it stays listed running, and when it ends its session gets the end notice (`<background-result kind="shell" … state="completed" …>`) and is woken by it. On Linux the service places itself in its own user scope (`opencode-service-<pid>.scope`, the update plugin's placement), and that scope outlives the old service while the PTY daemon and its shells are in it. A stop with no handoff (a signal, or systemd stopping the scope) ends the shell: the session gets the cancelled notice, queued for its next turn (upstream), or woken once (the fork's restart wake, once installed).

## Sub-features

- `restart-handoff`: a running background shell survives `service restart`, stays listed running, and its end notice wakes its idle session.
- `restart-scope`: on Linux the shell's scope (the old service's) is still active after the handoff and holds the shell; systemd's view says why it survived.
- `signal-stop`: SIGTERM to the service, then `service start`: the shell ends, and its session gets the cancelled notice, queued or woken once.
- `scope-stop`: `systemctl --user stop` on the scope that holds the shell: the same report as `signal-stop`.

## How to get to it (user POV)

- An install's restart: the update plugin's handoff runs the launcher's `service restart`.
- The owner or a client running `opencode service restart`, `service stop` and `service start`.
- A service manager's stop: launchd or systemd sending SIGTERM, or systemd stopping the scope.

## Driving it with the world

- **Preconditions:** none on the world: it has no service process, no PTY daemon and no systemd.
- **States:** n/a on the world.
- **World suites:** none yet: a restart replaces the service process and its systemd scope, which the world does not model; the drive is on a real host.
- **Code:** `mods/update/placement.ts`, `mods/update/process/placement.ts`, `scripts/restart-leg.ts`

The world cannot show this feature: drive it on a real host below.

## Driving it with real OpenCode

- **Real:** `scripts/restart-leg.test.ts`

The fork's own test (`packages/cli/test/service-shell-restart.test.ts` in the fork) runs the restart on a service from source with no dotfiles plugins. The Linux leg, with the installed build and the update plugin's placement under a user systemd, is `scripts/restart-leg.ts`, run on the workbox. `scripts/restart-leg.test.ts` (what `--real` runs anywhere) checks its flags, its refusals, its ownership check and its dry run.

1. **Dry run (any host).** `bun scripts/restart-leg.ts --root /dev/shm --dry-run` prints every command and step the run takes, with `<…>` for what only a run reads. Exit 0.
2. **The Linux leg (the workbox).** From the dotfiles checkout's `opencode/`, with `~/.bun/bin` and `~/.local/bin` on PATH: `nice -n 10 bun scripts/restart-leg.ts --root /dev/shm --expect no-wake` (`--expect wake` once the fork's restart wake is installed). It prints a JSON line per systemd view (`"case":"b"`) and per case (`"case":"a"`, `"c"`, `"d"` with `"pass":true` and the `behaviour`), then `restart-leg: PASS …`. Exit 0 pass, 1 a case failed, 2 refused, 3 the live service or install changed.
3. **The Mac smoke.** `bun scripts/restart-leg.ts --root <scratch> --no-systemd --cases a,c` runs cases a and c on the Mac's installed build, with no launcher scopes, placement or systemd view.

## Gotchas

- The leg runs the installed build as a clone in its run dir: started by its own path, a build binds the plugin tree beside it over the scratch config.
- It loads the update plugin alone, every option in the run dir (its check fails at its first step, a `git fetch` in a checkout that does not exist); never the wake plugin or another that registers OS jobs.
- Its cleanup stops only pids and units it recorded whose processes carry the run dir, and removes only `<root>/restart-leg-<id>`; a live service pid, scope, tree pointer or launcher that changed, or a line of the run in the live update log, is exit 3.
- Under load (the workbox at 60 to 100) each wait is up to `--wait-ms` (default 300000); a full run takes several minutes.
