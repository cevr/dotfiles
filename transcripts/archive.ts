#!/usr/bin/env bun
// Back up this machine's Claude and Codex transcripts to the R2 archive, and
// restore them from it.
//
// A transcript only grows while its session runs, but R2 cannot append to an
// object, and the weekly image cull rewrites old transcripts. So each changed
// file is uploaded whole, zstd-compressed (about 5x), to
// `<host>/<claude|codex>/<path>.zst`, replacing the copy from its last change.
// The archive never deletes: a transcript that Claude's cleanup removes here
// stays there. Images beside the transcripts stay out, as the cull keeps them
// out of the transcripts.
//
// Usage:
//   bun archive.ts push [--dry-run]
//   bun archive.ts pull <prefix> <dir>     e.g. pull bite-cristian/claude/ ~/restore
//
// Keys: ~/.config/transcript-archive/credentials.json, written by credentials.ts.
// Upload record: ~/.local/state/transcript-archive/pushed.json (key → size:mtime).

import { S3Client } from 'bun';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, relative } from 'node:path';

const ROOTS = { claude: join(homedir(), '.claude', 'projects'), codex: join(homedir(), '.codex', 'sessions') };
const SKIP = /\.(png|jpe?g|gif|webp|pdf|cull-tmp)$/i;
const CREDENTIALS = join(homedir(), '.config', 'transcript-archive', 'credentials.json');
const RECORD = join(homedir(), '.local', 'state', 'transcript-archive', 'pushed.json');
const PARALLEL = 8;

type Credentials = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };

const client = (): S3Client => {
  const c: Credentials = JSON.parse(readFileSync(CREDENTIALS, 'utf8'));
  return new S3Client({ ...c, region: 'auto' });
};

function files(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (e.isFile() && !SKIP.test(e.name)) out.push(p);
  }
  return out;
}

async function push(dryRun: boolean): Promise<void> {
  const host = hostname().split('.')[0]!.toLowerCase();
  let record: Record<string, string> = {};
  try {
    record = JSON.parse(readFileSync(RECORD, 'utf8'));
  } catch {}
  const save = () => {
    mkdirSync(dirname(RECORD), { recursive: true });
    writeFileSync(RECORD, JSON.stringify(record));
  };

  const changed: { key: string; file: string; mark: string; size: number }[] = [];
  for (const [name, root] of Object.entries(ROOTS)) {
    for (const file of files(root)) {
      const stat = statSync(file);
      const key = `${host}/${name}/${relative(root, file)}.zst`;
      const mark = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
      if (record[key] !== mark) changed.push({ key, file, mark, size: stat.size });
    }
  }
  const raw = changed.reduce((n, c) => n + c.size, 0);
  if (dryRun) {
    console.log(JSON.stringify({ host, dryRun, changed: changed.length, rawGB: +(raw / 1e9).toFixed(2) }));
    return;
  }

  const s3 = client();
  let sent = 0;
  let failed = 0;
  let uploads = 0;
  let next = 0;
  const worker = async () => {
    while (next < changed.length) {
      const c = changed[next++]!;
      try {
        const body = Bun.zstdCompressSync(readFileSync(c.file), { level: 3 });
        await s3.write(c.key, body, { type: 'application/zstd' });
        record[c.key] = c.mark;
        sent += body.length;
        if (++uploads % 100 === 0) save();
      } catch (e) {
        failed++;
        console.error(`${c.key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  save();
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      host,
      uploaded: changed.length - failed,
      failed,
      rawGB: +(raw / 1e9).toFixed(2),
      sentGB: +(sent / 1e9).toFixed(2),
    }),
  );
  if (failed > 0) process.exit(1);
}

async function pull(prefix: string, dir: string): Promise<void> {
  const s3 = client();
  let token: string | undefined;
  let count = 0;
  do {
    const page = await s3.list({ prefix, continuationToken: token });
    for (const object of page.contents ?? []) {
      const target = join(dir, object.key.replace(/\.zst$/, ''));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Bun.zstdDecompressSync(await s3.file(object.key).bytes()));
      count++;
    }
    token = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (token);
  console.log(JSON.stringify({ prefix, restored: count, dir }));
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'push') await push(rest.includes('--dry-run'));
else if (command === 'pull' && rest.length === 2) await pull(rest[0]!, rest[1]!);
else {
  console.error('usage: bun archive.ts push [--dry-run] | pull <prefix> <dir>');
  process.exit(2);
}
