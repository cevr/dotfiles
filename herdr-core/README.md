# herdr-core

The move from herdr to herdr-core (`hc`). [RUNBOOK.md](RUNBOOK.md) is the order for the window; `cutover.ts` is its script:

- `bun herdr-core/cutover.ts pre`: read-only checks, `hcm plan` and a copy of the snapshot saved, the pane table.
- `bun herdr-core/cutover.ts labels --snapshot <saved> [--save <pane-restore file>]`: after `hcm apply`, with herdr stopped, it labels each OpenCode pane's new shell `migrate.resume=opencode -s <id>`, using the tab key hcm leaves (`migrate.from`). It also sets `project=<workspace name>` and `hc keep`.
- `bun herdr-core/cutover.ts resume`: removes any label whose terminal is no longer a fresh shell, then runs `hcm resume`, which types each label once.
- `bun herdr-core/cutover.ts verify --snapshot <saved>`: read-only; checks one terminal per tab, no label left, a status from each resumed terminal, and no session open twice.

Tests: `bun test --parallel=1 herdr-core/cutover.test.ts` runs a model-based test, a generated property and a drive against a scratch hc core. The drive is skipped when `hc` or `hcm` is missing. Typecheck: `opencode/node_modules/.bin/tsc -p herdr-core`.
