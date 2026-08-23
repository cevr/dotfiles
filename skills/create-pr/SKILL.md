---
name: create-pr
description: Commit, push, and create a pull request with a focused summary, visual evidence, and call-flow review guides.
user-invocable: true
---

# Create PR

Commit the task changes, push the branch, and create a pull request.

## Navigation

```text
Create the pull request
├─ Inspect and publish the branch       → Steps
├─ Explain runtime flow                 → Call-flow evidence
├─ Show a user-visible change           → Visual evidence
└─ Confirm the remote result            → Final verification
```

## Steps

1. Confirm the repository, worktree, branch, HEAD SHA, and remote.
2. Run `git status` and preserve unrelated user changes.
3. Run `git diff` to understand the task changes.
4. Run `git log` to see the commit message style.
5. Run the repository quality gate.
6. Stage only the task changes.
7. Commit with a concise Conventional Commit message.
8. Push the branch to the remote with `-u`.
9. Create the pull request with `gh pr create`.
10. Add call-flow evidence when the change affects runtime flow.
11. Add visual evidence when the change affects a visible interface.
12. Apply each requested person to each requested assignee and reviewer role.

## PR Body Format

```
## Problem / Intent

[Why this change exists - the problem being solved or feature being added]

## Approach

[High-level concept of the solution - not a list of file changes]
```

## Rules

- PR title should be succinct (no "feat:" prefix, but "fix:" is ok for bug fixes)
- Do NOT include a summary of code changes or files modified
- Do NOT include a test plan with checkboxes
- Do NOT include "Generated with Claude Code" or similar footers
- Keep the PR description concise and focused on intent and approach
- Use HEREDOC for the PR body to preserve formatting

## Call-flow Evidence

Add numbered inline review-guide comments at key changed lines. State the local callgraph change in each comment.

### Function and component callgraphs

1. Read the PR base SHA and head SHA from GitHub.
2. Fetch the base SHA when a shallow worktree does not contain it.
3. Run a focused callgraph diff for each important entry point.

```bash
bunx https://github.com/tanishqkancharla/calldiff diff <base-sha> <head-sha> \
  --entry <entry-point> --max-depth 3 -- <changed-paths>
```

If the GitHub package has no built executable, use `bunx calldiff@latest`. Verify that its version matches the inspected GitHub source.

Keep the useful `+` and `-` lines. Remove unrelated expansion. Put the reduced ASCII diff in the inline comment.

### XState machines

`calldiff` does not describe declarative machine configuration. Read the exact machine diff. Add a small ASCII transition diff next to the changed state or event.

```diff
  ExistingState
+ └─ NewEvent(payload)
+    ├─ assign context.value
+    └─ NewState
+       ├─ Done
+       │  └─ ExistingState
+       └─ Quit
+          └─ Resetting
```

Show new and removed states, events, guards, actions, and context assignments. Use `+` and `-` markers. Do not invent paths that the machine does not contain.

Skip call-flow evidence for text-only or configuration-only changes with no meaningful runtime path.

## Visual Evidence

For each user-visible change:

1. Run the changed interface in a representative state.
2. Capture at least one clear screenshot for each distinct changed state.
3. Use before-and-after images when the old state gives useful context.
4. Reuse screenshots already produced during implementation when they show the final code.
5. Upload images to a stable location that pull request viewers can access.
6. Embed the images in the PR body below the approach.
7. Verify that every image renders from the live PR body.

Do not use a local or temporary file path in the PR body. Do not add screenshots to the product branch unless the repository has that convention. Use a dedicated PR asset branch when GitHub attachment upload is not available. Keep asset files out of the product diff.

Skip visual evidence when the change has no visible output.

## Final Verification

After all external changes:

1. Re-read the live PR body.
2. Verify each image URL and rendered image.
3. Verify assignees and requested reviewers.
4. Verify numbered review-guide comments.
5. Verify the local SHA, remote SHA, and PR head SHA.
6. Treat automation commits as remote changes. Inspect them before a fast-forward.
7. Report pending CI as pending. Do not call the PR green from partial evidence.
