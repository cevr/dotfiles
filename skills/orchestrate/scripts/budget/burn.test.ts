import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { burnOf, hostBurn, report, simulate, tune, untunedOverruns, WINDOWS, workerKind, type FileBurn } from './burn.ts';

const hour = (create: number, read: number, output: number) => ({
  input_tokens: 0,
  cache_creation_input_tokens: create,
  cache_read_input_tokens: read,
  output_tokens: output,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: create },
});
const at = (s: number) => new Date(Date.UTC(2026, 9, 21, 12, 0, s)).toISOString();

// A session: a 1000-token start, a Bash call whose 4000-char result enters the context,
// a compaction, and one call on the summary.
const session = [
  { type: 'user', cwd: '/Users/x/Developer/personal/foo', timestamp: at(0), message: { role: 'user', content: 'list the files' } },
  {
    type: 'assistant',
    timestamp: at(1),
    message: { id: 'm1', usage: hour(1000, 0, 100), content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls', description: 'List files' } }] },
  },
  { type: 'user', timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(4000) }] } },
  { type: 'assistant', timestamp: at(3), message: { id: 'm2', usage: hour(2100, 1000, 50), content: [{ type: 'text', text: 'done' }] } },
  { type: 'system', subtype: 'compact_boundary', timestamp: at(4), compactMetadata: { preTokens: 3100 } },
  { type: 'assistant', timestamp: at(5), message: { id: 'm3', usage: hour(1500, 0, 20), content: [{ type: 'text', text: 'ok' }] } },
];
const jsonl = session.map((l) => JSON.stringify(l)).join('\n') + '\n';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'burn-'));
  const file = join(dir, 's1.jsonl');
  writeFileSync(file, jsonl);
  return file;
}

describe('burnOf', () => {
  test('charges each item its write once and its share of every later read', () => {
    const b = burnOf(fixture(), jsonl.length);
    expect(b.calls).toBe(3);
    expect(b.project).toBe('foo');
    expect(b.w.output).toBe(5 * (100 + 50 + 20));
    // The reply (100 tokens) and the 4000-char result (≤ 2000 tokens) fill the 2100-token growth.
    expect(b.cats['tool:Bash']).toBe(2 * 2000);
    expect(b.cats.assistant).toBe(2 * 100);
    // The base: written at m1, read at m2, and rebuilt after the compaction.
    expect(b.cats.base).toBe(2 * 1000 + 0.1 * 1000 + 2 * 1000);
    // The summary: the compaction call's read, and the part of m3's context beyond the base.
    expect(b.cats.compaction).toBe(0.1 * 3100 + 2 * 500);
    expect(b.base).toEqual([1000, 1500]);
    expect(b.compactions).toBe(1);
    expect(b.top[0]).toMatchObject({ cat: 'tool:Bash', label: 'List files', tokens: 2000 });
  });
});

describe('hostBurn', () => {
  test('counts a session copied under two project folders once', () => {
    const root = mkdtempSync(join(tmpdir(), 'burn-projects-'));
    for (const project of ['-a', '-b']) {
      mkdirSync(join(root, project));
      writeFileSync(join(root, project, 's1.jsonl'), jsonl);
    }
    const h = hostBurn(Date.now(), root, join(root, 'burn.json'));
    expect(h.burns).toHaveLength(1);
    expect(report([h])).toContain('| tool:Bash |');
  });
});

describe('simulate', () => {
  // A 10k start that grows 20k a call; a compaction rebuilds to the start plus a 15k summary.
  const calls: [number, number][] = Array.from({ length: 5 }, () => [20e3, 1]);

  test('charges each call its read and its growth when the window is never reached', () => {
    // Contexts 30k, 50k, 70k, 90k, 110k.
    expect(simulate(10e3, calls, 350e3)).toEqual([0.1 * 350e3 + 100e3, 0, 0]);
  });

  test('compacts when the next call would pass the window, and counts the calls after', () => {
    const [w, compactions, after] = simulate(10e3, calls, 60e3);
    expect([compactions, after]).toEqual([3, 3]);
    // Two calls to 50k, then three compactions (read 50k or 45k, a 4k summary at 5x, a 25k rebuild), each followed by a call at 45k.
    expect(w).toBe(3e3 + 20e3 + 5e3 + 20e3 + (5e3 + 20e3 + 25e3) + 2 * (4.5e3 + 20e3 + 25e3) + 3 * (4.5e3 + 20e3));
  });
});

