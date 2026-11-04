# opencode-gent

Our harness work, ported onto OpenCode 2.x: the Prime Agent look, orchestration, the account pool, the code kernel.

## Layout
- `scenarios/`: opencode-drive scenarios. Each runs OpenCode headless with a scripted model and writes frames (text) and screenshots. They are the deterministic check for every UI or plugin change.
- `themes/`, `plugins/`: what OpenCode loads from us (added as they land).
- The fork lives at `~/Developer/personal/opencode` (remote `cevr/opencode`, upstream `anomalyco/opencode`), branch `prime`, based on the v2.2.5 release commit `4878a0e30f`. Keep the fork's diff small and generic (hook points OpenCode lacks); the look itself belongs here.

## Running a scenario
`OPENCODE_DEV=<opencode checkout or rift> SCENARIO_OUT=out OPENCODE_DRIVE_MEDIA_DIR=$PWD/media bunx opencode-drive run scenarios/<name>.ts`
- Without `OPENCODE_DEV` it drives the installed `opencode2`.
- `SCENARIO_LABEL` names the frame and screenshot; `SCENARIO_THEME` picks the theme; `SCENARIO_DUMP=1` writes each model request as `request-<n>.json`.
- The simulated model is offered `patch`, not `edit`, and `shell`, not `bash`.

## Reference
- Prime Agent (MIT, Rust, ratatui): renders of its current UI and the design notes are the target for the look.
