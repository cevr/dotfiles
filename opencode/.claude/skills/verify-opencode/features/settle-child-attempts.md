# Child lifecycle

A parent can distinguish a kept latch, a running child, a child with live background work, recovery, a confirmed end and unavailable current evidence. The child's last message and any report are still readable; neither settles the child. A shell exit can wake the same child after an error without the parent starting another. The observer never starts a child or sends a notice.

## Sub-features

- `child-observation`: direct `subagents` listing and reads return `observation` alongside the old `state`.
- `child-observation-handle`: `.read()` and `.refresh()` replace a handle's view together; an older reply cannot undo a newer observation.
- `child-observation-row`: a notice can supply diagnostic text without giving a historical row a terminal badge.

## How to get to it (user POV)

- Call `subagents` with `{ action: "list" }` or `{ action: "get", sessionID }`. The caller reaches only its own children.
- A kernel cell reads the live result of `tools.subagent(...)`, or uses `await tools.subagent.handle(sessionID)` to rebuild it after restart.
- Open Prime's Subagents panel or read its dock: a child waiting after a step error is still waiting.

## Driving it with the world

- **Preconditions:** the kernel plugin loaded with `codeOnly: false`; an owned child; a scripted lifecycle stream.
- **States:** default (running and settled); loading (unknown while evidence is missing); error (running error diagnostic, quota settlement); refused (another family's child); open and empty are `n/a`.
- **World suites:** `cmd/kernel/settle-child-attempts.sim.test.ts`
- **Code:** `mods/kernel/child-lifecycle.ts`, `mods/kernel/child-lifecycle.qnt`, `mods/kernel/child-lifecycle.test.ts`, `mods/kernel/subagents.ts`, `mods/kernel/subagents.test.ts`, `mods/kernel/opencode/child-lifecycle.ts`, `mods/kernel/opencode/subagents.ts`, `mods/kernel/opencode/subagents.test.ts`, `mods/kernel/worker/subagent-handle.ts`, `mods/kernel/worker/subagent-handle.test.ts`, `mods/kernel/tools.ts`, `cmd/kernel/server.ts`, `cmd/kernel/server.test.ts`, `cmd/kernel/settle-child-attempts.sim.test.ts`, `mods/subagents/family.ts`, `mods/subagents/subagent-row.ts`, `mods/subagents/subagent-row.test.ts`, `mods/subagents/opencode/view.ts`, `mods/subagents/opencode/view.test.ts`, `tests/settle-child-attempts.test.ts`

1. **Read a held child.** Call `subagents` with `{ "action": "get", "sessionID": "<child>" }`: a kept pace latch shows its recheck time. `{ "action": "stop", "sessionID": "<child>" }` leaves the latch to Wake. After it opens, the same child is `running`.
2. **Read during diagnostics.** The same call distinguishes a scheduled host retry, a step error and shutdown recovery. A quota failure that really ended an execution is `settled: failed`, not a latch. When a shell keeps running after an error, the child is `continuing`; it can start again without a new launch.
3. **Read after settlement and reload.** A stale or wrong-location failure cannot displace newer success. An unavailable replay cannot prove that the old terminal is current. Reads send no reports or new prompts.

## Driving it with real OpenCode

- **Real:** `tests/settle-child-attempts.test.ts`

1. **Start and read.** `bun test tests/settle-child-attempts.test.ts` runs the kernel and its direct tool on the pinned fork, with an owned scratch process and loopback scripted model. Start a child in a cell; while its shell is held, read it after the scripted step error.
2. **Release and rebuild.** Open the shell's gate; the same child restarts without a new launch. Read its settled observation from a rebuilt handle and compare the direct read with the row and native notices.
3. **Restart.** Commit another execution on the same child while the observer is absent, then reopen against the same scratch store. The handle can say the coarse outcome without treating the previous receipt as current.

## Gotchas

- `state` remains the compatibility enum. Use `observation` for the distinction between unknown, latched, continuing and settled.
- A host execution point identifies a busy period, not a review assignment or a verifier verdict. A coarse outcome without that point is not an ordered receipt.
- Use `wake_cancel` for a held start; `subagents` does not own the latch. A stop handles local owned work, not a remote process that survives its local command.
