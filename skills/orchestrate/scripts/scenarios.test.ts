// The scenario rows that are not about how a step ends (ending.test.ts's decision table holds those): the nothing-is-hard
// principle's refusal and follow-up lines, the question form, provenance routing, the On base mark and the lean worker's
// authority reminder. Each row is asserted against the clauses of the GENERATED prompts in every format they ship in
// (Claude Code's agents/*.md, Codex's codex/agents/*.toml, OpenCode's mods/orchestrate/agents.json), the principle and
// the orchestrator skill, and carries a mutant that brings its competing answer back; the table proves each mutant red.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

type Doc = 'planner' | 'implementor' | 'verifier' | 'worker' | 'principle' | 'skill';
/** Each document's text, once per format it ships in. */
type Texts = Record<Doc, ReadonlyArray<{ format: string; text: string }>>;

const body = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n/, '');
const toml = (file: string) => {
  const match = /developer_instructions = '''\n([\s\S]*?)\n'''/.exec(file);
  if (!match) throw new Error('no developer_instructions in a codex agent');
  return match[1]!;
};

function load(): Texts {
  const json = JSON.parse(read('opencode/mods/orchestrate/agents.json')) as { agents: Record<string, { system: string }> };
  const role = (name: string) => [
    { format: 'claude', text: body(read(`agents/${name}.md`)) },
    { format: 'codex', text: toml(read(`codex/agents/${name}.toml`)) },
    { format: 'opencode', text: json.agents[name]!.system },
  ];
  return {
    planner: role('planner'),
    implementor: role('implementor'),
    verifier: role('verifier'),
    worker: [
      { format: 'claude', text: body(read('agents/worker.md')) },
      { format: 'opencode', text: json.agents.worker!.system },
    ],
    principle: [{ format: 'skill', text: read('skills/principle-nothing-is-hard/SKILL.md') }],
    skill: [{ format: 'skill', text: read('skills/orchestrate/SKILL.md') }],
  };
}

/** The clause a reader looks in: the paragraph that starts with `lead`, else the line (a list item) that does. */
const clause = (text: string, lead: string) =>
  text.split(/\n\s*\n/).find((block) => block.trimStart().startsWith(lead)) ??
  text.split('\n').find((line) => line.trimStart().startsWith(lead));

const ROLES = ['planner', 'implementor', 'verifier'] as const;

/** One assertion: in every format of each doc, the clause (or the whole text) contains `has` / does not match `lacks`. */
interface Rule {
  readonly docs: ReadonlyArray<Doc>;
  readonly clause?: string;
  readonly has?: string | RegExp;
  readonly lacks?: RegExp;
  /** Equal to the whole clause. */
  readonly is?: string;
}
interface Row {
  readonly id: string;
  /** The input case. */
  readonly input: string;
  /** The one disposition, per reader. */
  readonly expect: Partial<Record<Doc, string>>;
  readonly rules: ReadonlyArray<Rule>;
  /** The competing answer brought back: `from` must stand in every format of each doc. */
  readonly mutant: { readonly docs: ReadonlyArray<Doc>; readonly from: string; readonly to: string };
}

const REFUSAL =
  '**Refusals.** At the first permission or classifier refusal, stop that step and report the exact `!` command, or the allow rule, that would let it through. Never work around it or ask for permission in chat. A refusal is authority, not difficulty.';
const PRINCIPLE_REFUSAL = '- **A refusal is authority, not difficulty.**';

