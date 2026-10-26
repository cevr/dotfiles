#!/usr/bin/env bun
// Read-only survey of the disk space a Mac could reclaim: free space, then each
// candidate with its size, idle age, tier, and the command that removes it.
// Nothing is changed. Sizes are `du` allocations: APFS clones (Rifts, bun's
// node_modules, uv environments) count in full, so `df` after a removal is the
// real figure.
//
// Usage: bun survey.ts [--json] [--roots <dir,...>] [--idle-days 30] [--build-days 2]
//                      [--transcript-days 7] [--keep-since YYYY-MM-DD]
//   --roots         code folders to scan for build output, node_modules and worktrees (default ~/Developer)
//   --keep-since    keep agent transcripts from this date on, whatever their age (a pending model eval)

import { existsSync, lstatSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

type Tier = 'A' | 'B' | 'C';
type Item = {
  tier: Tier;
  category: string;
  what: string;
  paths: string[];
  bytes: number;
  idleDays?: number;
  command: string;
  busy?: string;
  note?: string;
};

const HOME = homedir();
const DAY = 86400e3;
const NOW = Date.now();
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1]! : fallback;
};
const ROOTS = flag('--roots', join(HOME, 'Developer')).split(',').map((r) => r.replace(/^~/, HOME));
const IDLE_DAYS = Number(flag('--idle-days', '30'));
const BUILD_DAYS = Number(flag('--build-days', '2'));
const TRANSCRIPT_DAYS = Number(flag('--transcript-days', '7'));
const KEEP_SINCE = Date.parse(flag('--keep-since', '')) || Infinity;
const TRANSCRIPT_CUTOFF = Math.min(NOW - TRANSCRIPT_DAYS * DAY, KEEP_SINCE);

const items: Item[] = [];
// macOS keeps the data volume and /tmp under these names; Linux under / and /tmp.
const DATA = existsSync('/System/Volumes/Data') ? '/System/Volumes/Data' : '/';
const TMP = existsSync('/private/tmp') ? '/private/tmp' : '/tmp';
const home = (p: string) => p.replace(/^~/, HOME);
const tilde = (p: string) => p.replace(HOME, '~');
const exists = (p: string) => existsSync(p);
const sh = (cmd: string[]): string => {
  if (!Bun.which(cmd[0]!)) return '';
  const run = Bun.spawnSync(cmd, { stderr: 'ignore' });
  return run.success ? run.stdout.toString() : '';
};
const du = (paths: string[]): number =>
  paths.length === 0 ? 0 : sh(['du', '-sk', ...paths]).split('\n').reduce((sum, line) => sum + (parseInt(line, 10) || 0) * 1024, 0);
const ls = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

// What is running: its command lines, and the folders processes work in (a dev server, a build).
const PROCESSES = sh(['ps', '-axo', 'args=']).split('\n');
const busyWith = (pattern?: RegExp) => (pattern ? PROCESSES.find((p) => pattern.test(p))?.slice(0, 80) : undefined);
const CWDS = sh(['lsof', '-a', '-d', 'cwd', '-Fn'])
  .split('\n')
  .filter((l) => l.startsWith('n/'))
  .map((l) => l.slice(1));
const inUse = (dir: string) => CWDS.find((cwd) => cwd === dir || cwd.startsWith(dir + sep));

// The newest change under a folder, skipping the heavy folders that change on their own.
const HEAVY = new Set(['node_modules', '.git', '.turbo', '.next', 'dist', 'build', 'target', '.cache', '.alchemy', '.wrangler']);
function newest(dir: string, depth = 4): number {
  let best = 0;
  for (const e of ls(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!HEAVY.has(e.name) && depth > 0) best = Math.max(best, newest(p, depth - 1));
    } else {
      try {
        best = Math.max(best, lstatSync(p).mtimeMs);
      } catch {}
    }
  }
  return best;
}
const idleDays = (ms: number) => Math.max(0, Math.floor((NOW - ms) / DAY));
const touchedWithin = (dir: string, days: number) => sh(['find', dir, '-type', 'f', '-mtime', `-${days}`, '-print', '-quit']).trim() !== '';

