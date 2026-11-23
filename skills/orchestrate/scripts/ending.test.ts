// How a step ends: the regression suite of the round policy (round-policy.ts; its old subject, ending.ts, is
// replaced and deleted), ported to stable rule ids and checked against the independent oracle (item-histories.ts):
//   (i)   the outcome is total: every stop with every multiset of up to three item states, mixed, gets one verdict or
//         is rejected as ill-formed with its reason; the invariants batches 22q to 22t asked for hold over all of them;
//   (ii)  rule retention: every sentence of the installed prompts (4afe1fda) the head no longer holds word for word is
//         in retention.ts with where its rule went, and every destination exists in the prompt;
//   (iii) the prompts: one block each, its role's policy byte for byte; every paragraph outside it is in the approved
//         inventory (inventory.ts), so any appended or edited sentence is red until the inventory is rewritten;
//   (iv)  every case found so far, N1 to N8 of 22t included, as a named row with its one disposition;
//   (v)   a changed label, a changed verdict rule, a deleted row or rule and dropped artifacts are each red;
//   (vi)  the item model: every record is rejected by one stated validity rule or meets exactly one state's
//         predicate; the valid records are the reachable ones; histories A1 to A3 of 22u;
//   (vii) every shipped prompt's decoded policy gives the oracle's state and label on every reachable record, its
//         overlaps are exactly the pinned ones, and every history's due hand-back holds exactly its evidence fields.
import { describe, expect, test } from 'bun:test';

import {
  ATOMS,
  atomWords,
  batchVerdict,
  block,
  condition,
  decide,
  decode,
  decodeBlock,
  owed,
  evidence,
  labelOf,
  render,
  outcome,
  parseCondition,
  parseVerdictWhen,
  PINS,
  type Pin,
  type Policy,
  policyFaults,
  project,
  REQUIRED,
  ROLES,
  type Role,
  type State,
  STATES,
  STATES_OF,
  type Stop,
  STOPS,
  STOPS_OF,
  truths,
  VERDICT_ORDER,
  verdictWhen,
  written,
  type Artifact,
  ASSIGNMENT,
  type Row,
  STATE_NAME,
} from './round-policy.ts';
import { approved, current, drift, paragraphs, type Prompt, prompts, ROOT } from './inventory.ts';
import { INSTALLED, RETENTION } from './retention.ts';
import { allItems, EVENTS, type Item, matching, stepEnvelope, traceFor, OBSTACLE_FACTS, obstructed, ORACLE_STATES, PREDICATE, type Predicates, reachable, recordKey, stateOf, type Validity, validity, VALIDITY } from './item-histories.ts';
import { handBackOf, judgeHandBack, labelWord, LIST_HISTORIES, type HandBack, type ObstacleRow } from './list-histories.ts';

const VOCAB: Record<Role, ReadonlyArray<string>> = { planner: ['ready', 'blocked'], implementor: ['ready', 'blocked'], verifier: ['stuck', 'changes', 'accepted'], worker: ['none'] };
const HOLDS_BACK: Record<Role, ReadonlyArray<State>> = {
  planner: ['runnable', 'waits', 'refused', 'cannot'],
  implementor: ['runnable', 'waits', 'refused', 'cannot'],
  verifier: ['runnable', 'waits', 'refused', 'cannot', 'unclear'],
  worker: [],
};
const SIZE = 3;
const POLICIES: Record<Role, Policy> = { planner: project('planner'), implementor: project('implementor'), verifier: project('verifier'), worker: project('worker') };

/** Every multiset of states up to `size` items. */
export function multisets(states: ReadonlyArray<State>, size: number): State[][] {
  const out: State[][] = [[]];
  const grow = (prefix: State[], from: number) => {
    if (prefix.length === size) return;
    for (let index = from; index < states.length; index++) {
      const next = [...prefix, states[index]!];
      out.push(next);
      grow(next, index);
    }
  };
  grow([], 0);
  return out;
}

/** The label the oracle expects for a state and attempt: the first source row of that state, a verifier's attempted runnable taking `retry`. */
const label = (role: Role, state: State, attempt: Item['attempt'] = 'never', policy: Policy = POLICIES[role]): string => {
  const rows = policy.rows.filter((row) => row.state === state);
  const pick = state === 'runnable' && role === 'verifier' ? rows.find((row) => (row.id === 'retry') === (attempt !== 'never')) : rows[0];
  if (pick === undefined) throw new Error(`no label for ${role} × ${state}`);
  return pick.label;
};

// ---- (i) totality --------------------------------------------------------------------------------------------------

export function totality(policies: Record<Role, Policy> = POLICIES): string[] {
  const out: string[] = [];
  for (const role of ROLES) {
    for (const state of STATES_OF[role]) if (!policies[role].rows.some((row) => row.state === state)) out.push(`F1 ${role} × ${state}: no row`);
    for (const stop of STOPS)
      for (const states of multisets(STATES, SIZE)) {
        const got = outcome(policies[role], stop, states);
        if (got.ok && !VOCAB[role].includes(got.value.verdict)) out.push(`F2 ${role} ${stop} [${states}]: verdict ${got.value.verdict}`);
        if (!got.ok && got.error === `no verdict rule holds for ${role}`) out.push(`F2 ${role} ${stop} [${states}]: ${got.error}`);
      }
  }
  return out;
}

const has = (writes: ReadonlyArray<Artifact>, ...want: Artifact[]) => want.every((one) => writes.includes(one));

export function invariants(policies: Record<Role, Policy> = POLICIES): string[] {
  const out: string[] = [];
  for (const role of ROLES)
    for (const stop of STOPS_OF[role])
      for (const states of multisets(STATES_OF[role], SIZE)) {
        const got = outcome(policies[role], stop, states);
        if (!got.ok) {
          if (got.error.startsWith('no verdict')) out.push(`${role} ${stop} [${states}]: ${got.error}`);
          continue;
        }
        const { verdict, writes, fields } = got.value;
        const at = `${role} ${stop} [${states}] → ${verdict}`;
        const held = states.some((state) => HOLDS_BACK[role].includes(state));
        if (role === 'planner' || role === 'implementor') {
          if ((verdict === 'ready') === held) out.push(`${at}: ready only when every required item is done`);
          if (verdict === 'blocked' && !has(writes.artifacts, 'state', 'blocked')) out.push(`${at}: a non-ready hand-back writes state.md current and blocked.md`);
        }
        if (role === 'verifier') {
          if ((verdict === 'stuck') !== held) out.push(`${at}: stuck exactly when a required check has no interpretable outcome`);
          if (!held && (verdict === 'changes') !== states.includes('proven')) out.push(`${at}: changes exactly when a Blocker or Major is proven`);
          if (writes.artifacts.includes('blocked')) out.push(`${at}: a verifier writes no blocked.md`);
          if (!writes.contents.includes('evidence')) out.push(`${at}: a verifier's findings hold the stop's evidence`);
        }
        if (states.includes('refused') && ['ready', 'accepted', 'changes'].includes(verdict)) out.push(`${at}: a refused required item never ends a step done`);
        if (verdict !== 'ready' && (!writes.contents.includes('evidence') || fields.length === 0)) out.push(`${at}: the stop's evidence fields are not written`);
        if (stop === 'refusalForm' && !fields.includes('refused.form')) out.push(`${at}: a refusal's named form is not written`);
        if (stop === 'refusalNone' && fields.includes('refused.form')) out.push(`${at}: a refusal that named no form gets none inferred`);
      }
  return out;
}