export const TABLE: ReadonlyArray<Row> = [
  {
    id: 'refusal-no-form',
    input: 'a permission refusal names no accepted form; one item is refused and another is runnable (22q principle B1)',
    expect: { planner: 'stop the step and report the allow rule', implementor: 'stop the step and report the allow rule', verifier: 'stop the step and report the allow rule', principle: 'none of its own: the role rule decides' },
    rules: [
      { docs: [...ROLES], clause: '**Refusals.**', is: REFUSAL },
      { docs: ['principle'], clause: PRINCIPLE_REFUSAL, has: /Whether or not it names an accepted form[^.]*your role's own rule decides/ },
      { docs: ['principle'], clause: PRINCIPLE_REFUSAL, has: "the worker protocol's Refusals section" },
      { docs: ['principle'], clause: PRINCIPLE_REFUSAL, lacks: /go on|continue|rest of the work|carry on|keep working/i },
    ],
    mutant: { docs: ['principle'], from: 'This principle adds nothing to that rule.', to: 'Then go on with the rest of the work.' },
  },
  {
    id: 'refusal-named-form',
    input: "a worker's first permission refusal names an accepted form (\"use a script file\") (22r text-fix B2)",
    expect: { implementor: 'stop the step and report that form; the form is used only in a later step that authorises it', principle: 'none of its own: the role rule decides first' },
    rules: [
      { docs: [...ROLES], clause: '**Refusals.**', has: 'At the first permission or classifier refusal, stop that step and report the exact' },
      { docs: ['principle'], clause: PRINCIPLE_REFUSAL, has: 'used only in a later step that authorises it' },
      { docs: ['principle'], clause: PRINCIPLE_REFUSAL, lacks: /follow (that|the) form|Otherwise your role/i },
    ],
    mutant: {
      docs: ['principle'],
      from: 'Whether or not it names an accepted form ("commit first", "use a script file"), your role\'s own rule decides what happens next',
      to: 'When it names the accepted form ("commit first", "use a script file"), follow that form. Otherwise your role\'s own rule decides what happens next',
    },
  },
  {
    id: 'discovery-in-owned-file-x-unfinished-item',
    input: 'a unit owns src/a.ts for feature X; it finds an unrelated defect Y in that file, and one spec item is still undone (22r principle B1)',
    expect: { implementor: 'Y is a follow-up (no spec item asks for it, even inside Owns); the undone item is never a follow-up', principle: 'the same: keyed on spec items, not owned paths' },
    rules: [
      { docs: ['principle'], has: 'a follow-up is for a finding no spec item asks for (even one inside a file the unit owns), with a trigger; a spec item is never a follow-up' },
      { docs: ['principle'], lacks: /outside the unit's Owns/ },
      { docs: ['implementor'], clause: '**Timebox.**', has: 'a spec item never does' },
      { docs: ['skill'], has: 'A follow-up is work no spec item asks for, with a trigger; a spec item never is one.' },
    ],
    mutant: {
      docs: ['principle'],
      from: 'a follow-up is for a finding no spec item asks for (even one inside a file the unit owns), with a trigger; a spec item is never a follow-up.',
      to: "a follow-up is for a finding outside the unit's Owns, with a trigger.",
    },
  },
  {
    id: 'question-x-build-the-better-one',
    input: 'two options differ only in effort',
    expect: { planner: 'no question: build the better one', implementor: 'no question: build the better one', verifier: 'no question: build the better one', principle: 'build the better one', skill: '"leave it as a follow-up" is no answer' },
    rules: [
      { docs: [...ROLES], clause: '**Questions.**', has: 'two that differ only in effort are no question: build the better one' },
      { docs: [...ROLES], clause: 'You run one step', has: 'of two options equal but for effort, build the better one unasked' },
      { docs: ['principle'], has: '**Equal but for effort: build the better one.**' },
      { docs: ['skill'], has: '"leave it as a follow-up" is no answer' },
    ],
    mutant: { docs: [...ROLES], from: ' (two that differ only in effort are no question: build the better one)', to: '' },
  },
  {
    id: 'provenance-unit-x-base',
    input: 'a verifier proves a weak test the unit wrote, and a written-rule break the base head shows too (22q text B2, 22r T2)',
    expect: { verifier: "neither fails a round; the unit's goes to its lane's next round, the base's to a follow-up unit", skill: 'the same, at the lane verify step and in What blocks' },
    rules: [
      { docs: [...ROLES], clause: 'A round is one request', has: "one the unit's change introduced, the same lane closes in its next round, before that lane takes another unit; one the base has too (shown at the base head) becomes a follow-up unit" },
      { docs: ['verifier'], clause: '3. **Proof.**', has: "one the unit's change introduced to its lane's next round, one the base head shows too to a follow-up unit" },
      { docs: ['skill'], clause: '- When a `land` or `status` answer starts', has: /unit's change introduced[^.;]*(its lane's next round|the same lane)/ },
      { docs: ['skill'], clause: '- When a `land` or `status` answer starts', has: 'base head shows too becomes a follow-up unit' },
      { docs: ['skill'], clause: '- **Every verify is a fresh verifier', has: /unit's change introduced[^.;]*(its lane's next round|the same lane)/ },
      { docs: ['skill'], clause: '- **Every verify is a fresh verifier', has: 'base head shows too becomes a follow-up unit' },
    ],
    mutant: {
      docs: ['skill'],
      from: "Each finding goes by where it came from (`protocol.md`, Rounds): one the unit's change introduced is its lane's next round; one the base head shows too becomes a follow-up unit.",
      to: 'Each finding becomes a fix unit.',
    },
  },
  {
    id: 'on-base-meaning',
    input: 'a verifier files a written-rule break under On base',
    expect: { verifier: 'marked `unit` or `base`; the batch\'s On base lists the `base` ones' },
    rules: [
      { docs: ['verifier'], clause: '6. **Findings.**', has: "marked `unit` if the unit's change introduced it or `base` if the base head shows it too" },
      { docs: ['verifier'], clause: '6. **Findings.**', has: 'its On base (the findings marked `base`)' },
    ],
    mutant: { docs: ['verifier'], from: 'its On base (the findings marked `base`)', to: 'its On base' },
  },
  {
    id: 'lean-worker-refusal',
    input: 'the lean worker (no unit, no round) meets a guard refusal (22r On base R1)',
    expect: { worker: "never rephrase or work around it; authority outranks effort; no bound-step instruction outside its round-policy block" },
    rules: [
      { docs: ['worker'], has: "A guard, permission or classifier refusal is the host's rule and outranks effort: never rephrase or work around it to get past." },
      { docs: ['worker'], has: 'principle-nothing-is-hard' },
      { docs: ['worker'], lacks: /round-N-request|hand back|`ready`|state\.md|ask_orchestrator|blocked\.md/ },
    ],
    mutant: {
      docs: ['worker'],
      from: "A guard, permission or classifier refusal is the host's rule and outranks effort: never rephrase or work around it to get past.",
      to: 'If something refuses you, say so in your result and go on.',
    },
  },
];