const GIB = 1024 ** 3;
function add({ min = 50 * 1024 ** 2, ...item }: Omit<Item, 'bytes'> & { bytes?: number; min?: number }) {
  const paths = item.paths.filter(exists);
  if (paths.length === 0) return;
  const bytes = item.bytes ?? du(paths);
  if (bytes < min) return;
  items.push({ ...item, paths, bytes });
}

// ── Tier A: package and tool caches, by their own clean commands ──
const pnpmStore = sh(['pnpm', 'store', 'path']).trim();
const CACHES: { what: string; paths: string[]; command: string; busy?: RegExp; note?: string }[] = [
  { what: 'Bun install cache', paths: ['~/.bun/install/cache', '~/Library/Caches/bun'], command: 'bun pm cache rm', busy: /\bbun (install|add|i)\b/, note: "node_modules are clones of it: df frees less than du says" },
  { what: 'npm cache', paths: ['~/.npm/_cacache'], command: 'npm cache clean --force', busy: /\bnpm (install|ci|i)\b/ },
  { what: 'pnpm store', paths: [pnpmStore || '~/Library/pnpm/store'], command: 'pnpm store prune', busy: /\bpnpm (install|add|i)\b/, note: 'keep PNPM_HOME: global binaries' },
  { what: 'Yarn cache', paths: ['~/Library/Caches/Yarn', '~/.cache/yarn'], command: 'yarn cache clean' },
  { what: 'uv cache', paths: ['~/.cache/uv'], command: 'uv cache prune', busy: /\buvx? /, note: 'uvx tool environments live here; restart uvx tools after a clean' },
  { what: 'pip cache', paths: ['~/Library/Caches/pip', '~/.cache/pip'], command: 'pip3 cache purge' },
  { what: 'Homebrew downloads', paths: ['~/Library/Caches/Homebrew'], command: 'brew cleanup --prune=all', busy: /\bbrew / },
  { what: 'Gradle caches', paths: ['~/.gradle/caches'], command: 'rm -rf ~/.gradle/caches', busy: /GradleDaemon/ },
  { what: 'CocoaPods cache', paths: ['~/Library/Caches/CocoaPods'], command: 'pod cache clean --all' },
  { what: 'Go build cache', paths: ['~/Library/Caches/go-build', '~/.cache/go-build'], command: 'go clean -cache' },
  { what: 'Turborepo local cache', paths: ['~/.cache/turbo'], command: 'rm -rf ~/.cache/turbo', busy: /\bturbo /, note: 'the next gate of each repo misses the cache once' },
  { what: 'Playwright browsers', paths: ['~/Library/Caches/ms-playwright', '~/.cache/ms-playwright'], command: 'npx playwright uninstall --all', busy: /playwright/i, note: 'reinstall with npx playwright install' },
  { what: 'Puppeteer browsers', paths: ['~/.cache/puppeteer'], command: 'rm -rf ~/.cache/puppeteer' },
  { what: 'node-gyp and electron-builder caches', paths: ['~/Library/Caches/node-gyp', '~/Library/Caches/electron-builder'], command: 'rm -rf <paths>' },
  { what: 'Xcode DerivedData', paths: ['~/Library/Developer/Xcode/DerivedData'], command: 'rm -rf ~/Library/Developer/Xcode/DerivedData', busy: /Xcode\.app\/Contents\/MacOS\/Xcode/ },
];
for (const c of CACHES) add({ tier: 'A', category: 'package caches', what: c.what, paths: c.paths.map(home), command: c.command, busy: busyWith(c.busy), note: c.note });

// App updater leftovers: downloaded update packages.
const updaters = ls(home('~/Library/Caches'))
  .filter((e) => /ShipIt|updater/i.test(e.name))
  .map((e) => join(home('~/Library/Caches'), e.name));
add({ tier: 'A', category: 'stale temp', what: 'App updater leftovers', paths: updaters, command: 'rm -rf <paths>', note: 'only while the app is not updating' });

// Code-sign clones: APFS clones of a running browser, kept after it quits.
const signClones = ls(join(dirname(tmpdir()), 'X'))
  .filter((e) => e.name.endsWith('.code_sign_clone'))
  .map((e) => join(dirname(tmpdir()), 'X', e.name));
