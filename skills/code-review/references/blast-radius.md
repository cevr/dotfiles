# Blast radius

Find what a change breaks somewhere else, before it ships, and prove the one fact it is safe because of by running real code. Adapted from pstack (`cursor/plugins`, `pstack/skills/blast-radius`), MIT.

Use it for "what could this break", a small diff you do not trust, and as the check of the orchestrate skill's `single fix` mode when the fix is risky. Listing callers is not the job: grep does that in a second. The job is the breakage grep does not show. A writeup that sounds right reads the same whether or not it is true, so hand back proof, not prose.

## How sure you are

For each fact the change's safety rests on, push it as far down this ladder as is cheap, and say where it stopped:

1. You said so. Worth nothing on its own.
2. You pointed at the line: a real `file:line`, or the library's own source.
3. You showed the bad case cannot happen: you walked the failure step by step and it does not reach.
4. You ran it: a script or test that calls the real code and fails loud if you are wrong.
5. You reproduced it in the running app.

Step 4 is usually one small script that imports the library the app ships and calls the exact function in doubt. A fact that stops before step 4 is `unproven`; this is the same ladder as the Safety fact in code-review's Phase 3.

## Steps

1. Read the change: the diff, the symbols it adds, changes and deletes, and what it now does differently, including what the diff does not spell out. The `why` skill pulls the PR and commits.
2. Find the one fact it is safe because of. Most changes that look risky are safe because of a single fact ("this call only drops cache entries that are already dead"). If it holds, most risky cases clear at once. Spend the time here, not on a long list of maybes.
3. Look where grep stops: the source of a library you call, at its pinned version and with any local patch; timing (microtasks, teardown, the order effects run); a wire or stored format (the JSON an API returns, a DB column); another reader of the same bytes, in another language or three hops downstream; a feature flag.
4. Weigh each risk honestly: a real chance and a real cost. Keep the confirmed ones and list the cleared ones apart. Cite a real `file:line`; a search that finds nothing is an answer; never invent a caller or an API.
5. Prove the one fact: write the script or test, run it, and paste what it printed.

A wide or costly change needs adversaries instead: [interrogate.md](interrogate.md).

## Hand back

- **What it does**: what changed, including the part that is not obvious.
- **The one fact**: stated, with the step it reached and its proof, or marked unproven.
- **Risks**: each with how it breaks, the `file:line`, how likely and how bad, and how to check.
- **Cleared**: what you checked and why it is fine.
- **Before you merge**: the cheapest test or repro that catches the real bug, including your script.
