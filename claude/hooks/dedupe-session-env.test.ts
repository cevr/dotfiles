import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dedupe } from './dedupe-session-env';

const HOOK = join(import.meta.dir, 'dedupe-session-env.ts');

describe('dedupe-session-env', () => {
  test('a session start leaves one export per name, the last one', () => {
    const config = mkdtempSync(join(tmpdir(), 'env-'));
    const dir = join(config, 'session-env', 's1');
    mkdirSync(dir, { recursive: true });
    const starts = Array.from({ length: 400 }, (_, i) => `export A='${i}'\nexport B='b'\n`).join('');
    writeFileSync(join(dir, 'sessionstart-hook-2.sh'), starts);
    Bun.spawnSync(['bun', HOOK], {
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: 's1' })),
      env: { ...process.env, CLAUDE_CONFIG_DIR: config },
    });
    expect(readFileSync(join(dir, 'sessionstart-hook-2.sh'), 'utf8')).toBe("export A='399'\nexport B='b'\n");
  });

  test('a file with anything besides exports stays as it is', () => {
    expect(dedupe("export A='1'\nexport A='2'\necho hi\n")).toBeUndefined();
  });
});
