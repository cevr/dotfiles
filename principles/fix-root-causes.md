# Fix Root Causes

When debugging, fix the fault, not the place where it surfaced. The symptom is where a wrong state became visible. The root cause is the first place the system did something it should not do, or failed to handle a state it should handle.

**Why:** A symptom fix hides the evidence and leaves the fault free to surface somewhere else. Each one makes the system harder to reason about, because the code now carries a workaround for a bug nobody named.

**Pattern:**

- Reproduce first (if you can't reproduce it, you can't verify your fix).
- Ask "why" at each step until the answer is a wrong decision in the code, not a consequence of an earlier one.
- When stuck, instrument: read the actual error and the actual state.
- **Ask whether the triggering state is legitimate.** If the system may be in that state, the code that broke on it is the root cause, and handling the state there is the fix. If the state should never exist, a check where it broke hides the bug: find what produced the state. Guards, retries, swallowed errors, clamped values and discarded state are the usual hiding places.
- Check for the pattern, not just the instance: find every place with the same fault and fix them all.
- A workaround that needs a paragraph-long comment to justify it means the code is wrong. Fix the code.
- When the deciding fact took a deep dig to find, propose the cheap, always-on signal that would have shown it at first look.

**Restart Bugs: Suspect State Before Code**
Code doesn't change between runs. State does. When "fails after restart," suspect stale persistent state first — config files, caches, lock files, serialized state. If clearing a state file restores behavior, prioritize state validation as the fix.

**See also:** [[chase-y-not-x]] — the requirements-side analogue: interrogate the framing of an incoming request before building, not just the framing of a bug before fixing.