describe('(i) the outcome is total', () => {
  test('every state of every role has a row, and a state the role lacks is refused', () => {
    expect(totality().filter((line) => line.startsWith('F1'))).toEqual([]);
    for (const role of ROLES) expect([role, [...STATES_OF[role]].sort()]).toEqual([role, [...ORACLE_STATES[role]].sort()]);
  });
  test(`every stop × every multiset of up to ${SIZE} item states gets one outcome or an ill-formed reason`, () => {
    expect(totality().filter((line) => line.startsWith('F2'))).toEqual([]);
    expect(multisets(STATES, SIZE).length).toBe(364);
  });
  test('each stop a role has leaves some well-formed input, and every verdict a role has is reached', () => {
    for (const role of ROLES) {
      const reached = new Set<string>();
      for (const stop of STOPS_OF[role]) {
        const outcomes = multisets(STATES_OF[role], SIZE).map((states) => outcome(POLICIES[role], stop, states)).filter((got) => got.ok);
        expect([role, stop, outcomes.length > 0]).toEqual([role, stop, true]);
        for (const got of outcomes) if (got.ok) reached.add(got.value.verdict);
      }
      expect([role, [...reached].sort()]).toEqual([role, [...VOCAB[role]].sort()]);
    }
  });
  test('the invariants hold over every well-formed input', () => {
    expect(invariants()).toEqual([]);
  });
  test('ill-formed inputs are refused with their reason, never answered', () => {
    const bad: ReadonlyArray<[Role, Stop, State[], string]> = [
      ['verifier', 'limit', ['runnable'], 'a verifier has no limit stop'],
      ['worker', 'limit', ['runnable'], 'a worker has no limit stop'],
      ['planner', 'idle', ['unclear'], 'a planner has no unclear state'],
      ['verifier', 'idle', ['discovery'], 'a verifier has no discovery state'],
      ['implementor', 'refusalNone', ['runnable'], 'a refusal stops the step at the one item it refused (a refused optional probe is refused too)'],
      ['verifier', 'refusalNone', ['done', 'unproven'], 'a refusal stops the step at the one item it refused (a refused optional probe is refused too)'],
      ['implementor', 'refusalForm', ['refused', 'refused'], 'a refusal stops the step at the one item it refused'],
      ['implementor', 'idle', ['refused'], 'a refusal stops the step at once, so a refused item means the step stopped on it'],
      ['verifier', 'idle', ['runnable', 'done'], 'the step goes on while a runnable item is left'],
      ['implementor', 'limit', ['waits'], 'with no runnable item left the step had already stopped, before the limit passed'],
    ];
    for (const [role, stop, states, why] of bad) expect(outcome(POLICIES[role], stop, states)).toEqual({ ok: false, error: why });
  });
});

// ---- (ii) rule retention against the installed prompts -------------------------------------------------------------

