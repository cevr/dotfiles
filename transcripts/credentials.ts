#!/usr/bin/env bun
// Write the archive's S3 keys to ~/.config/transcript-archive/credentials.json
// (mode 600) on this machine and on each SSH host named, without printing them.
// The keys come from the stack's token in Alchemy state: the access key id is
// the token id, the secret is the SHA-256 of the token value.
//
// Usage: bun credentials.ts [<ssh-host>...]     e.g. bun credentials.ts bite-workbox

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { BUCKET } from './bucket.ts';

const read = Bun.spawnSync(
  [join(import.meta.dir, 'node_modules', '.bin', 'alchemy'), 'state', 'read', 'transcripts/prod/Writer', '--no-input'],
  { cwd: import.meta.dir, stderr: 'pipe' },
);
const text = read.stdout.toString();
if (read.exitCode !== 0 || !text.includes('{')) {
  console.error(`alchemy state read failed: ${read.stderr.toString().trim().split('\n').pop()}`);
  process.exit(1);
}
const record = JSON.parse(text.slice(text.indexOf('{'))) as {
  attr: { tokenId: string; accountId: string; value: { __redacted__: string } };
};

const credentials = JSON.stringify({
  endpoint: `https://${record.attr.accountId}.r2.cloudflarestorage.com`,
  bucket: BUCKET,
  accessKeyId: record.attr.tokenId,
  secretAccessKey: createHash('sha256').update(record.attr.value.__redacted__).digest('hex'),
});

const dir = join(homedir(), '.config', 'transcript-archive');
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(join(dir, 'credentials.json'), credentials, { mode: 0o600 });
console.log('wrote ~/.config/transcript-archive/credentials.json');

for (const host of process.argv.slice(2)) {
  const ssh = Bun.spawnSync(
    [
      'ssh',
      '-o',
      'BatchMode=yes',
      host,
      'umask 077 && mkdir -p ~/.config/transcript-archive && cat > ~/.config/transcript-archive/credentials.json',
    ],
    { stdin: new Blob([credentials]), stderr: 'pipe' },
  );
  console.log(ssh.exitCode === 0 ? `wrote ${host}:~/.config/transcript-archive/credentials.json` : `${host}: ${ssh.stderr}`);
}
