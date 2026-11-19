---
name: principle-prove-it-works
description: "Apply before calling any task done: check the real thing directly (run it, read the actual value, inspect the diff), not a proxy or a self-report."
disable-model-invocation: true
---

# Prove It Works

Verify every output by checking the real thing directly: run the feature, read the actual value, inspect the diff. Proxies (file mtimes, self-reports, cached output, "it compiles") do not count. When a check fails, suspect the observation method before the system.

Script the check when you can. A deterministic script that reruns the comparison beats a one-time look. Keep its output where the human can see it, and commit it only when the trail must be auditable later.

Code / Features:

1. Build it (necessary but not sufficient)
2. Run it and exercise the actual feature path
3. Check the full chain: does data flow from input to output?
4. For integrations, test the full communication path end-to-end

Delegation: trust artifacts, not self-reports:
When verifying delegated work, inspect the actual output artifact (git diff, file contents, runtime behavior) — never the delegate's summary. Agents report what they intended, not always what happened.

Cross-session artifacts: verify before ending:
Files written during a session can fail to persist (interrupted writes, path errors, tool failures). If an artifact is needed in a future session, verify it exists (`ls` or `Read`) before closing. Unverified writes are lost work.

API Research: trust source over docs/agents:
When migrating between library versions, grep the actual source (via `repo-explorer`) rather than relying on docs or research agent summaries. Docs lag releases; agent output can be wrong on 2/5 API changes. Read the types directly.

**See also:** [test-through-public-interfaces](../principle-test-through-public-interfaces/SKILL.md) — *how* to verify: through the caller's surface, not internal inspection. This principle says verify; that one says verify from the outside in.