const RULE_ROLES = ['planner', 'implementor', 'verifier'] as const;
const git = (...args: string[]) => {
  const run = Bun.spawnSync(['git', ...args], { cwd: ROOT });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
  return run.stdout.toString();
};
export const sentences = (text: string) =>
  text
    .split('\n')
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z`*(])/))
    .map((one) => one.trim())
    .filter(Boolean);
function installed(role: Role): Prompt[] {
  const json = JSON.parse(git('show', `${INSTALLED}:opencode/mods/orchestrate/agents.json`)) as { agents: Record<string, { system: string }> };
  const toml = /developer_instructions = '''\n([\s\S]*?)\n'''/.exec(git('show', `${INSTALLED}:codex/agents/${role}.toml`))?.[1] ?? '';
  return [
    { role, format: 'claude', text: git('show', `${INSTALLED}:agents/${role}.md`).replace(/^---\n[\s\S]*?\n---\n/, '') },
    { role, format: 'codex', text: toml },
    { role, format: 'opencode', text: json.agents[role]?.system ?? '' },
  ];
}

/** Where a destination of retention.ts stands, or why it does not. */
function destination(ref: string): { role: Role; text: string } | string {
  const [kind, role, a, b] = ref.split(' ') as [string, Role, string | undefined, string | undefined];
  if (!ROLES.includes(role)) return `${ref}: no role`;
  if (kind === 'F1') {
    const found = a === undefined ? undefined : labelOf(role, a as State);
    return found === undefined ? `${ref}: no label` : { role, text: found };
  }
  if (kind === 'F2' && a === 'evidence') return b !== undefined && (STOPS_OF[role] as ReadonlyArray<string>).includes(b) ? { role, text: evidence(role, b as Stop) } : `${ref}: no stop`;
  if (kind === 'F2') {
    const files = a === undefined ? undefined : written(role, a);
    return files === undefined ? `${ref}: no verdict` : { role, text: files };
  }
  if (kind === 'REQUIRED') return { role, text: REQUIRED[role] };
  return `${ref}: unknown`;
}

describe('(ii) every rule of the installed prompts is kept, moved into the policy, or replaced by a design line', () => {
  const head = prompts();
  const lost = new Map<string, Set<Role>>();
  for (const role of RULE_ROLES)
    for (const old of installed(role)) {
      const now = head.find((one) => one.role === role && one.format === old.format)?.text ?? '';
      for (const sentence of sentences(old.text)) if (!now.includes(sentence)) lost.set(sentence, (lost.get(sentence) ?? new Set()).add(role));
    }
  test("the sentences no longer held word for word are exactly retention.ts's entries", () => {
    expect([...lost.keys()].filter((sentence) => !(sentence in RETENTION))).toEqual([]);
    expect(Object.keys(RETENTION).filter((sentence) => !lost.has(sentence))).toEqual([]);
  });
  test('a reworded rule stands word for word in every prompt of each role that had it', () => {
    for (const [sentence, fate] of Object.entries(RETENTION))
      if (fate.kind === 'reworded')
        for (const role of lost.get(sentence) ?? []) for (const prompt of head.filter((one) => one.role === role)) expect([prompt.role, prompt.format, prompt.text.includes(fate.now)]).toEqual([role, prompt.format, true]);
  });
  test("every destination is a row, verdict, stop field or required-work line that its role's prompts carry", () => {
    for (const fate of Object.values(RETENTION))
      for (const ref of fate.to ?? []) {
        const found = destination(ref);
        expect([ref, typeof found === 'string' ? found : 'ok']).toEqual([ref, 'ok']);
        if (typeof found !== 'string') for (const prompt of head.filter((one) => one.role === found.role)) expect([ref, prompt.format, prompt.text.includes(found.text)]).toEqual([ref, prompt.format, true]);
      }
  });
  test('a moved or replaced rule names at least one destination, and a replacement its design line', () => {
    for (const [sentence, fate] of Object.entries(RETENTION)) {
      if (fate.kind !== 'reworded') expect([sentence, fate.to.length > 0]).toEqual([sentence, true]);
      if (fate.kind === 'replaced') expect(fate.by).toMatch(/^\(F[12]\)/);
    }
  });
});

// ---- (iii) the prompts: one block, and the approved inventory outside it -------------------------------------------

/** Every structural fault: the block (decoded and byte for byte), then any paragraph outside it the inventory has not approved. */
export const lint = (prompt: Prompt): ReadonlyArray<string> => [...policyFaults(prompt.role, prompt.text), ...drift(prompt)];

const SURVIVORS: ReadonlyArray<{ role: Role; sentence: string }> = [
  { role: 'planner', sentence: 'A planner may hand back ready without running any acceptance check.' },
  { role: 'planner', sentence: "An unrun acceptance check cannot prevent a planner's `ready` verdict." },
  { role: 'planner', sentence: 'Skip the acceptance check and conclude the planning step as soon as the spec is written.' },
  { role: 'worker', sentence: 'Upon any permission refusal, complete one more unrelated item before replying.' },
  { role: 'implementor', sentence: 'Keep going on the next item after a refusal.' },
  { role: 'verifier', sentence: 'When a required check ran unclear, call the unit accepted.' },
];

describe("(iii) each prompt: its role's one block, and nothing outside it the inventory has not approved", () => {
  const all = prompts();
  test('three host formats for each role, two for the lean worker', () => {
    expect(all.map((prompt) => `${prompt.role} ${prompt.format}`)).toEqual(Object.keys(approved().prompts));
    expect(all.length).toBe(11);
  });
  for (const prompt of all)
    test(`${prompt.role} ${prompt.format}: one block, its policy, every other paragraph approved`, () => {
      expect(lint(prompt)).toEqual([]);
    });
  test('the inventory holds no paragraph no prompt uses, and matches the prompts as they are', () => {
    const inventory = approved();
    const used = new Set(Object.values(inventory.prompts).flat());
    expect(Object.keys(inventory.paragraphs).filter((key) => !used.has(key))).toEqual([]);
    expect(current(all)).toEqual(inventory);
  });
  test('each surviving mutant of 22s and 22t, appended outside or inside the block, is red in every format of its role', () => {
    for (const { role, sentence } of SURVIVORS)
      for (const prompt of all.filter((one) => one.role === role)) {
        expect([prompt.format, sentence, lint({ ...prompt, text: `${prompt.text}\n${sentence}` }).length > 0]).toEqual([prompt.format, sentence, true]);
        expect([prompt.format, sentence, lint({ ...prompt, text: `${prompt.text}\n\n${sentence}` }).length > 0]).toEqual([prompt.format, sentence, true]);
        const inside = prompt.text.replace('\n\nTake the first row that is true', `\n\n${sentence}\n\nTake the first row that is true`);
        expect([prompt.format, sentence, inside !== prompt.text, policyFaults(role, inside).length > 0]).toEqual([prompt.format, sentence, true, true]);
      }
  });
  test('an edit inside a paragraph, a deleted paragraph and two swapped paragraphs are each red in every format', () => {
    for (const prompt of all) {
      const parts = paragraphs(prompt.text);
      const target = parts.find((one) => one.startsWith('**Refusals.**') || one.startsWith('Do the task')) ?? parts[2] ?? '';
      const edited = prompt.text.replace(target, `${target.replace(/\.$/, '')}, unless it slows you down.`);
      expect([prompt.role, prompt.format, edited !== prompt.text, lint({ ...prompt, text: edited }).length > 0]).toEqual([prompt.role, prompt.format, true, true]);
      expect([prompt.role, prompt.format, lint({ ...prompt, text: prompt.text.replace(target, '') }).length > 0]).toEqual([prompt.role, prompt.format, true]);
      const [first, second] = [parts[1] ?? '', parts[2] ?? ''];
      const swapped = prompt.text.replace(`${first}\n\n${second}`, `${second}\n\n${first}`);
      if (swapped !== prompt.text) expect([prompt.role, prompt.format, lint({ ...prompt, text: swapped }).length > 0]).toEqual([prompt.role, prompt.format, true]);
    }
  });
  test('the planner mutant set inside its own paragraph is red in all three formats', () => {
    for (const prompt of all.filter((one) => one.role === 'planner')) {
      const inside = prompt.text.replace('and change no product code', 'and change no product code; skip the acceptance check and conclude as soon as the spec is written');
      expect([prompt.format, inside !== prompt.text, lint({ ...prompt, text: inside }).length > 0]).toEqual([prompt.format, true, true]);
    }
  });
  test('a second block, or a block of another role, is red', () => {
    const planner = all.find((one) => one.role === 'planner' && one.format === 'codex')!;
    expect(lint({ ...planner, text: `${planner.text}\n${block('planner')}` }).length).toBeGreaterThan(0);
    expect(lint({ ...planner, text: planner.text.replace(block('planner'), () => block('implementor')) })).toContain('planner: role: source planner, shown implementor');
  });
});

// ---- (iv) named cases ---------------------------------------------------------------------------------------------

interface Case {
  readonly name: string;
  readonly role: Role;
  readonly stop: Stop;
  readonly items: Readonly<Record<string, State>>;
  readonly verdict: string;
  readonly labels: Readonly<Record<string, string>>;
  /** Artifacts and stop fields the outcome must hold. */
  readonly writes?: ReadonlyArray<Artifact>;
  readonly fields?: ReadonlyArray<string>;
}

const WAITS = '`waits on <id>`';
const REFUSED = '`refused: <what>`';
const CANNOT = '`cannot run here: <check or tool>`';
const CONTINUES = '`continues next round`';
const OUTSIDE = '`finding outside the unit`';

export const CASES: ReadonlyArray<Case> = [
  { name: 'N1 verifier: check A waits, independent check B is refused', role: 'verifier', stop: 'refusalNone', items: { a: 'waits', b: 'refused' }, verdict: 'stuck', labels: { a: WAITS, b: REFUSED }, fields: ['refused.what'] },
  { name: 'N2 verifier: check A waits, independent check B lacks its executable', role: 'verifier', stop: 'idle', items: { a: 'waits', b: 'cannot' }, verdict: 'stuck', labels: { a: WAITS, b: CANNOT } },
  { name: 'N3 implementor: check A cannot run, then item B is refused', role: 'implementor', stop: 'refusalNone', items: { a: 'cannot', b: 'refused' }, verdict: 'blocked', labels: { a: CANNOT, b: REFUSED } },
  { name: 'N4 verifier: a written-rule break the unit introduced, outside the spec items, no failing run', role: 'verifier', stop: 'idle', items: { checks: 'done', rule: 'unitFinding' }, verdict: 'accepted', labels: { rule: 'marked `unit`: the same lane closes it in its next round' } },
  { name: 'N4 control: the same break shown on the base head', role: 'verifier', stop: 'idle', items: { checks: 'done', rule: 'baseFinding' }, verdict: 'accepted', labels: { rule: 'marked `base`: a follow-up unit' } },
  { name: 'N5 verifier: a required check ran, its result settles nothing', role: 'verifier', stop: 'idle', items: { check: 'unclear' }, verdict: 'stuck', labels: { check: '`ran unclear: <check>`' } },
  { name: 'N5 control: the required executable is absent', role: 'verifier', stop: 'idle', items: { check: 'cannot' }, verdict: 'stuck', labels: { check: CANNOT } },
  { name: 'N5 control: the required check is conclusively red', role: 'verifier', stop: 'idle', items: { check: 'proven' }, verdict: 'changes', labels: { check: 'a Blocker or Major' } },
  { name: 'N5 control (22u T1): every required check passed, an optional wider probe ran unclear: Unproven, verdict unaffected', role: 'verifier', stop: 'idle', items: { check: 'done', probe: 'unproven' }, verdict: 'accepted', labels: { probe: '`unproven: <probe>`, under Unproven with the probe that would settle it' } },
  { name: 'N6 implementor: the timebox passes after uncommitted progress and a new wait', role: 'implementor', stop: 'limit', items: { progress: 'runnable', wait: 'waits' }, verdict: 'blocked', labels: { progress: CONTINUES, wait: WAITS }, writes: ['state', 'blocked'], fields: ['limit'] },
  { name: 'N7 planner: waits on a prerequisite and finds unrelated work', role: 'planner', stop: 'idle', items: { prerequisite: 'waits', found: 'discovery' }, verdict: 'blocked', labels: { prerequisite: WAITS, found: OUTSIDE }, writes: ['blocked'] },
  { name: 'N8 lean worker: refused with no form, unrelated work left', role: 'worker', stop: 'refusalNone', items: { it: 'refused', other: 'runnable' }, verdict: 'none', labels: { it: 'never tried another way', other: '`left`' }, fields: ['refused.what'] },
  { name: '22s-1 planner refused by a terminal classifier that names no command or allow rule', role: 'planner', stop: 'refusalNone', items: { spec: 'refused' }, verdict: 'blocked', labels: { spec: REFUSED }, fields: ['refused.what'] },
  { name: '22s-2 implementor refusal with a named form, another item runnable, the clock not out', role: 'implementor', stop: 'refusalForm', items: { refused: 'refused', other: 'runnable' }, verdict: 'blocked', labels: { refused: '; form: <the form it named>', other: CONTINUES }, fields: ['refused.what', 'refused.form'] },
  { name: '22s-3 verifier refused on its first required check', role: 'verifier', stop: 'refusalNone', items: { first: 'refused', rest: 'runnable' }, verdict: 'stuck', labels: { first: REFUSED, rest: '`not run`' }, writes: ['findings', 'batch'] },
  { name: '22s-4 verifier whose required executable is absent, no refusal', role: 'verifier', stop: 'idle', items: { check: 'cannot' }, verdict: 'stuck', labels: { check: CANNOT } },
  { name: '22s-5 implementor past its timebox, one item waits on an open unit, one runnable', role: 'implementor', stop: 'limit', items: { waiting: 'waits', runnable: 'runnable' }, verdict: 'blocked', labels: { waiting: WAITS, runnable: CONTINUES }, fields: ['limit'] },
  { name: '22s-6 verifier lacking only a wider probe, every required check ran', role: 'verifier', stop: 'idle', items: { checks: 'done' }, verdict: 'accepted', labels: {} },
  { name: '22s-8 planner with a red check and the product unbuilt', role: 'planner', stop: 'idle', items: { spec: 'done', found: 'discovery' }, verdict: 'ready', labels: { found: OUTSIDE }, writes: ['spec'] },
  { name: '22r-B2 first refusal names a script-file form', role: 'implementor', stop: 'refusalForm', items: { item: 'refused' }, verdict: 'blocked', labels: { item: '; form: <the form it named>' }, fields: ['refused.form'] },
  { name: '22r-principle-B1 a defect found in an owned file, one spec item unfinished at the timebox', role: 'implementor', stop: 'limit', items: { defect: 'discovery', item: 'runnable' }, verdict: 'blocked', labels: { defect: OUTSIDE, item: CONTINUES } },
  { name: '22r-R1 the lean worker meets a refusal with other work left', role: 'worker', stop: 'refusalNone', items: { it: 'refused', other: 'runnable' }, verdict: 'none', labels: { it: REFUSED, other: '`left`' } },
  { name: '22q-B1 the timebox passes with a runnable item unfinished', role: 'implementor', stop: 'limit', items: { item: 'runnable' }, verdict: 'blocked', labels: { item: CONTINUES } },
  { name: '22q-principle-B1 a refusal with no form, one item refused, another runnable', role: 'implementor', stop: 'refusalNone', items: { refused: 'refused', other: 'runnable' }, verdict: 'blocked', labels: { refused: REFUSED, other: CONTINUES } },
  { name: 'refusal × timebox: the refusal came first', role: 'implementor', stop: 'refusalNone', items: { refused: 'refused', other: 'runnable' }, verdict: 'blocked', labels: { refused: REFUSED, other: CONTINUES } },
  { name: 'refusal × timebox: the clock came first', role: 'implementor', stop: 'limit', items: { other: 'runnable' }, verdict: 'blocked', labels: { other: CONTINUES }, fields: ['limit'] },
  { name: 'blocked × waiting: only waiting work is left', role: 'implementor', stop: 'idle', items: { item: 'waits' }, verdict: 'blocked', labels: { item: WAITS }, writes: ['state'] },
  { name: 'a check cannot run and another item waits', role: 'planner', stop: 'idle', items: { check: 'cannot', other: 'waits' }, verdict: 'blocked', labels: { check: CANNOT, other: WAITS } },
  { name: 'follow-up × finding: the discovery is outside the unit, the cut item is not', role: 'planner', stop: 'limit', items: { found: 'discovery', cut: 'runnable' }, verdict: 'blocked', labels: { found: OUTSIDE, cut: CONTINUES } },
  { name: 'a verifier whose spec lines contradict', role: 'verifier', stop: 'idle', items: { check: 'waits' }, verdict: 'stuck', labels: { check: WAITS } },
  { name: 'a verifier proves a Blocker and a check ran unclear: stuck first', role: 'verifier', stop: 'idle', items: { red: 'proven', other: 'unclear' }, verdict: 'stuck', labels: { red: 'a Blocker or Major', other: '`ran unclear: <check>`' } },
  { name: 'the lean worker cannot run a tool', role: 'worker', stop: 'idle', items: { tool: 'cannot' }, verdict: 'none', labels: { tool: CANNOT } },
];

export function caseFailures(policies: Record<Role, Policy> = POLICIES, cases: ReadonlyArray<Case> = CASES): string[] {
  const out: string[] = [];
  for (const one of cases) {
    const got = outcome(policies[one.role], one.stop, Object.values(one.items));
    if (!got.ok) {
      out.push(`${one.name}: ill-formed: ${got.error}`);
      continue;
    }
    if (got.value.verdict !== one.verdict) out.push(`${one.name}: verdict ${got.value.verdict}`);
    for (const artifact of one.writes ?? []) if (!got.value.writes.artifacts.includes(artifact)) out.push(`${one.name}: writes ${got.value.writes.artifacts}`);
    for (const field of one.fields ?? []) if (!got.value.fields.includes(field as never)) out.push(`${one.name}: fields ${got.value.fields}`);
    for (const [name, words] of Object.entries(one.labels)) {
      let found = '';
      try {
        found = label(one.role, one.items[name] ?? 'done', 'never', policies[one.role]);
      } catch (error) {
        found = String(error);
      }
      if (!found.includes(words)) out.push(`${one.name}: ${name} is ${found}`);
    }
  }
  return out;
}

describe('(iv) every case found so far has its one disposition', () => {
  test('the named cases', () => {
    expect(caseFailures()).toEqual([]);
  });
  test('an item keeps its label whatever stops the step (N1 to N3): a row takes no stop', () => {
    for (const role of ROLES) for (const row of POLICIES[role].rows) expect(block(role)).toContain(`| ${row.label} |`);
  });
  test('22s-7 a wrong heads line makes the batch `stuck` even with a proven Blocker; the prompt says the same', () => {
    expect(batchVerdict(false, ['changes'])).toBe('stuck');
    expect(batchVerdict(true, ['accepted', 'changes'])).toBe('changes');
    expect(batchVerdict(true, ['accepted', 'stuck'])).toBe('stuck');
    expect(batchVerdict(true, ['accepted'])).toBe('accepted');
    expect(REQUIRED.verifier).toContain('else the batch is `stuck`. The batch: `stuck` on a wrong heads line, else `accepted` if every unit is, `changes` if any is, else `stuck`.');
  });
  test('the planner never implements: its required work names no product item', () => {
    expect(REQUIRED.planner).toContain('You never implement, so the product behavior its Done line names stays unbuilt and is no item left.');
  });
});

// ---- (v) mutations -----------------------------------------------------------------------------------------------

const withRole = (role: Role, policy: Policy): Record<Role, Policy> => ({ ...POLICIES, [role]: policy });
const relabel = (policy: Policy, id: string, label: string): Policy => ({ ...policy, rows: policy.rows.map((row) => (row.id === id ? { ...row, label } : row)) });

describe('(v) a changed label, verdict rule or artifacts, and a deleted row or rule, are each red', () => {
  test('changing one label (a live wait relabelled `continues next round`) is red', () => {
    const p = POLICIES.implementor;
    expect(caseFailures(withRole('implementor', relabel(p, 'waits', p.rows.find((row) => row.id === 'runnable')!.label))).length).toBeGreaterThan(0);
  });
  test('changing one verdict rule (ran unclear no longer `stuck`) is red', () => {
    const p = POLICIES.verifier;
    const rules = p.verdicts.map((rule) => (rule.id === 'stuck' && rule.when.kind === 'any' ? { ...rule, when: { kind: 'any' as const, states: rule.when.states.filter((state) => state !== 'unclear') } } : rule));
    const policies = withRole('verifier', { ...p, verdicts: rules });
    expect(invariants(policies).length).toBeGreaterThan(0);
    expect(caseFailures(policies).some((line) => line.startsWith('N5'))).toBe(true);
  });
  test('giving a verifier `blocked` is red', () => {
    const p = POLICIES.verifier;
    const policies = withRole('verifier', { ...p, verdicts: [{ priority: 0, id: 'blocked', verdict: 'blocked', when: { kind: 'any', states: ['refused'] }, writes: { artifacts: ['blocked'], contents: [] } }, ...p.verdicts] });
    expect(totality(policies).length).toBeGreaterThan(0);
    expect(invariants(policies).length).toBeGreaterThan(0);
  });
  test('dropping state.md from a non-ready hand-back (B4) is red', () => {
    const p = POLICIES.implementor;
    const policies = withRole('implementor', { ...p, verdicts: p.verdicts.map((rule) => (rule.id === 'blocked' ? { ...rule, writes: { ...rule.writes, artifacts: ['blocked' as const] } } : rule)) });
    expect(invariants(policies).length).toBeGreaterThan(0);
    expect(caseFailures(policies).some((line) => line.startsWith('N6'))).toBe(true);
  });
  test('dropping the named form from a refusal stop, or inferring one where none was named, is red', () => {
    const p = POLICIES.implementor;
    const drop = withRole('implementor', { ...p, stops: p.stops.map((one) => (one.stop === 'refusalForm' ? { ...one, fields: one.fields.filter((field) => field.id !== 'refused.form') } : one)) });
    expect(invariants(drop).some((line) => line.includes("named form is not written"))).toBe(true);
    const infer = withRole('implementor', { ...p, stops: p.stops.map((one) => (one.stop === 'refusalNone' ? { ...one, fields: [...one.fields, { id: 'refused.form' as const, text: 'the form it implied' }] } : one)) });
    expect(invariants(infer).some((line) => line.includes('gets none inferred'))).toBe(true);
  });
  test('deleting one row, or one verdict rule, is red', () => {
    const p = POLICIES.verifier;
    expect(totality(withRole('verifier', { ...p, rows: p.rows.filter((row) => row.id !== 'unitFinding') }))).toEqual(['F1 verifier × unitFinding: no row']);
    expect(totality(withRole('planner', { ...POLICIES.planner, verdicts: POLICIES.planner.verdicts.filter((rule) => rule.id !== 'blocked') })).length).toBeGreaterThan(0);
  });
});

// ---- (vi) the item model -------------------------------------------------------------------------------------------

export function partition(predicates: Predicates = PREDICATE, rules: ReadonlyArray<Validity> = VALIDITY): string[] {
  const out: string[] = [];
  for (const role of ROLES)
    for (const one of allItems()) {
      if (validity(role, one, rules) !== undefined) continue;
      const found = matching(role, one, predicates);
      if (found.length !== 1) out.push(`${role} ${recordKey(one)}: ${found.length ? found.join(' and ') : 'no state'}`);
    }
  return out;
}

export function reachGap(rules: ReadonlyArray<Validity> = VALIDITY): string[] {
  const out: string[] = [];
  for (const role of ROLES) {
    const reached = reachable(role);
    for (const one of allItems()) {
      const valid = validity(role, one, rules) === undefined;
      if (valid !== reached.has(recordKey(one))) out.push(`${role} ${recordKey(one)}: ${valid ? 'valid, reached by no history' : `reached (${reached.get(recordKey(one))?.history.join(' → ')}) but rejected: ${validity(role, one, rules)}`}`);
    }
  }
  return out;
}

const item = (facts: Partial<Item>): Item => ({ assigned: false, required: false, attempt: 'never', settled: true, refused: false, hostCannot: false, wait: false, provenance: 'none', ...facts });
const work = (facts: Partial<Item>): Item => item({ assigned: true, required: true, settled: false, ...facts });

describe('(vi) the item model: valid = reachable, and every valid item is in exactly one state', () => {
  test('the enumeration: 2 × 2 × 5 attempts × settled × 2³ obstacle sets × 3 provenances; the valid ones meet exactly one state', () => {
    expect(allItems().length).toBe(960);
    expect(partition()).toEqual([]);
  });
  test('the valid records are exactly the records some history reaches, both ways', () => {
    expect(reachGap()).toEqual([]);
  });
  test('every rejection is justified, every state is met, and every validity rule rejects some record first', () => {
    for (const rule of VALIDITY) {
      if (rule.justification.kind === 'definition') expect((rule.justification.cites.match(/`[^`]+`/g) ?? []).length).toBeGreaterThanOrEqual(2);
      else expect(rule.justification.why.length).toBeGreaterThan(0);
    }
    for (const role of ROLES) {
      const valid = allItems().filter((one) => validity(role, one) === undefined);
      for (const state of ORACLE_STATES[role]) expect([role, state, valid.some((one) => matching(role, one)[0] === state)]).toEqual([role, state, true]);
      const used = new Set(allItems().map((one) => validity(role, one)).filter((rule) => rule !== undefined));
      for (const { rule } of VALIDITY) if (!(role === 'verifier' && rule.startsWith('only a verifier')) && !(role !== 'verifier' && rule.startsWith("a verifier's")) && !(role === 'verifier' && rule.startsWith("a planner's"))) expect([role, rule, used.has(rule)]).toEqual([role, rule, true]);
    }
  });
  test('stateOf refuses an invalid record with its rule', () => {
    expect(() => stateOf('implementor', work({ required: false }))).toThrow('only a verifier has optional work');
    expect(() => stateOf('verifier', work({ attempt: 'pass', settled: false }))).toThrow('a passed item stays settled');
    expect(() => stateOf('planner', work({ attempt: 'started', settled: true }))).toThrow('a settled item is settled by a result');
  });
});

