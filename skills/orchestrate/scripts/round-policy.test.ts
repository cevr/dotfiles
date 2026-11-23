// The round policy over its whole finite domain, through its public seams (round-policy.ts and the canonical leaf it
// places, opencode/mods/orchestrate/round-policy.ts), against the independent oracle (item-histories.ts):
//   (a) the four baseline controls (red on 1cf649e9), each on the actual host artifacts, with its matched positive;
//   (b) the 11 shipped renders, read back through each host's envelope: each decodes to its role's policy, and a
//       mutation of any one render alone is named for that render only;
//   (c) mirrored loss: the source mutated and every render regenerated in agreement passes delivery, and the
//       independent expectations still reject it; each named mutant is killed by the check meant for it;
//   (d) evidence over every role × reachable record × attempt kind × obstacle set: the owed hand-back holds exactly the
//       record's evidence, and stripping, forging, mispairing or varying any one value is named;
//   (e) steps: every role × stop × saturated state multiset, presence and count at the decision's thresholds, item
//       order permuted, admitted only against the checked records;
//   (f) seeded production traces (attempt begin/finish/interrupt/deny, refusal lift, host and wait open/close,
//       duplicates and restarts): every snapshot is a valid record whose owed hand-back holds its latest completed
//       attempt, never an older one, and keeps it through a later denial or obstacle; a broken step is caught.
// Fixtures are redacted shapes: opaque ids, never a real command, path, log or register row.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  admit,
  type Artifact,
  block,
  type Claim,
  decode,
  delivered,
  differences,
  due,
  factsFaults,
  type Field,
  fieldKey,
  type HandBack,
  hostPrompt,
  HOSTS,
  type ItemRecord,
  judge,
  outcome,
  type Policy,
  policyFaults,
  project,
  recordFaults,
  render,
  RENDERS,
  renderFaults,
  ROLES,
  type Role,
  ROOT,
  type State,
  STATES_OF,
  type Step,
  type Stop,
  type StopFieldId,
  type StopValue,
  STOPS_OF,
} from './round-policy.ts';
import { allItems, freshSnapshot, materialize, reachable, recordKey, recordOf, type Snapshot, stateOf, step, type TraceEvent, validity } from './item-histories.ts';

// ---- independent expectations: written here by hand, never read from the policy --------------------------------

/** What each verdict writes. */
const ARTIFACTS: Record<Role, Record<string, ReadonlyArray<Artifact>>> = {
  planner: { ready: ['spec'], blocked: ['state', 'blocked'] },
  implementor: { ready: ['request'], blocked: ['state', 'blocked'] },
  verifier: { stuck: ['findings', 'batch'], changes: ['findings', 'batch'], accepted: ['findings', 'batch'] },
  worker: { none: ['result'] },
};
/** The evidence fields each stop writes: the remedy a refusal printed (a `!` command or an allow rule), none when it printed none. */
const REMEDY = ['refused.what', 'refused.form', 'refused.allow'] as const;
const STOP_FIELDS: Record<Role, Partial<Record<Stop, ReadonlyArray<StopFieldId>>>> = {
  planner: { refusalForm: REMEDY, refusalNone: ['refused.what'], limit: ['limit'], idle: ['held'] },
  implementor: { refusalForm: REMEDY, refusalNone: ['refused.what'], limit: ['limit'], idle: ['held'] },
  verifier: { refusalForm: REMEDY, refusalNone: ['refused.what'], idle: ['held'] },
  worker: { refusalForm: REMEDY, refusalNone: ['refused.what'], idle: ['held'] },
};
/** The verdict a step's state set owes, by the stated precedence. */
const VERDICT = (role: Role, states: ReadonlyArray<State>): string => {
  const held = (...these: State[]) => states.some((state) => these.includes(state));
  if (role === 'worker') return 'none';
  if (role === 'verifier') return held('runnable', 'waits', 'refused', 'cannot', 'unclear') ? 'stuck' : held('proven') ? 'changes' : 'accepted';
  return held('runnable', 'waits', 'refused', 'cannot') ? 'blocked' : 'ready';
};

/** Every way a policy disagrees with the independent expectations: artifacts, stop fields, verdicts on every well-formed step. */
function expectationFaults(policy: Policy): string[] {
  const out: string[] = [];
  const role = policy.role;
  for (const stop of STOPS_OF[role])
    for (const states of multisets(STATES_OF[role], 3)) {
      const got = outcome(policy, stop, states);
      if (!got.ok) continue;
      const want = VERDICT(role, states);
      if (got.value.verdict !== want) out.push(`${role} ${stop} [${states}]: verdict ${got.value.verdict}, expected ${want}`);
      if (got.value.writes.artifacts.join() !== (ARTIFACTS[role][want] ?? []).join()) out.push(`${role} ${want}: writes [${got.value.writes.artifacts}], expected [${ARTIFACTS[role][want]}]`);
      if (got.value.fields.join() !== (STOP_FIELDS[role][stop] ?? []).join()) out.push(`${role} ${stop}: fields [${got.value.fields}], expected [${STOP_FIELDS[role][stop]}]`);
    }
  return [...new Set(out)];
}

/** Every reachable record whose owed hand-back under `policy` is not the oracle's state with exactly the record's evidence. */
function evidenceFaults(policy: Policy): string[] {
  const out: string[] = [];
  for (const [key, { item }] of reachable(policy.role))
    for (const record of variants(key, item)) {
      const owed = due(policy, record);
      if (!owed.ok) {
        out.push(`${policy.role} ${key}: ${owed.error}`);
        continue;
      }
      const state = stateOf(policy.role, item);
      if (owed.value.state !== state) out.push(`${policy.role} ${key}: state ${owed.value.state}, the oracle ${state}`);
      const want = record.fields.map((field) => field.field).join();
      const got = owed.value.fields.map((field) => field.field).join();
      if (want !== got) out.push(`${policy.role} ${key}: owes [${got}], the record holds [${want}]`);
    }
  return [...new Set(out)];
}

