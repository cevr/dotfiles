// The end-of-step decision table (ending.ts): (i) every cell of role × reason × item state resolves to exactly one
// outcome or a named impossibility; (ii) each generated prompt, in every host format, carries its role's rows as the
// one generated block, and no sentence outside that block states how a step ends; (iii) every case batches 22q, 22r
// and 22s found, as a named row with its one disposition; (v) changing one cell, deleting one row and appending a
// contradictory sentence each turn a check red.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AT_ONCE,
  batchVerdict,
  BEGIN,
  BLOCK,
  cell,
  END,
  LABELS,
  NEVER,
  ONCE_NOTHING_RUNNABLE,
  REASONS,
  reasonOf,
  render,
  REQUIRED,
  ROLES,
  type Label,
  type Reason,
  type Role,
  type Row,
  type State,
  STATES,
  stateOf,
  TABLE,
} from './ending.ts';

const ROOT = join(import.meta.dir, '../../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

// ---- (i) totality ------------------------------------------------------------------------------------------------

/** Every way the table fails to give each cell of the cross-product exactly one outcome. */
export function totality(table: ReadonlyArray<Row>): string[] {
  const out: string[] = [];
  for (const role of ROLES)
    for (const reason of REASONS) {
      const rows = table.filter((row) => row.role === role && row.reason === reason);
      if (rows.length !== 1) { out.push(`${role} × ${reason}: ${rows.length} rows`); continue; }
      const row = rows[0]!;
      if ('never' in row) { if (!(row.never in NEVER)) out.push(`${role} × ${reason}: unknown reason ${row.never}`); continue; }
      const keys = Object.keys(row.items).sort();
      if (keys.join() !== [...STATES].sort().join()) out.push(`${role} × ${reason}: states ${keys.join()}`);
      for (const state of STATES) {
        const item = row.items[state];
        if (item === undefined) continue;
        if ('label' in item && !(item.label in LABELS)) out.push(`${role} × ${reason} × ${state}: unknown label`);
        if ('never' in item && !(item.never in NEVER)) out.push(`${role} × ${reason} × ${state}: unknown reason`);
        if ('label' in item === 'never' in item) out.push(`${role} × ${reason} × ${state}: not exactly one of a label and a reason`);
      }
    }
  for (const row of table) if (!ROLES.includes(row.role) || !REASONS.includes(row.reason)) out.push(`a row off the axes: ${row.role} × ${row.reason}`);
  return out;
}

/** The rules a cell's outcome must keep, whatever it says: each role's own verdict words, labels where they belong. */
export function invariants(table: ReadonlyArray<Row>): string[] {
  const out: string[] = [];
  for (const row of table) {
    const at = `${row.role} × ${row.reason}`;
    if ('never' in row) continue;
    const words = [...row.verdict.matchAll(/`(\w+)`/g)].map((match) => match[1]);
    if (row.role === 'planner' || row.role === 'implementor') {
      if (words.length !== 1 || words[0] !== (row.reason === 'done' ? 'ready' : 'blocked')) out.push(`${at}: verdict ${row.verdict}`);
      if (row.reason !== 'done' && !row.file.includes('blocked.md')) out.push(`${at}: writes no blocked.md`);
    }
    if (row.role === 'verifier') {
      if (words.some((word) => !['accepted', 'changes', 'stuck'].includes(word!)) || words.length === 0) out.push(`${at}: a verdict a verifier lacks: ${row.verdict}`);
      if (row.file.includes('blocked.md')) out.push(`${at}: a verifier writes no blocked.md`);
      if (row.reason !== 'done' && row.verdict !== '`stuck`') out.push(`${at}: a verifier stopped early is \`stuck\``);
    }
    if (row.role === 'worker' && (!row.verdict.startsWith('none: your result as text') || words.length > 0)) out.push(`${at}: a lean worker has no verdict word`);
    const label = (state: State) => ('label' in row.items[state] ? (row.items[state] as { label: Label }).label : undefined);
    const stopped = label('stopped');
    const refusedLabels: ReadonlyArray<Label> = ['refused', 'refusedForm', 'taskRefused', 'taskRefusedForm'];
    if (row.reason === 'refusal-form' && !(stopped === 'refusedForm' || stopped === 'taskRefusedForm')) out.push(`${at}: the refused item names its form`);
    if (row.reason === 'refusal-none' && !(stopped === 'refused' || stopped === 'taskRefused')) out.push(`${at}: the refused item names no form`);
    if (!row.reason.startsWith('refusal') && stopped !== undefined && refusedLabels.includes(stopped)) out.push(`${at}: a refused label without a refusal`);
    if (label('waits') !== undefined && label('waits') !== 'waits') out.push(`${at}: a live wait keeps \`waits on <id>\``);
    if (['continues', 'waits', 'notRun', 'left'].includes(label('discovery') ?? '')) out.push(`${at}: a discovery is no unit work`);
    if ((row.role === 'planner' || row.role === 'implementor') && row.reason !== 'done' && label('runnable') !== undefined && label('runnable') !== 'continues')
      out.push(`${at}: a runnable item left stays this unit's work, \`continues next round\``);
  }
  return out;
}

describe('(i) the table is total', () => {
  test('every role × reason × state resolves to exactly one outcome or a named impossibility', () => {
    expect(totality(TABLE)).toEqual([]);
    let cells = 0;
    for (const role of ROLES) for (const reason of REASONS) for (const state of STATES) {
      const outcome = cell(role, reason, state);
      expect(['never' in outcome, 'label' in outcome].filter(Boolean).length).toBe(1);
      cells += 1;
    }
    expect(cells).toBe(ROLES.length * REASONS.length * STATES.length);
  });
  test('every outcome keeps its role\'s verdict words and puts each label where it belongs', () => {
    expect(invariants(TABLE)).toEqual([]);
  });
  test('the reasons and states are each one order: no reason or state is left out or listed twice', () => {
    expect([...AT_ONCE, ...ONCE_NOTHING_RUNNABLE].sort()).toEqual([...REASONS].sort());
    expect(new Set(STATES).size).toBe(STATES.length);
  });
});

// ---- (ii) one block per prompt, nothing outside it ----------------------------------------------------------------

const body = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n/, '');
const toml = (file: string) => /developer_instructions = '''\n([\s\S]*?)\n'''/.exec(file)![1]!;
type Prompt = { readonly role: Role; readonly format: string; readonly text: string };
function prompts(): Prompt[] {
  const json = JSON.parse(read('opencode/mods/orchestrate/agents.json')) as { agents: Record<string, { system: string }> };
  return ROLES.flatMap((role) => [
    { role, format: 'claude', text: body(read(`agents/${role}.md`)) },
    ...(role === 'worker' ? [] : [{ role, format: 'codex', text: toml(read(`codex/agents/${role}.toml`)) }]),
    { role, format: 'opencode', text: json.agents[role]!.system },
  ]);
}

