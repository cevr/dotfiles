// Histories the rendered label list must answer (batches 22w and 23b): each is what happened to one item, the record
// it leaves (its current obstacles are a set: two or three can hold at once), the state and label the list must give,
// and the hand-back, written here by hand as a structure. ending.test.ts finds the shortest generated history that
// reaches each record (item-histories.ts `traceFor`), decodes it as a step's envelope, derives the claim each delivered prompt's
// decoded policy owes (round-policy.ts `owed`) and checks it gives exactly this: the rule and label, the governing obstacle's field, every
// other obstacle's field, and attempt evidence exactly when there was an attempt. The swap mutants there turn one red.
import type { Role, State } from './round-policy.ts';
import type { Item } from './item-histories.ts';

/** An obstacle row, by its state. */
export type ObstacleRow = 'refused' | 'cannot' | 'waits';
/** What a history's hand-back must hold, in the abstract: its state, the label's opening words, the governing obstacle, every other obstacle that holds, and whether attempt evidence (`completed` or `current`) is due. The test decodes the shortest history reaching the record and checks `owed` gives exactly these. */
export interface HandBack {
  readonly state: State;
  readonly label: string;
  readonly evidence: ObstacleRow | null;
  readonly others: ReadonlyArray<ObstacleRow>;
  readonly lastAttempt: boolean;
}

export interface ListHistory {
  readonly name: string;
  readonly role: Role;
  /** What happened, in order. */
  readonly events: string;
  /** The item at the end. */
  readonly items: ReadonlyArray<Item>;
  readonly state: State;
  /** Words the label must hold. */
  readonly label: string;
  /** The hand-back for this item, field by field: the label's opening words stand for the label. */
  readonly handBack: HandBack;
}

const item = (facts: Partial<Item>): Item => ({ assigned: false, required: false, attempt: 'never', settled: true, refused: false, hostCannot: false, wait: false, provenance: 'none', ...facts });
const work = (facts: Partial<Item>): Item => item({ assigned: true, required: true, settled: false, ...facts });
const probe = (facts: Partial<Item>): Item => work({ required: false, ...facts });
/** A history whose hand-back is the state, the label's opening words, the governing obstacle, the others named, and whether the last attempt is given. */
const h = (name: string, role: Role, events: string, one: Item, state: State, label: string, evidence: ObstacleRow | null, others: ReadonlyArray<ObstacleRow>, lastAttempt: boolean): ListHistory => ({
  name,
  role,
  events,
  items: [one],
  state,
  label,
  handBack: { state, label, evidence, others, lastAttempt },
});

const CANNOT = '`cannot run here: <check or tool>`';
const REFUSED = '`refused: <what>`';
const WAITS = '`waits on <id>`';
const NONE = 'none: it is no item left';

