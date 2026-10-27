import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { familyOf, type CodexLoad } from './codex-host.ts';

const HOST = join(import.meta.dir, 'codex-host.ts');
const MINUTE = 60e3;
const t0 = Date.now() - 8 * MINUTE;
const at = (minutes: number) => new Date(t0 + minutes * MINUTE).toISOString();

const meta = (id: string, parent?: string) =>
  JSON.stringify({
    timestamp: at(0),
    type: 'session_meta',
    payload: { id, originator: 'codex_bridge', cwd: '/repo', ...(parent && { source: { subagent: { thread_spawn: { parent_thread_id: parent } } } }) },
  });
const context = (model: string) => JSON.stringify({ timestamp: at(0), type: 'turn_context', payload: { model } });
// A token event with the thread's running total and the week's use.
const count = (minutes: number, input: number, cached: number, output: number, used = 40) =>
  JSON.stringify({
    timestamp: at(minutes),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
      rate_limits: { limit_id: 'codex', primary: { used_percent: used, window_minutes: 10080, resets_at: Math.round((t0 + 3 * 864e5) / 1e3) }, secondary: null },
    },
  });

/** codex-host.ts over `sessions` in the HOME `home`, whose bridge knows thread `a` as an implementor. */
function run(home: string, sessions: string): CodexLoad {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home };
  delete env.CODEX_BRIDGE_DIR;
  delete env.XDG_STATE_HOME;
  const out = Bun.spawnSync(['bun', HOST, '--sessions', sessions], { env });
  return JSON.parse(out.stdout.toString());
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'codex-host-'));
  const day = join(home, 'sessions', '2026', '10', '27');
  mkdirSync(day, { recursive: true });
  mkdirSync(join(home, '.local', 'state', 'codex-bridge'), { recursive: true });
  writeFileSync(join(home, '.local', 'state', 'codex-bridge', 'state.json'), JSON.stringify({ threads: { a: { role: 'implementor' } } }));
  const file = (name: string, lines: string[]) => {
    const path = join(day, `rollout-${name}.jsonl`);
    writeFileSync(path, lines.join('\n') + '\n');
    return path;
  };
  return { home, sessions: join(home, 'sessions'), file };
}

describe('codexLoad', () => {
  test("counts each thread's rises of its total once, by family and role, a spawned thread in its parent's", () => {
    const { home, sessions, file } = setup();
    // W = uncached + 0.1 × cached + 8 × output: 1000 + 800, then 2000 + 100 + 1600; the repeat adds nothing.
    file('a', [meta('a'), context('gpt-6.1-sol'), count(1, 1000, 0, 100), count(1, 1000, 0, 100), count(2, 3000, 1000, 200, 41)]);
    file('b', [meta('b'), context('gpt-6-luna'), count(3, 500, 0, 0)]);
    file('c', [meta('c', 'a'), context('gpt-6-luna'), count(4, 100, 0, 0)]);
    const load = run(home, sessions);
    expect(load.complete).toBe(true);
    const byId = Object.fromEntries(load.threads.map((t) => [t.id, t]));
    expect(byId.a).toMatchObject({ family: 'sol', role: 'implementor', w: 3700 + 100 });
    expect(byId.b).toMatchObject({ family: 'luna', role: 'interactive', w: 500 });
    expect(byId.c).toBeUndefined();
    expect(load.w1h).toBe(4300);
    expect(load.interactive1h).toEqual({ luna: 500 });
    expect(load.live.map((t) => [t.id, t.role]).sort()).toEqual([['a', 'implementor'], ['b', 'interactive'], ['c', 'implementor']]);
    expect(load.hours.reduce((n, h) => n + (h.w.sol ?? 0), 0)).toBe(3700);
    // One snapshot a minute: the minute's highest use.
    expect(load.snapshots.map((s) => [s.used, s.windowMinutes])).toEqual([
      [40, 10080],
      [41, 10080],
      [40, 10080],
      [40, 10080],
    ]);
  });

  test('a second run reads only the lines appended since the first', () => {
    const { home, sessions, file } = setup();
    const path = file('a', [meta('a'), context('gpt-6.1-sol'), count(1, 1000, 0, 100)]);
    expect(run(home, sessions).threads[0]).toMatchObject({ id: 'a', family: 'sol', w: 1800 });
    // Blank the lines already read, at the same length: a run that read them again would lose the thread.
    writeFileSync(path, readFileSync(path, 'utf8').replace(/[^\n]/g, ' '));
    appendFileSync(path, count(5, 2000, 0, 100) + '\n');
    expect(run(home, sessions).threads[0]).toMatchObject({ id: 'a', family: 'sol', role: 'implementor', w: 2800 });
  });
});

test('a model goes by its family', () => {
  expect(familyOf('gpt-6.1-sol')).toBe('sol');
  expect(familyOf('gpt-6-luna')).toBe('luna');
  expect(familyOf('o9')).toBe('o9');
  expect(familyOf(undefined)).toBe('other');
});
