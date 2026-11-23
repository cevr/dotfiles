// Histories the rendered label list must answer (batch 22w): each is what happened to one item, the record (or, where
// two obstacles hold at once, the records) it leaves, the state and label the list must give, and what the hand-back
// must hold. ending.test.ts reads every prompt's list back and evaluates these on it; the swap mutants there must turn
// one of them red. Grouped by the kinds 22w had not tried: an obstacle that appears and clears, two obstacles at once,
// a wait on a retry, a refusal lifted, a tool that returns after a host change, discovery mid-retry, reassignment.
import type { Item, Role, State } from './ending.ts';

export interface ListHistory {
  readonly name: string;
  readonly role: Role;
  /** What happened, in order. */
  readonly events: string;
  /** The item at the end; two records when two obstacles hold at once (every atom true of either is true of it). */
  readonly items: ReadonlyArray<Item>;
  readonly state: State;
  /** Words the label must hold. */
  readonly label: string;
  /** What the hand-back must contain for this item. */
  readonly handBack: string;
}

const item = (facts: Partial<Item>): Item => ({ assigned: false, required: false, attempt: 'never', now: 'settled', provenance: 'none', ...facts });
const work = (facts: Partial<Item>): Item => item({ assigned: true, required: true, now: 'advance', ...facts });
const probe = (facts: Partial<Item>): Item => work({ required: false, ...facts });

