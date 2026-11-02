#!/usr/bin/env bun
// Tracks the outside skills we folded into our own. Each source in
// upstreams.json records the upstream commit we last read; `scan` lists what
// changed upstream since then, `diff` shows it, and `mark` records a reviewed
// head. `scan` also lists okra-managed skills an update would change, and
// managed skills with local edits, which okra's update skips (`modified`).
//
// Usage: bun upstreams.ts scan [--json] [--notify]
//        bun upstreams.ts diff <name> [--stat]
//        bun upstreams.ts mark <name...|--all> [--before YYYY-MM-DD]
//   --notify   write the digest to ~/.cache/upstreams/digest.md and post a
//              macOS notification when any source moved (the weekly job)
//   --before   record the last upstream commit before a date (a new source's baseline)

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Source = {
  name: string;
  repo: string;
  paths: string[];
  into: string[];
  license: string;
  folded: { sha: string; date: string };
};
type Change = { source: Source; head: string; commits: string[]; stat: string };

const registryPath = join(import.meta.dir, '..', 'upstreams.json');
const skillsDir = join(import.meta.dir, '..', '..');
const cacheDir = join(homedir(), '.cache', 'upstreams');

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 256 << 20 }).trim();

const load = (): Source[] => JSON.parse(readFileSync(registryPath, 'utf8'));
const save = (sources: Source[]) => writeFileSync(registryPath, JSON.stringify(sources, null, 2) + '\n');

const fetched = new Map<string, string>();
// Blobless clone per repo, fetched once per run; returns the clone's directory.
function sync(repo: string): string {
  const dir = join(cacheDir, repo.replace('/', '__'));
  if (fetched.has(repo)) return dir;
  if (!existsSync(dir)) {
    mkdirSync(cacheDir, { recursive: true });
    execFileSync('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', `https://github.com/${repo}`, dir]);
  } else {
    git(dir, 'fetch', '-q', '--prune', 'origin');
    git(dir, 'remote', 'set-head', 'origin', '--auto');
  }
  fetched.set(repo, git(dir, 'rev-parse', 'origin/HEAD'));
  return dir;
}

function changeOf(source: Source): Change {
  const dir = sync(source.repo);
  const head = fetched.get(source.repo)!;
  const range = `${source.folded.sha}..${head}`;
  const commits = git(dir, 'log', '--format=%h %ad %s', '--date=short', range, '--', ...source.paths)
    .split('\n')
    .filter(Boolean);
  const stat = commits.length ? git(dir, 'diff', '--shortstat', source.folded.sha, head, '--', ...source.paths) : '';
  return { source, head, commits, stat };
}

type Managed = { outdated: string[]; modified: string[] };
// okra-managed skills: what an update would change, and what it skips for local edits.
function managed(): Managed {
  let outdated: string[] = [];
  let modified: string[] = [];
  try {
    const out = execFileSync('okra', ['skills', 'update', '--dry-run', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, SKILLS_DIR: skillsDir },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const report = JSON.parse(out);
    outdated = report.outdated.map((o: { name: string }) => o.name);
    modified = report.modified.map((o: { name: string }) => o.name);
  } catch {
    outdated = ['(okra skills update --dry-run failed)'];
  }
  return { outdated, modified };
}

function digest(changes: Change[], m: Managed): string {
  const moved = changes.filter((c) => c.commits.length);
  const lines = [`# Upstream skills, ${new Date().toISOString().slice(0, 10)}`, ''];
  lines.push(`## Folded sources: ${moved.length} of ${changes.length} moved`, '');
  for (const c of moved) {
    const s = c.source;
    lines.push(`### ${s.name} (${s.repo}, ${s.license}) → ${s.into.join(', ')}`);
    lines.push(`${s.folded.sha.slice(0, 7)}..${c.head.slice(0, 7)}: ${c.commits.length} commits; ${c.stat}`);
    for (const commit of c.commits.slice(0, 15)) lines.push(`- ${commit}`);
    if (c.commits.length > 15) lines.push(`- … ${c.commits.length - 15} more`);
    lines.push('');
  }
  const still = changes.filter((c) => !c.commits.length).map((c) => c.source.name);
  if (still.length) lines.push(`Unchanged: ${still.join(', ')}`, '');
  lines.push('## okra-managed skills', '');
  lines.push(`Outdated: ${m.outdated.length ? m.outdated.join(', ') : 'none'}`);
  lines.push(`Modified locally (update skips them): ${m.modified.length ? m.modified.join(', ') : 'none'}`);
  return lines.join('\n') + '\n';
}

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(name);
const option = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

if (command === 'scan') {
  const changes = load().map(changeOf);
  const m = managed();
  if (flag('--json')) {
    console.log(
      JSON.stringify(
        {
          sources: changes.map((c) => ({ name: c.source.name, head: c.head, commits: c.commits, stat: c.stat })),
          managed: m,
        },
        null,
        2,
      ),
    );
  } else {
    const text = digest(changes, m);
    console.log(text);
    if (flag('--notify')) {
      writeFileSync(join(cacheDir, 'digest.md'), text);
      const moved = changes.filter((c) => c.commits.length).length;
      const pending = moved + m.outdated.length + m.modified.length;
      if (pending > 0) {
        const message = `${moved} folded sources moved, ${m.outdated.length} managed skills outdated. Run /upstreams.`;
        execFileSync('osascript', ['-e', `display notification "${message}" with title "Upstream skills"`]);
      }
    }
  }
} else if (command === 'diff') {
  const name = rest.find((a) => !a.startsWith('--'));
  const source = load().find((s) => s.name === name);
  if (!source) throw new Error(`no source named ${name}`);
  const dir = sync(source.repo);
  const args = flag('--stat') ? ['--stat'] : [];
  console.log(git(dir, 'diff', ...args, source.folded.sha, fetched.get(source.repo)!, '--', ...source.paths));
} else if (command === 'mark') {
  const sources = load();
  const before = option('--before');
  const names = rest.filter((a) => !a.startsWith('--') && a !== before);
  const targets = flag('--all') ? sources : sources.filter((s) => names.includes(s.name));
  if (!targets.length) throw new Error('name one or more sources, or pass --all');
  for (const source of targets) {
    const dir = sync(source.repo);
    const sha = before
      ? git(dir, 'rev-list', '-1', `--before=${before}`, 'origin/HEAD')
      : fetched.get(source.repo)!;
    source.folded = { sha, date: before ?? new Date().toISOString().slice(0, 10) };
    console.log(`${source.name}: ${sha.slice(0, 7)} (${source.folded.date})`);
  }
  save(sources);
} else {
  console.error('usage: upstreams.ts scan [--json] [--notify] | diff <name> [--stat] | mark <name...|--all> [--before YYYY-MM-DD]');
  process.exit(2);
}
