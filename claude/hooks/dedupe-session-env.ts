#!/usr/bin/env bun
// SessionStart: keep each session's env files to one export per name.
// The Codex plugin's SessionStart hook appends its exports on every start,
// resume and compaction (openai/codex-plugin-cc#661). Claude Code puts the env
// file on every Bash command line, so after a few hundred starts each Bash call
// fails with E2BIG. The last export of a name is the one in force, so it stays.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EXPORT = /^export ([A-Za-z_][A-Za-z0-9_]*)=/;

export function dedupe(text: string): string | undefined {
  const lines = text.split('\n').filter(Boolean);
  const names = lines.map((line) => line.match(EXPORT)?.[1]);
  if (names.some((name) => name === undefined)) return undefined;
  const kept = lines.filter((_, i) => names.lastIndexOf(names[i]) === i);
  return kept.length < lines.length ? kept.join('\n') + '\n' : undefined;
}

if (import.meta.main) {
  const input: { session_id?: string } = JSON.parse((await Bun.stdin.text()) || '{}');
  const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const dir = join(config, 'session-env', input.session_id ?? '');
  if (input.session_id && existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const kept = dedupe(readFileSync(file, 'utf8'));
      if (kept !== undefined) writeFileSync(file, kept);
    }
  }
}
