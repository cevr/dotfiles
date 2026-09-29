#!/usr/bin/env bun
// Claude Code PreToolUse hook: deny Bash commands that skip the git hooks.
// Wire it in .claude/settings.json; see references/agent-fence.md.

const bypasses: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bgit\b[^;&|]*\s--no-verify\b/u, "--no-verify"],
  [/\bgit\b[^;&|]*\bcommit\b[^;&|]*\s-[a-zA-Z]*n[a-zA-Z]*\b/u, "git commit -n"],
  [/\bLEFTHOOK=(?:0|false)\b/u, "LEFTHOOK=0"],
  [/\bLEFTHOOK_EXCLUDE=/u, "LEFTHOOK_EXCLUDE"],
  [/\bcore\.hooksPath\b/u, "core.hooksPath"],
]

const payload = JSON.parse((await Bun.stdin.text()) || "{}")
const command: string = payload?.tool_input?.command ?? ""
const unquoted = command.replace(/"(?:\\.|[^"\\])*"|'[^']*'/gu, "''")
const hit = bypasses.find(([pattern]) => pattern.test(unquoted))

if (hit !== undefined) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Blocked git hook bypass (${hit[1]}). Fix what the hook reports instead of skipping it.`,
      },
    }),
  )
}