for (const clone of signClones) {
  const open = sh(['lsof', '+D', clone]).trim() !== '';
  add({ tier: 'A', category: 'stale temp', what: `Code-sign clone ${basename(clone, '.code_sign_clone')}`, paths: [clone], command: 'rm -rf <path>', busy: open ? 'files open' : undefined, note: 'a clone: df frees less than du says' });
}

// Huge logs: empty them in place, so the writer keeps its file.
const bigLogs = sh(['find', home('~/Library/Logs'), '-type', 'f', '-size', '+100M']).split('\n').filter(Boolean);
add({ tier: 'A', category: 'stale temp', what: 'Log files over 100 MB', paths: bigLogs, command: ': > <file> (empty, keep the file)' });

// Old Claude Code versions: keep the current one and the newest other.
const versions = home('~/.local/share/claude/versions');
let current = '';
try {
  current = basename(readlinkSync(home('~/.local/bin/claude')));
} catch {}
const older = ls(versions)
  .map((e) => e.name)
  .filter((v) => v !== current)
  .sort(Bun.semver.order)
  .slice(0, -1)
  .map((v) => join(versions, v));
add({ tier: 'A', category: 'stale temp', what: `Old Claude Code versions (current ${current || 'unknown'})`, paths: older, command: 'rm -rf <paths>' });

// ── Tier A: Xcode device support and dead simulators ──
const support = home('~/Library/Developer/Xcode/iOS DeviceSupport');
const supportDirs = ls(support)
  .filter((e) => e.isDirectory())
  .map((e) => join(support, e.name))
  .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
  .slice(0, -1);
add({ tier: 'A', category: 'xcode', what: 'iOS DeviceSupport, all but the newest', paths: supportDirs, command: 'rm -rf <paths>', note: 'Xcode copies symbols again when that iOS version connects' });
const unavailable: string[] = [];
try {
  const devices = JSON.parse(sh(['xcrun', 'simctl', 'list', 'devices', 'unavailable', '-j']) || '{}').devices ?? {};
  for (const list of Object.values(devices) as { udid: string }[][]) for (const d of list) unavailable.push(home(`~/Library/Developer/CoreSimulator/Devices/${d.udid}`));
} catch {}
add({ tier: 'A', category: 'xcode', what: `Unavailable simulators (${unavailable.length})`, paths: unavailable, command: 'xcrun simctl delete unavailable', note: 'their apps and data go too' });

// ── Tier A: agent leftovers ──
type Found = { paths: string[]; bytes: number };
function agentFiles(match: (path: string) => boolean, olderThan: number): Found {
  const found: Found = { paths: [], bytes: 0 };
  const walk = (dir: string) => {
    for (const e of ls(dir)) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (match(p)) {
        const s = lstatSync(p);
        if (s.mtimeMs < olderThan) {
          found.paths.push(p);
          found.bytes += s.blocks * 512;
        }
      }
    }
  };
  walk(home('~/.claude/projects'));
  return found;
}
const prune = `bun ${join(import.meta.dir, 'prune-agent-files.ts')}`;
const cutoff = new Date(TRANSCRIPT_CUTOFF).toISOString().slice(0, 10);
const subagents = agentFiles((p) => p.includes(`${sep}subagents${sep}`), TRANSCRIPT_CUTOFF);
add({ tier: 'A', category: 'agent leftovers', what: `Claude subagent transcripts before ${cutoff} (${subagents.paths.length})`, paths: subagents.paths.length ? [home('~/.claude/projects')] : [], bytes: subagents.bytes, command: `${prune} --before ${cutoff} --apply`, note: 'push the transcript archive first, if one is set up' });
const results = agentFiles((p) => p.includes(`${sep}tool-results${sep}`), TRANSCRIPT_CUTOFF);
add({ tier: 'A', category: 'agent leftovers', what: `Claude tool-result spills before ${cutoff} (${results.paths.length})`, paths: results.paths.length ? [home('~/.claude/projects')] : [], bytes: results.bytes, command: `${prune} --before ${cutoff} --apply` });
const scratchRoot = TMP;
{
  const stale: string[] = [];
  for (const user of ls(scratchRoot).filter((e) => /^claude-\d+$/.test(e.name)))
    for (const project of ls(join(scratchRoot, user.name)))
      for (const session of ls(join(scratchRoot, user.name, project.name)))
        if (session.isDirectory() && !touchedWithin(join(scratchRoot, user.name, project.name, session.name), TRANSCRIPT_DAYS))
          stale.push(join(scratchRoot, user.name, project.name, session.name));
  add({ tier: 'A', category: 'agent leftovers', what: `Claude scratchpads idle ${TRANSCRIPT_DAYS}+ days (${stale.length})`, paths: stale, command: `${prune} --before ${cutoff} --apply` });
}
const cull = join(import.meta.dir, 'cull-transcript-images.ts');
const culled = exists(cull) ? JSON.parse(sh(['bun', cull, '--dry-run']) || '{}') : {};
if (culled.freedGB > 0.05)
  items.push({ tier: 'A', category: 'agent leftovers', what: `Images and binaries inlined in ${culled.culled} transcripts`, paths: [home('~/.claude/projects'), home('~/.codex/sessions')], bytes: culled.freedGB * 1e9, command: `bun ${cull}` });

