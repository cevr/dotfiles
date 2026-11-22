// How a step ends (ending.ts), as two independent total functions:
//   (i)   F1 (state → label) and F2 (stop, item states → verdict and files) are total: every state of every role has
//         one label, and every stop with every multiset of up to three item states, mixed, gets one outcome or is
//         rejected as ill-formed with its reason; the invariants batches 22q to 22t asked for hold over all of them;
//   (ii)  rule retention: every sentence of the installed prompts (4afe1fda) the head no longer holds word for word is
//         in retention.ts with where its rule went, and every destination exists in the prompt;
//   (iii) the prompts: one block each, its role's two tables; every paragraph outside it is in the approved inventory
//         (inventory.ts), so any appended or edited sentence is red until the inventory is rewritten on purpose;
//   (iv)  every case found so far, N1 to N8 of 22t included, as a named row with its one disposition;
//   (v)   a changed label, a changed verdict rule, a deleted label or rule and dropped files are each red.
import { describe, expect, test } from 'bun:test';

import {
  ALL_STATES,
  ALL_STOPS,
  BEGIN,
  BLOCK,
  batchVerdict,
  classify,
  END,
  evidence,
  FILES,
  label,
  LABEL,
  multisets,
  REQUIRED,
  render,
  ROLES,
  type Role,
  type State,
  type Stop,
  STATES_OF,
  STOPS_OF,
  VERDICT,
} from './ending.ts';
import { approved, current, drift, paragraphs, type Prompt, prompts, ROOT } from './inventory.ts';
import { INSTALLED, RETENTION } from './retention.ts';

/** The verdict words each role may give. */
const VOCAB: Record<Role, ReadonlyArray<string>> = { planner: ['ready', 'blocked'], implementor: ['ready', 'blocked'], verifier: ['stuck', 'changes', 'accepted'], worker: ['none'] };
const HOLDS_BACK: Record<Role, ReadonlyArray<State>> = {
  planner: ['runnable', 'waits', 'refused', 'cannot'],
  implementor: ['runnable', 'waits', 'refused', 'cannot'],
  verifier: ['runnable', 'waits', 'refused', 'cannot', 'unclear'],
  worker: [],
};
const STATE_MD = '`<unit dir>/state.md` current (even with no commit since)';
const SIZE = 3;

type Data = { readonly labels: typeof LABEL; readonly rules: typeof VERDICT; readonly files: typeof FILES };
const DATA: Data = { labels: LABEL, rules: VERDICT, files: FILES };

// ---- (i) totality ------------------------------------------------------------------------------------------------

/** Every input either function leaves unanswered, answers twice or answers outside the role's words. */
export function totality(data: Data = DATA): string[] {
  const out: string[] = [];
  for (const role of ROLES) {
    for (const state of STATES_OF[role]) {
      try {
        const got = label(role, state, data.labels);
        if ((got === null) !== (state === 'done')) out.push(`F1 ${role} × ${state}: ${String(got)}`);
      } catch (error) {
        out.push(`F1 ${role} × ${state}: ${String(error)}`);
      }
    }
    for (const stop of ALL_STOPS)
      for (const states of multisets(ALL_STATES, SIZE)) {
        try {
          const got = classify(role, stop, states, data.rules, data.files);
          if ('outcome' in got === 'illFormed' in got) out.push(`F2 ${role} ${stop} [${states}]: not exactly one answer`);
          if ('outcome' in got && !VOCAB[role].includes(got.outcome.verdict)) out.push(`F2 ${role} ${stop} [${states}]: verdict ${got.outcome.verdict}`);
        } catch (error) {
          out.push(`F2 ${role} ${stop} [${states}]: ${String(error)}`);
        }
      }
  }
  return out;
}

