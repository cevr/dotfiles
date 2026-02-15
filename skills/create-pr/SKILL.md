---
name: create-pr
description: Commit, push, and create a PR with a focused summary.
user-invocable: true
---

# Create PR

Commit all changes, push to remote, and create a pull request.

## Steps

1. Run `git status` to see changes
2. Run `git diff` to understand what changed
3. Run `git log` to see commit message style
4. Stage and commit changes with a concise message
5. Push branch to remote with `-u` flag
6. Create PR using `gh pr create`

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