// ── Code folders: build output, idle node_modules, worktrees ──
const BUILD = new Set(['.next', 'dist', 'build', '.turbo', '.parcel-cache', 'target', '.gradle', 'DerivedData']);
type Checkout = { path: string; worktree: boolean };
function checkouts(dir: string, depth: number, hidden: boolean, out: Checkout[] = []): Checkout[] {
  for (const e of ls(dir)) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    const isHidden = hidden || e.name.startsWith('.');
    if (exists(join(p, '.git'))) out.push({ path: p, worktree: isHidden || lstatSync(join(p, '.git')).isFile() });
    else if (depth > 0) checkouts(p, depth - 1, isHidden, out);
  }
  return out;
}
function buildDirs(repo: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const e of ls(dir)) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (BUILD.has(e.name) && (e.name !== 'target' || exists(join(dir, 'Cargo.toml')))) out.push(p);
      else if (e.name !== 'node_modules' && e.name !== '.git' && !e.name.startsWith('.') && depth > 0) walk(p, depth - 1);
    }
  };
  walk(repo, 6);
  if (out.length === 0) return out;
  const ignored = new Set(Bun.spawnSync(['git', '-C', repo, 'check-ignore', '--stdin'], { stdin: Buffer.from(out.join('\n')) }).stdout.toString().split('\n'));
  return out.filter((p) => ignored.has(p) && !touchedWithin(p, BUILD_DAYS));
}
function nodeModules(repo: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const e of ls(dir)) {
      if (!e.isDirectory() || e.name === '.git') continue;
      const p = join(dir, e.name);
      if (e.name === 'node_modules') out.push(p);
      else if (depth > 0 && !e.name.startsWith('.')) walk(p, depth - 1);
    }
  };
  walk(repo, 3);
  return out;
}
// Folders git ignores that are neither dependencies nor build output: renders, bundles, scratch.
function ignoredData(repo: string): string[] {
  return sh(['git', '-C', repo, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory'])
    .split('\n')
    .filter((p) => p.endsWith('/') && !p.split('/').some((part) => part === 'node_modules' || BUILD.has(part) || HEAVY.has(part)))
    .map((p) => join(repo, p.slice(0, -1)));
}
const git = (repo: string, ...a: string[]) => sh(['git', '-C', repo, ...a]).trim();
for (const root of ROOTS)
  for (const repo of checkouts(root, 3, false)) {
    const name = tilde(repo.path);
    const idle = idleDays(Math.max(newest(repo.path), exists(join(repo.path, '.git/logs/HEAD')) ? statSync(join(repo.path, '.git/logs/HEAD')).mtimeMs : 0));
    const busy = inUse(repo.path);
    if (repo.worktree) {
      const dirty = git(repo.path, 'status', '--porcelain').split('\n').filter(Boolean).length;
      const ahead = git(repo.path, 'rev-list', '--count', '@{u}..HEAD');
      const pushed = ahead === '' ? 'no upstream' : `${ahead} unpushed`;
      add({ tier: 'C', category: 'worktrees', what: `${name} (${git(repo.path, 'branch', '--show-current') || 'detached'}, ${dirty} dirty, ${pushed})`, paths: [repo.path], idleDays: idle, busy, command: 'rift remove / git worktree remove, after its work is merged', note: 'clones: df frees less than du says' });
      continue;
    }
    if (!busy) add({ tier: 'A', category: 'build output', what: `${name}: build output idle ${BUILD_DAYS}+ days`, paths: buildDirs(repo.path), idleDays: idle, command: 'rm -rf <paths>' });
    for (const dir of ignoredData(repo.path)) add({ tier: 'C', category: 'ignored data', what: `${tilde(dir)}: ignored by git`, paths: [dir], idleDays: idleDays(newest(dir, 2)), command: 'move to the Trash, item by item', note: 'renders, bundles, scratch: ask what it is', min: GIB });
    if (idle >= IDLE_DAYS && !busy) add({ tier: 'A', category: 'idle node_modules', what: `${name}: node_modules, project idle ${idle} days`, paths: nodeModules(repo.path), idleDays: idle, command: 'rm -rf <paths> (reinstall with the lockfile)', note: 'a warm source for clones loses its install' });
  }

// ── Temp: tool caches that rebuild, and folders nothing touched lately ──
const TEMP_CACHES = /^(node-compile-cache|playwright-transform-cache-\d+|bunx-\d+-.+|jiti|v8-compile-cache-\d+)$/;
const tempCaches = ls(TMP).filter((e) => TEMP_CACHES.test(e.name)).map((e) => join(TMP, e.name));
add({ tier: 'A', category: 'stale temp', what: `Tool caches in ${TMP} (${tempCaches.length})`, paths: tempCaches, command: 'rm -rf <paths>', note: 'node, playwright and bunx rebuild them' });
const staleTemp = ls(TMP)
  .filter((e) => !TEMP_CACHES.test(e.name) && !/^claude-\d+$/.test(e.name) && !e.name.startsWith('.') && !e.isSymbolicLink())
  .map((e) => join(TMP, e.name))
  .filter((p) => !inUse(p) && !touchedWithin(p, TRANSCRIPT_DAYS));
if (staleTemp.length) {
  const sized = staleTemp.map((p) => ({ p, bytes: du([p]) })).sort((a, b) => b.bytes - a.bytes);
  add({ tier: 'C', category: 'stale temp', what: `${TMP} entries untouched ${TRANSCRIPT_DAYS}+ days (${staleTemp.length}); largest: ${sized.slice(0, 6).map((s) => `${basename(s.p)} ${(s.bytes / GIB).toFixed(1)}G`).join(', ')}`, paths: staleTemp, bytes: sized.reduce((s, x) => s + x.bytes, 0), command: 'rm -rf <paths>, after asking whoever made them', note: 'agents keep work data in temp: ask before removing' });
}
add({ tier: 'C', category: 'trash', what: 'The Trash', paths: ['~/.local/share/Trash', '~/.Trash'].map(home), command: 'empty it, after a separate yes', note: 'a macOS Trash reads empty without Full Disk Access' });

// ── Tier B: costly to get back ──
const runtimes = sh(['xcrun', 'simctl', 'runtime', 'list']).split('\n').filter((l) => /\(Ready\)/.test(l));
if (runtimes.length) {
  const bytes = runtimes.reduce((sum, l) => sum + (Number(/\(([\d.]+)G\)/.exec(l)?.[1] ?? 0) * 1024 ** 3), 0) || du([home('~/Library/Developer/CoreSimulator')]);
  items.push({ tier: 'B', category: 'xcode', what: `Simulator runtimes: ${runtimes.map((l) => l.trim().split(' - ')[0]).join(', ')}`, paths: [], bytes, command: 'xcrun simctl runtime delete <id>, after deleting its devices', note: 'gigabytes to download again' });
}
add({ tier: 'B', category: 'android', what: 'Android SDK', paths: [home('~/Library/Android/sdk')], command: 'Android Studio > SDK Manager', note: 'system images re-download' });
add({ tier: 'B', category: 'android', what: 'Android emulators (AVDs)', paths: [home('~/.android/avd')], command: 'avdmanager delete avd -n <name>', note: 'emulator data goes' });
add({ tier: 'B', category: 'ai models', what: 'Local AI models', paths: ['~/.ollama/models', '~/.cache/huggingface', '~/.cache/lm-studio'].map(home), command: 'ollama rm <model> / hf cache rm <id>', note: 'check which model an app uses first' });
// Docker: what it says each kind could give back (RECLAIMABLE), unused by any container.
const UNITS: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
const DOCKER: Record<string, { what: string; command: string; note: string }> = {
  Images: { what: 'Docker images no container uses', command: 'docker image prune -a', note: 'pulled or built again on the next run' },
  'Build Cache': { what: 'Docker build cache', command: 'docker builder prune -a', note: 'the next image build runs cold' },
  'Local Volumes': { what: 'Docker volumes no container uses', command: 'docker volume prune', note: 'volumes can hold databases: ask per volume' },
};
for (const line of sh(['docker', 'system', 'df']).split('\n').slice(1)) {
  const kind = Object.keys(DOCKER).find((k) => line.startsWith(k));
  const reclaim = /([\d.]+)\s*([kKMGT]?B)\s*(\(\d+%\))?\s*$/.exec(line);
  if (!kind || !reclaim) continue;
  const bytes = Number(reclaim[1]) * (UNITS[reclaim[2]!] ?? 0);
  const d = DOCKER[kind]!;
  if (bytes >= 50 * 1024 ** 2) items.push({ tier: kind === 'Local Volumes' ? 'C' : 'B', category: 'docker', what: d.what, paths: [], bytes, command: d.command, note: d.note });
}

// ── Tier C: folders beside the checkouts, and big files in the personal folders ──
const repoPaths = ROOTS.flatMap((root) => checkouts(root, 3, false)).map((c) => c.path);
const holdsRepo = (dir: string) => repoPaths.some((r) => r === dir || r.startsWith(dir + sep));
for (const root of ROOTS)
  for (const group of [root, ...ls(root).filter((e) => e.isDirectory()).map((e) => join(root, e.name))])
    for (const e of ls(group))
      if (e.isDirectory() && !holdsRepo(join(group, e.name)) && join(group, e.name) !== root)
        add({ tier: 'C', category: 'loose folders', what: `${tilde(join(group, e.name))}: not a checkout`, paths: [join(group, e.name)], idleDays: idleDays(newest(join(group, e.name), 2)), command: 'move to the Trash, item by item', min: GIB });
const PERSONAL = ['~/Downloads', '~/Desktop', '~/Documents', '~/Movies', '~/Music'].map(home).filter(exists);
for (const file of sh(['find', ...PERSONAL, '-type', 'f', '-size', '+500M']).split('\n').filter(Boolean))
  add({ tier: 'C', category: 'big files', what: tilde(file), paths: [file], idleDays: idleDays(statSync(file).mtimeMs), command: 'move to the Trash, item by item', note: /\.(dmg|pkg|xip|apk|ipa)$/i.test(file) ? 'an installer: check its app is installed' : undefined });

// ── Report ──
const df = sh(['df', '-k', DATA]).split('\n')[1]?.trim().split(/\s+/) ?? [];
const free = Number(df[3] ?? 0) * 1024;
const size = Number(df[1] ?? 0) * 1024;
const gib = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GiB`;
if (args.includes('--json')) {
  console.log(JSON.stringify({ freeBytes: free, sizeBytes: size, items }, null, 2));
} else {
  console.log(`Free: ${gib(free)} of ${gib(size)} (df). Sizes below are du allocations; clones count in full.\n`);
  for (const tier of ['A', 'B', 'C'] as Tier[]) {
    const rows = items.filter((i) => i.tier === tier).sort((a, b) => b.bytes - a.bytes);
    if (!rows.length) continue;
    console.log(`Tier ${tier}: ${{ A: 'regenerable', B: 'costly to get back', C: 'user data, decide per item' }[tier]} (${gib(rows.reduce((s, r) => s + r.bytes, 0))})`);
    for (const r of rows) {
      console.log(`  ${gib(r.bytes).padStart(10)}  ${r.idleDays === undefined ? '' : `${r.idleDays}d idle  `}${r.what}${r.busy ? `  [busy: ${r.busy}]` : ''}`);
      console.log(`              ${r.command}${r.note ? `  (${r.note})` : ''}`);
      if (r.paths.length > 1 && r.paths.length <= 8) for (const p of r.paths) console.log(`                ${tilde(p)}`);
    }
    console.log();
  }
}
