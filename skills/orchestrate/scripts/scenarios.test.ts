// The scenario table: each input case a reader of the role prompts can meet, and the one disposition it must get,
// asserted against the clauses of the GENERATED prompts in every format they ship in (Claude Code's agents/*.md,
// Codex's codex/agents/*.toml, OpenCode's mods/orchestrate/agents.json), the nothing-is-hard principle and the
// orchestrator skill. It replaces reading for two-answer cases: batches 22q and 22r each found one by reading, and
// each such case is a row here. Every row carries a mutant that brings its competing answer back (most of them the
// exact text a verifier found), and the table proves each mutant turns its row red.
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
    id: 'planner-ready',
    input: 'a planner has filled every section of its spec and its acceptance check runs and is red; the product behavior its Done line names is not built (22r text-fix B1)',
    expect: { planner: '`ready`: a planner never implements, so the product Done item stays undone' },
    rules: [
      { docs: ['planner'], clause: 'You run one step', has: "A planner's step is `ready` when every section of its spec is filled and its acceptance check runs and is red; a planner never implements" },
      { docs: ['planner'], lacks: /planner's (or implementor's )?step is `ready` only when every item of its spec is done/ },
      { docs: ['planner'], clause: "You write the unit's spec", has: 'change no product code' },
    ],
    mutant: {
      docs: ['planner'],
      from: "A planner's step is `ready` when every section of its spec is filled and its acceptance check runs and is red; a planner never implements, so the product behavior the spec's Done line names stays undone. An implementor's step",
      to: "A planner's or implementor's step",
    },
  },
  {
    id: 'implementor-ready',
    input: 'an implementor has one spec item undone that nothing blocks',
    expect: { implementor: 'not `ready`: it builds the item; effort names nothing not done' },
    rules: [
      { docs: ['implementor'], clause: 'You run one step', has: "An implementor's step is `ready` only when every item of its spec is done" },
      { docs: ['implementor'], clause: "A verifier's line names its batch", has: 'Effort is none of these.' },
    ],
    mutant: { docs: ['implementor'], from: 'only when every item of its spec is done', to: 'when its main items are done' },
  },
  {
    id: 'required-check-could-not-run',
    input: 'a verifier cannot run one of its step-1 checks (22q Unproven × stuck)',
    expect: { verifier: '`stuck`, never Unproven and never `accepted`' },
    rules: [
      { docs: ['verifier'], clause: 'You run one step', has: "A verifier's step ends when every required check of its step 1 ran" },
      { docs: ['verifier'], clause: '7. **Verdict.**', has: 'a check of step 1 that could not run or ran unclear is `stuck`' },
      { docs: ['verifier'], clause: '3. **Proof.**', has: 'What this host cannot run, beyond the checks of step 1, goes under Unproven' },
      { docs: ['verifier'], lacks: /What this host cannot run goes under Unproven/ },
    ],
    mutant: { docs: ['verifier'], from: 'What this host cannot run, beyond the checks of step 1, goes', to: 'What this host cannot run goes' },
  },
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
    id: 'refusal-x-timebox',
    input: 'a refusal stops one item and the timebox passes with another runnable item unfinished',
    expect: { implementor: 'the refused item `waits on` the allow rule; the other `continues next round`; verdict `blocked`' },
    rules: [
      { docs: [...ROLES], clause: "A verifier's line names its batch", has: '`waits on <dependency>` (an open unit, owner question or commitment, or the allow rule a refusal named' },
      { docs: ['implementor'], clause: '**Timebox.**', has: 'each unfinished item `continues next round`' },
    ],
    mutant: { docs: [...ROLES], from: ', or the allow rule a refusal named, by its id or command', to: '' },
  },
  {
    id: 'blocked-x-waiting',
    input: 'the timebox passes: which file says why the round stopped',
    expect: { implementor: '`blocked`, with `blocked.md` quoting the clock, as Questions says for anything that blocks' },
    rules: [
      { docs: ['implementor'], clause: '**Timebox.**', has: 'and `blocked.md` (as Questions says) quoting the clock' },
      { docs: ['implementor'], clause: '**Questions.**', has: 'write `<unit dir>/blocked.md`' },
    ],
    mutant: { docs: ['implementor'], from: ', and `blocked.md` (as Questions says) quoting the clock', to: '' },
  },
  {
    id: 'follow-up-x-finding',
    input: 'an implementor finds work no spec item asks for, and has an item the timebox cut short',
    expect: { implementor: 'the finding goes under Follow-ups (`finding outside the unit`); the cut item `continues next round`, never a follow-up' },
    rules: [
      { docs: ['implementor'], clause: '**Timebox.**', has: 'A finding outside the spec goes in `state.md` under "Follow-ups"; a spec item never does.' },
      { docs: [...ROLES], clause: "A verifier's line names its batch", has: '`finding outside the unit`, for work no spec item asks for' },
      { docs: [...ROLES], clause: "A verifier's line names its batch", has: 'never a follow-up' },
    ],
    mutant: { docs: [...ROLES], from: 'after the failure cap), never a follow-up;', to: 'after the failure cap), or a follow-up;' },
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
    id: 'failure-cap-x-next-round',
    input: "the unit's third round fails with an item unfinished: there is no next round of this spec",
    expect: { implementor: 'the item stays this unit\'s work and continues in its rewrite' },
    rules: [
      { docs: [...ROLES], clause: "A verifier's line names its batch", has: "it stays this unit's work (its next round, or its rewrite after the failure cap)" },
      { docs: [...ROLES], clause: 'A round is one request', has: 'At the third failed round, the orchestrator rewrites the unit on a new spec' },
    ],
    mutant: { docs: [...ROLES], from: ' (its next round, or its rewrite after the failure cap)', to: '' },
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
    expect: { worker: "follow the host's refusal rule; authority outranks effort; no bound-step instruction" },
    rules: [
      { docs: ['worker'], has: "A guard, permission or classifier refusal is the host's rule and outranks effort: follow the host's refusal rule" },
      { docs: ['worker'], has: 'principle-nothing-is-hard' },
      { docs: ['worker'], lacks: /round-N-request|hand back|`ready`|state\.md|ask_orchestrator|blocked\.md/ },
    ],
    mutant: {
      docs: ['worker'],
      from: "A guard, permission or classifier refusal is the host's rule and outranks effort: follow the host's refusal rule, and never rephrase or work around it to get past.",
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
  test('ids are unique, and every 22q, 22r and listed pair has its row', () => {
    const ids = TABLE.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      'planner-ready', 'implementor-ready', 'required-check-could-not-run', 'refusal-no-form', 'refusal-named-form',
      'refusal-x-timebox', 'blocked-x-waiting', 'follow-up-x-finding', 'discovery-in-owned-file-x-unfinished-item',
      'question-x-build-the-better-one', 'failure-cap-x-next-round', 'provenance-unit-x-base', 'on-base-meaning', 'lean-worker-refusal',
    ]));
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