/** Every well-formed input whose outcome breaks a rule the batches set. */
export function invariants(data: Data = DATA): string[] {
  const out: string[] = [];
  for (const role of ROLES)
    for (const stop of STOPS_OF[role])
      for (const states of multisets(STATES_OF[role], SIZE)) {
        let got;
        try {
          got = classify(role, stop, states, data.rules, data.files);
        } catch (error) {
          out.push(`${role} ${stop} [${states}]: ${String(error)}`);
          continue;
        }
        if (!('outcome' in got)) continue;
        const { verdict, files } = got.outcome;
        const at = `${role} ${stop} [${states}] → ${verdict}`;
        const held = states.some((state) => HOLDS_BACK[role].includes(state));
        if (role === 'planner' || role === 'implementor') {
          if ((verdict === 'ready') === held) out.push(`${at}: ready only when every required item is done`);
          if (verdict === 'blocked' && !(files.includes(STATE_MD) && files.includes('blocked.md'))) out.push(`${at}: a non-ready hand-back writes state.md current and blocked.md`);
        }
        if (role === 'verifier') {
          if ((verdict === 'stuck') !== held) out.push(`${at}: stuck exactly when a required check has no interpretable outcome`);
          if (!held && (verdict === 'changes') !== states.includes('proven')) out.push(`${at}: changes exactly when a Blocker or Major is proven`);
          if (files.includes('blocked.md')) out.push(`${at}: a verifier writes no blocked.md`);
        }
        if ((stop === 'refusalForm' || stop === 'refusalNone') && ['ready', 'accepted', 'changes'].includes(verdict)) out.push(`${at}: a refusal never ends a step done`);
        if (verdict !== 'ready' && verdict !== 'accepted' && verdict !== 'changes' && !files.includes(evidence(role, stop))) out.push(`${at}: the stop's evidence is not written`);
      }
  return out;
}

