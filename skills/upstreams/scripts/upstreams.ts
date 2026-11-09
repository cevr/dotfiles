#!/usr/bin/env bun
// Tracks the outside skills we folded into our own. A repo source in
// upstreams.json records the upstream commit we last read; a URL source (a
// paste, a page) records the sha256 of the content we last read. `scan` lists
// what changed upstream since then, `diff` shows it, and `mark` records a
// reviewed head. `scan` also lists okra-managed skills an update would change,
// and managed skills with local edits, which okra's update skips (`modified`).
//
// Usage: bun upstreams.ts scan [--json] [--notify]
//        bun upstreams.ts diff <name> [--stat]
//        bun upstreams.ts mark <name...|--all> [--before YYYY-MM-DD]
//   --notify   write the digest to ~/.cache/upstreams/digest.md and post a
//              macOS notification when any source moved (the weekly job)
//   --before   record the last upstream commit before a date (a new repo source's baseline)

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Common = { name: string; into: string[]; license: string };
export type RepoSource = Common & { repo: string; paths: string[]; folded: { sha: string; date: string } };
export type UrlSource = Common & { url: string; folded: { hash: string; date: string } };
export type Source = RepoSource | UrlSource;
// `head` is the upstream commit, or the content hash for a URL source.
export type Change = { source: Source; head: string; commits: string[]; stat: string };

const registryPath = join(import.meta.dir, '..', 'upstreams.json');
const skillsDir = join(import.meta.dir, '..', '..');
const cacheDir = join(homedir(), '.cache', 'upstreams');

const isUrl = (s: Source): s is UrlSource => 'url' in s;
const origin = (s: Source) => (isUrl(s) ? s.url : s.repo);
const baseline = (s: Source) => (isUrl(s) ? s.folded.hash : s.folded.sha);
const today = () => new Date().toISOString().slice(0, 10);

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

// A URL source moved when the content's hash differs from the one we read.
export function urlChange(source: UrlSource, content: string): Change {
  const head = sha256(content);
  const moved = head !== source.folded.hash;
  return {
    source,
    head,
    commits: moved ? [`content changed since ${source.folded.date}`] : [],
    stat: moved ? `${content.length} bytes now` : '',
  };
}

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

async function download(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

// The copy of a URL source's content as last marked, which `diff` compares against.
const snapshotPath = (s: UrlSource) => join(cacheDir, 'url', `${s.name}.txt`);

async function changeOf(source: Source): Promise<Change> {
  if (isUrl(source)) return urlChange(source, await download(source.url));
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

export function digest(changes: Change[], m: Managed): string {
  const moved = changes.filter((c) => c.commits.length);
  const lines = [`# Upstream skills, ${today()}`, ''];
  lines.push(`## Folded sources: ${moved.length} of ${changes.length} moved`, '');
  for (const c of moved) {
    const s = c.source;
    lines.push(`### ${s.name} (${origin(s)}, ${s.license}) → ${s.into.join(', ')}`);
    const count = isUrl(s) ? '' : `${c.commits.length} commits; `;
    lines.push(`${baseline(s).slice(0, 7)}..${c.head.slice(0, 7)}: ${count}${c.stat}`);
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

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string) => rest.includes(name);
  const option = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  if (command === 'scan') {
    const changes = await Promise.all(load().map(changeOf));
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
        mkdirSync(cacheDir, { recursive: true });
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
    const args = flag('--stat') ? ['--stat'] : [];
    if (isUrl(source)) {
      const content = await download(source.url);
      const snapshot = snapshotPath(source);
      if (!existsSync(snapshot)) {
        console.log(`(no snapshot from the last mark at ${snapshot}; the current content follows)\n`);
        console.log(content);
        return;
      }
      const current = join(cacheDir, 'url', `${source.name}.current.txt`);
      writeFileSync(current, content);
      // --no-index exits 1 when the files differ, so read stdout rather than the status.
      const out = spawnSync('git', ['diff', '--no-index', ...args, snapshot, current], { encoding: 'utf8' });
      console.log(out.stdout);
      return;
    }
    const dir = sync(source.repo);
    console.log(git(dir, 'diff', ...args, source.folded.sha, fetched.get(source.repo)!, '--', ...source.paths));
  } else if (command === 'mark') {
    const sources = load();
    const before = option('--before');
    const names = rest.filter((a) => !a.startsWith('--') && a !== before);
    const targets = flag('--all') ? sources : sources.filter((s) => names.includes(s.name));
    if (!targets.length) throw new Error('name one or more sources, or pass --all');
    for (const source of targets) {
      if (isUrl(source)) {
        if (before) throw new Error(`${source.name}: --before needs a repo source`);
        const content = await download(source.url);
        mkdirSync(join(cacheDir, 'url'), { recursive: true });
        writeFileSync(snapshotPath(source), content);
        source.folded = { hash: sha256(content), date: today() };
        console.log(`${source.name}: ${source.folded.hash.slice(0, 7)} (${source.folded.date})`);
        continue;
      }
      const dir = sync(source.repo);
      const sha = before
        ? git(dir, 'rev-list', '-1', `--before=${before}`, 'origin/HEAD')
        : fetched.get(source.repo)!;
      source.folded = { sha, date: before ?? today() };
      console.log(`${source.name}: ${sha.slice(0, 7)} (${source.folded.date})`);
    }
    save(sources);
  } else {
    console.error('usage: upstreams.ts scan [--json] [--notify] | diff <name> [--stat] | mark <name...|--all> [--before YYYY-MM-DD]');
    process.exit(2);
  }
}

if (import.meta.main) await main();
