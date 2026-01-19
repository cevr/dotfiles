# PR Creation Skill

Create pull requests with consistent formatting and automatic context extraction.

## Usage

```
/pr                    # Auto-generate title from commits
/pr "feat: add X"      # Specify title directly
```

## Workflow

1. **Extract context from branch**
   - Parse ticket ID from branch name (e.g., `cvr/BITE-1234-foo` → `BITE-1234`)
   - If Linear MCP available: fetch ticket summary

2. **Analyze changes**
   - Get affected packages from diff: `git diff master...HEAD --name-only`
   - Group by package for Changes section

3. **Generate PR body**
   - Use template below
   - Auto-populate from context

4. **Create PR**
   - Push branch if needed: `git push -u origin HEAD`
   - Create via `gh pr create`

## Template

```markdown
## Summary
${ticketSummary || "Brief description of changes"}

## Changes
${affectedPackages.map(pkg => `- **${pkg}**: description`).join('\n')}

## Test Plan
- [ ] Unit tests pass
- [ ] Manual testing
- [ ] E2E tests (if applicable)

---
${ticketId ? `Closes: ${ticketId}` : ''}
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## Implementation

### Step 1: Gather context

```bash
# Get current branch
git branch --show-current

# Get ticket ID from branch (pattern: user/BITE-XXXX-description)
# Extract BITE-XXXX portion

# Get changed files
git diff origin/master...HEAD --name-only

# Get commit history
git log origin/master..HEAD --oneline
```

### Step 2: Fetch Linear ticket (if available)

If Linear MCP is connected and ticket ID found:
- Use `linear issue view BITE-XXXX` to get title/description
- Include in Summary section

### Step 3: Determine affected packages

Parse changed files to identify packages:
- `packages/bureau/*` → bureau
- `packages/vitrine/*` → vitrine
- `packages/cli/*` → cli
- etc.

### Step 4: Generate title

If not provided:
1. Use Linear ticket title if available
2. Otherwise, derive from first commit or branch name
3. Ensure conventional commit format: `type(scope): description`

### Step 5: Create PR

```bash
# Push if needed
git push -u origin HEAD

# Create PR
gh pr create --title "$TITLE" --body "$(cat <<'EOF'
$BODY
EOF
)"
```

## Example Output

For branch `cvr/BITE-1234-add-dark-mode`:

```markdown
## Summary
Add dark mode toggle to user settings panel.

## Changes
- **bureau**: Add theme toggle component and settings page
- **vitrine**: Support dark theme CSS variables

## Test Plan
- [ ] Unit tests pass
- [ ] Manual testing
- [ ] E2E tests (if applicable)

---
Closes: BITE-1234
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## Notes

- Always push branch before creating PR
- Use HEREDOC for body to preserve formatting
- Return PR URL when done
