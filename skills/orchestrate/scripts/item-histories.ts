// Every history one item can have within a step, as sequences of events, and the records they reach (batch 22v:
// every record the model rejects must be one no history reaches, or one two definitions exclude). ending.test.ts
// compares the records reached here with the records ending.ts's VALIDITY accepts: the two sets are equal. It also
// computes, from every record reached here, which rows of each prompt's list can be true together (batch 23b).
//
// An item starts with one of two events and then takes any events whose precondition holds, in any order; the step
// may stop after any event, so every record along the way is reached. The obstacles are independent facts: each
// opens and closes on its own, so any subset of them can hold at once.
//   assign(required | optional)   a spec item, the worker's task, or a verifier's wider probe (optional: verifier only)
//   discover(provenance)          a finding outside the assignment; nothing happens to it after
//   attempt → result              from an unsettled item no obstacle holds: none yet (interrupted), pass, fail or unclear
//   retry becomes unavailable     after an unclear result, for a verifier's check no obstacle holds: no retry can settle it
//   wait opens / closes           on an unsettled item, whatever else holds
//   refusal / refusal lifted      a refusal answers an attempt (a never-attempted item becomes attempted, no result
//                                 yet), on an unsettled item whatever else holds; the orchestrator may lift it
//   host probe fails / recovers   on an unsettled item, whatever else holds
import { type Attempt, type Item, obstructed, type Provenance, type Role } from './ending.ts';

export interface Event {
  readonly name: string;
  /** The record after the event, or undefined when its precondition does not hold. */
  readonly apply: (role: Role, item: Item) => Item | undefined;
}

/** The record after `next`, when the item is assigned work still open and `when` holds. */
const open = (item: Item, when: boolean, next: Partial<Item>): Item | undefined => (item.assigned && !item.settled && when ? { ...item, ...next } : undefined);

/** Whether an attempt's result settles the item. */
const settles = (role: Role, result: Attempt) => result === 'pass' || (result === 'fail' && role === 'verifier');

export const EVENTS: ReadonlyArray<Event> = [
  ...(['started', 'pass', 'fail', 'unclear'] as const).map(
    (result): Event => ({ name: `attempt → ${result === 'started' ? 'no result yet' : result}`, apply: (role, item) => open(item, !obstructed(item), { attempt: result, settled: settles(role, result) }) }),
  ),
  { name: 'retry becomes unavailable', apply: (role, item) => open(item, role === 'verifier' && item.attempt === 'unclear' && !obstructed(item), { settled: true }) },
  { name: 'wait opens', apply: (_, item) => open(item, !item.wait, { wait: true }) },
  { name: 'wait closes', apply: (_, item) => open(item, item.wait, { wait: false }) },
  { name: 'refusal', apply: (_, item) => open(item, !item.refused, { refused: true, attempt: item.attempt === 'never' ? 'started' : item.attempt }) },
  { name: 'refusal lifted', apply: (_, item) => open(item, item.refused, { refused: false }) },
  { name: 'host probe fails', apply: (_, item) => open(item, !item.hostCannot, { hostCannot: true }) },
  { name: 'host recovers', apply: (_, item) => open(item, item.hostCannot, { hostCannot: false }) },
];

/** The records an item starts as. */
export function starts(role: Role): Item[] {
  const fresh = { attempt: 'never' as const, settled: false, refused: false, hostCannot: false, wait: false, provenance: 'none' as const };
  const assigned: Item[] = [{ assigned: true, required: true, ...fresh }, ...(role === 'verifier' ? [{ assigned: true, required: false, ...fresh }] : [])];
  const found: ReadonlyArray<Provenance> = role === 'verifier' ? ['unit', 'base'] : ['none'];
  return [...assigned, ...found.map((provenance): Item => ({ ...fresh, assigned: false, required: false, settled: true, provenance }))];
}

const key = (item: Item) =>
  `${item.assigned}/${item.required}/${item.attempt}/${item.settled ? 'settled' : 'open'}/${[item.refused ? 'refused' : '', item.hostCannot ? 'hostCannot' : '', item.wait ? 'wait' : ''].filter(Boolean).join('+') || 'free'}/${item.provenance}`;

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