/** Words that state how a step ends: a verdict, a hand-back, an item's label. */
const ENDS = /\b(ready|blocked|accepted|changes|stuck)\b|hand(s|ed|ing)?[- ]back|\bends? with\b|continues next round|waits on|refused:|cannot run here|finding outside the unit|outside the task|`not run`|`left`/i;
/**
 * The sentences outside the block that carry such a word and still decide no step's end, each with why. Any other
 * such sentence is a second answer.
 */
const ALLOWED: Record<string, string> = {
  '**Messages.** Every reply is a file in the unit dir plus your hand-back line; the orchestrator answers through the host\'s agent messages, naming file paths.':
    'the hand-back line as the transport, no outcome',
  'A unit lands once its focused gate is green, by its receipt, alone (lane) or with the other ready units (batch), and is verified after, over a range of main or its batch; a `deep` unit is verified before its merge.':
    "the orchestrator's land, after a step",
  'A round **fails** when that verifier proves a Blocker or Major against the unit (`changes`), and a Blocker or Major is only a failure a run shows a user would hit, a red gate, acceptance check or CI run, data loss, or a reserved action taken; a red acceptance check is a Blocker.':
    'what a `changes` verdict does to the round; the verdict itself is the table\'s',
  'A `stuck` verdict means no round can help until its cause changes.': 'what a `stuck` verdict means to the orchestrator',
  '**Findings.** `<unit dir>/round-N-findings.md`, under 10 KB: `Verdict: ACCEPTED`, `Verdict: CHANGES REQUIRED` or `Verdict: STUCK` first; Check (command, expected, observed, evidence); the sections Blockers and Major, Test strength, Unproven (3 at most) and On base (a written-rule break), each Test strength and On base finding marked `unit` if the unit\'s change introduced it or `base` if the base head shows it too, each finding with an id, file:line, failure, proof, repair and guard (`M3 repeat of r2 M1` for a new trigger); each command\'s exit code.':
    "the findings file's format",
};
const sentences = (text: string) =>
  text.split('\n').flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z`*(])/)).map((one) => one.trim()).filter(Boolean);

/** Every way a prompt breaks the structure: not one block, not its role's rows, or a disposition outside it. */
export function lint(prompt: Prompt): string[] {
  const out: string[] = [];
  const at = `${prompt.role} ${prompt.format}`;
  if (prompt.text.split(BEGIN).length !== 2 || prompt.text.split(END).length !== 2) out.push(`${at}: not exactly one end-of-step block`);
  const block = BLOCK.exec(prompt.text)?.[0];
  if (block !== render(prompt.role)) out.push(`${at}: the block is not its role's rows`);
  for (const sentence of sentences(prompt.text.replace(BLOCK, '')))
    if (ENDS.test(sentence) && !(sentence in ALLOWED)) out.push(`${at}: outside the block: ${sentence}`);
  return out;
}