/** A reachable record's evidence variants: as it stands, a newer unfinished attempt beside a finished one, a named form. */
const variants = (key: string, item: ItemRecord['facts']): ReadonlyArray<ItemRecord> => [
  materialize(key, item),
  ...(['pass', 'fail', 'unclear'].includes(item.attempt) ? [materialize(key, item, { newer: true })] : []),
  ...(item.refused ? [materialize(key, item, { form: true }), materialize(key, item, { allow: true })] : []),
];

/** Every multiset of `states` with 1 to `size` items. */
function multisets(states: ReadonlyArray<State>, size: number): State[][] {
  const out: State[][] = [];
  const grow = (prefix: State[], from: number) => {
    if (prefix.length > 0) out.push(prefix);
    if (prefix.length === size) return;
    for (let index = from; index < states.length; index++) grow([...prefix, states[index]!], index);
  };
  grow([], 0);
  return out;
}

const handBack = (owed: { item: string; rule: string; label: string; fields: ReadonlyArray<Field> }): HandBack => ({ item: owed.item, rule: owed.rule, label: owed.label, fields: owed.fields });
const owedOf = (policy: Policy, record: ItemRecord) => {
  const owed = due(policy, record);
  if (!owed.ok) throw new Error(owed.error);
  return owed.value;
};

const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const IMPLEMENTOR_FILES = { claude: 'agents/implementor.md', codex: 'codex/agents/implementor.toml', opencode: 'opencode/mods/orchestrate/agents.json' } as const;
const DROP_STATE = '`<unit dir>/state.md` current (even with no commit since) and ';
const DROP_FORM = /\n\| a refusal named an accepted form \| `refused\.form` \|[^\n]*/;

// ---- (a) the baseline controls --------------------------------------------------------------------------------------

describe('(a) the four baseline controls, on the actual host artifacts', () => {
  test('control 1 (22t N6): losing state.md from the blocked verdict is named on every host; the untouched artifact decodes clean', () => {
    for (const [host, path] of Object.entries(IMPLEMENTOR_FILES)) {
      const text = hostPrompt(host as 'claude', 'implementor', read(path));
      expect([host, policyFaults('implementor', text)]).toEqual([host, []]);
      const lost = text.replace(DROP_STATE, '');
      expect([host, lost !== text, policyFaults('implementor', lost).map((line) => line.split(': source')[0])]).toEqual([host, true, ['implementor: verdict blocked']]);
    }
  });
  test("control 2 (22r B2, 22s): losing the refusal's exact form field is named; the untouched artifact decodes clean", () => {
    for (const role of ROLES) {
      const text = hostPrompt('opencode', role, read(IMPLEMENTOR_FILES.opencode));
      expect([role, delivered(role, text)]).toEqual([role, { ok: true, value: project(role) }]);
      const lost = text.replace(DROP_FORM, '');
      expect([role, lost !== text, policyFaults(role, lost).map((line) => line.split(': source')[0])]).toEqual([role, true, [`${role}: stop refusalForm`]]);
    }
  });
  test('control 3 (23b T1): a `lastAttempt` flag cannot stand in for the attempt\'s content; the exact content is accepted', () => {
    const policy = project('implementor');
    const record = materialize('t1', { assigned: true, required: true, attempt: 'fail', settled: false, refused: true, hostCannot: true, wait: true, provenance: 'none' });
    const owed = owedOf(policy, record);
    expect([owed.state, owed.fields.map((field) => field.field)]).toEqual(['refused', ['completed', 'refused', 'cannot', 'waits']]);
    expect(judge(owed, handBack(owed))).toEqual([]);
    const forged = { ...handBack(owed), fields: owed.fields.filter((field) => field.field !== 'completed'), lastAttempt: true };
    expect(judge(owed, forged)).toEqual([
      'unknown hand-back keys [lastAttempt]: no flag stands in for evidence',
      `completed: due completed id="t1-a1" command="cmd:t1:check" output=log "sha:t1:a1" exit=1 receipt="rcpt:t1:a1" head="head:t1" result=fail, given none`,
    ]);
  });
  test('control 4: `ready` with a spec item not run is refused against its checked records; the owed claim is admitted', () => {
    const policy = project('implementor');
    const built = materialize('built', { assigned: true, required: true, attempt: 'pass', settled: true, refused: false, hostCannot: false, wait: false, provenance: 'none' });
    const unrun = materialize('unrun', { assigned: true, required: true, attempt: 'never', settled: false, refused: false, hostCannot: false, wait: false, provenance: 'none' });
    const stepped: Step = { stop: { stop: 'limit', values: [{ id: 'limit', value: 'clock:2h' }] }, items: [built, unrun] };
    const items = [built, unrun].map((record) => handBack(owedOf(policy, record)));
    expect(admit(policy, stepped, { verdict: 'ready', writes: ['request'], stop: [], items })).toEqual(['verdict: due blocked, given ready', 'writes: due [state, blocked], given [request]', 'stop limit: due "clock:2h", given none']);
    expect(admit(policy, stepped, { verdict: 'blocked', writes: ['state', 'blocked'], stop: [{ id: 'limit', value: 'clock:2h' }], items })).toEqual([]);
  });
});

// ---- (b) the 11 renders --------------------------------------------------------------------------------------------

/** A scratch copy of the shipped host files, for mutating one render alone. */
function scratchRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'round-policy-'));
  for (const path of new Set(RENDERS.map((one) => one.path))) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), read(path));
  }
  return dir;
}

