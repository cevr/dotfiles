import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The CLI, run as the loop's cost step runs it, against a fake OpenCode service
// and a Claude Code transcript.
const script = join(import.meta.dir, 'agent-cost.ts');
const dir = mkdtempSync(join(tmpdir(), 'agent-cost-'));
// Async: the fake service answers from this process, so a sync spawn would block it.
const run = async (args: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawn(['bun', script, ...args], { env: { ...process.env, XDG_STATE_HOME: join(dir, 'state'), ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out.trim(), err: err.trim() };
};

const T0 = Date.parse('2026-11-06T10:00:00Z');
const turn = (min: number, extra: object = {}) => ({
  type: 'assistant',
  time: { created: T0 + min * 60e3, completed: T0 + min * 60e3 + 1000 },
  tokens: { input: 1000, output: 3000, reasoning: 1000, cache: { read: 1_000_000, write: 20_000 } },
  content: [],
  ...extra,
});
const messages = [
  { type: 'user', time: { created: T0 }, text: 'Implement round 1 of /r/u/spec.md' },
  turn(1, { content: [{ type: 'tool', name: 'shell', state: { status: 'completed', input: { command: 'sleep 60; tail out.log' } } }] }),
  turn(2, { content: [{ type: 'tool', name: 'kernel', state: { status: 'completed', input: { code: 'await tools.shell({ command: "until test -f done; do sleep 5; done" })' } } }] }),
  { type: 'compaction', time: { created: T0 + 3 * 60e3 }, status: 'completed' },
  { type: 'compaction', time: { created: T0 + 4 * 60e3 }, status: 'failed' },
  turn(30, { content: [{ type: 'tool', name: 'shell', state: { status: 'completed', input: { command: 'bun test' } } }] }),
];

let auth: string | null = null;
const server = Bun.serve({
  port: 0,
  fetch(req) {
    auth = req.headers.get('authorization');
    const url = new URL(req.url);
    if (url.pathname === '/api/session/ses_child/message') return Response.json({ data: messages });
    return new Response('not found', { status: 404 });
  },
});
afterAll(() => server.stop(true));
mkdirSync(join(dir, 'state', 'opencode'), { recursive: true });
writeFileSync(join(dir, 'state', 'opencode', 'service.json'), JSON.stringify({ url: server.url.href, password: 'pw' }));

test('an OpenCode session id is read through the service: turns, tokens with reasoning as output, completed compactions, wall time, polls', async () => {
  const r = await run(['ses_child']);
  expect(r).toEqual({
    code: 0,
    out: 'cost ses_child: 3 turns, 3.0M cache-read, 0.1M cache-create, 12k out, 1 compactions, 30 min, floor 1021k, ctx 1021k/turn, polls 2',
    err: '',
  });
  expect(auth).toBe(`Basic ${btoa('opencode:pw')}`);
});

test('an unknown OpenCode session, or no service, fails with the cause', async () => {
  const unknown = await run(['ses_gone']);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain('no OpenCode session ses_gone');
  const none = await run(['ses_child'], { XDG_STATE_HOME: join(dir, 'nowhere') });
  expect(none.code).toBe(1);
  expect(none.err).toContain('no OpenCode service registered');
});

test('a Claude Code agent id is read from its transcript, each message counted once', async () => {
  const projects = join(dir, 'projects');
  const sub = join(projects, 'repo', 'sess', 'subagents');
  mkdirSync(sub, { recursive: true });
  const usage = { input_tokens: 10, cache_read_input_tokens: 500_000, cache_creation_input_tokens: 10_000, output_tokens: 2000 };
  const lines = [
    { type: 'user', timestamp: '2026-11-06T10:00:00Z' },
    { type: 'assistant', timestamp: '2026-11-06T10:01:00Z', message: { id: 'm1', usage, content: [{ type: 'text' }] } },
    { type: 'assistant', timestamp: '2026-11-06T10:01:00Z', message: { id: 'm1', usage, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 30' } }] } },
    { type: 'system', subtype: 'compact_boundary', timestamp: '2026-11-06T10:05:00Z' },
    { type: 'assistant', timestamp: '2026-11-06T10:10:00Z', message: { id: 'm2', usage, content: [] } },
  ];
  writeFileSync(join(sub, 'agent-a1b2.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  expect(await run(['a1b2', '--projects', projects])).toEqual({
    code: 0,
    out: 'cost a1b2: 2 turns, 1.0M cache-read, 0.0M cache-create, 4k out, 1 compactions, 10 min, floor 510k, ctx 510k/turn, polls 1',
    err: '',
  });
  expect((await run(['zzz', '--projects', projects])).code).toBe(1);
});