const MUTANT = 'A planner may hand back ready without running any acceptance check.';

describe('(ii) each prompt carries its rows and no other end-of-step sentence', () => {
  const all = prompts();
  test('three host formats for each role, two for the lean worker', () => {
    expect(all.length).toBe(11);
  });
  for (const prompt of all)
    test(`${prompt.role} ${prompt.format}: one block, its role's rows, nothing outside it`, () => {
      expect(lint(prompt)).toEqual([]);
    });
  test("22s's surviving mutant, appended or set inside a paragraph, is red in every planner format", () => {
    for (const prompt of all.filter((one) => one.role === 'planner')) {
      expect([prompt.format, lint({ ...prompt, text: `${prompt.text}\n${MUTANT}` }).length > 0]).toEqual([prompt.format, true]);
      const inside = prompt.text.replace('and change no product code', `and change no product code. ${MUTANT} Then`);
      expect(inside).not.toBe(prompt.text);
      expect([prompt.format, lint({ ...prompt, text: inside }).length > 0]).toEqual([prompt.format, true]);
    }
  });
  test('a second block, or a block of another role, is red', () => {
    const planner = all.find((one) => one.role === 'planner' && one.format === 'codex')!;
    expect(lint({ ...planner, text: `${planner.text}\n${render('planner')}` }).length).toBeGreaterThan(0);
    expect(lint({ ...planner, text: planner.text.replace(BLOCK, () => render('implementor')) }).length).toBeGreaterThan(0);
  });
  test('every allowed sentence still stands in some prompt (none is stale)', () => {
    const outside = new Set(all.flatMap((prompt) => sentences(prompt.text.replace(BLOCK, ''))));
    expect(Object.keys(ALLOWED).filter((sentence) => !outside.has(sentence))).toEqual([]);
  });
});

// ---- (iii) named cases -------------------------------------------------------------------------------------------

interface Case {
  readonly name: string;
  readonly role: Role;
  /** Every reason that holds when the step ends, and the one that came first among those that end it at once. */
  readonly holding: ReadonlyArray<Reason>;
  readonly first?: Reason;
  /** Each item left, by name, with every state it is in. */
  readonly items: Readonly<Record<string, ReadonlyArray<State>>>;
  readonly reason: Reason;
  readonly verdict: string;
  readonly labels: Readonly<Record<string, Label>>;
  /** Words the row's file must hold. */
  readonly file?: string;
}