/** Each mutation of one render's block: what it does, and the fault prefix the decoder must name. */
const MUTATIONS: ReadonlyArray<{ readonly name: string; readonly apply: (role: Role, text: string) => string; readonly names: (role: Role) => string }> = [
  { name: 'another role\'s block in its place', apply: (role, text) => text.replace(block(role), () => block(role === 'planner' ? 'verifier' : 'planner')), names: (role) => `${role}: role: source ${role}` },
  { name: 'the first row deleted', apply: (role, text) => text.replace(/\n\| 1 \| `[a-zA-Z]+` \|[^\n]*/, ''), names: (role) => `${role}: the rows are not numbered` },
  { name: 'a stop field\'s evidence widened', apply: (_, text) => text.replace('| `held` | ', '| `held` | or skip it: '), names: (role) => `${role}: stop idle` },
  { name: 'a stray clause inside the block', apply: (_, text) => text.replace('\n\nTake the first row that holds for the step', '\n\nSkip the acceptance check.\n\nTake the first row that holds for the step'), names: (role) => `${role}: 9 paragraphs` },
  { name: 'an unknown version', apply: (role, text) => text.replace(`round-policy v1 ${role}`, `round-policy v2 ${role}`), names: (role) => `${role}: unknown round-policy version v2` },
  { name: 'a priority dropped', apply: (_, text) => text.replace(/\n\| 2 \| /, '\n| 9 | '), names: (role) => `${role}: the rows are not numbered` },
  { name: 'the evidence fields\' instruction cut', apply: (_, text) => text.replace('; `waits`: the id it waits on', ''), names: (role) => `${role}: fields` },
];

describe('(b) every shipped render, read back through its host envelope', () => {
  test('11 renders: three named roles on three hosts, the lean worker on Claude Code and OpenCode only', () => {
    expect(RENDERS.length).toBe(11);
    expect(RENDERS.filter((one) => one.role === 'worker').map((one) => one.host)).toEqual(['claude', 'opencode']);
    for (const role of ['planner', 'implementor', 'verifier'] as const) expect(RENDERS.filter((one) => one.role === role).map((one) => one.host)).toEqual([...HOSTS]);
  });
  test('each decodes to exactly its role\'s policy, part by part and byte for byte', () => {
    expect(renderFaults()).toEqual([]);
    for (const { role, host, path } of RENDERS) {
      const text = hostPrompt(host, role, read(path));
      const shown = decode(/<!-- round-policy v1 [\s\S]*?<!-- \/round-policy -->/.exec(text)?.[0] ?? '');
      expect([role, host, shown]).toEqual([role, host, { ok: true, value: project(role) }]);
    }
  });
  test('a mutation of any one render alone is named for that render, and only it', () => {
    for (const mutation of MUTATIONS)
      for (const target of RENDERS) {
        const root = scratchRoot();
        const file = join(root, target.path);
        const original = readFileSync(file, 'utf8');
        if (target.host === 'opencode') {
          const json = JSON.parse(original) as { agents: Record<string, { system: string }> };
          json.agents[target.role]!.system = mutation.apply(target.role, json.agents[target.role]!.system);
          writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
        } else writeFileSync(file, mutation.apply(target.role, original));
        const faults = renderFaults(root);
        expect([mutation.name, target.role, target.host, readFileSync(file, 'utf8') !== original]).toEqual([mutation.name, target.role, target.host, true]);
        expect([mutation.name, target.role, target.host, faults.length > 0 && faults.every((line) => line.startsWith(`${target.host} ${target.role}: `))]).toEqual([mutation.name, target.role, target.host, true]);
        expect([mutation.name, target.role, target.host, faults.some((line) => line.startsWith(`${target.host} ${mutation.names(target.role)}`)) || faults]).toEqual([mutation.name, target.role, target.host, true]);
      }
  });
});

// ---- (c) mirrored loss and the mutation kills ----------------------------------------------------------------------

const POLICIES = Object.fromEntries(ROLES.map((role) => [role, project(role)])) as Record<Role, Policy>;

/** A named mutant of a role's policy, and the check meant to kill it. */
interface Mutant {
  readonly name: string;
  readonly role: Role;
  readonly mutate: (policy: Policy) => Policy;
  readonly killedBy: 'expectations' | 'evidence' | 'oracle';
}
const MUTANTS: ReadonlyArray<Mutant> = [
  { name: 'state.md dropped from blocked (22t N6)', role: 'implementor', killedBy: 'expectations', mutate: (p) => ({ ...p, verdicts: p.verdicts.map((rule) => (rule.id === 'blocked' ? { ...rule, writes: { ...rule.writes, artifacts: ['blocked' as const] } } : rule)) }) },
  { name: 'the named form dropped (22r B2)', role: 'implementor', killedBy: 'expectations', mutate: (p) => ({ ...p, stops: p.stops.map((one) => (one.stop === 'refusalForm' ? { ...one, fields: one.fields.filter((field) => field.id !== 'refused.form') } : one)) }) },
  { name: 'an allow rule inferred for the worker (22q)', role: 'worker', killedBy: 'expectations', mutate: (p) => ({ ...p, stops: p.stops.map((one) => (one.stop === 'refusalNone' ? { ...one, fields: [...one.fields, { id: 'refused.allow' as const, presence: 'always' as const, text: 'the rule it implies' }] } : one)) }) },
  { name: 'unclear no longer stuck (22t N5)', role: 'verifier', killedBy: 'expectations', mutate: (p) => ({ ...p, verdicts: p.verdicts.map((rule) => (rule.id === 'stuck' && rule.when.kind === 'any' ? { ...rule, when: { kind: 'any' as const, states: rule.when.states.filter((state) => state !== 'unclear') } } : rule)) }) },
  { name: 'ready while a wait is left (22q timebox)', role: 'planner', killedBy: 'expectations', mutate: (p) => ({ ...p, verdicts: p.verdicts.map((rule) => (rule.id === 'ready' && rule.when.kind === 'only' ? { ...rule, when: { kind: 'only' as const, states: [...rule.when.states, 'waits' as const] } } : rule)) }) },
  ...(['cannot', 'waits', 'refused', 'completed', 'current'] as const).map((id): Mutant => ({ name: `the ${id} evidence field forgotten (22w, 23b)`, role: 'verifier', killedBy: 'evidence', mutate: (p) => ({ ...p, fields: p.fields.filter((field) => field.id !== id) }) })),
  { name: 'waits above refused (a refusal laundered into a wait)', role: 'implementor', killedBy: 'oracle', mutate: (p) => ({ ...p, rows: reorder(p.rows, 'waits', 'refused') }) },
  { name: 'unclear above cannot (22w W01)', role: 'verifier', killedBy: 'oracle', mutate: (p) => ({ ...p, rows: reorder(p.rows, 'unclear', 'cannot') }) },
  { name: 'cannot above refused (a refusal laundered into a missing tool)', role: 'worker', killedBy: 'oracle', mutate: (p) => ({ ...p, rows: reorder(p.rows, 'cannot', 'refused') }) },
];