describe('tune', () => {
  // Twenty agents whose replay is cheapest at 160k and at 180k alike, and dearer above.
  const cost: Record<number, number> = { 100e3: 140, 120e3: 120, 140e3: 110, 160e3: 100, 180e3: 100.5, 200e3: 105, 250e3: 120, 300e3: 130, 350e3: 140, 400e3: 150, 500e3: 160 };
  const agent = (kind: string): FileBurn =>
    ({ kind, compactions: 1, reread: 0, compactMs: 60e3, windows: Object.fromEntries(WINDOWS.map((w) => [w, [cost[w], 0, 0]])) }) as unknown as FileBurn;
  const burns = Array.from({ length: 20 }, () => agent('general-purpose'));

  test('picks the largest window within 1% of the cheapest, and skips kinds with few agents', () => {
    const [worker, ...rest] = tune([...burns, agent('Explore')], 200e3);
    expect(rest).toEqual([]);
    expect(worker).toMatchObject({ kind: 'general-purpose', agents: 20, window: 180e3, best: 180e3 });
    expect(worker.saving).toBeCloseTo(1 - 100.5 / 105);
  });

  test('stays under the ceiling and names the better window above it', () => {
    expect(tune(burns, 140e3)[0]).toMatchObject({ window: 140e3, best: 180e3, saving: 0 });
  });

  test('keeps a worker under 200k, whatever the ceiling', () => {
    const wide: Record<number, number> = { ...cost, 200e3: 104, 250e3: 101, 300e3: 100 };
    const roomy = (kind: string): FileBurn =>
      ({ kind, compactions: 1, reread: 0, compactMs: 60e3, windows: Object.fromEntries(WINDOWS.map((w) => [w, [wide[w], 0, 0]])) }) as unknown as FileBurn;
    const worker = tune(Array.from({ length: 20 }, () => roomy('general-purpose')), 450e3)[0]!;
    expect(worker).toMatchObject({ window: 180e3, best: 300e3 });
  });

  test('counts the recent agents whose context ran past the window', () => {
    const ran = (peak: number, last: number) => ({ ...agent('general-purpose'), peak, last });
    const mixed = [...burns.slice(4), ran(416e3, 2000), ran(190e3, 2000), ran(416e3, 500), ran(150e3, 2000)];
    // 190k is within 10% of the window; the 416k agent at 500 ran before `since`.
    expect(tune(mixed, 200e3, 1000)[0]).toMatchObject({ window: 180e3, overrun: 1 });
  });

  test('counts the overruns of a kind too small to tune, at the window it runs with', () => {
    const ran = (kind: string, peak: number) => ({ ...agent(kind), peak, last: 2000 });
    const tuned = tune(burns, 200e3, 1000);
    // No orchestrate-worker ran, so an untuned role runs at the worker cap.
    const worker = 200e3;
    const few = [ran('orchestrate-implementor', 396e3), ran('orchestrate-implementor', worker), ran('Explore', 230e3), ran('Explore', 210e3)];
    expect(untunedOverruns([...burns, ...few], tuned, 200e3, 1000)).toEqual([
      { kind: 'orchestrate-implementor', window: worker, overrun: 1 },
      { kind: 'Explore', window: 200e3, overrun: 1 },
    ]);
  });

  test('runs every orchestrate role at 200k, however cheap a smaller window replays', () => {
    const roles = ['orchestrate-worker', 'orchestrate-implementor', 'orchestrate-verifier'].flatMap((kind) => Array.from({ length: 20 }, () => agent(kind)));
    for (const t of tune(roles, 200e3)) expect(t).toMatchObject({ window: 200e3 });
    expect(tune([agent('orchestrate-reviewer')], 200e3)).toMatchObject([{ kind: 'orchestrate-reviewer', window: 200e3 }]);
  });

  test("keeps the owner's window for the main session, however few its transcripts", () => {
    const root = Array.from({ length: 2 }, () => agent('root'));
    expect(tune(root, 450e3)[0]).toMatchObject({ kind: 'root', agents: 2, window: 400e3, best: 180e3 });
  });
});

test("a worker that ran a protocol role tunes as that role's agent", () => {
  expect(workerKind('status:orchestrate-worker', 'Read protocol.md. You are the reviewer of sheet, round 2.')).toBe('orchestrate-reviewer');
  expect(workerKind('status:orchestrate-worker', 'Survey the docs for the reviewer.')).toBe('orchestrate-worker');
  expect(workerKind('status:orchestrate-verifier', '')).toBe('orchestrate-verifier');
  expect(workerKind(undefined, '')).toBe('agent');
});
