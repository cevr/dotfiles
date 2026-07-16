---
name: linear
description: Interact with Linear issues, comments, projects, teams, and GraphQL from the command line. Use for ticket context, bulk issue reads, starting work, or explicitly requested Linear mutations.
allowed-tools: [Bash]
---

# Linear CLI

Use the `linear` CLI for Linear work. It owns authentication, stable JSON output, issue URL normalization, and actionable exit codes.

## Agent rules

1. Use typed commands before raw GraphQL.
2. Add `--json` to reads and parse the complete response. Do not truncate with `head` or `tail`.
3. Never read `~/.config/linear/token` directly and never put the token in `curl`, Python, logs, or shell history.
4. Treat issue identifiers and Linear issue URLs as equivalent inputs.
5. Do not mutate Linear unless the user explicitly requested the mutation.
6. For supported mutations, run `--dry-run` first, validate the result, then run the same command without `--dry-run`.
7. Use `linear api graphql` only when no typed command can express the operation. For GraphQL mutations, the user's request itself must explicitly authorize the write and the command must include `--allow-mutation`.
8. Trust exit codes: nonzero means the operation failed. Do not infer success from partial stdout.
9. Prompts are opt-in. Pass `--interactive` only when a human is present; otherwise provide every required input.
10. Keep `--query-file` inside the current workspace. The CLI rejects traversal and symlinks that escape it.

If `/linear` is invoked without an issue or task, run `linear issue list --json` and summarize the available work.

## Common reads

```bash
linear auth whoami --json
linear issue list --json
linear issue list --state started --limit 10 --json
linear team list --json
linear project list --json
```

### Read one or many issues

```bash
linear issue view BITE-123 --json
linear issue view https://linear.app/acme/issue/BITE-123/slug --json
linear issue view BITE-123 BITE-124 BITE-125 --json
```

`issue view --json` always returns an array, including for one issue. Each item includes its ID, identifier, title, description, URL, branch name, priority, state, team, assignee, project, parent, and labels.

Request potentially larger relationships only when needed:

```bash
linear issue view BITE-123 --children --json
linear issue view BITE-123 --comments --json
linear issue view BITE-123 --relations --json
linear issue view BITE-123 --children --comments --relations --json
```

Use the returned `branchName`; do not invent a branch name from the title.

## Mutations

### Start work

```bash
linear issue start BITE-123 --dry-run
linear issue start BITE-123 --json
```

The dry run resolves the issue and target state without updating Linear. The real command moves the issue to the team's started state and returns the Linear branch name. It does not create or check out a Git branch.

### Create an issue

Interactive:

```bash
linear issue create --interactive
```

Non-interactive agent flow:

```bash
linear issue create \
  --team BITE \
  --title "Concise title" \
  --description "Markdown description" \
  --parent BITE-100 \
  --project "Tech Debt" \
  --priority 3 \
  --dry-run

linear issue create \
  --team BITE \
  --title "Concise title" \
  --description "Markdown description" \
  --parent BITE-100 \
  --project "Tech Debt" \
  --priority 3 \
  --json
```

`--team` accepts a team key or UUID. `--project` accepts a project name, slug, or UUID. `--parent` accepts an issue identifier or UUID. Priority is `0` through `4`.

### Add a comment

```bash
linear issue comment BITE-123 --body "Markdown comment" --dry-run
linear issue comment BITE-123 --body "Markdown comment" --json
```

Comments are external messages. Only send one when the user explicitly requested it.

## GraphQL escape hatch

Use this only when typed commands cannot express the operation:

```bash
linear api graphql \
  --query 'query Issue($id: String!) { issue(id: $id) { id identifier title } }' \
  --variables '{"id":"BITE-123"}'
```

For multiline documents, keep the query in a file:

```bash
linear api graphql --query-file .linear/issue-query.graphql --variables '{"id":"BITE-123"}'
```

The query file must resolve inside the current workspace. The command uses the configured credential and emits only the GraphQL `data` object as JSON. Keep variables separate from the query. Prefer one bulk GraphQL operation over shell loops when migrating a large issue tree.

Raw GraphQL mutations are rejected unless `--allow-mutation` is present. Add that flag only after verifying that the user explicitly authorized the write and inspecting the complete mutation document and variables.

## Authentication and configuration

```bash
linear auth
linear auth whoami --json
```

Token resolution order:

1. `~/.config/linear/token`
2. `LINEAR_API_KEY`
3. Actionable authentication error

Project defaults live in `.linear.toml`:

```toml
team_id = "BITE"
```