/** Mutants no check can kill because they change no answer: rows that are never both true. Each is shown equivalent. */
const EQUIVALENT: ReadonlyArray<Mutant> = [
  { name: 'done above discovery: no reachable record is both assigned-and-passed and not assigned', role: 'worker', killedBy: 'oracle', mutate: (p) => ({ ...p, rows: reorder(p.rows, 'done', 'discovery') }) },
];

/** Rows with `up` moved to just above `over`, renumbered. */
function reorder<R extends { readonly id: string; readonly priority: number }>(rows: ReadonlyArray<R>, up: string, over: string): R[] {
  const moved = rows.find((row) => row.id === up)!;
  const rest = rows.filter((row) => row.id !== up);
  const at = rest.findIndex((row) => row.id === over);
  return [...rest.slice(0, at), moved, ...rest.slice(at)].map((row, index) => ({ ...row, priority: index + 1 }));
}

/** The oracle's check: every reachable record's state from the policy's first true row. */
const oracleFaults = (policy: Policy): string[] => evidenceFaults(policy).filter((line) => line.includes(': state '));
const CHECKS = { expectations: expectationFaults, evidence: (p: Policy) => evidenceFaults(p).filter((line) => line.includes(' owes ')), oracle: oracleFaults };

describe('(c) mirrored loss: the source mutated and every render regenerated in agreement', () => {
  test('the shipped policies meet every independent expectation', () => {
    for (const role of ROLES) expect([role, expectationFaults(POLICIES[role]), evidenceFaults(POLICIES[role])]).toEqual([role, [], []]);
  });
  for (const mutant of MUTANTS)
    test(`${mutant.role}: ${mutant.name}: passes delivery once regenerated, and the ${mutant.killedBy} check kills it`, () => {
      const policy = mutant.mutate(POLICIES[mutant.role]);
      // Regenerated in agreement: the rendered block decodes to the mutant, so a delivery check against it is blind.
      expect(decode(render(policy))).toEqual({ ok: true, value: policy });
      expect(differences(policy, policy)).toEqual([]);
      // The independent expectation kills it; against the true source, delivery names it too.
      expect([mutant.name, CHECKS[mutant.killedBy](policy).length > 0]).toEqual([mutant.name, true]);
      expect([mutant.name, policyFaults(mutant.role, render(policy)).length > 0]).toEqual([mutant.name, true]);
    });
  for (const mutant of EQUIVALENT)
    test(`${mutant.role}: equivalent mutant, ${mutant.name}: every answer unchanged, and delivery still names the reordered block`, () => {
      const policy = mutant.mutate(POLICIES[mutant.role]);
      expect([expectationFaults(policy), evidenceFaults(policy)]).toEqual([[], []]);
      expect(policyFaults(mutant.role, render(policy)).length).toBeGreaterThan(0);
    });
});

// ---- (d) evidence over the whole domain ----------------------------------------------------------------------------

const RUN_KEYS = ['id', 'command', 'exit', 'receipt', 'head'] as const;