interface History {
  readonly name: string;
  readonly role: Role;
  readonly events: ReadonlyArray<string>;
  readonly item: Item;
  readonly state: State;
  readonly label: string;
  readonly not?: string;
}
const HISTORIES: ReadonlyArray<History> = [
  { name: 'V7 a required check ran, printed a truncated report, and can be retried here (a sibling refusal then stops the step)', role: 'verifier', events: ['attempt → unclear'], item: work({ attempt: 'unclear' }), state: 'runnable', label: '`retry: <check>`, named under Check; it continues to a result', not: '`not run`' },
  { name: 'V6 a required check ran unclear and no retry can settle it here', role: 'verifier', events: ['attempt → unclear', 'retry becomes unavailable'], item: work({ attempt: 'unclear', settled: true }), state: 'unclear', label: '`ran unclear: <check>`' },
  { name: 'A1 the only gate ran red, is repairable, and the timebox arrives', role: 'implementor', events: ['attempt → fail'], item: work({ attempt: 'fail' }), state: 'runnable', label: '`continues next round`' },
  { name: 'A1 variant: the gate printed an unclear result and can be rerun', role: 'implementor', events: ['attempt → unclear'], item: work({ attempt: 'unclear' }), state: 'runnable', label: '`continues next round`' },
  { name: 'A1 control: the gate never ran', role: 'implementor', events: [], item: work({}), state: 'runnable', label: '`continues next round`' },
  { name: 'A2 an optional wider probe the host cannot run, no refusal', role: 'verifier', events: ['host probe fails'], item: work({ required: false, hostCannot: true }), state: 'unproven', label: '`unproven: <probe>`' },
  { name: 'A2 control: the same host failure on a required check', role: 'verifier', events: ['host probe fails'], item: work({ hostCannot: true }), state: 'cannot', label: '`cannot run here: <check or tool>`' },
  { name: 'A2 control: an optional probe that proves a Blocker', role: 'verifier', events: ['attempt → fail'], item: work({ required: false, attempt: 'fail', settled: true }), state: 'proven', label: 'a Blocker or Major' },
  { name: 'A2 control: an optional probe ran unclear and can be retried', role: 'verifier', events: ['attempt → unclear'], item: work({ required: false, attempt: 'unclear' }), state: 'unproven', label: '`unproven: <probe>`, under Unproven with the probe that would settle it; it never changes the verdict' },
  { name: "A3 the lean worker's first-message task, not yet started", role: 'worker', events: [], item: work({}), state: 'runnable', label: '`left`' },
  { name: 'A3 control: an unrelated defect the worker notices', role: 'worker', events: [], item: item({}), state: 'discovery', label: '`outside the task`' },
  { name: 'N3 history: required check A, host cannot run it after one attempt', role: 'implementor', events: ['attempt → no result yet', 'host probe fails'], item: work({ attempt: 'started', hostCannot: true }), state: 'cannot', label: '`cannot run here: <check or tool>`' },
  { name: 'N4 history: a written-rule break the unit introduced', role: 'verifier', events: [], item: item({ provenance: 'unit' }), state: 'unitFinding', label: 'marked `unit`' },
  { name: "22s-1 history: the planner's spec work refused", role: 'planner', events: ['refusal'], item: work({ attempt: 'started', refused: true }), state: 'refused', label: '`refused: <what>`' },
  { name: 'a retry after a failed gate is refused', role: 'implementor', events: ['attempt → fail', 'refusal'], item: work({ attempt: 'fail', refused: true }), state: 'refused', label: '`refused: <what>`' },
];

