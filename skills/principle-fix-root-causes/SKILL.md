---
name: principle-fix-root-causes
description: "Apply when debugging or fixing a bug: fix the first place the system went wrong, not where the symptom surfaced, and every place with the same fault."
disable-model-invocation: true
---

# Fix Root Causes

Fix the fault, not the place where it surfaced. The root cause is the first place the system did something it should not do, or failed to handle a state it should handle.

- Reproduce first: if you can't reproduce it, you can't verify the fix. Ask "why" until the answer is a wrong decision in the code. When stuck, instrument and read the actual state.
- Ask whether the state that triggered the symptom is legitimate. If it is, handle it where the code broke. If it should never exist, a check there hides the bug, so find what produced it. Guards, retries, swallowed errors, clamped values, and discarded state are the usual ways to hide a bug.
- Fix the pattern, not the instance. Find every place with the same fault.
- If the deciding fact took a deep dig, propose the cheap, always-on signal that would have shown it at first look.
- **Restart bugs: suspect state before code.** Code doesn't change between runs; state does. When something fails only after a restart, suspect stale persistent state first (config files, caches, lock files, serialized state). If clearing a state file restores behavior, validating that state is the fix.

**See also:** [chase-y-not-x](../principle-chase-y-not-x/SKILL.md) — the requirements-side analogue: interrogate the framing of an incoming request before building, not just the framing of a bug before fixing.