describe('(i) both functions are total', () => {
  test('F1: every state of every role has one label (none for done), and a state the role lacks is refused', () => {
    expect(totality().filter((line) => line.startsWith('F1'))).toEqual([]);
    for (const role of ROLES) for (const state of ALL_STATES.filter((one) => !STATES_OF[role].includes(one))) expect(() => label(role, state)).toThrow(`${role} has no state ${state}`);
  });
  test(`F2: every stop × every multiset of up to ${SIZE} item states gets one outcome or an ill-formed reason`, () => {
    expect(totality().filter((line) => line.startsWith('F2'))).toEqual([]);
  });
  test('the enumeration crosses every pair of states, mixed and repeated, under every stop', () => {
    const all = multisets(ALL_STATES, SIZE).map((states) => states.join());
    for (const a of ALL_STATES) for (const b of ALL_STATES) expect(all.includes([a, b].sort((x, y) => ALL_STATES.indexOf(x) - ALL_STATES.indexOf(y)).join())).toBe(true);
    expect(all.length).toBe(286);
  });
  test('each stop a role has leaves some well-formed input, and every verdict a role has is reached', () => {
    for (const role of ROLES) {
      const reached = new Set<string>();
      for (const stop of STOPS_OF[role]) {
        const outcomes = multisets(STATES_OF[role], SIZE).map((states) => classify(role, stop, states)).filter((got) => 'outcome' in got);
        expect([role, stop, outcomes.length > 0]).toEqual([role, stop, true]);
        for (const got of outcomes) if ('outcome' in got) reached.add(got.outcome.verdict);
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
      ['implementor', 'refusalNone', ['runnable'], 'a refusal stops the step at the one item it refused'],
      ['implementor', 'refusalForm', ['refused', 'refused'], 'a refusal stops the step at the one item it refused'],
      ['implementor', 'idle', ['refused'], 'a refusal stops the step at once, so a refused item means the step stopped on it'],
      ['verifier', 'idle', ['runnable', 'done'], 'the step goes on while a runnable item is left'],
      ['implementor', 'limit', ['waits'], 'with no runnable item left the step had already stopped, before the limit passed'],
    ];
    for (const [role, stop, states, why] of bad) expect(classify(role, stop, states)).toEqual({ illFormed: why });
  });
});

// ---- (ii) rule retention against the installed prompts -----------------------------------------------------------

const RULE_ROLES = ['planner', 'implementor', 'verifier'] as const;
const git = (...args: string[]) => {
  const run = Bun.spawnSync(['git', ...args], { cwd: ROOT });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
  return run.stdout.toString();
};
/** A prompt's sentences: each line, split after a sentence's end. */
export const sentences = (text: string) =>
  text.split('\n').flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z`*(])/)).map((one) => one.trim()).filter(Boolean);
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
    const found = a !== undefined && STATES_OF[role].includes(a as State) ? label(role, a as State) : null;
    return found === null ? `${ref}: no label` : { role, text: found };
  }
  if (kind === 'F2' && a === 'evidence') return b !== undefined && STOPS_OF[role].includes(b as Stop) ? { role, text: evidence(role, b as Stop) } : `${ref}: no stop`;
  if (kind === 'F2') {
    const files = a === undefined ? undefined : FILES[role][a];
    return VERDICT[role].some((rule) => rule.verdict === a) && files !== undefined ? { role, text: files.replace('<evidence>', "the stop's evidence").replace('<items>', 'each item left with its label') } : `${ref}: no verdict`;
  }
  if (kind === 'REQUIRED') return { role, text: REQUIRED[role] };
  return `${ref}: unknown`;
}

describe('(ii) every rule of the installed prompts is kept, moved into F1 or F2, or replaced by a design line', () => {
  const head = prompts();
  const lost = new Map<string, Set<Role>>();
  for (const role of RULE_ROLES)
    for (const old of installed(role)) {
      const now = head.find((one) => one.role === role && one.format === old.format)?.text ?? '';
      for (const sentence of sentences(old.text)) if (!now.includes(sentence)) lost.set(sentence, (lost.get(sentence) ?? new Set()).add(role));
    }
  test('the sentences no longer held word for word are exactly retention.ts\'s entries', () => {
    expect([...lost.keys()].filter((sentence) => !(sentence in RETENTION))).toEqual([]);
    expect(Object.keys(RETENTION).filter((sentence) => !lost.has(sentence))).toEqual([]);
  });
  test('a reworded rule stands word for word in every prompt of each role that had it', () => {
    for (const [sentence, fate] of Object.entries(RETENTION))
      if (fate.kind === 'reworded')
        for (const role of lost.get(sentence) ?? []) for (const prompt of head.filter((one) => one.role === role)) expect([prompt.role, prompt.format, prompt.text.includes(fate.now)]).toEqual([role, prompt.format, true]);
  });
  test('every destination is a cell of F1 or F2 (or a required-work line) that its role\'s prompts carry', () => {
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

/** Every way a prompt's block is not its role's one block. */
export function blockFaults(prompt: Prompt): string[] {
  const at = `${prompt.role} ${prompt.format}`;
  const out: string[] = [];
  if (prompt.text.split(BEGIN).length !== 2 || prompt.text.split(END).length !== 2) out.push(`${at}: not exactly one end-of-step block`);
  if (BLOCK.exec(prompt.text)?.[0] !== render(prompt.role)) out.push(`${at}: the block is not its role's two tables`);
  return out;
}

/** Every structural fault: the block, then any paragraph outside it the inventory has not approved. */
export const lint = (prompt: Prompt): string[] => [...blockFaults(prompt), ...drift(prompt)];

const SURVIVORS: ReadonlyArray<{ role: Role; sentence: string }> = [
  { role: 'planner', sentence: 'A planner may hand back ready without running any acceptance check.' },
  { role: 'planner', sentence: "An unrun acceptance check cannot prevent a planner's `ready` verdict." },
  { role: 'planner', sentence: 'Skip the acceptance check and conclude the planning step as soon as the spec is written.' },
  { role: 'worker', sentence: 'Upon any permission refusal, complete one more unrelated item before replying.' },
  { role: 'implementor', sentence: 'Keep going on the next item after a refusal.' },
  { role: 'verifier', sentence: 'When a required check ran unclear, call the unit accepted.' },
];

