# Source playbooks

The why skill runs one investigation per available evidence category, each reading a single source-specific playbook below. Adapt a playbook for a different tool in the same category.

| Category | Playbook | Where it reads |
|---|---|---|
| Source control history | [`code-archaeology.md`](./sources/code-archaeology.md) | git, `gh` |
| Issue / ticket tracker | [`linear.md`](./sources/linear.md) | Linear through the `linear` skill (Bite); adapt for GitHub Issues through `gh` (personal repos) |
| Agent sessions | [`sessions.md`](./sources/sessions.md) | Claude Code and Codex transcripts, Counsel exchanges, `devsql` |
| Long-form documents | none | the repo's `NORTH_STAR.md`, `PRIOR_ART.md`, ADRs and `plans/`; Claude Docs when connected |
| Error / exception tracking | [`sentry.md`](./sources/sentry.md) | Sentry (adapt for Rollbar, Bugsnag, Airbrake) |

Cross-cutting:

- [`incident-postmortem.md`](./sources/incident-postmortem.md). Add this if the target code looks defensive (null checks, retry, timeout, rate limit, feature flag, egress guard, OOM handler).