export const LIST_HISTORIES: ReadonlyArray<ListHistory> = [
  // 22w's own: an unclear result, then the obstacle that now governs.
  { name: 'W01 a check printed HTML instead of a compiler result, then the compiler left this host', role: 'verifier', events: 'attempt → unclear; host probe fails', items: [work({ attempt: 'unclear', now: 'hostCannot' })], state: 'cannot', label: '`cannot run here:', handBack: 'cannot run here: the compiler, with its command and output; and the HTML its attempt printed' },
  { name: 'W03 a truncated log, then a permission refusal on the retry', role: 'verifier', events: 'attempt → unclear; refusal', items: [work({ attempt: 'unclear', now: 'refused' })], state: 'refused', label: '`refused: <what>`', handBack: 'refused: what, as the refusal said it; and the truncated log its attempt printed' },
  { name: 'a retry of an unclear check waits on a question', role: 'verifier', events: 'attempt → unclear; wait opens', items: [work({ attempt: 'unclear', now: 'wait' })], state: 'waits', label: '`waits on <id>`', handBack: 'waits on the question id; and the unclear output its attempt printed' },
  { name: 'an interrupted check, then the host cannot run it', role: 'verifier', events: 'attempt → no result yet; host probe fails', items: [work({ attempt: 'started', now: 'hostCannot' })], state: 'cannot', label: '`cannot run here:', handBack: 'cannot run here: the tool, with its command and output; and what the interrupted attempt printed' },
  { name: 'an interrupted check, then a wait opens on its rerun', role: 'verifier', events: 'attempt → no result yet; wait opens', items: [work({ attempt: 'started', now: 'wait' })], state: 'waits', label: '`waits on <id>`', handBack: 'waits on the id; and what the interrupted attempt printed' },
  { name: 'an optional probe proves a Blocker', role: 'verifier', events: 'assign(optional); attempt → fail', items: [probe({ attempt: 'fail', now: 'settled' })], state: 'proven', label: 'a Blocker or Major', handBack: 'the Blocker, filed with its proof' },
  { name: 'an optional probe passes after an earlier unclear run', role: 'verifier', events: 'assign(optional); attempt → unclear; attempt → pass', items: [probe({ attempt: 'pass', now: 'settled' })], state: 'done', label: 'none: it is no item left', handBack: 'nothing for the probe' },
  // An obstacle that appears and then clears.
  { name: 'a host probe fails, then the host recovers, before any attempt', role: 'verifier', events: 'host probe fails; host recovers', items: [work({})], state: 'runnable', label: '`not run`', handBack: 'not run, named under Check' },
  { name: 'a wait opens and closes around a retry of an unclear check', role: 'verifier', events: 'attempt → unclear; wait opens; wait closes', items: [work({ attempt: 'unclear' })], state: 'runnable', label: '`retry: <check>`', handBack: 'retry: the check, named under Check; and the unclear output its attempt printed' },
  { name: 'the gate cannot run, the host recovers, the gate is not yet rerun', role: 'implementor', events: 'attempt → fail; host probe fails; host recovers', items: [work({ attempt: 'fail' })], state: 'runnable', label: '`continues next round`', handBack: 'continues next round; and the failing gate output its attempt printed' },
  // Two obstacles at once.
  { name: 'a refusal arrives while this host also cannot run the check', role: 'verifier', events: 'attempt → unclear; host probe fails and a refusal comes on the same check', items: [work({ attempt: 'unclear', now: 'refused' }), work({ attempt: 'unclear', now: 'hostCannot' })], state: 'refused', label: '`refused: <what>`', handBack: 'refused: what, as the refusal said it; and the unclear output its attempt printed' },
  { name: 'the tool is absent and the check also waits on an open unit', role: 'verifier', events: 'host probe fails while a wait is open', items: [work({ now: 'hostCannot' }), work({ now: 'wait' })], state: 'cannot', label: '`cannot run here:', handBack: 'cannot run here: the tool, with its command and output' },
  { name: 'a spec item waits on a question and its retry is refused', role: 'implementor', events: 'attempt → fail; wait opens; a refusal comes on the retry', items: [work({ attempt: 'fail', now: 'refused' }), work({ attempt: 'fail', now: 'wait' })], state: 'refused', label: '`refused: <what>`', handBack: 'refused: what; and the failing output its attempt printed' },
  { name: 'an optional probe refused while its tool is also absent', role: 'verifier', events: 'assign(optional); a refusal comes; host probe fails', items: [probe({ attempt: 'started', now: 'refused' }), probe({ attempt: 'started', now: 'hostCannot' })], state: 'unproven', label: '`unproven: <probe>`', handBack: 'unproven: the probe, with the probe that would settle it' },
  // A wait that opens on a retry.
  { name: 'the gate failed and its retry waits on the orchestrator', role: 'implementor', events: 'attempt → fail; wait opens', items: [work({ attempt: 'fail', now: 'wait' })], state: 'waits', label: '`waits on <id>`', handBack: 'waits on the id; and the failing output its attempt printed' },
  // A refusal lifted by the orchestrator.
  { name: 'a refused check, the orchestrator grants the rule, the rerun passes', role: 'verifier', events: 'refusal; the orchestrator lifts it; attempt → pass', items: [work({ attempt: 'pass', now: 'settled' })], state: 'done', label: 'none: it is no item left', handBack: 'nothing for the check' },
  { name: 'a refused check, the rule granted, the rerun prints an unclear result and can retry', role: 'verifier', events: 'refusal; lifted; attempt → unclear', items: [work({ attempt: 'unclear' })], state: 'runnable', label: '`retry: <check>`', handBack: 'retry: the check; and the unclear output its attempt printed' },
  { name: 'a refused task, the rule granted, not yet rerun', role: 'worker', events: 'refusal; lifted', items: [work({ attempt: 'started' })], state: 'runnable', label: '`left`', handBack: 'left; and what the refused attempt printed' },
  // A tool that returns after a host change.
  { name: 'the tool returns after a host change, the task not yet rerun', role: 'worker', events: 'host probe fails; the host changes; host recovers', items: [work({})], state: 'runnable', label: '`left`', handBack: 'left, named in the result' },
  { name: 'the tool returns, the rerun is unclear and no retry can settle it here', role: 'verifier', events: 'host probe fails; host recovers; attempt → unclear; retry becomes unavailable', items: [work({ attempt: 'unclear', now: 'settled' })], state: 'unclear', label: '`ran unclear: <check>`', handBack: 'ran unclear: the check, with its command and the output that settles nothing' },
  { name: 'the tool returns and the rerun proves a Blocker', role: 'verifier', events: 'host probe fails; host recovers; attempt → fail', items: [work({ attempt: 'fail', now: 'settled' })], state: 'proven', label: 'a Blocker or Major', handBack: 'the Blocker, filed with its proof' },
  // Discovery mid-retry.
  { name: 'while retrying, the verifier finds a defect the base head shows too', role: 'verifier', events: 'discover(base) during a retry', items: [item({ provenance: 'base' })], state: 'baseFinding', label: 'marked `base`', handBack: 'the finding, marked base: a follow-up unit' },
  { name: 'while retrying, the verifier finds a defect the unit introduced', role: 'verifier', events: 'discover(unit) during a retry', items: [item({ provenance: 'unit' })], state: 'unitFinding', label: 'marked `unit`', handBack: 'the finding, marked unit: the same lane closes it' },
  { name: 'while rerunning the gate, the implementor finds an unrelated defect', role: 'implementor', events: 'discover during a retry', items: [item({})], state: 'discovery', label: '`finding outside the unit`', handBack: 'the finding, in state.md under Follow-ups' },
  // An item reassigned.
  { name: 'a spec item moved to another unit by the orchestrator', role: 'implementor', events: 'assign(required); attempt → fail; the orchestrator moves it to another unit', items: [item({})], state: 'discovery', label: '`finding outside the unit`', handBack: 'the item, in state.md under Follow-ups, naming the unit it moved to' },
  { name: 'a finding the orchestrator adds to this unit', role: 'planner', events: 'discover; the orchestrator adds it to the spec', items: [work({})], state: 'runnable', label: '`continues next round`', handBack: 'continues next round' },
  { name: 'the acceptance holds once the wait closes', role: 'planner', events: 'wait opens; wait closes; attempt → pass', items: [work({ attempt: 'pass', now: 'settled' })], state: 'done', label: 'none: it is no item left', handBack: 'nothing for the item' },
];
