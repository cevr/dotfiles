import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleaner } from './classify.ts';
import { countChildren, modelLabel, opencodeDigest, opencodeSession, serviceEndpoint, toolOf, type SessionInfo } from './opencode.ts';

const T0 = Date.parse('2026-11-04T10:00:00Z');
const at = (min: number) => ({ created: T0 + min * 60e3 });
const opts = { since: T0, clean: cleaner(true), skillDirs: new Set(['dream', 'retro']) };
const opus = { id: 'claude-opus-5-5', providerID: 'anthropic', variant: 'medium' };
const root: SessionInfo = { id: 'ses_root', agent: 'build', model: opus, time: { created: T0, updated: T0 + 3600e3 }, location: { directory: '/work/app' } };
const child: SessionInfo = { ...root, id: 'ses_kid', parentID: 'ses_root', agent: 'implementor', model: { ...opus, variant: 'default' } };

const assistant = (min: number, extra: object = {}) => ({
  type: 'assistant',
  time: at(min),
  agent: 'build',
  model: opus,
  tokens: { input: 10, output: 100, reasoning: 50, cache: { read: 1000, write: 200 } },
  cost: 0.5,
  content: [],
  ...extra,
});

// The messages of one root session, in the API's projected shapes.
const rootMessages = [
  { type: 'user', time: { created: T0 - 60e3 }, text: 'before the window: never counted' },
  assistant(-1),
  { type: 'user', time: at(1), text: 'Run the $dream please, read the digests not the transcripts', skills: [] },
  { type: 'user', time: at(2), text: 'You were restarted: the OpenCode binary was updated. Resume where you left off.' },
  { type: 'user', time: at(3), text: '/retro last session' },
  assistant(4, {
    content: [
      { type: 'tool', name: 'read', state: { status: 'completed', input: { path: '/x/skills/retro/SKILL.md' } } },
      { type: 'tool', name: 'kernel', state: { status: 'error', input: { code: 'await tools.edit({ path: "/a/b.ts", oldString: "x" })' }, error: { type: 'tool.execution', message: 'Error: Could not find oldString in /a/b.ts.' } } },
      { type: 'tool', name: 'kernel', state: { status: 'completed', input: { code: 'const r = await tools.subagent({ agent: "implementor", description: "implementor u r1" })' } } },
    ],
  }),
  assistant(5, { error: { type: 'provider.rate-limit', message: 'The pooled Anthropic login cannot be used for 300s' } }),
  assistant(6, { error: { type: 'aborted', message: 'Step interrupted' } }),
  { type: 'compaction', time: at(7), status: 'completed', reason: 'auto' },
  { type: 'compaction', time: at(8), status: 'failed', reason: 'auto' },
  { type: 'synthetic', time: at(9), metadata: { source: 'subagent', childID: 'ses_kid' }, text: '<subagent ...>' },
  { type: 'synthetic', time: at(10), metadata: { source: 'mail' }, text: 'From the planner session: unit two is ready' },
  { type: 'skill', time: at(11), name: 'orchestrate', skill: 'orchestrate' },
  assistant(11, {
    content: [
      { type: 'tool', name: 'skill', state: { status: 'completed', input: { id: 'effect' } } },
      { type: 'tool', name: 'kernel', state: { status: 'completed', input: { code: 'await tools.skill({ id: "effect" })' } } },
    ],
  }),
  ...[1, 2, 3, 4].map((n) => assistant(11 + n, { content: [{ type: 'tool', name: 'kernel', state: { status: 'completed', input: { code: 'await tools.read({ path: "/x/plan.md" })' } } }] })),
];