describe("(vi) histories: each item's events reach one record, in one state, with its label", () => {
  for (const one of HISTORIES)
    test(one.name, () => {
      const start = one.item.assigned ? work({ required: one.item.required }) : one.item;
      const reached = one.events.reduce<Item | undefined>((at, name) => (at === undefined ? undefined : EVENTS.find((event) => event.name === name)?.apply(one.role, at)), start);
      expect(reached).toEqual(one.item);
      expect(stateOf(one.role, one.item)).toBe(one.state);
      const got = decide(POLICIES[one.role], truths([one.item]))[0]?.label ?? '';
      // Exact: the history's label is the label the list gives, or its word (labelWord), never a substring or a blank.
      expect([got, one.label === got || one.label === labelWord(got)]).toEqual([got, true]);
      if (one.not !== undefined) expect(got).not.toContain(one.not);
    });
  test('V7 with its sibling refusal: the retryable check and the refused check give one `stuck`, both labels distinct', () => {
    const states = [stateOf('verifier', work({ attempt: 'unclear' })), stateOf('verifier', work({ attempt: 'started', refused: true }))];
    expect(states).toEqual(['runnable', 'refused']);
    expect(outcome(POLICIES.verifier, 'refusalNone', states)).toMatchObject({ ok: true, value: { verdict: 'stuck' } });
    expect(label('verifier', 'runnable', 'unclear')).not.toBe(label('verifier', 'runnable', 'never'));
  });
  test('A1 at the timebox: `blocked`, state.md current and blocked.md with the clock', () => {
    const got = outcome(POLICIES.implementor, 'limit', [stateOf('implementor', work({ attempt: 'fail' }))]);
    expect(got).toMatchObject({ ok: true, value: { verdict: 'blocked', writes: { artifacts: ['state', 'blocked'] }, fields: ['limit'] } });
  });
  test('A2 and T1: every required check passed and an optional probe cannot run (or ran unclear): `accepted`', () => {
    for (const probe of [work({ required: false, hostCannot: true }), work({ required: false, attempt: 'unclear', settled: true }), work({ required: false, attempt: 'unclear' })]) {
      const states = [stateOf('verifier', work({ attempt: 'pass', settled: true })), stateOf('verifier', probe)];
      expect(states).toEqual(['done', 'unproven']);
      expect(outcome(POLICIES.verifier, 'idle', states)).toMatchObject({ ok: true, value: { verdict: 'accepted' } });
    }
  });
  test('an optional probe refused: a refusal is authority whatever the item, so the probe is refused and the step stops `stuck` on it', () => {
    for (const probe of [work({ required: false, attempt: 'started', refused: true }), work({ required: false, attempt: 'unclear', refused: true, hostCannot: true, wait: true })]) {
      const state = stateOf('verifier', probe);
      expect(state).toBe('refused');
      expect(label('verifier', state, probe.attempt)).toContain('refused: <what>');
      expect(outcome(POLICIES.verifier, 'refusalNone', ['done', state])).toMatchObject({ ok: true, value: { verdict: 'stuck' } });
    }
  });
});