describe('(d) every role × reachable record × evidence variant: the owed hand-back, exactly', () => {
  test('the domain: every attempt kind and every obstacle set is reached, with and without a newer attempt or a named form', () => {
    for (const role of ROLES) {
      const items = [...reachable(role).values()].map(({ item }) => item).filter((item) => item.assigned);
      expect([role, [...new Set(items.map((item) => item.attempt))].sort()]).toEqual([role, ['fail', 'never', 'pass', 'started', 'unclear']]);
      expect([role, new Set(items.map((item) => `${item.refused}${item.hostCannot}${item.wait}`)).size]).toEqual([role, 8]);
    }
  });
  for (const role of ROLES)
    test(`${role}: the exact hand-back is accepted; each field stripped, forged, swapped or varied alone is named`, () => {
      const policy = POLICIES[role];
      let checked = 0;
      for (const [key, { item }] of reachable(role))
        for (const record of variants(key, item)) {
          const owed = owedOf(policy, record);
          const exact = handBack(owed);
          expect([key, judge(owed, exact)]).toEqual([key, []]);
          expect([key, judge(owed, { ...exact, rule: 'otherwise', label: `${exact.label} ` }).length]).toEqual([key, 2]);
          for (const field of owed.fields) {
            const stripped = judge(owed, { ...exact, fields: exact.fields.filter((one) => one !== field) });
            expect([key, field.field, stripped.length, stripped[0]?.startsWith(`${field.field}: due `)]).toEqual([key, field.field, 1, true]);
            const doubled = judge(owed, { ...exact, fields: [...exact.fields, field] });
            expect([key, field.field, doubled.length]).toEqual([key, field.field, 1]);
          }
          for (const field of owed.fields.filter((one) => one.field === 'completed'))
            for (const name of RUN_KEYS) {
              const varied = exact.fields.map((one) => (one === field && one.field === 'completed' ? { ...one, run: { ...one.run, [name]: name === 'exit' ? 99 : `other:${name}` } } : one));
              expect([key, name, judge(owed, { ...exact, fields: varied }).length]).toEqual([key, name, 1]);
            }
          const extra = { field: 'waits' as const, ref: 'ref:other' };
          if (!owed.fields.some((one) => one.field === 'waits')) expect([key, judge(owed, { ...exact, fields: [...exact.fields, extra] })]).toEqual([key, ['waits: due none, given waits ref="ref:other"']]);
          checked++;
        }
      expect(checked).toBeGreaterThan(20);
    });
  test('two items\' evidence mispaired, or same-looking ids swapped, is named for both items', () => {
    const policy = POLICIES.verifier;
    const facts = { assigned: true, required: true, attempt: 'fail' as const, settled: true, refused: false, hostCannot: false, wait: false, provenance: 'none' as const };
    const a = materialize('a', facts);
    const b = materialize('b', facts);
    const [owedA, owedB] = [owedOf(policy, a), owedOf(policy, b)];
    const stepped: Step = { stop: { stop: 'idle', values: [] }, items: [a, b] };
    const right: Claim = { verdict: 'changes', writes: ['findings', 'batch'], stop: [], items: [handBack(owedA), handBack(owedB)] };
    expect(admit(policy, stepped, right)).toEqual([]);
    const swapped: Claim = { ...right, items: [{ ...handBack(owedA), fields: owedB.fields }, { ...handBack(owedB), fields: owedA.fields }] };
    const faults = admit(policy, stepped, swapped);
    expect([faults.some((line) => line.startsWith('a: completed')), faults.some((line) => line.startsWith('b: completed'))]).toEqual([true, true]);
    expect(admit(policy, stepped, { ...right, items: [handBack(owedA)] })).toEqual(['b: 0 hand-backs, not one']);
    expect(admit(policy, stepped, { ...right, items: [...right.items, { ...handBack(owedA), item: 'c' }] })).toEqual(['c: no such item in the step']);
  });
  test('a record whose evidence contradicts its facts owes no hand-back', () => {
    const facts = { assigned: true, required: true, attempt: 'unclear' as const, settled: false, refused: true, hostCannot: false, wait: false, provenance: 'none' as const };
    const record = materialize('x', facts, { newer: true });
    expect(due(POLICIES.verifier, { ...record, fields: record.fields.filter((one) => one.field !== 'refused') }).ok).toBe(false);
    expect(due(POLICIES.verifier, { ...record, fields: record.fields.filter((one) => one.field !== 'completed') }).ok).toBe(false);
    expect(due(POLICIES.verifier, { ...record, fields: [...record.fields, { field: 'waits', ref: '' }] }).ok).toBe(false);
    const sameId = record.fields.map((one): Field => (one.field === 'current' ? { ...one, attempt: { ...one.attempt, id: 'x-a1' } } : one));
    expect(recordFaults('verifier', { ...record, fields: sameId })).toEqual(['`current` and `completed` are the same attempt']);
  });
});

// ---- (e) steps: saturated state multisets, thresholds, order -------------------------------------------------------

describe('(e) every role × stop × saturated multiset of states', () => {
  test('the verdict reads presence only: up to four of each state present gives the verdict its set gives', () => {
    for (const role of ROLES)
      for (const stop of STOPS_OF[role])
        for (const states of multisets(STATES_OF[role], 4)) {
          const got = outcome(POLICIES[role], stop, states);
          const set = outcome(POLICIES[role], stop, [...new Set(states)]);
          const refused = states.filter((state) => state === 'refused').length;
          // The one count threshold: a refusal stops the step at the one item it refused.
          if (refused > 1) expect([role, stop, states, got.ok]).toEqual([role, stop, states, false]);
          else expect([role, stop, states, got.ok && got.value.verdict]).toEqual([role, stop, states, set.ok && set.value.verdict]);
          if (got.ok) expect([role, stop, states, got.value.verdict]).toEqual([role, stop, states, VERDICT(role, states)]);
        }
  });
  test('item order changes nothing: every permutation of a step admits or refuses alike', () => {
    const policy = POLICIES.implementor;
    const base = { assigned: true, required: true, settled: false, refused: false, hostCannot: false, wait: false, provenance: 'none' as const };
    const records = [
      materialize('p', { ...base, attempt: 'pass', settled: true }),
      materialize('w', { ...base, attempt: 'fail', wait: true }),
      materialize('c', { ...base, attempt: 'started', hostCannot: true }),
    ];
    const items = records.map((record) => handBack(owedOf(policy, record)));
    const HELD = [{ id: 'held' as const, item: 'w', value: 'h:w' }, { id: 'held' as const, item: 'c', value: 'h:c' }];
    const claim: Claim = { verdict: 'blocked', writes: ['state', 'blocked'], stop: HELD, items };
    const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    for (const order of permutations) {
      const stepped: Step = { stop: { stop: 'idle', values: HELD }, items: order.map((index) => records[index]!) };
      expect([order, admit(policy, stepped, claim)]).toEqual([order, []]);
      expect([order, admit(policy, stepped, { ...claim, items: order.map((index) => items[index]!), verdict: 'ready' })]).toEqual([order, ['verdict: due blocked, given ready']]);
    }
  });
});