const CASES: ReadonlyArray<Case> = [
  // 22s, the five FAIL inputs and the three PASS ones of its prompt-audit.ts.
  { name: '22s-1 planner refused by a terminal classifier that names no command or allow rule', role: 'planner', holding: ['refusal-none'], items: { spec: ['stopped'] }, reason: 'refusal-none', verdict: '`blocked`', labels: { spec: 'refused' }, file: 'an allow rule only if one exists' },
  { name: '22s-2 implementor refusal with a named form, another item runnable, the clock not out', role: 'implementor', holding: ['refusal-form'], items: { refused: ['stopped'], other: ['runnable'] }, reason: 'refusal-form', verdict: '`blocked`', labels: { refused: 'refusedForm', other: 'continues' }, file: 'the form it named' },
  { name: '22s-3 verifier refused on its first required check', role: 'verifier', holding: ['refusal-none'], items: { first: ['stopped'], rest: ['runnable'] }, reason: 'refusal-none', verdict: '`stuck`', labels: { first: 'refused', rest: 'notRun' }, file: 'the refusal under Check' },
  { name: '22s-4 verifier whose required executable is absent, no refusal', role: 'verifier', holding: ['cannot-run'], items: { check: ['stopped'] }, reason: 'cannot-run', verdict: '`stuck`', labels: { check: 'cannot' } },
  { name: '22s-5 implementor past its timebox, one item waits on an open unit, one runnable', role: 'implementor', holding: ['limit', 'waiting'], items: { waiting: ['waits'], runnable: ['runnable'] }, reason: 'limit', verdict: '`blocked`', labels: { waiting: 'waits', runnable: 'continues' }, file: 'quoting the clock' },
  { name: '22s-6 verifier lacking only a wider probe, every required check ran', role: 'verifier', holding: ['done'], items: {}, reason: 'done', verdict: '`changes` if you proved a Blocker or Major, else `accepted`', labels: {} },
  { name: '22s-8 planner with a red check and the product unbuilt', role: 'planner', holding: ['done'], items: { found: ['discovery'] }, reason: 'done', verdict: '`ready`', labels: { found: 'outside' }, file: 'spec.md' },
  // 22r.
  { name: '22r-B2 first refusal names a script-file form', role: 'implementor', holding: ['refusal-form'], items: { item: ['stopped'] }, reason: 'refusal-form', verdict: '`blocked`', labels: { item: 'refusedForm' } },
  { name: '22r-principle-B1 a defect found in an owned file, one spec item unfinished at the timebox', role: 'implementor', holding: ['limit'], items: { defect: ['discovery'], item: ['runnable'] }, reason: 'limit', verdict: '`blocked`', labels: { defect: 'outside', item: 'continues' } },
  { name: '22r-R1 the lean worker meets a refusal with other work left', role: 'worker', holding: ['refusal-none'], items: { it: ['stopped'], other: ['runnable'] }, reason: 'refusal-none', verdict: 'none: your result as text, naming what was refused, as it said it', labels: { it: 'taskRefused', other: 'left' } },
  // 22q.
  { name: '22q-B1 the timebox passes with a runnable item unfinished', role: 'implementor', holding: ['limit'], items: { item: ['runnable'] }, reason: 'limit', verdict: '`blocked`', labels: { item: 'continues' } },
  { name: '22q-principle-B1 a refusal with no form, one item refused, another runnable', role: 'implementor', holding: ['refusal-none'], items: { refused: ['stopped'], other: ['runnable'] }, reason: 'refusal-none', verdict: '`blocked`', labels: { refused: 'refused', other: 'continues' } },
  // The crossings listed before and found since.
  { name: 'refusal × timebox: the refusal came first', role: 'implementor', holding: ['limit', 'refusal-none'], first: 'refusal-none', items: { refused: ['stopped'], other: ['runnable'] }, reason: 'refusal-none', verdict: '`blocked`', labels: { refused: 'refused', other: 'continues' } },
  { name: 'refusal × timebox: the clock came first', role: 'implementor', holding: ['limit', 'refusal-form'], first: 'limit', items: { other: ['runnable'] }, reason: 'limit', verdict: '`blocked`', labels: { other: 'continues' } },
  { name: 'refused item that also waited: the refusal labels it', role: 'planner', holding: ['refusal-form'], items: { item: ['waits', 'stopped'] }, reason: 'refusal-form', verdict: '`blocked`', labels: { item: 'refusedForm' } },
  { name: 'blocked × waiting: only waiting work is left', role: 'implementor', holding: ['waiting'], items: { item: ['waits'] }, reason: 'waiting', verdict: '`blocked`', labels: { item: 'waits' }, file: 'each wait by its id' },
  { name: 'a check cannot run and another item waits', role: 'planner', holding: ['cannot-run', 'waiting'], items: { check: ['stopped'], other: ['waits'] }, reason: 'cannot-run', verdict: '`blocked`', labels: { check: 'cannot', other: 'waits' } },
  { name: 'follow-up × finding: the discovery is outside the unit, the cut item is not', role: 'planner', holding: ['limit'], items: { found: ['discovery'], cut: ['runnable'] }, reason: 'limit', verdict: '`blocked`', labels: { found: 'outside', cut: 'continues' } },
  { name: 'a verifier whose spec lines contradict', role: 'verifier', holding: ['waiting'], items: { check: ['waits'] }, reason: 'waiting', verdict: '`stuck`', labels: { check: 'waits' } },
  { name: 'a verifier finds a defect the base has too', role: 'verifier', holding: ['done'], items: { defect: ['discovery'] }, reason: 'done', verdict: '`changes` if you proved a Blocker or Major, else `accepted`', labels: { defect: 'base' } },
  { name: 'the lean worker cannot run a tool', role: 'worker', holding: ['cannot-run'], items: { tool: ['stopped'] }, reason: 'cannot-run', verdict: 'none: your result as text, naming the check or tool', labels: { tool: 'cannot' } },
];