export const LIST_HISTORIES: ReadonlyArray<ListHistory> = [
  // 22w's own: an unclear result, then the obstacle that now governs.
  h('W01 a check printed HTML instead of a compiler result, then the compiler left this host', 'verifier', 'attempt → unclear; host probe fails', work({ attempt: 'unclear', hostCannot: true }), 'cannot', CANNOT, 'cannot', [], true),
  h('W03 a truncated log, then a permission refusal on the retry', 'verifier', 'attempt → unclear; refusal', work({ attempt: 'unclear', refused: true }), 'refused', REFUSED, 'refused', [], true),
  h('a retry of an unclear check waits on a question', 'verifier', 'attempt → unclear; wait opens', work({ attempt: 'unclear', wait: true }), 'waits', WAITS, 'waits', [], true),
  h('an interrupted check, then the host cannot run it', 'verifier', 'attempt → no result yet; host probe fails', work({ attempt: 'started', hostCannot: true }), 'cannot', CANNOT, 'cannot', [], true),
  h('an interrupted check, then a wait opens on its rerun', 'verifier', 'attempt → no result yet; wait opens', work({ attempt: 'started', wait: true }), 'waits', WAITS, 'waits', [], true),
  h('an optional probe proves a Blocker', 'verifier', 'assign(optional); attempt → fail', probe({ attempt: 'fail', settled: true }), 'proven', 'a Blocker or Major', null, [], true),
  h('an optional probe passes after an earlier unclear run', 'verifier', 'assign(optional); attempt → unclear; attempt → pass', probe({ attempt: 'pass', settled: true }), 'done', NONE, null, [], true),
  // An obstacle that appears and then clears.
  h('a host probe fails, then the host recovers, before any attempt', 'verifier', 'host probe fails; host recovers', work({}), 'runnable', '`not run`', null, [], false),
  h('a wait opens and closes around a retry of an unclear check', 'verifier', 'attempt → unclear; wait opens; wait closes', work({ attempt: 'unclear' }), 'runnable', '`retry: <check>`', null, [], true),
  h('the gate cannot run, the host recovers, the gate is not yet rerun', 'implementor', 'attempt → fail; host probe fails; host recovers', work({ attempt: 'fail' }), 'runnable', '`continues next round`', null, [], true),
  // Two obstacles at once.
  h('a refusal arrives while this host also cannot run the check', 'verifier', 'attempt → unclear; host probe fails; refusal', work({ attempt: 'unclear', refused: true, hostCannot: true }), 'refused', REFUSED, 'refused', ['cannot'], true),
  h('the tool is absent and the check also waits on an open unit', 'verifier', 'wait opens; host probe fails', work({ hostCannot: true, wait: true }), 'cannot', CANNOT, 'cannot', ['waits'], false),
  h('a spec item waits on a question and its retry is refused', 'implementor', 'attempt → fail; wait opens; refusal', work({ attempt: 'fail', refused: true, wait: true }), 'refused', REFUSED, 'refused', ['waits'], true),
  h('an optional probe refused while its tool is also absent', 'verifier', 'assign(optional); refusal; host probe fails', probe({ attempt: 'started', refused: true, hostCannot: true }), 'refused', REFUSED, 'refused', ['cannot'], true),
  // A wait that opens on a retry.
  h('the gate failed and its retry waits on the orchestrator', 'implementor', 'attempt → fail; wait opens', work({ attempt: 'fail', wait: true }), 'waits', WAITS, 'waits', [], true),
  // A refusal lifted by the orchestrator.
  h('a refused check, the orchestrator grants the rule, the rerun passes', 'verifier', 'refusal; refusal lifted; attempt → pass', work({ attempt: 'pass', settled: true }), 'done', NONE, null, [], true),
  h('a refused check, the rule granted, the rerun prints an unclear result and can retry', 'verifier', 'refusal; refusal lifted; attempt → unclear', work({ attempt: 'unclear' }), 'runnable', '`retry: <check>`', null, [], true),
  h('a refused task, the rule granted, not yet rerun', 'worker', 'refusal; refusal lifted', work({ attempt: 'started' }), 'runnable', '`left`', null, [], true),
  // A tool that returns after a host change.
  h('the tool returns after a host change, the task not yet rerun', 'worker', 'host probe fails; host recovers', work({}), 'runnable', '`left`', null, [], false),
  h('the tool returns, the rerun is unclear and no retry can settle it here', 'verifier', 'host probe fails; host recovers; attempt → unclear; retry becomes unavailable', work({ attempt: 'unclear', settled: true }), 'unclear', '`ran unclear: <check>`', null, [], true),
  h('the tool returns and the rerun proves a Blocker', 'verifier', 'host probe fails; host recovers; attempt → fail', work({ attempt: 'fail', settled: true }), 'proven', 'a Blocker or Major', null, [], true),
  // Discovery mid-retry.
  h('while retrying, the verifier finds a defect the base head shows too', 'verifier', 'discover(base) during a retry', item({ provenance: 'base' }), 'baseFinding', 'marked `base`', null, [], false),
  h('while retrying, the verifier finds a defect the unit introduced', 'verifier', 'discover(unit) during a retry', item({ provenance: 'unit' }), 'unitFinding', 'marked `unit`', null, [], false),
  h('while rerunning the gate, the implementor finds an unrelated defect', 'implementor', 'discover during a retry', item({}), 'discovery', '`finding outside the unit`', null, [], false),
  // An item reassigned.
  h('a spec item moved to another unit by the orchestrator', 'implementor', 'assign(required); attempt → fail; the orchestrator moves it to another unit (it is now outside the assignment, as found)', item({}), 'discovery', '`finding outside the unit`', null, [], false),
  h('a finding the orchestrator adds to this unit', 'planner', 'discover; the orchestrator adds it to the spec', work({}), 'runnable', '`continues next round`', null, [], false),
  h('the acceptance holds once the wait closes', 'planner', 'wait opens; wait closes; attempt → pass', work({ attempt: 'pass', settled: true }), 'done', NONE, null, [], true),
  // 23b: two and three facts at once. Every pair of obstacles in every role, all three in several, a probe displaced by obstacles.
  h('M01 a refused preflight while the tool is also absent', 'verifier', 'host probe fails; refusal', work({ attempt: 'started', refused: true, hostCannot: true }), 'refused', REFUSED, 'refused', ['cannot'], true),
  h('M02 the tool is absent and the prerequisite unit is still open, never attempted', 'verifier', 'host probe fails; wait opens', work({ hostCannot: true, wait: true }), 'cannot', CANNOT, 'cannot', ['waits'], false),
  h('M03 a refused retry while a question is open', 'verifier', 'attempt → no result yet; wait opens; refusal', work({ attempt: 'started', refused: true, wait: true }), 'refused', REFUSED, 'refused', ['waits'], true),
  h('M04 partial JSON, then the compiler is gone, a question opens, and a refusal comes', 'verifier', 'attempt → unclear; host probe fails; wait opens; refusal', work({ attempt: 'unclear', refused: true, hostCannot: true, wait: true }), 'refused', REFUSED, 'refused', ['cannot', 'waits'], true),
  h('M05 an interrupted check with all three obstacles', 'verifier', 'attempt → no result yet; wait opens; host probe fails; refusal', work({ attempt: 'started', refused: true, hostCannot: true, wait: true }), 'refused', REFUSED, 'refused', ['cannot', 'waits'], true),
  h('M06 unclear output, then the tool is gone and a unit is open', 'verifier', 'attempt → unclear; host probe fails; wait opens', work({ attempt: 'unclear', hostCannot: true, wait: true }), 'cannot', CANNOT, 'cannot', ['waits'], true),
  h('M07 an optional probe ran unclear, then its tool left and a question opened', 'verifier', 'assign(optional); attempt → unclear; host probe fails; wait opens', probe({ attempt: 'unclear', hostCannot: true, wait: true }), 'unproven', '`unproven: <probe>`', null, ['cannot', 'waits'], true),
  h('M08 an optional probe refused on its first run', 'verifier', 'assign(optional); refusal', probe({ attempt: 'started', refused: true }), 'refused', REFUSED, 'refused', [], true),
  h('M09 the planner refused while its renderer is absent', 'planner', 'host probe fails; refusal', work({ attempt: 'started', refused: true, hostCannot: true }), 'refused', REFUSED, 'refused', ['cannot'], true),
  h('M10 the renderer is absent and an upstream question is open', 'planner', 'host probe fails; wait opens', work({ hostCannot: true, wait: true }), 'cannot', CANNOT, 'cannot', ['waits'], false),
  h('M11 a red acceptance attempt, a question opens, and the retry is refused', 'planner', 'attempt → fail; wait opens; refusal', work({ attempt: 'fail', refused: true, wait: true }), 'refused', REFUSED, 'refused', ['waits'], true),
  h('M12 a failed gate, the compiler is gone, and the retry is refused', 'implementor', 'attempt → fail; host probe fails; refusal', work({ attempt: 'fail', refused: true, hostCannot: true }), 'refused', REFUSED, 'refused', ['cannot'], true),
  h('M13 an unclear gate, then the tool is gone and a dependency is open', 'implementor', 'attempt → unclear; host probe fails; wait opens', work({ attempt: 'unclear', hostCannot: true, wait: true }), 'cannot', CANNOT, 'cannot', ['waits'], true),
  h('M14 a failed gate with all three obstacles', 'implementor', 'attempt → fail; wait opens; host probe fails; refusal', work({ attempt: 'fail', refused: true, hostCannot: true, wait: true }), 'refused', REFUSED, 'refused', ['cannot', 'waits'], true),
  h('M15 the worker refused while its converter is absent', 'worker', 'host probe fails; refusal', work({ attempt: 'started', refused: true, hostCannot: true }), 'refused', REFUSED, 'refused', ['cannot'], true),
  h('M16 the converter is absent and the conversion wait is open', 'worker', 'host probe fails; wait opens', work({ hostCannot: true, wait: true }), 'cannot', CANNOT, 'cannot', ['waits'], false),
  h('M17 an unclear comparison, a wait opens, then the retry is refused', 'worker', 'attempt → unclear; wait opens; refusal', work({ attempt: 'unclear', refused: true, wait: true }), 'refused', REFUSED, 'refused', ['waits'], true),
  h('M18 the worker with all three obstacles after an interrupted run', 'worker', 'attempt → no result yet; host probe fails; wait opens; refusal', work({ attempt: 'started', refused: true, hostCannot: true, wait: true }), 'refused', REFUSED, 'refused', ['cannot', 'waits'], true),
  h('M19 a wait opens, the host fails, the wait closes', 'verifier', 'attempt → unclear; wait opens; host probe fails; wait closes', work({ attempt: 'unclear', hostCannot: true }), 'cannot', CANNOT, 'cannot', [], true),
  h('M20 the refusal is lifted while the tool is still absent and a unit still open', 'verifier', 'refusal; host probe fails; wait opens; refusal lifted', work({ attempt: 'started', hostCannot: true, wait: true }), 'cannot', CANNOT, 'cannot', ['waits'], true),
  h('M21 a wait closes, leaving a refusal and a missing tool', 'implementor', 'wait opens; host probe fails; refusal; wait closes', work({ attempt: 'started', refused: true, hostCannot: true }), 'refused', REFUSED, 'refused', ['cannot'], true),
  h('M22 the planner with all three obstacles', 'planner', 'host probe fails; wait opens; refusal', work({ attempt: 'started', refused: true, hostCannot: true, wait: true }), 'refused', REFUSED, 'refused', ['cannot', 'waits'], true),
  // Round 2: an optional probe held by one, two or three obstacles. A refusal makes it refused (the Refusals paragraph
  // stops the step on it); a missing tool or a wait leaves it unproven, and the hand-back names what held it.
  h('O01 an optional probe whose tool is absent, never run', 'verifier', 'assign(optional); host probe fails', probe({ hostCannot: true }), 'unproven', '`unproven: <probe>`', null, ['cannot'], false),
  h('O02 an optional probe waiting on an open unit, never run', 'verifier', 'assign(optional); wait opens', probe({ wait: true }), 'unproven', '`unproven: <probe>`', null, ['waits'], false),
  h('O03 an optional probe ran unclear, then its tool left', 'verifier', 'assign(optional); attempt → unclear; host probe fails', probe({ attempt: 'unclear', hostCannot: true }), 'unproven', '`unproven: <probe>`', null, ['cannot'], true),
  h('O04 an interrupted optional probe whose rerun waits on a question', 'verifier', 'assign(optional); attempt → no result yet; wait opens', probe({ attempt: 'started', wait: true }), 'unproven', '`unproven: <probe>`', null, ['waits'], true),
  h('O05 an optional probe with its tool absent and a unit open, never run', 'verifier', 'assign(optional); wait opens; host probe fails', probe({ hostCannot: true, wait: true }), 'unproven', '`unproven: <probe>`', null, ['cannot', 'waits'], false),
  h('O06 an optional probe refused while a question is open', 'verifier', 'assign(optional); wait opens; refusal', probe({ attempt: 'started', refused: true, wait: true }), 'refused', REFUSED, 'refused', ['waits'], true),
  h('O07 an optional probe ran unclear, then all three obstacles', 'verifier', 'assign(optional); attempt → unclear; host probe fails; wait opens; refusal', probe({ attempt: 'unclear', refused: true, hostCannot: true, wait: true }), 'refused', REFUSED, 'refused', ['cannot', 'waits'], true),
  h('O08 an optional probe refused, the rule granted, its tool still absent', 'verifier', 'assign(optional); refusal; host probe fails; refusal lifted', probe({ attempt: 'started', hostCannot: true }), 'unproven', '`unproven: <probe>`', null, ['cannot'], true),
  h('O09 an optional probe ran unclear, its tool left, then a refusal', 'verifier', 'assign(optional); attempt → unclear; host probe fails; refusal', probe({ attempt: 'unclear', refused: true, hostCannot: true }), 'refused', REFUSED, 'refused', ['cannot'], true),
  h('O10 an optional probe refused on its first run, its tool absent and a unit open', 'verifier', 'assign(optional); host probe fails; wait opens; refusal', probe({ attempt: 'started', refused: true, hostCannot: true, wait: true }), 'refused', REFUSED, 'refused', ['cannot', 'waits'], true),
  h('O11 control: a wait opens and closes, then the optional probe ran unclear', 'verifier', 'assign(optional); wait opens; wait closes; attempt → unclear', probe({ attempt: 'unclear' }), 'unproven', '`unproven: <probe>`', null, [], true),
];