/** Every way the texts break the row, empty when it holds. */
export function failures(row: Row, texts: Texts): string[] {
  const out: string[] = [];
  for (const rule of row.rules)
    for (const doc of rule.docs)
      for (const { format, text } of texts[doc]) {
        const where = `${row.id} ${doc} ${format}${rule.clause ? ` "${rule.clause}"` : ''}`;
        const scope = rule.clause === undefined ? text : clause(text, rule.clause);
        if (scope === undefined) {
          out.push(`${where}: no such clause`);
          continue;
        }
        if (rule.is !== undefined && scope.trim() !== rule.is) out.push(`${where}: is not the pinned clause`);
        if (rule.has !== undefined && !(typeof rule.has === 'string' ? scope.includes(rule.has) : rule.has.test(scope))) out.push(`${where}: lacks ${String(rule.has)}`);
        if (rule.lacks !== undefined && rule.lacks.test(scope)) out.push(`${where}: has ${String(rule.lacks)}`);
      }
  return out;
}

function mutate(texts: Texts, mutant: Row['mutant']): Texts {
  const next = { ...texts };
  for (const doc of mutant.docs)
    next[doc] = texts[doc].map(({ format, text }) => {
      if (!text.includes(mutant.from)) throw new Error(`mutant text not in ${doc} ${format}: ${mutant.from}`);
      return { format, text: text.replace(mutant.from, mutant.to) };
    });
  return next;
}

describe('the scenario table', () => {
  const texts = load();
  test('ids are unique, and each row is one the end-of-step table does not cover', () => {
    const ids = TABLE.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The end-of-step cases live in ending.test.ts's table; these rows test what it does not: the principle, routing, questions, the worker's reminder.
    expect(ids).toEqual([
      'refusal-no-form', 'refusal-named-form', 'discovery-in-owned-file-x-unfinished-item', 'question-x-build-the-better-one',
      'provenance-unit-x-base', 'on-base-meaning', 'lean-worker-refusal',
    ]);
  });
  for (const row of TABLE) {
    test(`${row.id}: one disposition holds in every generated prompt`, () => {
      expect(failures(row, texts)).toEqual([]);
    });
    test(`${row.id}: its mutant turns the row red`, () => {
      expect(failures(row, mutate(texts, row.mutant)).length).toBeGreaterThan(0);
    });
  }
});