/** Every way the table answers a named case otherwise than the case expects. */
export function caseFailures(table: ReadonlyArray<Row>, cases: ReadonlyArray<Case> = CASES): string[] {
  const out: string[] = [];
  for (const one of cases) {
    const reason = reasonOf(one.holding, one.first);
    if (reason !== one.reason) { out.push(`${one.name}: ends on ${reason}`); continue; }
    try {
      const row = table.find((candidate) => candidate.role === one.role && candidate.reason === reason);
      if (row === undefined || 'never' in row) { out.push(`${one.name}: no row`); continue; }
      if (row.verdict !== one.verdict) out.push(`${one.name}: verdict ${row.verdict}`);
      if (one.file !== undefined && !row.file.includes(one.file)) out.push(`${one.name}: file ${row.file}`);
      for (const [name, states] of Object.entries(one.items)) {
        const outcome = cell(one.role, reason, stateOf(states), table);
        const got = 'label' in outcome ? outcome.label : `cannot occur: ${outcome.never}`;
        if (got !== one.labels[name]) out.push(`${one.name}: ${name} is ${got}`);
      }
    } catch (error) {
      out.push(`${one.name}: ${String(error)}`);
    }
  }
  return out;
}

describe('(iii) every case found so far has its one disposition', () => {
  test('the named cases', () => {
    expect(caseFailures(TABLE)).toEqual([]);
  });
  test('a runnable item never sits beside a check that cannot run or work that waits: the step goes on first', () => {
    for (const role of ROLES) for (const reason of ['cannot-run', 'waiting'] as const) expect(cell(role, reason, 'runnable')).toEqual({ never: 'runnableFirst' });
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

describe('(v) one changed cell, one deleted row and one appended sentence are each red', () => {
  test('changing one cell (a live wait relabelled at the timebox) is red', () => {
    const changed = TABLE.map((row) =>
      row.role === 'implementor' && row.reason === 'limit' && !('never' in row) ? { ...row, items: { ...row.items, waits: { label: 'continues' as const } } } : row,
    );
    expect(caseFailures(changed).length).toBeGreaterThan(0);
    expect(invariants(changed).length).toBeGreaterThan(0);
  });
  test('changing one verdict (a stopped verifier handing back `blocked`) is red', () => {
    const changed = TABLE.map((row) => (row.role === 'verifier' && row.reason === 'refusal-none' && !('never' in row) ? { ...row, verdict: '`blocked`' } : row));
    expect(invariants(changed).length).toBeGreaterThan(0);
    expect(caseFailures(changed).length).toBeGreaterThan(0);
  });
  test('deleting one row is red, and so is a duplicated one', () => {
    const deleted = TABLE.filter((row) => !(row.role === 'verifier' && row.reason === 'cannot-run'));
    expect(totality(deleted)).toEqual(['verifier × cannot-run: 0 rows']);
    expect(totality([...TABLE, TABLE[0]!]).length).toBeGreaterThan(0);
  });
  test('appending a contradictory sentence is red in each of the three formats', () => {
    const formats = prompts().filter((prompt) => prompt.role === 'planner');
    expect(formats.map((prompt) => prompt.format)).toEqual(['claude', 'codex', 'opencode']);
    for (const prompt of formats) expect(lint({ ...prompt, text: `${prompt.text}\n${MUTANT}` })).toEqual([`planner ${prompt.format}: outside the block: ${MUTANT}`]);
  });
});
