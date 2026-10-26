// The agent queue: each Agent call the pace holds waits here for its turn,
// across every host on the account pool, so no agent sets a timer to try again.
//
// Each host keeps its own tickets in ~/.cache/orchestrate/queue.json, and
// host.ts reports them with the host's load, so every host sees every live
// ticket and all agree on one order. A host grants only its own tickets, and
// only the one at the head.
//
// Order: the session that runs the fewest agents (running or granted) first,
// then the earliest request. Each open session gets its next agent in turn, and
// a session with none running goes before one that has some.
//
// A held Agent call queues a ticket (budget.ts --admit). Its waiter (budget.ts
// --wait <id>, a background command) keeps the ticket alive and exits when the
// ticket is granted. The session's next Agent call with the same type and
// description then starts at once and marks the ticket started. A granted or
// started ticket holds its estimate in the pace until the agent's own burn
// shows in the transcripts.

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Session, Ticket } from './host.ts';
import { admit, type Decision } from './pace.ts';

const MINUTE = 60e3;

/** How long a ticket lives: a waiter beats every poll, a grant waits for its Agent call, a start for the transcripts. */
export const LIFE = { beat: 2 * MINUTE, granted: 5 * MINUTE, started: MINUTE };

export function live(t: Ticket, now: number): boolean {
  if (t.started !== undefined) return now - t.started < LIFE.started;
  if (t.granted !== undefined) return now - t.granted < LIFE.granted;
  return now - t.beat < LIFE.beat;
}

const granted = (tickets: readonly Ticket[]) => tickets.filter((t) => t.granted !== undefined);

/** The waiting tickets in serving order. */
export function order(tickets: readonly Ticket[], sessions: readonly Session[]): Ticket[] {
  const held = new Map<string, number>();
  const hold = (session: string) => held.set(session, (held.get(session) ?? 0) + 1);
  for (const s of sessions) if (s.sub) hold(s.session);
  for (const t of granted(tickets)) hold(t.session);
  const load = (t: Ticket) => held.get(t.session) ?? 0;
  return tickets
    .filter((t) => t.granted === undefined)
    .sort((a, b) => load(a) - load(b) || a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Whether a waiting `ticket` goes now: it heads the queue and its estimate fits the pace. */
export function serve(input: {
  ticket: Ticket;
  tickets: readonly Ticket[];
  sessions: readonly Session[];
  targetWph: number;
  cap?: number;
}): Decision & { ahead: number } {
  const { ticket, sessions, targetWph, cap } = input;
  const tickets = input.tickets.some((t) => t.id === ticket.id) ? input.tickets : [...input.tickets, ticket];
  const ahead = order(tickets, sessions).findIndex((t) => t.id === ticket.id);
  if (ahead > 0) return { ok: false, ahead, reason: `${ahead} request(s) ahead of this one` };
  return { ...admit({ targetWph, sessions, reserved: granted(tickets), estimateWph: ticket.estimateWph, cap }), ahead: 0 };
}

// ── This host's store ──

const LOCK_STALE = 10e3;

function lock(path: string): () => void {
  const dir = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const until = Date.now() + 5e3;
  for (;;) {
    try {
      mkdirSync(dir);
      return () => rmSync(dir, { recursive: true, force: true });
    } catch {
      try {
        if (Date.now() - statSync(dir).mtimeMs > LOCK_STALE) rmSync(dir, { recursive: true, force: true });
      } catch {}
      if (Date.now() > until) throw new Error(`queue lock ${dir} held over 5 s`);
      Bun.sleepSync(20);
    }
  }
}

/** Runs `change` on this host's live tickets under the lock, and writes the tickets it leaves. */
export function update<T>(path: string, now: number, change: (tickets: Ticket[]) => T): T {
  const release = lock(path);
  try {
    let tickets: Ticket[] = [];
    try {
      tickets = (JSON.parse(readFileSync(path, 'utf8')) as { tickets?: Ticket[] }).tickets ?? [];
    } catch {}
    tickets = tickets.filter((t) => live(t, now));
    const result = change(tickets);
    const tmp = `${path}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ tickets }));
    renameSync(tmp, path);
    return result;
  } finally {
    release();
  }
}
