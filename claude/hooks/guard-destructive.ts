#!/usr/bin/env bun
// PreToolUse(Bash): refuse the few shell commands that lose work for good.
// rm -rf on home, root or a repository's root; git reset --hard; git clean -f
// with -d or -x. Force-push stays allowed (owner, 2026-10-13). Everything
// else passes through untouched.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

type Input = { tool_input?: { command?: string }; cwd?: string };

const input: Input = JSON.parse((await Bun.stdin.text()) || '{}');
const command = input.tool_input?.command ?? '';
const cwd = input.cwd ?? process.cwd();
const home = homedir();

const deny = (reason: string) => {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `guard-destructive: ${reason}.`,
      },
    }),
  );
  process.exit(0);
};

// Split on command separators so `cd x && rm -rf .` is read per command.
const commands = command.split(/&&|\|\||;|\||\n/).map((c) => c.trim());

const words = (c: string) =>
  [...c.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');

const expand = (p: string) =>
  p
    .replace(/^~(?=\/|$)/, home)
    .replace(/^\$\{?HOME\}?(?=\/|$)/, home)
    .replace(/\/+$/, '') || '/';

const isRepoRoot = (p: string) => existsSync(resolve(p, '.git'));

for (const c of commands) {
  const w = words(c).filter((x) => x !== 'sudo' && x !== 'command');
  const head = w[0]?.split('/').pop();

  if (head === 'rm') {
    const flags = w.slice(1).filter((x) => x.startsWith('-'));
    const recursive = flags.some((f) => f === '--recursive' || (/^-[^-]/.test(f) && /[rR]/.test(f)));
    const force = flags.some((f) => f === '--force' || (/^-[^-]/.test(f) && f.includes('f')));
    if (!(recursive && force)) continue;
    for (const target of w.slice(1).filter((x) => !x.startsWith('-'))) {
      const path = resolve(cwd, expand(target));
      if (path === '/' || path === home || target === '*' || target === '/*' || target === '~/*') {
        deny(`\`${c}\` would delete ${path === '/' ? 'the root' : 'your home'}; use \`trash\` on a narrower path`);
      }
      if (isRepoRoot(path)) deny(`\`${c}\` would delete the repository at ${path}; use \`trash\` if you mean it`);
    }
  }

  if (head === 'git') {
    const args = w.slice(1);
    if (args[0] === 'reset' && args.includes('--hard')) {
      deny(`\`${c}\` discards uncommitted work; stash it (\`git stash -u\`) or commit first`);
    }
    if (args[0] === 'clean') {
      const short = args.filter((a) => /^-[^-]/.test(a)).join('');
      const forced = short.includes('f') || args.includes('--force');
      const wide = short.includes('d') || short.includes('x') || short.includes('X');
      const dry = short.includes('n') || args.includes('--dry-run');
      if (forced && wide && !dry) deny(`\`${c}\` deletes untracked files for good; run it with -n first and trash what you mean to remove`);
    }
  }
}