describe('(vi) a model fault is red', () => {
  test('merging attempt history back into disposition (ran unclear without `settled`) is red', () => {
    expect(partition({ ...PREDICATE, unclear: PREDICATE.unclear.filter(([field]) => field !== 'settled') }).some((line) => line.includes('runnable and unclear'))).toBe(true);
  });
  test('re-adding the deleted validity rule (a result is final: an unclear attempt cannot advance) is red', () => {
    const rules: ReadonlyArray<Validity> = [...VALIDITY, { rule: 'a result is final for the step', justification: { kind: 'unreachable', why: 'claimed' }, breaks: (_, one) => one.attempt === 'unclear' && !one.settled }];
    expect(reachGap(rules).some((line) => line.includes('verifier true/true/unclear/open/free') && line.includes('but rejected'))).toBe(true);
  });
  test('overlapping two predicates (runnable without `required`) is red', () => {
    expect(partition({ ...PREDICATE, runnable: PREDICATE.runnable.filter(([field]) => field !== 'required') }).some((line) => line.includes('runnable and unproven'))).toBe(true);
  });
  test('a discovery that ignores assignment (22u A3) is red', () => {
    expect(partition({ ...PREDICATE, discovery: PREDICATE.discovery.filter(([field]) => field !== 'assigned') }).some((line) => line.startsWith('worker') && line.includes('runnable and discovery'))).toBe(true);
  });
  test('a hole (runnable only when never attempted, as 22u A1 found) is red', () => {
    expect(partition({ ...PREDICATE, runnable: [...PREDICATE.runnable, ['attempt', ['never']]] }).some((line) => line.startsWith('implementor') && line.endsWith('no state'))).toBe(true);
  });
});

// ---- (vii) each delivered prompt's decoded policy against the oracle ----------------------------------------------

const pairKey = (a: string, b: string) => [a, b].sort().join(' & ');

/** Every pair of rows (catch-all aside) a policy makes true together on some reachable record: computed, never written by hand. */
export function computedPairs(policy: Policy): Map<string, string> {
  const out = new Map<string, string>();
  for (const { item: one } of reachable(policy.role).values()) {
    const atoms = truths([one]);
    const hits = policy.rows.filter((row) => row.when !== 'otherwise' && row.when.every((atom) => atoms.has(atom))).map((row) => row.id);
    for (const [i, a] of hits.entries()) for (const b of hits.slice(i + 1)) if (!out.has(pairKey(a, b))) out.set(pairKey(a, b), recordKey(one));
  }
  return out;
}

/** Every way a decoded policy disagrees with the oracle on a reachable record, and its overlaps with the pins. */
export function listFaults(policy: Policy, pins: ReadonlyArray<Pin> = PINS[policy.role]): string[] {
  const out: string[] = [];
  const role = policy.role;
  for (const { item: one } of reachable(role).values()) {
    const got = decide(policy, truths([one]))[0];
    const state = stateOf(role, one);
    const want = label(role, state, one.attempt);
    if (got === undefined || got.state !== state || got.label !== want) out.push(`${role} ${recordKey(one)}: the list gives ${got === undefined ? 'no row' : `${STATE_NAME[got.state]} (${got.label})`}, the oracle ${STATE_NAME[state]} (${want})`);
  }
  const pinned = new Map(pins.map((pin) => [pairKey(...pin.pair), pin]));
  const place = (id: string) => policy.rows.findIndex((row) => row.id === id);
  for (const [key, record] of computedPairs(policy)) {
    const pin = pinned.get(key);
    if (pin === undefined) out.push(`${role}: rows ${key} are both true of ${record}, and no winner is pinned`);
    else if (!(place(pin.winner) < place(pin.pair.find((id) => id !== pin.winner) ?? ''))) out.push(`${role}: ${pin.winner} is pinned over its pair, but the list puts the other first`);
  }
  const pairs = computedPairs(policy);
  for (const key of pinned.keys()) if (!pairs.has(key)) out.push(`${role}: a winner is pinned for ${key}, but no reachable record makes both true`);
  return out;
}

/** Every way a decoded policy's verdict rules answer a well-formed step otherwise than the source, and every unlisted overlap. */
export function verdictFaults(policy: Policy): string[] {
  const out: string[] = [];
  const pairs = new Set<string>();
  const holds = (rule: Policy['verdicts'][number], states: ReadonlyArray<State>) => (rule.when.kind === 'any' ? rule.when.states.some((s) => states.includes(s)) : rule.when.kind === 'only' ? states.every((s) => (rule.when as { states: ReadonlyArray<State> }).states.includes(s)) : true);
  for (const stop of STOPS_OF[policy.role])
    for (const states of multisets(STATES_OF[policy.role], SIZE)) {
      const want = outcome(POLICIES[policy.role], stop, states);
      const got = outcome(policy, stop, states);
      if (!want.ok) continue;
      if (!got.ok || got.value.verdict !== want.value.verdict) out.push(`${policy.role} ${stop} [${states}]: the shown rules give ${got.ok ? got.value.verdict : got.error}, the source ${want.value.verdict}`);
      const first = policy.verdicts.findIndex((rule) => holds(rule, states));
      for (const [index, rule] of policy.verdicts.entries()) if (index > first && rule.when.kind !== 'else' && holds(rule, states)) pairs.add(`${policy.verdicts[first]?.verdict} > ${rule.verdict}`);
    }
  const listed = new Set(VERDICT_ORDER[policy.role].map((pair) => `${pair.earlier} > ${pair.later}`));
  for (const pair of pairs) if (!listed.has(pair)) out.push(`${policy.role}: verdicts ${pair} both hold, and VERDICT_ORDER does not say why`);
  for (const pair of listed) if (!pairs.has(pair)) out.push(`${policy.role}: VERDICT_ORDER lists ${pair}, but no step makes both hold`);
  return out;
}

