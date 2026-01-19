# CodeRabbit Review Skill

Fetch and address CodeRabbit review feedback on PRs.

## Usage

```
/coderabbit              # Current branch PR
/coderabbit 16908        # Specific PR number
```

## Workflow

### 1. Get PR number

```bash
# From current branch
gh pr view --json number --jq '.number'

# Or use provided PR number
```

### 2. Fetch CodeRabbit comments

```bash
# Get inline review comments
gh api repos/{owner}/{repo}/pulls/{pr}/comments --paginate \
  --jq '.[] | select(.user.login == "coderabbitai[bot]") |
    "FILE: \(.path):\(.line // .original_line // "N/A")\n\(.body)\n---"'

# Get review summary
gh pr view {pr} --json reviews \
  --jq '.reviews[] | select(.author.login == "coderabbitai") | .body'
```

### 3. Parse and categorize

Extract from comments:
- **Critical** (🔴): Security, data loss, breaking changes
- **Major** (🟠): Bugs, logic errors, performance issues
- **Minor** (🟡): Style, naming, minor improvements
- **Nitpick** (🧹): Optional suggestions

### 4. Assess merit

For each issue, determine:
- **Fix**: Valid concern, should address
- **Skip**: Low value, out of scope, or incorrect suggestion
- **Discuss**: Needs clarification or is debatable

### 5. Create action plan

Present findings as a table:

```markdown
| Issue | Severity | Merit | Action |
|-------|----------|-------|--------|
| s3Exists masks auth errors | 🟠 Major | ✓ Fix | Distinguish auth from not-found |
| Layer.effect vs Layer.succeed | 🟡 Minor | Skip | Layer.succeed fine for static impls |
```

### 6. Fix issues with merit

- Address fixes in priority order (Critical → Major → Minor)
- Run typecheck + tests after each fix
- Commit with descriptive message referencing the feedback

### 7. Verify and push

```bash
# Typecheck
pnpm run typecheck

# Tests
pnpm exec vitest run

# Commit and push
git add -A && git commit -m "fix: address CodeRabbit review feedback" && git push
```

## Output Format

```
## CodeRabbit Review: PR #16908

### Summary
- 3 actionable comments
- 5 nitpicks

### Action Plan

| Issue | Severity | File | Action |
|-------|----------|------|--------|
| Silent error swallowing | 🟠 Major | log-manager.ts:254 | Log errors to console |
| Redundant trace parse | 🟡 Minor | profile.ts:338 | Reuse existing events |

### Skipped (low value)
- Layer.effect suggestion - Layer.succeed is fine for static implementations
- lint-fix script inconsistency - out of scope

### Fixes Applied
1. ✅ log-manager.ts: Log file write errors to console
2. ✅ profile.ts: Reuse parsed events variable
```

## Notes

- Always check comment timestamps vs last commit to avoid re-fixing
- CodeRabbit comments include `<!-- fingerprinting:... -->` markers - ignore these
- Focus on actionable feedback, skip nitpicks unless trivial to fix
- Some suggestions may be incorrect - use judgment based on codebase context