// ---- (f) seeded production traces ----------------------------------------------------------------------------------

/** A small seeded generator (mulberry32): traces are the same on every run of a seed. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** One random content event: revisions run ahead, fall behind (a late older result) and repeat (a duplicate). */
function event(next: () => number, rev: number): TraceEvent {
  const pick = Math.floor(next() * 10);
  const at = Math.max(1, rev + Math.floor(next() * 3) - 1);
  const results = ['pass', 'fail', 'unclear'] as const;
  if (pick === 0) return { kind: 'begin', rev: at };
  if (pick === 1) return { kind: 'finish', rev: at, result: results[Math.floor(next() * 3)]! };
  if (pick === 2) return { kind: 'interrupt', rev: at };
  if (pick === 3) return { kind: 'deny', rev: at, form: next() < 0.5 };
  if (pick === 4) return { kind: 'lift' };
  if (pick === 5) return { kind: 'host', open: next() < 0.5 };
  if (pick === 6) return { kind: 'wait', open: next() < 0.5 };
  if (pick === 7) return { kind: 'restart' };
  return { kind: 'begin', rev: rev + 1 };
}

type Stepper = (role: Role, at: Snapshot, event: TraceEvent) => Snapshot;
const completedRev = (record: ItemRecord): number => {
  const run = record.fields.find((one) => one.field === 'completed');
  return run?.field === 'completed' ? Number(run.run.id.split('-r')[1]) : 0;
};

/** Every trace fault over `traces` seeded traces of up to 12 events, for each role. */
function traceFaults(stepper: Stepper, traces = 1000): string[] {
  const out: string[] = [];
  for (const role of ROLES)
    for (let seed = 0; seed < traces && out.length === 0; seed++) {
      const next = random(0x23b + seed);
      let at = freshSnapshot(role !== 'verifier' || next() < 0.7);
      let rev = 0;
      const seen: string[] = [];
      const length = 1 + Math.floor(next() * 12);
      for (let index = 0; index < length; index++) {
        const one = event(next, rev);
        seen.push(JSON.stringify(one));
        const before = recordOf('t', at);
        const after = stepper(role, at, one);
        // A duplicate delivery changes nothing more; a restart changes nothing at all.
        if (JSON.stringify(stepper(role, after, one)) !== JSON.stringify(after) && one.kind !== 'begin' && one.kind !== 'host' && one.kind !== 'wait') out.push(`${role} seed ${seed}: a duplicate ${one.kind} changed the snapshot`);
        if (one.kind === 'restart' && JSON.stringify(after) !== JSON.stringify(at)) out.push(`${role} seed ${seed}: a restart changed the snapshot`);
        at = after;
        rev = Math.max(rev, 'rev' in one ? one.rev : 0);
        const record = recordOf('t', at);
        const bad = recordFaults(role, record);
        if (bad.length > 0) out.push(`${role} seed ${seed} after [${seen.join(' ')}]: ${bad.join('; ')}`);
        // The latest completed attempt is kept through any later event, and never replaced by an older one.
        if (completedRev(record) < completedRev(before)) out.push(`${role} seed ${seed} after [${seen.join(' ')}]: completed went from r${completedRev(before)} to r${completedRev(record)}`);
        if (bad.length > 0) continue;
        const owed = due(POLICIES[role], record);
        if (!owed.ok || owed.value.fields.map((field) => field.field).join() !== record.fields.map((field) => field.field).join()) out.push(`${role} seed ${seed}: the owed hand-back lost evidence`);
        else if (owed.value.state !== stateOf(role, record.facts)) out.push(`${role} seed ${seed}: state ${owed.value.state}, the oracle ${stateOf(role, record.facts)}`);
      }
    }
  return out;
}

describe('(f) seeded production traces', () => {
  test('1000 traces of up to 12 events per role, seed 0x23b: every snapshot valid, its latest completed attempt kept, its evidence owed', () => {
    expect(traceFaults(step)).toEqual([]);
  });
  test('the events the traces cover: a denial after a red result keeps the red output beside the denial (22w W03)', () => {
    let at = freshSnapshot(true);
    for (const one of [{ kind: 'begin', rev: 1 }, { kind: 'finish', rev: 1, result: 'fail' }, { kind: 'deny', rev: 2, form: true }] as const) at = step('implementor', at, one);
    expect(recordOf('w', at).fields.map((field) => field.field)).toEqual(['completed', 'current', 'refused']);
    const late = step('implementor', step('implementor', freshSnapshot(true), { kind: 'begin', rev: 3 }), { kind: 'finish', rev: 2, result: 'pass' });
    expect(recordOf('l', late).fields.map((field) => field.field)).toEqual(['current']);
  });
  test('a broken step that drops the completed attempt on a denial is caught (the model\'s `broken` step)', () => {
    const broken: Stepper = (role, at, one) => {
      const next = step(role, at, one);
      return one.kind === 'deny' && next !== at ? { ...next, runs: [], facts: { ...next.facts, attempt: 'started' } } : next;
    };
    expect(traceFaults(broken).length).toBeGreaterThan(0);
  });
});

// ---- (g) the input domain, comparison, absence and the stop's values -------------------------------------------------

const BASE = { assigned: true, required: true, attempt: 'never' as const, settled: false, refused: false, hostCannot: false, wait: false, provenance: 'none' as const };
const STOP_FIELD_IDS: ReadonlyArray<StopFieldId> = ['refused.what', 'refused.form', 'refused.allow', 'limit', 'held'];