/** Every list history a policy answers otherwise than the history expects: its state and label, and its due hand-back's evidence fields. */
export function historyFaults(policy: Policy, histories = LIST_HISTORIES): string[] {
  return histories
    .filter((one) => one.role === policy.role)
    .flatMap((one) => {
      // The shortest generated history that reaches the list history's facts, as the envelope a step stores.
      const reached = traceFor(policy.role, one.items[0]!);
      if (reached === undefined) return [`${one.name}: no history reaches its facts`];
      const checked = decode(stepEnvelope(reached));
      if (!checked.ok) return [`${one.name}: ${checked.error}`];
      const due = owed(policy, checked.value);
      if (!due.ok) return [`${one.name}: ${due.error}`];
      const { label, fields } = due.value.claim.items[0]!;
      const handBack = handBackOf(due.value.states[0]!.state, label, fields);
      const out: string[] = [];
      // Exact: the history's label is the due label or its word (labelWord), never a shorter prefix or a blank.
      if (handBack.state !== one.state || (one.label !== handBack.label && one.label !== labelWord(handBack.label))) out.push(`${one.name}: ${STATE_NAME[handBack.state]} (${handBack.label})`);
      return [...out, ...judgeHandBack(handBack, one.handBack).map((line) => `${one.name}: hand-back ${line}`)];
    });
}

/** A policy with row `later` moved to just above `earlier`, renumbered: a well-formed block with another order. */
const moveAbove = (policy: Policy, earlier: string, later: string): Policy => {
  const moved = policy.rows.find((row) => row.id === later)!;
  const rest = policy.rows.filter((row) => row.id !== later);
  const at = rest.findIndex((row) => row.id === earlier);
  return { ...policy, rows: [...rest.slice(0, at), moved, ...rest.slice(at)].map((row, index): Row => ({ ...row, priority: index + 1 })) };
};

const decodedOf = (prompt: Prompt): Policy => {
  const found = /<!-- round-policy v[\s\S]*?<!-- \/round-policy -->/.exec(prompt.text)?.[0] ?? '';
  const got = decodeBlock(found);
  if (!got.ok) throw new Error(`${prompt.role} ${prompt.format}: ${got.error}`);
  return got.value;
};

describe('(vii) each delivered prompt, decoded: the first true row gives the oracle on every reachable record', () => {
  const all = prompts();
  test('each row is written by the grammar it is read back by: emit then parse is the identity', () => {
    for (const role of ROLES) for (const row of POLICIES[role].rows) expect([role, row.id, parseCondition(role, condition(role, row.when))]).toEqual([role, row.id, { ok: true, value: row.when }]);
    for (const role of ROLES) for (const rule of POLICIES[role].verdicts) expect(parseVerdictWhen(verdictWhen(rule.when, false))).toEqual({ ok: true, value: rule.when.kind === 'else' ? { kind: 'else' } : rule.when });
    expect(parseCondition('verifier', 'required, the moon is full').ok).toBe(false);
    expect(parseVerdictWhen('any item is lost').ok).toBe(false);
  });
  test('the atoms read one-to-one in each role: no two atoms share words', () => {
    for (const role of ROLES) expect(new Set(ATOMS.map((atom) => atomWords(role, atom))).size).toBe(ATOMS.length);
    for (const role of ROLES) expect(block(role)).toContain(`Assigned work is ${ASSIGNMENT[role]}`);
  });
  test('two and three obstacles at once are reachable, and every subset of them for every role', () => {
    for (const role of ROLES) {
      const sets = new Set([...reachable(role).values()].filter(({ item: one }) => one.assigned && one.required).map(({ item: one }) => OBSTACLE_FACTS.filter((fact) => one[fact]).join('+')));
      expect([role, [...sets].sort()]).toEqual([role, ['', 'hostCannot', 'hostCannot+wait', 'refused', 'refused+hostCannot', 'refused+hostCannot+wait', 'refused+wait', 'wait'].sort()]);
    }
  });
  for (const prompt of all)
    test(`${prompt.role} ${prompt.format}: every reachable record gets the oracle's state and label; overlaps are exactly the pinned ones; every history's due hand-back holds its fields`, () => {
      const policy = decodedOf(prompt);
      expect(listFaults(policy)).toEqual([]);
      expect(verdictFaults(policy)).toEqual([]);
      expect(historyFaults(policy)).toEqual([]);
    });
  test('optional probes: every subset of obstacles is reachable, and a history covers each, its due hand-back naming every obstacle that holds it', () => {
    const subsets = new Set([...reachable('verifier').values()].filter(({ item: one }) => one.assigned && !one.required && obstructed(one)).map(({ item: one }) => OBSTACLE_FACTS.filter((fact) => one[fact]).join('+')));
    expect([...subsets].sort()).toEqual(['hostCannot', 'hostCannot+wait', 'refused', 'refused+hostCannot', 'refused+hostCannot+wait', 'refused+wait', 'wait'].sort());
    const covered = new Set(LIST_HISTORIES.filter((one) => one.role === 'verifier' && one.items.every((it) => it.assigned && !it.required) && one.items.some(obstructed)).map((one) => OBSTACLE_FACTS.filter((fact) => one.items.some((it) => it[fact])).join('+')));
    expect([...covered].sort()).toEqual([...subsets].sort());
    for (const one of LIST_HISTORIES.filter((h) => h.items.every((it) => it.assigned && !it.required) && h.items.some(obstructed)))
      expect([one.name, one.state]).toEqual([one.name, one.items.some((it) => it.refused) ? 'refused' : 'unproven']);
  });
  test('at least 20 histories with two or three facts at once', () => {
    const multi = LIST_HISTORIES.filter((one) => one.name.startsWith('M') && (one.items.length > 1 || one.items.some((it) => OBSTACLE_FACTS.filter((fact) => it[fact]).length > 1 || (obstructed(it) && it.attempt !== 'never'))));
    expect(multi.length).toBeGreaterThanOrEqual(20);
  });
});

describe('(vii) a reordered, unpinned or forgetful policy is red', () => {
  test('moving the loser of any pinned pair above its winner is red against the oracle, and the delivery check names the rows', () => {
    for (const role of ROLES)
      for (const { pair, winner } of PINS[role]) {
        const loser = pair.find((id) => id !== winner) ?? '';
        const moved = moveAbove(POLICIES[role], winner, loser);
        expect([role, winner, loser, listFaults(moved).length > 0]).toEqual([role, winner, loser, true]);
        if (!(winner === 'unclear' && loser === 'retry')) expect([role, winner, loser, historyFaults(moved).length > 0]).toEqual([role, winner, loser, true]);
        const shown = render(moved);
        expect([role, winner, loser, policyFaults(role, shown).some((line) => line.startsWith(`${role}: row ${loser}:`) || line.startsWith(`${role}: rows:`))]).toEqual([role, winner, loser, true]);
      }
  });
  test('a computed pair with no pin, and a pin no record produces, are each red', () => {
    for (const role of ROLES) {
      const pins = PINS[role];
      expect(listFaults(POLICIES[role], pins.slice(1))[0]).toContain('no winner is pinned');
      expect(listFaults(POLICIES[role], [...pins, { pair: ['done', 'refused'], winner: 'refused', why: 'claimed' }]).at(-1)).toContain('no reachable record makes both true');
    }
  });
  test('a policy whose evidence fields forget an obstacle or the attempt is red against the histories', () => {
    for (const drop of ['waits', 'cannot', 'completed', 'current'] as const) {
      const red = ROLES.some((role) => historyFaults({ ...POLICIES[role], fields: POLICIES[role].fields.filter((field) => field.id !== drop) }).length > 0);
      expect([drop, red]).toEqual([drop, true]);
    }
  });
  test('folding the attempt history back into a row (ran unclear on its result alone) is red against the oracle', () => {
    const p = POLICIES.verifier;
    const folded = { ...p, rows: p.rows.map((row) => (row.id === 'unclear' ? { ...row, when: ['required', 'unclear'] as const } : row)) };
    expect(listFaults(folded).length).toBeGreaterThan(0);
    expect(historyFaults(folded).some((line) => line.startsWith('W01') || line.startsWith('W03') || line.includes('retry'))).toBe(true);
  });
});

// ---- the hand-back judge compares every field exactly (batch 23d T1; text-fix8-label 164493d5, carried here) ---------