describe('opencodeSession', () => {
  const { session: s, messages } = opencodeSession(root, rootMessages, opts);

  test('counts only the window, the owner apart from peers, and tokens with reasoning as output', () => {
    expect(s).toMatchObject({ src: 'opencode', project: '/work/app', sub: false, agent: 'build', model: 'claude-opus-5-5@medium' });
    expect(s.human).toBe(1);
    expect(s.peer).toBe(2); // the restart notice and the mail
    expect(s.slash).toEqual({ retro: 1 });
    // 8 assistant messages in the window, one before it
    expect({ input: s.input, read: s.cacheRead, write: s.cacheWrite, output: s.output, cost: s.cost }).toEqual({ input: 80, read: 8000, write: 1600, output: 1200, cost: 4 });
    expect(s.first).toBe(new Date(T0 + 60e3).toISOString());
  });

  test('counts completed compactions, limit and interrupt errors, subagent calls and tool errors by tool', () => {
    expect(s.compactions).toBe(1);
    expect(s.limits).toBe(1);
    expect(s.interrupts).toBe(1);
    expect(s.agents).toBe(1);
    expect(s.toolErrors).toEqual({ 'kernel:edit': 1 });
    expect(s.notices).toEqual({ subagent: 1, mail: 1 });
  });

  test('skills: a skill message, a skill call direct or in a cell, a SKILL.md read, a $ mention and a slash command', () => {
    expect(s.skills).toEqual({ orchestrate: 1, effect: 2, retro: 1, dream: 1 });
    expect(s.rereads).toEqual({ '/x/plan.md': 4 });
  });

  test('writes the owner message, the slash, the peers, the limit, the interrupt and the tool error', () => {
    expect(messages.map((m) => m.kind)).toEqual(['msg', 'peer', 'slash', 'tool-error', 'limit', 'interrupt', 'peer']);
    expect(messages[0]!.text).toStartWith('Run the $dream');
    expect(messages[3]!.text).toContain('kernel:edit: tool.execution: Error: Could not find oldString');
  });

  test("a child's user turns are its brief, never the owner's", () => {
    const r = opencodeSession(child, [{ type: 'user', time: at(1), text: 'Implement round 1 of /r/u/spec.md' }, assistant(2)], opts);
    expect(r.session).toMatchObject({ sub: true, parent: 'ses_root', human: 0, peer: 0, model: 'claude-opus-5-5@medium' });
    expect(r.messages).toEqual([]);
  });

  test('a root counts the children that name it, when its calls show fewer', () => {
    const kids = [opencodeSession(child, [], opts).session, opencodeSession({ ...child, id: 'ses_kid2' }, [], opts).session];
    const all = [s, ...kids];
    countChildren(all);
    expect(s.agents).toBe(2);
  });

  test('the digest groups by role and model and by error shape', () => {
    const text = opencodeDigest([s, opencodeSession(child, [assistant(2)], opts).session], messages).join('\n');
    expect(text).toContain('| root:build | claude-opus-5-5@medium | 1 |');
    expect(text).toContain('| implementor | claude-opus-5-5@medium | 1 |');
    expect(text).toContain('kernel:edit 1');
    expect(text).toContain('1x in 1 sessions: kernel:edit: tool.execution: Error: Could not find oldString in /…');
  });
});

test('modelLabel and toolOf', () => {
  expect(modelLabel({ id: 'gpt-6.1-sol', variant: 'high' })).toBe('gpt-6.1-sol@high');
  expect(modelLabel({ id: 'claude-opus-5-5', variant: 'default' })).toBe('claude-opus-5-5');
  expect(toolOf('shell', {})).toBe('shell');
  expect(toolOf('kernel', { code: 'await tools.read({path:"a"}); await tools.shell({command:"ls"})' })).toBe('kernel');
});

test('serviceEndpoint reads the registration and builds basic auth', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-svc-'));
  const file = join(dir, 'service.json');
  writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:1', password: 'pw' }));
  expect(serviceEndpoint(file)).toEqual({ url: 'http://127.0.0.1:1', authorization: `Basic ${btoa('opencode:pw')}` });
  expect(serviceEndpoint(join(dir, 'missing.json'))).toBeUndefined();
});