/** The claim a step's checked records owe: its verdict, artifacts, the recorded stop values and every hand-back. */
function owedClaim(policy: Policy, stepped: Step): Claim {
  const dues = stepped.items.map((record) => owedOf(policy, record));
  const got = outcome(policy, stepped.stop.stop, dues.map((one) => one.state));
  if (!got.ok) throw new Error(got.error);
  return { verdict: got.value.verdict, writes: got.value.writes.artifacts, stop: stepped.stop.values, items: dues.map(handBack) };
}
/** A step's own claim admitted against it: the faults of the step's record alone. */
const recordedFaults = (policy: Policy, stepped: Step) => {
  const dues = stepped.items.map((record) => due(policy, record));
  const states = dues.flatMap((one) => (one.ok ? [one.value.state] : []));
  const got = outcome(policy, stepped.stop.stop, states);
  const items = dues.flatMap((one) => (one.ok ? [handBack(one.value)] : []));
  return admit(policy, stepped, { verdict: got.ok ? got.value.verdict : 'none', writes: got.ok ? got.value.writes.artifacts : [], stop: stepped.stop.values, items });
};

/** One truthful step per stop a role has and per remedy a refusal prints: the records and the stop values they make true. */
function truthfulSteps(role: Role): ReadonlyArray<{ readonly name: string; readonly step: Step }> {
  const done = materialize('done', { ...BASE, attempt: 'pass', settled: true });
  const refused = (options: { readonly form?: boolean; readonly allow?: boolean }) => materialize('r', { ...BASE, attempt: 'started', refused: true }, options);
  const what = { id: 'refused.what' as const, value: 'action:r' };
  const all: ReadonlyArray<{ readonly name: string; readonly step: Step }> = [
    { name: 'refusal printing a command', step: { stop: { stop: 'refusalForm', values: [what, { id: 'refused.form', value: 'form:r' }] }, items: [done, refused({ form: true })] } },
    { name: 'refusal printing an allow rule', step: { stop: { stop: 'refusalForm', values: [what, { id: 'refused.allow', value: 'allow:r' }] }, items: [done, refused({ allow: true })] } },
    { name: 'refusal printing no remedy', step: { stop: { stop: 'refusalNone', values: [what] }, items: [done, refused({})] } },
    { name: 'limit', step: { stop: { stop: 'limit', values: [{ id: 'limit', value: 'clock:2h' }] }, items: [done, materialize('run', BASE)] } },
    { name: 'idle with a held item', step: { stop: { stop: 'idle', values: [{ id: 'held', item: 'w', value: 'held: w' }] }, items: [done, materialize('w', { ...BASE, wait: true })] } },
    { name: 'idle with nothing held', step: { stop: { stop: 'idle', values: [] }, items: [done] } },
  ];
  return all.filter((one) => STOPS_OF[role].some((stop) => stop === one.step.stop.stop));
}

/** A stop value of `id` holding `value`: a `held` one names the done item, which holds nothing back. */
const valueOf = (id: StopFieldId, value: string): StopValue => (id === 'held' ? { id, item: 'done', value } : { id, value });

/** A text member of a field, read and replaced: the members `fieldKey` prints one after another. */
type Member = 'id' | 'command' | 'digest' | 'receipt' | 'head' | 'what' | 'scope' | 'report' | 'form' | 'tool' | 'probe';
const textOf = (field: Field, member: Member): string => {
  const flat: Record<string, unknown> =
    field.field === 'completed'
      ? { ...field.run, digest: field.run.output.kind === 'missing' ? '' : field.run.output.digest }
      : field.field === 'current'
        ? { ...field.attempt }
        : field.field === 'refused'
          ? { ...field.refusal, form: field.refusal.form.kind === 'named' ? field.refusal.form.form : '' }
          : field.field === 'cannot'
            ? { ...field.absent, digest: field.absent.output.kind === 'missing' ? '' : field.absent.output.digest }
            : {};
  return String(flat[member]);
};
const withText = (field: Field, member: Member, value: string): Field => {
  if (field.field === 'completed') return member === 'digest' ? { ...field, run: { ...field.run, output: { kind: 'log', digest: value } } } : { ...field, run: { ...field.run, [member]: value } };
  if (field.field === 'current') return { ...field, attempt: { ...field.attempt, [member]: value } };
  if (field.field === 'refused') return member === 'form' ? { ...field, refusal: { ...field.refusal, form: { kind: 'named', form: value } } } : { ...field, refusal: { ...field.refusal, [member]: value } };
  if (field.field === 'cannot') return member === 'digest' ? { ...field, absent: { ...field.absent, output: { kind: 'log', digest: value } } } : { ...field, absent: { ...field.absent, [member]: value } };
  return field;
};
/** Every pair of text members printed side by side, with the text `fieldKey` prints between their values. */
const BOUNDARIES: ReadonlyArray<readonly [Field['field'], Member, Member, string]> = [
  ['completed', 'id', 'command', ' command='],
  ['completed', 'command', 'digest', ' output=log '],
  ['completed', 'receipt', 'head', ' head='],
  ['current', 'id', 'command', ' command='],
  ['refused', 'what', 'scope', ' scope='],
  ['refused', 'scope', 'report', ' report='],
  ['refused', 'report', 'form', ' form=named '],
  ['cannot', 'tool', 'probe', ' probe='],
  ['cannot', 'probe', 'digest', ' output=log '],
];