describe('(vii) the hand-back judge compares every field exactly (batch 23d T1)', () => {
  /** Every label one role's list gives a reachable record. */
  const labelsOf = (role: Role) => [...new Set([...reachable(role).values()].map(({ item: one }) => decide(POLICIES[role], truths([one]))[0]!.label))].sort();
  /** The hand-back the shipped policy owes a list history, read from the claim of its decoded envelope. */
  const dueOf = (one: (typeof LIST_HISTORIES)[number]): HandBack => {
    const reached = traceFor(one.role, one.items[0]!);
    if (reached === undefined) throw new Error(`${one.name}: no history reaches it`);
    const checked = decode(stepEnvelope(reached));
    if (!checked.ok) throw new Error(checked.error);
    const due = owed(POLICIES[one.role], checked.value);
    if (!due.ok) throw new Error(due.error);
    const item = due.value.claim.items[0]!;
    return handBackOf(due.value.states[0]!.state, item.label, item.fields);
  };
  const OBSTACLE_ROWS: ReadonlyArray<ObstacleRow> = ['refused', 'cannot', 'waits'];
  test("a label's word is never blank, and the labels of one role have distinct words", () => {
    for (const role of ROLES) {
      const labels = labelsOf(role);
      for (const one of labels) expect([role, one, labelWord(one).trim().length > 0, one.startsWith(labelWord(one))]).toEqual([role, one, true, true]);
      expect([role, new Set(labels.map(labelWord)).size]).toEqual([role, labels.length]);
    }
    expect(() => labelWord('')).toThrow('has no word');
    expect(() => labelWord('   , and more')).toThrow('has no word');
  });
  test('each field: blank, prefix-only and wrong values are each rejected with exactly that field named; the due value and the label word are accepted', () => {
    for (const one of LIST_HISTORIES) {
      const due = dueOf(one);
      const word = labelWord(due.label);
      const good: HandBack = { ...one.handBack };
      expect([one.name, judgeHandBack(due, good)]).toEqual([one.name, []]);
      expect([one.name, judgeHandBack(due, { ...good, label: due.label })]).toEqual([one.name, []]);
      expect([one.name, judgeHandBack(due, { ...good, label: word })]).toEqual([one.name, []]);
      const otherWord = labelsOf(one.role).map(labelWord).find((w) => w !== word);
      if (otherWord === undefined) throw new Error(`${one.role} has one label`);
      const wrongState = STATES_OF[one.role].find((state) => state !== due.state);
      const wrongEvidence = OBSTACLE_ROWS.find((row) => row !== due.evidence);
      const without = (key: keyof HandBack) => Object.fromEntries(Object.entries(good).filter(([k]) => k !== key));
      const cases: ReadonlyArray<[unknown, string]> = [
        [{ ...good, label: '' }, `label: due ${word}, given ""`],
        [without('label'), `label: due ${word}, given unsaid`],
        [{ ...good, label: word.slice(0, 1) }, `label: due ${word}, given ${JSON.stringify(word.slice(0, 1))}`],
        [{ ...good, label: word.slice(0, -1) }, `label: due ${word}, given ${JSON.stringify(word.slice(0, -1))}`],
        [{ ...good, label: otherWord }, `label: due ${word}, given ${JSON.stringify(otherWord)}`],
        [{ ...good, label: `${word} and more` }, `label: due ${word}, given ${JSON.stringify(`${word} and more`)}`],
        [{ ...good, state: '' }, `state: due ${due.state}, given ""`],
        [without('state'), `state: due ${due.state}, given unsaid`],
        [{ ...good, state: due.state.slice(0, -1) }, `state: due ${due.state}, given ${JSON.stringify(due.state.slice(0, -1))}`],
        [{ ...good, state: wrongState }, `state: due ${due.state}, given ${JSON.stringify(wrongState)}`],
        [{ ...good, evidence: '' }, `evidence: due ${String(due.evidence)}, given ""`],
        [without('evidence'), `evidence: due ${String(due.evidence)}, given unsaid`],
        [{ ...good, evidence: wrongEvidence }, `evidence: due ${String(due.evidence)}, given ${JSON.stringify(wrongEvidence)}`],
        [{ ...good, evidence: due.evidence === null ? 'refused' : null }, `evidence: due ${String(due.evidence)}, given ${due.evidence === null ? '"refused"' : 'null'}`],
        [without('others'), `others: due [${due.others.join(', ')}], given unsaid`],
        [{ ...good, others: due.others.join(',') }, `others: due [${due.others.join(', ')}], given ${JSON.stringify(due.others.join(','))}`],
        [{ ...good, others: [...due.others, ...due.others.slice(0, 1), 'refused'] }, `others: due [${due.others.join(', ')}], given [${[...due.others, ...due.others.slice(0, 1), 'refused'].join(', ')}]`],
        [without('lastAttempt'), `last attempt: due ${due.lastAttempt ? 'present' : 'absent'}, given unsaid`],
        [{ ...good, lastAttempt: String(due.lastAttempt) }, `last attempt: due ${due.lastAttempt ? 'present' : 'absent'}, given ${JSON.stringify(String(due.lastAttempt))}`],
        [{ ...good, lastAttempt: !due.lastAttempt }, `last attempt: due ${due.lastAttempt ? 'present' : 'absent'}, given ${due.lastAttempt ? 'absent' : 'present'}`],
      ];
      for (const [given, fault] of cases) expect([one.name, judgeHandBack(due, given)]).toEqual([one.name, [fault]]);
      if (due.others.length > 0) {
        expect([one.name, judgeHandBack(due, { ...good, others: [] })]).toEqual([one.name, [`others: due [${due.others.join(', ')}], given []`]]);
        expect([one.name, judgeHandBack(due, { ...good, others: due.others.slice(0, -1) })]).toEqual([one.name, [`others: due [${due.others.join(', ')}], given [${due.others.slice(0, -1).join(', ')}]`]]);
        // Same length, a wrong obstacle: a length-only comparison would pass it.
        const swapped = [...due.others.slice(0, -1), OBSTACLE_ROWS.find((row) => !due.others.includes(row)) ?? 'refused'];
        expect([one.name, judgeHandBack(due, { ...good, others: swapped })]).toEqual([one.name, [`others: due [${due.others.join(', ')}], given [${swapped.join(', ')}]`]]);
      }
    }
  });
  test("a history's own label words are exact too: blank, prefix-only and another label's word are red", () => {
    const o07 = LIST_HISTORIES.find((one) => one.name.startsWith('O07 '))!;
    expect(historyFaults(POLICIES.verifier, [o07])).toEqual([]);
    const due = dueOf(o07);
    for (const wrong of ['', '`ref', '`waits on <id>`'])
      expect([wrong, historyFaults(POLICIES.verifier, [{ ...o07, label: wrong }])]).toEqual([wrong, [`${o07.name}: ${STATE_NAME[due.state]} (${due.label})`]]);
  });
  test("the verifier's 23d probe: O07 with a blank label is rejected by the label alone", () => {
    const o07 = LIST_HISTORIES.find((one) => one.name.startsWith('O07 '))!;
    const due = dueOf(o07);
    expect(judgeHandBack(due, { ...o07.handBack, label: '' })).toEqual([`label: due ${labelWord(due.label)}, given ""`]);
    expect(historyFaults(POLICIES.verifier, [{ ...o07, handBack: { ...o07.handBack, label: '' } }])).toEqual([`${o07.name}: hand-back label: due ${labelWord(due.label)}, given ""`]);
  });
  test('a hand-back that drops the last attempt, drops a second obstacle, or is prose is rejected, field by name', () => {
    for (const one of LIST_HISTORIES) {
      const given = one.handBack;
      if (given.lastAttempt) expect(historyFaults(POLICIES[one.role], [{ ...one, handBack: { ...given, lastAttempt: false } }])).toEqual([`${one.name}: hand-back last attempt: due present, given absent`]);
      else expect(historyFaults(POLICIES[one.role], [{ ...one, handBack: { ...given, lastAttempt: true } }])).toEqual([`${one.name}: hand-back last attempt: due absent, given present`]);
      if (given.others.length > 0) expect(historyFaults(POLICIES[one.role], [{ ...one, handBack: { ...given, others: given.others.slice(1) } }])).toEqual([`${one.name}: hand-back others: due [${given.others.join(', ')}], given [${given.others.slice(1).join(', ')}]`]);
    }
    const h = LIST_HISTORIES.find((one) => one.name.startsWith('an optional probe passes after an earlier unclear run'))!;
    expect(historyFaults(POLICIES.verifier, [{ ...h, handBack: 'discard the command and the last printed output' as never }])).toEqual([
      `${h.name}: hand-back the hand-back is prose ("discard the command and the last printed output"), not one whose fields can be checked`,
    ]);
  });
});
