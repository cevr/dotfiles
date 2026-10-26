import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'cull-transcript-images');
const NOTE = '[image removed to save disk]';
const PIXELS = 'iVBORw0KGgo'.repeat(50);
const HOUR_AGO = new Date(Date.now() - 2 * 3600e3);

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const transcript = (lines: unknown[], mtime = HOUR_AGO) => {
  dir = mkdtempSync(join(tmpdir(), 'cull-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n'));
  utimesSync(file, mtime, mtime);
  return file;
};

const cull = (...args: string[]) => {
  const run = Bun.spawnSync(['bun', SCRIPT, ...args, dir]);
  return JSON.parse(run.stdout.toString());
};

const lines = (file: string) => readFileSync(file, 'utf8').split('\n').map((line) => JSON.parse(line));

test('empties the Read tool copy of an image and replaces the image block, keeping the rest', () => {
  const file = transcript([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'look' }] } },
    {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXELS } }] },
        ],
      },
      toolUseResult: { type: 'image', file: { base64: PIXELS, type: 'image/png', originalSize: 9 } },
    },
  ]);
  const before = statSync(file).mtimeMs;

  expect(cull()).toMatchObject({ culled: 1, freedGB: expect.any(Number) });

  const [said, read] = lines(file);
  expect(said).toEqual({ type: 'assistant', message: { content: [{ type: 'text', text: 'look' }] } });
  expect(read.message.content[0].content).toEqual([{ type: 'text', text: NOTE }]);
  expect(read.toolUseResult).toEqual({ type: 'image', file: { base64: '', type: 'image/png', originalSize: 9 } });
  expect(statSync(file).mtimeMs).toBe(before);
});

test('replaces a base64 document block', () => {
  const file = transcript([
    { type: 'user', message: { content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PIXELS } }] } },
  ]);

  cull();

  expect(lines(file)[0].message.content).toEqual([{ type: 'text', text: NOTE }]);
});

test('leaves a transcript written in the last hour, and changes nothing on a dry run', () => {
  const live = transcript([{ type: 'user', toolUseResult: { type: 'image', file: { base64: PIXELS } } }], new Date());
  const text = readFileSync(live, 'utf8');

  expect(cull()).toMatchObject({ culled: 0, liveSkipped: 1 });
  expect(cull('--dry-run', '--idle-min', '0')).toMatchObject({ culled: 1, dryRun: true });
  expect(readFileSync(live, 'utf8')).toBe(text);
});