describe('(g) the input domain, comparison, absence and the stop values', () => {
  test('B3: of all 960 fact combinations per role, the leaf admits exactly the oracle\'s valid ones, which are the reachable ones; each rejected one is a typed rejection of `due` and `admit`', () => {
    const items = allItems();
    // recordKey joins fixed-position closed values (booleans, enums, an ordered obstacle set): injective on the domain.
    expect([items.length, new Set(items.map(recordKey)).size]).toEqual([960, 960]);
    for (const role of ROLES) {
      const reached = new Set(reachable(role).keys());
      let rejected = 0;
      for (const item of items) {
        const key = recordKey(item);
        const valid = validity(role, item) === undefined;
        expect([role, key, factsFaults(role, item).length === 0, reached.has(key)]).toEqual([role, key, valid, valid]);
        if (valid) continue;
        rejected++;
        const record = materialize('x', item);
        const owed = due(POLICIES[role], record);
        expect([role, key, owed.ok, !owed.ok && owed.error.startsWith('x: ')]).toEqual([role, key, false, true]);
        const faults = admit(POLICIES[role], { stop: { stop: 'idle', values: [] }, items: [record] }, { verdict: 'none', writes: [], stop: [], items: [] });
        expect([role, key, faults.length, faults[0]?.startsWith('ill-formed item: x: ')]).toEqual([role, key, 1, true]);
      }
      expect([role, rejected > 0, rejected + reached.size]).toEqual([role, true, 960]);
    }
  });
  test('B1: two values printed alike across every boundary between them are two values; both varied together are one difference', () => {
    const policy = POLICIES.implementor;
    const source = materialize('t', { ...BASE, attempt: 'fail', refused: true, hostCannot: true, wait: true }, { newer: true, form: true });
    for (const [kind, a, b, between] of BOUNDARIES) {
      const index = source.fields.findIndex((one) => one.field === kind);
      const original = source.fields[index]!;
      // The record holds `b` = "x<between>y"; the hand-back moves "<between>x" onto `a`: the plain line reads the same.
      const recorded = withText(original, b, `x${between}y`);
      const record: ItemRecord = { ...source, fields: source.fields.map((one, at) => (at === index ? recorded : one)) };
      const owed = owedOf(policy, record);
      const moved = withText(withText(recorded, a, `${textOf(original, a)}${between}x`), b, 'y');
      const given = { ...handBack(owed), fields: owed.fields.map((one) => (one.field === kind ? moved : one)) };
      expect([kind, a, b, fieldKey(moved) === fieldKey(recorded), judge(owed, given).length]).toEqual([kind, a, b, true, 1]);
      const both = withText(withText(recorded, a, 'other:a'), b, 'other:b');
      expect([kind, a, b, judge(owed, { ...given, fields: owed.fields.map((one) => (one.field === kind ? both : one)) }).length]).toEqual([kind, a, b, 1]);
      expect([kind, a, b, judge(owed, handBack(owed))]).toEqual([kind, a, b, []]);
    }
  });
  test('B2: every role × stop × field: absent is admitted exactly where absence is the truth; an empty value, a placeholder or a doubled value never is', () => {
    let cases = 0;
    for (const role of ROLES)
      for (const { name, step: stepped } of truthfulSteps(role)) {
        const policy = POLICIES[role];
        expect([role, name, recordedFaults(policy, stepped)]).toEqual([role, name, []]);
        for (const id of STOP_FIELD_IDS) {
          const entries = stepped.stop.values.filter((one) => one.id === id);
          const others = stepped.stop.values.filter((one) => one.id !== id);
          const at = (values: ReadonlyArray<StopValue>): Step => ({ ...stepped, stop: { ...stepped.stop, values } });
          const absent = recordedFaults(policy, at(others));
          expect([role, name, id, 'absent', absent.length === 0]).toEqual([role, name, id, 'absent', entries.length === 0]);
          const empty = entries.length === 0 ? [...others, valueOf(id, '')] : [...others, ...entries.map((one) => ({ ...one, value: '' }))];
          expect([role, name, id, 'empty', recordedFaults(policy, at(empty)).length > 0]).toEqual([role, name, id, 'empty', true]);
          if (entries.length === 0) expect([role, name, id, 'placeholder', recordedFaults(policy, at([...others, valueOf(id, 'nothing')])).length > 0]).toEqual([role, name, id, 'placeholder', true]);
          else expect([role, name, id, 'doubled', recordedFaults(policy, at([...stepped.stop.values, ...entries])).length > 0]).toEqual([role, name, id, 'doubled', true]);
          cases += 3;
        }
      }
    expect(cases).toBeGreaterThan(80);
  });
  test('T1: each recorded stop value changed alone, dropped, or moved across its item boundary is named; the recorded values are admitted', () => {
    let forged = 0;
    for (const role of ROLES)
      for (const { name, step: stepped } of truthfulSteps(role)) {
        const policy = POLICIES[role];
        const owed = owedClaim(policy, stepped);
        expect([role, name, admit(policy, stepped, owed)]).toEqual([role, name, []]);
        stepped.stop.values.forEach((value, index) => {
          const swap = (other: StopValue) => admit(policy, stepped, { ...owed, stop: owed.stop.map((one, at) => (at === index ? other : one)) });
          const changed = swap({ ...value, value: `${value.value}:forged` });
          expect([role, name, value.id, changed.length, changed[0]?.startsWith(`stop ${value.id}: due `)]).toEqual([role, name, value.id, 1, true]);
          const dropped = admit(policy, stepped, { ...owed, stop: owed.stop.filter((_, at) => at !== index) });
          expect([role, name, value.id, dropped.length]).toEqual([role, name, value.id, 1]);
          if (value.id === 'held') expect([role, name, 'item', swap({ ...value, item: 'done' }).length]).toEqual([role, name, 'item', 1]);
          if (value.id === 'held') expect([role, name, swap({ id: 'held', item: `${value.item}: ${value.value.split(': ')[0]}`, value: value.value.split(': ').slice(1).join(': ') }).length]).toEqual([role, name, 1]);
          forged++;
        });
      }
    expect(forged).toBeGreaterThan(20);
  });
});