describe('(iii) each prompt: its role\'s one block, and nothing outside it the inventory has not approved', () => {
  const all = prompts();
  test('three host formats for each role, two for the lean worker', () => {
    expect(all.map((prompt) => `${prompt.role} ${prompt.format}`)).toEqual(Object.keys(approved().prompts));
  });
  for (const prompt of all)
    test(`${prompt.role} ${prompt.format}: one block, its two tables, every other paragraph approved`, () => {
      expect(lint(prompt)).toEqual([]);
    });
  test('the inventory holds no paragraph no prompt uses, and matches the prompts as they are', () => {
    const inventory = approved();
    const used = new Set(Object.values(inventory.prompts).flat());
    expect(Object.keys(inventory.paragraphs).filter((key) => !used.has(key))).toEqual([]);
    expect(current(all)).toEqual(inventory);
  });
  test('each surviving mutant of 22s and 22t, appended, is red in every format of its role', () => {
    for (const { role, sentence } of SURVIVORS)
      for (const prompt of all.filter((one) => one.role === role)) {
        expect([prompt.format, sentence, lint({ ...prompt, text: `${prompt.text}\n${sentence}` }).length > 0]).toEqual([prompt.format, sentence, true]);
        expect([prompt.format, sentence, lint({ ...prompt, text: `${prompt.text}\n\n${sentence}` }).length > 0]).toEqual([prompt.format, sentence, true]);
      }
  });
  test('an edit inside a paragraph, a deleted paragraph and two swapped paragraphs are each red in every format', () => {
    for (const prompt of all) {
      const parts = paragraphs(prompt.text);
      const target = parts.find((one) => one.startsWith('**Refusals.**') || one.startsWith('Do the task')) ?? parts[2] ?? '';
      const edited = prompt.text.replace(target, `${target.replace(/\.$/, '')}, unless it slows you down.`);
      expect([prompt.role, prompt.format, edited !== prompt.text, lint({ ...prompt, text: edited }).length > 0]).toEqual([prompt.role, prompt.format, true, true]);
      const deleted = prompt.text.replace(target, '');
      expect([prompt.role, prompt.format, lint({ ...prompt, text: deleted }).length > 0]).toEqual([prompt.role, prompt.format, true]);
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
    const planner = all.find((one) => one.role === 'planner' && one.format === 'codex');
    if (planner === undefined) throw new Error('no codex planner');
    expect(lint({ ...planner, text: `${planner.text}\n${render('planner')}` }).length).toBeGreaterThan(0);
    expect(lint({ ...planner, text: planner.text.replace(BLOCK, () => render('implementor')) }).length).toBeGreaterThan(0);
  });
});

// ---- (iv) named cases ---------------------------------------------------------------------------------------------

interface Case {
  readonly name: string;
  readonly role: Role;
  readonly stop: Stop;
  /** Each item, by name, in its one state. */
  readonly items: Readonly<Record<string, State>>;
  readonly verdict: string;
  /** Words each item's label must hold. */
  readonly labels: Readonly<Record<string, string>>;
  /** Words the files written must hold. */
  readonly files?: ReadonlyArray<string>;
}

const WAITS = '`waits on <id>`';
const REFUSED = '`refused: <what>`';
const CANNOT = '`cannot run here: <check or tool>`';
const CONTINUES = '`continues next round`';
const OUTSIDE = '`finding outside the unit`';

export const CASES: ReadonlyArray<Case> = [
  // 22t, the six FAIL inputs and two PASS ones of its prompt.ts, and the controls its B3 asked for.
  { name: 'N1 verifier: check A waits, independent check B is refused', role: 'verifier', stop: 'refusalNone', items: { a: 'waits', b: 'refused' }, verdict: 'stuck', labels: { a: WAITS, b: REFUSED }, files: ['what was refused, as the refusal said it'] },
  { name: 'N2 verifier: check A waits, independent check B lacks its executable', role: 'verifier', stop: 'idle', items: { a: 'waits', b: 'cannot' }, verdict: 'stuck', labels: { a: WAITS, b: CANNOT } },
  { name: 'N3 implementor: check A cannot run, then item B is refused', role: 'implementor', stop: 'refusalNone', items: { a: 'cannot', b: 'refused' }, verdict: 'blocked', labels: { a: CANNOT, b: REFUSED } },
  { name: 'N4 verifier: a written-rule break the unit introduced, outside the spec items, no failing run', role: 'verifier', stop: 'idle', items: { checks: 'done', rule: 'unitFinding' }, verdict: 'accepted', labels: { rule: 'marked `unit`: the same lane closes it in its next round' } },
  { name: 'N4 control: the same break shown on the base head', role: 'verifier', stop: 'idle', items: { checks: 'done', rule: 'baseFinding' }, verdict: 'accepted', labels: { rule: 'marked `base`: a follow-up unit' } },
  { name: 'N5 verifier: a required check ran, its result settles nothing', role: 'verifier', stop: 'idle', items: { check: 'unclear' }, verdict: 'stuck', labels: { check: '`ran unclear: <check>`' } },
  { name: 'N5 control: the required executable is absent', role: 'verifier', stop: 'idle', items: { check: 'cannot' }, verdict: 'stuck', labels: { check: CANNOT } },
  { name: 'N5 control: the required check is conclusively red', role: 'verifier', stop: 'idle', items: { check: 'proven' }, verdict: 'changes', labels: { check: 'a Blocker or Major' } },
  { name: 'N5 control: only a wider probe ran unclear (Unproven, no required item)', role: 'verifier', stop: 'idle', items: { check: 'done' }, verdict: 'accepted', labels: {} },
  { name: 'N6 implementor: the timebox passes after uncommitted progress and a new wait', role: 'implementor', stop: 'limit', items: { progress: 'runnable', wait: 'waits' }, verdict: 'blocked', labels: { progress: CONTINUES, wait: WAITS }, files: [STATE_MD, 'the clock (the timebox)'] },
  { name: 'N7 planner: waits on a prerequisite and finds unrelated work', role: 'planner', stop: 'idle', items: { prerequisite: 'waits', found: 'discovery' }, verdict: 'blocked', labels: { prerequisite: WAITS, found: OUTSIDE }, files: ['blocked.md'] },
  { name: 'N8 lean worker: refused with no form, unrelated work left', role: 'worker', stop: 'refusalNone', items: { it: 'refused', other: 'runnable' }, verdict: 'none', labels: { it: 'never tried another way', other: '`left`' }, files: ['what was refused, as the refusal said it'] },
  // 22s, the five FAIL inputs and the PASS ones of its prompt-audit.ts.
  { name: '22s-1 planner refused by a terminal classifier that names no command or allow rule', role: 'planner', stop: 'refusalNone', items: { spec: 'refused' }, verdict: 'blocked', labels: { spec: REFUSED }, files: ['an allow rule only if one exists'] },
  { name: '22s-2 implementor refusal with a named form, another item runnable, the clock not out', role: 'implementor', stop: 'refusalForm', items: { refused: 'refused', other: 'runnable' }, verdict: 'blocked', labels: { refused: '; form: <the form it named>', other: CONTINUES }, files: ['the form it named'] },
  { name: '22s-3 verifier refused on its first required check', role: 'verifier', stop: 'refusalNone', items: { first: 'refused', rest: 'runnable' }, verdict: 'stuck', labels: { first: REFUSED, rest: '`not run`' }, files: ['under Check'] },
  { name: '22s-4 verifier whose required executable is absent, no refusal', role: 'verifier', stop: 'idle', items: { check: 'cannot' }, verdict: 'stuck', labels: { check: CANNOT } },
  { name: '22s-5 implementor past its timebox, one item waits on an open unit, one runnable', role: 'implementor', stop: 'limit', items: { waiting: 'waits', runnable: 'runnable' }, verdict: 'blocked', labels: { waiting: WAITS, runnable: CONTINUES }, files: ['the clock'] },
  { name: '22s-6 verifier lacking only a wider probe, every required check ran', role: 'verifier', stop: 'idle', items: { checks: 'done' }, verdict: 'accepted', labels: {} },
  { name: '22s-8 planner with a red check and the product unbuilt', role: 'planner', stop: 'idle', items: { spec: 'done', found: 'discovery' }, verdict: 'ready', labels: { found: OUTSIDE }, files: ['spec.md'] },
  // 22r.
  { name: '22r-B2 first refusal names a script-file form', role: 'implementor', stop: 'refusalForm', items: { item: 'refused' }, verdict: 'blocked', labels: { item: '; form: <the form it named>' } },
  { name: '22r-principle-B1 a defect found in an owned file, one spec item unfinished at the timebox', role: 'implementor', stop: 'limit', items: { defect: 'discovery', item: 'runnable' }, verdict: 'blocked', labels: { defect: OUTSIDE, item: CONTINUES } },
  { name: '22r-R1 the lean worker meets a refusal with other work left', role: 'worker', stop: 'refusalNone', items: { it: 'refused', other: 'runnable' }, verdict: 'none', labels: { it: REFUSED, other: '`left`' } },
  // 22q.
  { name: '22q-B1 the timebox passes with a runnable item unfinished', role: 'implementor', stop: 'limit', items: { item: 'runnable' }, verdict: 'blocked', labels: { item: CONTINUES } },
  { name: '22q-principle-B1 a refusal with no form, one item refused, another runnable', role: 'implementor', stop: 'refusalNone', items: { refused: 'refused', other: 'runnable' }, verdict: 'blocked', labels: { refused: REFUSED, other: CONTINUES } },
  // The crossings listed before and found since.
  { name: 'refusal × timebox: the refusal came first', role: 'implementor', stop: 'refusalNone', items: { refused: 'refused', other: 'runnable' }, verdict: 'blocked', labels: { refused: REFUSED, other: CONTINUES } },
  { name: 'refusal × timebox: the clock came first', role: 'implementor', stop: 'limit', items: { other: 'runnable' }, verdict: 'blocked', labels: { other: CONTINUES }, files: ['the clock'] },
  { name: 'blocked × waiting: only waiting work is left', role: 'implementor', stop: 'idle', items: { item: 'waits' }, verdict: 'blocked', labels: { item: WAITS }, files: [STATE_MD] },
  { name: 'a check cannot run and another item waits', role: 'planner', stop: 'idle', items: { check: 'cannot', other: 'waits' }, verdict: 'blocked', labels: { check: CANNOT, other: WAITS } },
  { name: 'follow-up × finding: the discovery is outside the unit, the cut item is not', role: 'planner', stop: 'limit', items: { found: 'discovery', cut: 'runnable' }, verdict: 'blocked', labels: { found: OUTSIDE, cut: CONTINUES } },
  { name: 'a verifier whose spec lines contradict', role: 'verifier', stop: 'idle', items: { check: 'waits' }, verdict: 'stuck', labels: { check: WAITS } },
  { name: 'a verifier proves a Blocker and a check ran unclear: stuck first', role: 'verifier', stop: 'idle', items: { red: 'proven', other: 'unclear' }, verdict: 'stuck', labels: { red: 'a Blocker or Major', other: '`ran unclear: <check>`' } },
  { name: 'the lean worker cannot run a tool', role: 'worker', stop: 'idle', items: { tool: 'cannot' }, verdict: 'none', labels: { tool: CANNOT } },
];

/** Every way the two functions answer a named case otherwise than the case expects. */
export function caseFailures(data: Data = DATA, cases: ReadonlyArray<Case> = CASES): string[] {
  const out: string[] = [];
  for (const one of cases) {
    try {
      const got = classify(one.role, one.stop, Object.values(one.items), data.rules, data.files);
      if (!('outcome' in got)) {
        out.push(`${one.name}: ill-formed: ${got.illFormed}`);
        continue;
      }
      if (got.outcome.verdict !== one.verdict) out.push(`${one.name}: verdict ${got.outcome.verdict}`);
      for (const words of one.files ?? []) if (!got.outcome.files.includes(words)) out.push(`${one.name}: files ${got.outcome.files}`);
      for (const [name, words] of Object.entries(one.labels)) {
        const found = label(one.role, one.items[name] ?? 'done', data.labels);
        if (found === null || !found.includes(words)) out.push(`${one.name}: ${name} is ${String(found)}`);
      }
    } catch (error) {
      out.push(`${one.name}: ${String(error)}`);
    }
  }
  return out;
}

describe('(iv) every case found so far has its one disposition', () => {
  test('the named cases', () => {
    expect(caseFailures()).toEqual([]);
  });
  test('an item keeps its label whatever stops the step (N1 to N3): F1 takes no stop', () => {
    expect(label.length).toBe(2);
    for (const role of ROLES)
      for (const state of STATES_OF[role]) expect(render(role)).toContain(`| ${label(role, state) ?? 'none: it is no item left'} |`);
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

describe('(v) a changed label, verdict rule or files, and a deleted label or rule, are each red', () => {
  test('changing one label (a live wait relabelled `continues next round`) is red', () => {
    const labels = { ...LABEL, implementor: { ...LABEL.implementor, waits: LABEL.implementor.runnable } };
    expect(caseFailures({ ...DATA, labels }).length).toBeGreaterThan(0);
  });
  test('changing one verdict rule (ran unclear no longer `stuck`) is red', () => {
    const rules = { ...VERDICT, verifier: VERDICT.verifier.map((rule) => ('any' in rule && rule.verdict === 'stuck' ? { ...rule, any: rule.any.filter((state) => state !== 'unclear') } : rule)) };
    expect(invariants({ ...DATA, rules }).length).toBeGreaterThan(0);
    expect(caseFailures({ ...DATA, rules }).some((line) => line.startsWith('N5'))).toBe(true);
  });
  test('giving a verifier `blocked` is red', () => {
    const rules = { ...VERDICT, verifier: [{ verdict: 'blocked', any: ['refused'] as State[] }, ...VERDICT.verifier] };
    const files = { ...FILES, verifier: { ...FILES.verifier, blocked: '`<unit dir>/blocked.md`' } };
    expect(totality({ labels: LABEL, rules, files }).length).toBeGreaterThan(0);
    expect(invariants({ labels: LABEL, rules, files }).length).toBeGreaterThan(0);
  });
  test('dropping state.md from a non-ready hand-back (B4) is red', () => {
    const files = { ...FILES, implementor: { ...FILES.implementor, blocked: '`<unit dir>/blocked.md`: <evidence>, and <items>' } };
    expect(invariants({ ...DATA, files }).length).toBeGreaterThan(0);
    expect(caseFailures({ ...DATA, files }).some((line) => line.startsWith('N6'))).toBe(true);
  });
  test('deleting one label, or one verdict rule, is red', () => {
    const { unitFinding: _gone, ...rest } = LABEL.verifier;
    expect(totality({ ...DATA, labels: { ...LABEL, verifier: rest } })).toEqual(['F1 verifier × unitFinding: Error: no label for verifier × unitFinding']);
    const rules = { ...VERDICT, planner: VERDICT.planner.filter((rule) => rule.verdict !== 'blocked') };
    expect(totality({ ...DATA, rules }).length).toBeGreaterThan(0);
  });
});
