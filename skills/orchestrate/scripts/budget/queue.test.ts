import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Session, Ticket } from './host.ts';
import { LIFE, live, order, serve, update } from './queue.ts';

const NOW = 1_000_000_000;
const ticket = (id: string, session: string, at: number, more: Partial<Ticket> = {}): Ticket => ({
  id,
  session,
  project: 'gent',
  kind: 'w:task',
  description: id,
  estimateWph: 20,
  host: 'mac',
  at,
  beat: NOW,
  ...more,
});
const agent = (session: string, recentWph = 10): Session => ({ session, project: 'gent', kind: 'w:task', sub: true, recentWph });

describe('order', () => {
  test('serves the earliest request among sessions that run as many agents', () => {
    expect(order([ticket('b', 's2', 2), ticket('a', 's1', 1)], []).map((t) => t.id)).toEqual(['a', 'b']);
  });
  test('serves the session that runs the fewest agents first, granted ones included', () => {
    const tickets = [ticket('a', 's1', 1), ticket('b', 's2', 2), ticket('g', 's3', 0, { granted: NOW })];
    expect(order(tickets, [agent('s1')]).map((t) => t.id)).toEqual(['b', 'a']);
    expect(order([...tickets, ticket('c', 's3', 3)], [agent('s1')]).map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('serve', () => {
  const base = { sessions: [agent('s1', 50)], targetWph: 100 };
  test('a request behind another waits, though it fits', () => {
    const first = ticket('a', 's2', 1, { estimateWph: 90 });
    const d = serve({ ...base, ticket: ticket('b', 's3', 2), tickets: [first] });
    expect(d).toMatchObject({ ok: false, ahead: 1 });
  });
  test('the head goes once it fits the pace', () => {
    const d = serve({ ...base, ticket: ticket('a', 's2', 1), tickets: [] });
    expect(d).toMatchObject({ ok: true, ahead: 0 });
  });
  test("a granted request holds its room until its agent's burn shows", () => {
    const d = serve({ ...base, ticket: ticket('b', 's3', 2), tickets: [ticket('a', 's2', 1, { granted: NOW, estimateWph: 40 })] });
    expect(d.ok).toBe(false);
  });
  test('a new session goes before a busy one that asked first', () => {
    const busy = ticket('a', 's1', 1);
    expect(serve({ ...base, ticket: ticket('b', 's2', 2), tickets: [busy] })).toMatchObject({ ok: true, ahead: 0 });
  });
});

describe('live', () => {
  test('a waiter beats, a grant waits for its Agent call, a start for the transcripts', () => {
    expect(live(ticket('a', 's', 0, { beat: NOW - LIFE.beat + 1 }), NOW)).toBe(true);
    expect(live(ticket('a', 's', 0, { beat: NOW - LIFE.beat }), NOW)).toBe(false);
    expect(live(ticket('a', 's', 0, { beat: 0, granted: NOW - LIFE.granted + 1 }), NOW)).toBe(true);
    expect(live(ticket('a', 's', 0, { granted: NOW - 1, started: NOW - LIFE.started }), NOW)).toBe(false);
  });
});

describe('update', () => {
  test('keeps what a change leaves and drops dead tickets', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'queue-')), 'queue.json');
    update(path, NOW, (tickets) => tickets.push(ticket('a', 's1', 1), ticket('dead', 's2', 1, { beat: 0 })));
    expect(update(path, NOW, (tickets) => tickets.map((t) => t.id))).toEqual(['a']);
  });
});
