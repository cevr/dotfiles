import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectFor as burnProjectFor } from './burn.ts';
import { currentKind, kindFor, projectFor as hostProjectFor } from './host.ts';

const HOST = join(import.meta.dir, 'host.ts');
const usage = { input_tokens: 100, output_tokens: 10 };
const reply = (id: string, stop: string) =>
  JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id, stop_reason: stop, usage } });

// host.ts over a projects folder with one session and the given subagents, in a fresh HOME.
function load(subs: Record<string, string[]>): { sessions: { sub: boolean }[] } {
  const home = mkdtempSync(join(tmpdir(), 'host-'));
  const dir = join(home, 'projects', '-repo', 's1', 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, 'projects', '-repo', 's1.jsonl'), reply('r1', 'end_turn') + '\n');
  for (const [name, lines] of Object.entries(subs)) writeFileSync(join(dir, `${name}.jsonl`), lines.join('\n') + '\n');
  const run = Bun.spawnSync(['bun', HOST, '--projects', join(home, 'projects')], { env: { ...process.env, HOME: home } });
  return JSON.parse(run.stdout.toString());
}

describe('hostLoad', () => {
  test('a subagent that has reported back holds no slot; a root waiting on its owner still counts', () => {
    const { sessions } = load({
      'agent-a': [reply('m1', 'tool_use'), reply('m2', 'end_turn')],
      'agent-b': [reply('m1', 'end_turn'), reply('m2', 'tool_use')],
    });
    expect(sessions.filter((s) => s.sub)).toHaveLength(1);
    expect(sessions.filter((s) => !s.sub)).toHaveLength(1);
  });

  test('a subagent its owner stopped holds no slot', () => {
    const stopped = JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    });
    const { sessions } = load({ 'agent-a': [reply('m1', 'tool_use'), stopped] });
    expect(sessions.filter((s) => s.sub)).toHaveLength(0);
  });
});

test("a role agent keeps the worker's cost history in its role", () => {
  expect(kindFor('status:implementor', 'implementor auth r2')).toBe('worker:implement');
  expect(kindFor('verifier', 'verifier auth r2')).toBe('worker:verify');
  expect(kindFor('planner', 'anything')).toBe('worker:plan');
  // A role agent's former name is orchestrate-<role>.
  expect(kindFor('status:orchestrate-implementor', 'implementor auth r2')).toBe('worker:implement');
  expect(kindFor('orchestrate-verifier', 'verifier auth r2')).toBe('worker:verify');
  expect(kindFor('orchestrate-planner', 'anything')).toBe('worker:plan');
  expect(kindFor('status:worker', 'verify coldload r3')).toBe('worker:verify');
  // The reviewer is the verifier's former name: its cost history is the verifier's.
  expect(kindFor('status:orchestrate-reviewer', 'anything')).toBe('worker:verify');
  expect(kindFor('status:worker', 'reviewer coldload r3')).toBe('worker:verify');
  expect(kindFor(undefined, 'explore the docs')).toBe('agent:explore');
});

test('an agent and a cached tally under a former name count under the current one', () => {
  expect(kindFor('status:orchestrate-worker', 'explore the docs')).toBe('worker:explore');
  expect(currentKind('orchestrate-worker:implement')).toBe('worker:implement');
  expect(currentKind('worker:review')).toBe('worker:verify');
  expect(currentKind('Explore:task')).toBe('Explore:task');
});

// A seeded generator, so a failing case reruns the same.
function rng(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n) => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    s = (s ^ (s >>> 13)) >>> 0;
    return s % n;
  };
}
const NAME = 'abcxyz019-.';
function name(r: (n: number) => number): string {
  for (;;) {
    let s = '';
    for (let i = 0, len = 1 + r(10); i < len; i++) s += NAME[r(NAME.length)];
    // Not a path step, and not a folder either reader keys on.
    if (!['.', '..', '.work', '.rifts', 'orchestrate'].includes(s)) return s;
  }
}
const PREFIXES = ['', '/Users/x/Developer/personal', '/Users/x/Developer/work', '/workspaces', '/home/u/src'];
function dir(r: (n: number) => number): string {
  let d = PREFIXES[r(PREFIXES.length)];
  for (let i = 0, len = r(3); i < len; i++) d += `/${name(r)}`;
  return d;
}
function tail(r: (n: number) => number): string {
  const steps = ['', 'src', '.work-trash', 'node_modules/.cache', 'sub/.work', 'a.b-c'];
  const step = steps[r(steps.length)];
  return step ? `/${step}` : '';
}

describe.each([
  ['host.ts', hostProjectFor],
  ['burn.ts', burnProjectFor],
])('projectFor in %s', (_file, projectFor) => {
  test('a workspace under .work/<repo>/<name> is <repo>, as the Rift copy under .rifts/<repo>/<name> is', () => {
    const r = rng(0x5eed);
    for (let i = 0; i < 500; i++) {
      const [d, repo, ws, t] = [dir(r), name(r), name(r), tail(r)];
      const work = projectFor(undefined, `${d}/.work/${repo}/${ws}${t}`);
      expect(work, `${d}/.work/${repo}/${ws}${t}`).toBe(repo);
      expect(projectFor(undefined, `${d}/.rifts/${repo}/${ws}${t}`)).toBe(work);
    }
  });

  test('a path with neither shape keeps its answer; an orchestrate run wins over both', () => {
    expect(projectFor(undefined, '/Users/x/Developer/personal/dotfiles/opencode')).toBe('dotfiles');
    expect(projectFor(undefined, '/Users/x/Developer/work/bite.web')).toBe('bite.web');
    expect(projectFor(undefined, '/workspaces/bite/apps')).toBe('bite');
    expect(projectFor(undefined, '/Users/x/Developer/personal/.work-trash/dotfiles/a.1')).toBe('a.1');
    expect(projectFor(undefined, '/srv/thing')).toBe('thing');
    expect(projectFor(undefined, undefined)).toBe('unknown');
    expect(projectFor(undefined, '/tmp/orchestrate/run1/.work/dotfiles/a')).toBe('run1');
    expect(projectFor(undefined, '/tmp/orchestrate/run1/.rifts/dotfiles/a')).toBe('run1');
  });
});
