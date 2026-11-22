// Every history one item can have within a step, as sequences of events, and the records they reach (batch 22v:
// every record the model rejects must be one no history reaches, or one two definitions exclude). ending.test.ts
// compares the records reached here with the records ending.ts's VALIDITY accepts: the two sets are equal.
//
// An item starts with one of two events and then takes any events whose precondition holds, in any order; the step
// may stop after any event, so every record along the way is reached.
//   assign(required | optional)   a spec item, the worker's task, or a verifier's wider probe (optional: verifier only)
//   discover(provenance)          a finding outside the assignment; nothing happens to it after
//   attempt → result              from `advance`: none yet (interrupted), pass, fail or unclear
//   retry becomes unavailable     after an unclear result, for a verifier's check: no retry can settle it here
//   wait opens / closes           from `advance` / back to it
//   refusal                       answers an attempt from `advance`; the step stops on it, nothing follows
//   host probe fails / recovers   from `advance` / back to it
import { type Attempt, type Disposition, type Item, type Provenance, type Role } from './ending.ts';

export interface Event {
  readonly name: string;
  /** The record after the event, or undefined when its precondition does not hold. */
  readonly apply: (role: Role, item: Item) => Item | undefined;
}

const from = (now: Disposition, item: Item, next: Partial<Item>): Item | undefined => (item.assigned && item.now === now ? { ...item, ...next } : undefined);

/** What an attempt's result leaves the item able to do. */
function after(role: Role, result: Attempt): Disposition {
  if (result === 'pass') return 'settled';
  if (result === 'fail') return role === 'verifier' ? 'settled' : 'advance';
  return 'advance';
}

export const EVENTS: ReadonlyArray<Event> = [
  ...(['started', 'pass', 'fail', 'unclear'] as const).map(
    (result): Event => ({ name: `attempt → ${result === 'started' ? 'no result yet' : result}`, apply: (role, item) => from('advance', item, { attempt: result, now: after(role, result) }) }),
  ),
  { name: 'retry becomes unavailable', apply: (role, item) => (role === 'verifier' && item.attempt === 'unclear' ? from('advance', item, { now: 'settled' }) : undefined) },
  { name: 'wait opens', apply: (_, item) => from('advance', item, { now: 'wait' }) },
  { name: 'wait closes', apply: (_, item) => from('wait', item, { now: 'advance' }) },
  { name: 'refusal', apply: (_, item) => from('advance', item, { now: 'refused', attempt: item.attempt === 'never' ? 'started' : item.attempt }) },
  { name: 'host probe fails', apply: (_, item) => from('advance', item, { now: 'hostCannot' }) },
  { name: 'host recovers', apply: (_, item) => from('hostCannot', item, { now: 'advance' }) },
];

/** The records an item starts as. */
export function starts(role: Role): Item[] {
  const fresh = { attempt: 'never' as const, now: 'advance' as const, provenance: 'none' as const };
  const assigned: Item[] = [{ assigned: true, required: true, ...fresh }, ...(role === 'verifier' ? [{ assigned: true, required: false, ...fresh }] : [])];
  const found: ReadonlyArray<Provenance> = role === 'verifier' ? ['unit', 'base'] : ['none'];
  return [...assigned, ...found.map((provenance): Item => ({ assigned: false, required: false, attempt: 'never', now: 'settled', provenance }))];
}

const key = (item: Item) => `${item.assigned}/${item.required}/${item.attempt}/${item.now}/${item.provenance}`;

/** Every record some history reaches, with one shortest history that reaches each. */
export function reachable(role: Role, events: ReadonlyArray<Event> = EVENTS): Map<string, { item: Item; history: string[] }> {
  const seen = new Map<string, { item: Item; history: string[] }>();
  const queue = starts(role).map((item) => ({ item, history: [item.assigned ? `assign(${item.required ? 'required' : 'optional'})` : `discover(${item.provenance})`] }));
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || seen.has(key(next.item))) continue;
    seen.set(key(next.item), next);
    for (const event of events) {
      const item = event.apply(role, next.item);
      if (item !== undefined && !seen.has(key(item))) queue.push({ item, history: [...next.history, event.name] });
    }
  }
  return seen;
}

export const recordKey = key;
