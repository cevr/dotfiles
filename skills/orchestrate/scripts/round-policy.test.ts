// The round policy over its whole finite domain, through its public seams (round-policy.ts and the canonical leaf it
// places, opencode/mods/orchestrate/round-policy.ts), against the independent oracle (item-histories.ts). Evidence
// enters only as a step's persisted envelope, raw JSON, through `decode`; every claim is judged by `admit` against the
// checked step:
//   (a) the four baseline controls (red on 1cf649e9), each on the actual host artifacts, with its matched positive;
//   (b) the 11 shipped renders, read back through each host's envelope: each decodes to its role's policy, and a
//       mutation of any one render alone is named for that render only;
//   (c) mirrored loss: the source mutated and every render regenerated in agreement passes delivery, and the
//       independent expectations still reject it; each named mutant is killed by the check meant for it;
//   (d) every generated history: the owed claim holds exactly its record's evidence, and stripping, forging,
//       mispairing or varying any one value is named;
//   (e) steps: every role × stop × saturated state multiset, presence and count at the decision's thresholds, item
//       order permuted;
//   (f) seeded production traces (attempt begin/observe/finish/interrupt/deny, refusal lift, host and wait open/close,
//       duplicates and restarts): every envelope decodes to the snapshot model's record, its latest completed attempt
//       kept; a broken model is caught;
//   (g) the input domain (the facts decoded envelopes reach are exactly the oracle's valid ones), member-wise
//       comparison, absence and the stop's values;
//   (h) envelopes: every generated one decodes to the snapshot model and a backward reading; every JSON mutation of
//       every member at every depth is a typed rejection or the evidence its new history implies, per mutation; every
//       evidence value of a second envelope claimed against the first is rejected.
// Fixtures are redacted shapes: opaque ids, never a real command, path, log or register row.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  admit,
  type Artifact,
  block,
  type Checked,
  type Claim,
  decide,
  decode,
  decodeBlock,
  delivered,
  differences,
  type Envelope,
  type Field,
  hostPrompt,
  HOSTS,
  type ItemRecord,
  outcome,
  owed,
  type Policy,
  policyFaults,
  project,
  render,
  RENDERS,
  renderFaults,
  ROLES,
  type Role,
  ROOT,
  type State,
  STATES_OF,
  type StepEvent,
  type Stop,
  type StopFieldId,
  type StopValue,
  STOPS_OF,
  type Trace,
  truths,
} from './round-policy.ts';
import { allItems, concrete, envelopeOf, freshSnapshot, type Generated, generateTraces, OWN_FILE, recordKey, recordOf, type Snapshot, stateOf, step, stepEnvelope, type TraceEvent, validity, writeDenied } from './item-histories.ts';

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
const HELD_STATES: ReadonlyArray<State> = ['waits', 'cannot', 'unclear'];

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

// ---- envelopes in, claims out ----------------------------------------------------------------------------------------

const json = <A>(value: A): A => JSON.parse(JSON.stringify(value));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const checkedOf = (input: unknown): Checked => {
  const got = decode(input);
  if (!got.ok) throw new Error(got.error);
  return got.value;
};
/** What a checked step owes: its claim and each item's state under its versioned policy. */
const owedOf = (checked: Checked) => {
  const got = owed(checked);
  if (!got.ok) throw new Error(got.error);
  return got.value;
};
const judged = (checked: Checked, claim: unknown) => admit(checked)(json(claim));

/** Generated histories per role and depth, computed once. */
const GENERATED = new Map<string, Generated[]>();
const generated = (role: Role, depth: number): Generated[] => {
  const key = `${role}/${depth}`;
  const all = GENERATED.get(key) ?? generateTraces(role, depth);
  GENERATED.set(key, all);
  return all;
};

/** What a held item's `held` entry says, from its record read by hand: the last finished run's command and exit, else why none ran. */
function heldOracle(record: ItemRecord): string {
  const run = record.fields.find((one) => one.field === 'completed');
  if (run?.field === 'completed') return `${run.run.command} (exit ${run.run.exit})`;
  const refused = record.fields.find((one) => one.field === 'refused');
  if (refused?.field === 'refused') return `refused: ${refused.refusal.what}${refused.refusal.form.kind === 'named' ? `; form: ${refused.refusal.form.form}` : refused.refusal.form.kind === 'allow' ? `; form: ${refused.refusal.form.allow}` : ''}`;
  const cannot = record.fields.find((one) => one.field === 'cannot');
  if (cannot?.field === 'cannot') return `cannot run here: ${cannot.absent.tool}`;
  const waits = record.fields.find((one) => one.field === 'waits');
  return waits?.field === 'waits' ? `waits on ${waits.ref}` : '';
}

/** A refusal's stop values, by hand: what it refused, and the remedy it printed if any. */
const refusalValues = (refusal: { readonly what: string; readonly form: { readonly kind: string; readonly form?: string; readonly allow?: string } }): StopValue[] => [
  { id: 'refused.what', value: refusal.what },
  ...(refusal.form.kind === 'named' ? [{ id: 'refused.form' as const, value: refusal.form.form ?? '' }] : []),
  ...(refusal.form.kind === 'allow' ? [{ id: 'refused.allow' as const, value: refusal.form.allow ?? '' }] : []),
];

/**
 * The claim a step owes, by the oracle: each item's state from its record (the snapshot model's or the backward
 * reading's), the verdict and artifacts by the hand-written expectations, the stop values from the records and the
 * step's own events. Rules and labels come from the policy's rows, which ending.test.ts checks against the oracle.
 */
function oracleClaim(role: Role, records: ReadonlyArray<ItemRecord>, events: ReadonlyArray<StepEvent>, rows: ReadonlyArray<{ readonly rule: string; readonly label: string }>): Claim {
  const states = records.map((record) => stateOf(role, record.facts));
  const refused = records.flatMap((record) => record.fields.flatMap((field) => (field.field === 'refused' ? [field.refusal] : [])));
  const write = events.flatMap((event) => (event.kind === 'writeDenied' ? [event.refusal] : []));
  const limit = events.flatMap((event) => (event.kind === 'limit' ? [event.limit] : []));
  const stop: StopValue[] =
    refused.length + write.length > 0
      ? refusalValues([...refused, ...write][0]!)
      : limit.length > 0
        ? limit.map((one) => ({ id: 'limit', value: one.kind === 'timebox' ? `timebox ${one.length}` : `failure cap ${one.count}` }))
        : records.flatMap((record, index) => (HELD_STATES.includes(states[index]!) ? [{ id: 'held' as const, item: record.id, value: heldOracle(record) }] : []));
  const verdict = VERDICT(role, [...states, ...(write.length > 0 ? (['refused'] as const) : [])]);
  return { verdict, writes: ARTIFACTS[role][verdict] ?? [], stop, items: records.map((record, index) => ({ item: record.id, rule: rows[index]!.rule, label: rows[index]!.label, fields: record.fields })) };
}

// ---- (a) the baseline controls --------------------------------------------------------------------------------------

const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const IMPLEMENTOR_FILES = { claude: 'agents/implementor.md', codex: 'codex/agents/implementor.toml', opencode: 'opencode/mods/orchestrate/agents.json' } as const;
const DROP_STATE = '`<unit dir>/state.md` current (even with no commit since) and ';
const DROP_FORM = /\n\| a refusal named an accepted form \| `refused\.form` \|[^\n]*/;

const ASSIGNED = { kind: 'assigned', required: true } as const;
const begin = (attempt: string, command: string) => ({ kind: 'begin', attempt, command }) as const;
const finish = (attempt: string, result: 'pass' | 'fail' | 'unclear', exit: number) => ({ kind: 'finish', attempt, result, exit, output: { kind: 'log', digest: `sha:${attempt}` }, receipt: `rcpt:${attempt}`, head: 'head:a' }) as const;
const TIMEBOX: StepEvent = { kind: 'limit', limit: { kind: 'timebox', length: '2h' } };

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
  test("control 3 (23b T1): a `lastAttempt` flag cannot stand in for the attempt's content; the exact content is accepted", () => {
    const input = envelopeOf('implementor', [{ id: 't1', assignment: ASSIGNED, events: [begin('t1-a1', 'cmd:t1'), finish('t1-a1', 'fail', 1), { kind: 'hostLost', absent: { tool: 'tool:t1', probe: 'probe:t1', output: { kind: 'log', digest: 'sha:probe' } } }] }]);
    const checked = checkedOf(input);
    const claim = owedOf(checked).claim;
    expect([owedOf(checked).states[0]?.state, claim.items[0]?.fields.map((field) => field.field)]).toEqual(['cannot', ['completed', 'cannot']]);
    expect(judged(checked, claim)).toEqual([]);
    const forged = { ...claim, items: claim.items.map((one) => ({ ...one, fields: one.fields.filter((field) => field.field !== 'completed'), lastAttempt: true })) };
    expect(judged(checked, forged)[0]?.startsWith('claim: Expected no excess property')).toBe(true);
    const stripped = { ...claim, items: claim.items.map((one) => ({ ...one, fields: one.fields.filter((field) => field.field !== 'completed') })) };
    expect(judged(checked, stripped)).toEqual([`t1: completed: due completed id="t1-a1" command="cmd:t1" output=log "sha:t1-a1" exit=1 receipt="rcpt:t1-a1" head="head:a" result=fail, given none`]);
  });
  test('control 4: `ready` with a spec item not run is refused against its envelope; the owed claim is admitted', () => {
    const input = envelopeOf('implementor', [{ id: 'built', assignment: ASSIGNED, events: [begin('b1', 'cmd:built'), finish('b1', 'pass', 0)] }, { id: 'unrun', assignment: ASSIGNED, events: [] }], [TIMEBOX]);
    const checked = checkedOf(input);
    const claim = owedOf(checked).claim;
    expect(judged(checked, { ...claim, verdict: 'ready', writes: ['request'], stop: [] })).toEqual(['verdict: due blocked, given ready', 'writes: due [state, blocked], given [request]', 'stop limit: due "timebox 2h", given none']);
    expect([claim.verdict, claim.stop, judged(checked, claim)]).toEqual(['blocked', [{ id: 'limit', value: 'timebox 2h' }], []]);
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
  { name: "another role's block in its place", apply: (role, text) => text.replace(block(role), () => block(role === 'planner' ? 'verifier' : 'planner')), names: (role) => `${role}: role: source ${role}` },
  { name: 'the first row deleted', apply: (role, text) => text.replace(/\n\| 1 \| `[a-zA-Z]+` \|[^\n]*/, ''), names: (role) => `${role}: the rows are not numbered` },
  { name: "a stop field's evidence widened", apply: (_, text) => text.replace('| `held` | ', '| `held` | or skip it: '), names: (role) => `${role}: stop idle` },
  { name: 'a stray clause inside the block', apply: (_, text) => text.replace('\n\nTake the first row that holds for the step', '\n\nSkip the acceptance check.\n\nTake the first row that holds for the step'), names: (role) => `${role}: 9 paragraphs` },
  { name: 'an unknown version', apply: (role, text) => text.replace(`round-policy v1 ${role}`, `round-policy v2 ${role}`), names: (role) => `${role}: unknown round-policy version v2` },
  { name: 'a priority dropped', apply: (_, text) => text.replace(/\n\| 2 \| /, '\n| 9 | '), names: (role) => `${role}: the rows are not numbered` },
  { name: "the evidence fields' instruction cut", apply: (_, text) => text.replace('; `waits`: the id it waits on', ''), names: (role) => `${role}: fields` },
];

describe('(b) every shipped render, read back through its host envelope', () => {
  test('11 renders: three named roles on three hosts, the lean worker on Claude Code and OpenCode only', () => {
    expect(RENDERS.length).toBe(11);
    expect(RENDERS.filter((one) => one.role === 'worker').map((one) => one.host)).toEqual(['claude', 'opencode']);
    for (const role of ['planner', 'implementor', 'verifier'] as const) expect(RENDERS.filter((one) => one.role === role).map((one) => one.host)).toEqual([...HOSTS]);
  });
  test("each decodes to exactly its role's policy, part by part and byte for byte", () => {
    expect(renderFaults()).toEqual([]);
    for (const { role, host, path } of RENDERS) {
      const text = hostPrompt(host, role, read(path));
      const shown = decodeBlock(/<!-- round-policy v1 [\s\S]*?<!-- \/round-policy -->/.exec(text)?.[0] ?? '');
      expect([role, host, shown]).toEqual([role, host, { ok: true, value: project(role) }]);
    }
  });
  test('no shipped policy block grows past round 3', () => {
    const ceiling = { planner: 4034, implementor: 3954, verifier: 5498, worker: 3446 }; // bytes at 8c429fa3
    for (const role of ROLES) expect(Buffer.byteLength(block(role))).toBeLessThanOrEqual(ceiling[role]);
  });
  test('a mutation of any one render alone is named for that render, and only it', () => {
    for (const mutation of MUTATIONS)
      for (const target of RENDERS) {
        const root = scratchRoot();
        const file = join(root, target.path);
        const original = readFileSync(file, 'utf8');
        if (target.host === 'opencode') {
          const parsed = JSON.parse(original) as { agents: Record<string, { system: string }> };
          parsed.agents[target.role]!.system = mutation.apply(target.role, parsed.agents[target.role]!.system);
          writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
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

/** Independently check the real claim and the displayed policy against the oracle's state and evidence. */
function evidenceFaults(policy: Policy): string[] {
  const out: string[] = [];
  for (const one of generated(policy.role, 4)) {
    const checked = checkedOf(stepEnvelope(one));
    const got = owed(checked);
    const key = recordKey(one.record.facts);
    if (!got.ok) {
      out.push(`${policy.role} ${key}: ${got.error}`);
      continue;
    }
    const state = stateOf(policy.role, one.record.facts);
    if (got.value.states[0]?.state !== state) out.push(`${policy.role} ${key}: state ${got.value.states[0]?.state}, the oracle ${state}`);
    const shown = decide(policy, truths([one.record.facts]))[0];
    if (shown === undefined) out.push(`${policy.role} ${key}: no row is true`);
    else if (shown.state !== state) out.push(`${policy.role} ${key}: state ${shown.state}, the oracle ${state}`);
    const want = one.record.fields.map((field) => field.field).join();
    const fields = got.value.claim.items[0]?.fields.map((field) => field.field).join();
    if (want !== fields) out.push(`${policy.role} ${key}: owes [${fields}], the record holds [${want}]`);
    const shownFields = one.record.fields.filter((field) => policy.fields.some((entry) => field.field === entry.id)).map((field) => field.field).join();
    if (want !== shownFields) out.push(`${policy.role} ${key}: owes [${shownFields}], the record holds [${want}]`);
  }
  return [...new Set(out)];
}

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

const oracleFaults = (policy: Policy): string[] => evidenceFaults(policy).filter((line) => line.includes(': state ') || line.includes('no row is true') || line.includes('step: '));
const CHECKS = { expectations: expectationFaults, evidence: (p: Policy) => evidenceFaults(p).filter((line) => line.includes(' owes ')), oracle: oracleFaults };

describe('(c) mirrored loss: the source mutated and every render regenerated in agreement', () => {
  test('the shipped policies meet every independent expectation', () => {
    for (const role of ROLES) expect([role, expectationFaults(POLICIES[role]), evidenceFaults(POLICIES[role])]).toEqual([role, [], []]);
  });
  for (const mutant of MUTANTS)
    test(`${mutant.role}: ${mutant.name}: passes delivery once regenerated, and the ${mutant.killedBy} check kills it`, () => {
      const policy = mutant.mutate(POLICIES[mutant.role]);
      // Regenerated in agreement: the rendered block decodes to the mutant, so a delivery check against it is blind.
      expect(decodeBlock(render(policy))).toEqual({ ok: true, value: policy });
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

// ---- (d) evidence over every generated history -------------------------------------------------------------------------

const RUN_KEYS = ['id', 'command', 'exit', 'receipt', 'head'] as const;

describe('(d) every role × generated history: the owed claim, exactly', () => {
  test('the domain: every attempt kind and every obstacle set is reached', () => {
    for (const role of ROLES) {
      const records = generated(role, 4).map((one) => checkedOf(stepEnvelope(one)).records[0]!).filter((record) => record.facts.assigned);
      expect([role, [...new Set(records.map((record) => record.facts.attempt))].sort()]).toEqual([role, ['fail', 'never', 'pass', 'started', 'unclear']]);
      expect([role, new Set(records.map((record) => `${record.facts.refused}${record.facts.hostCannot}${record.facts.wait}`)).size]).toEqual([role, 8]);
    }
  });
  for (const role of ROLES)
    test(`${role}: the exact claim is admitted; each field stripped, doubled or varied alone is named`, () => {
      let probed = 0;
      for (const one of generated(role, 4)) {
        const checked = checkedOf(stepEnvelope(one));
        const claim = owedOf(checked).claim;
        const item = claim.items[0]!;
        const key = JSON.stringify(one.trace.events);
        const withItem = (next: object) => ({ ...claim, items: [{ ...item, ...next }] });
        expect([key, judged(checked, claim)]).toEqual([key, []]);
        expect([key, judged(checked, withItem({ rule: 'otherwise', label: `${item.label} ` })).length]).toEqual([key, 2]);
        for (const field of item.fields) {
          const stripped = judged(checked, withItem({ fields: item.fields.filter((other) => other !== field) }));
          expect([key, field.field, stripped.length, stripped[0]?.startsWith(`item: ${field.field}: due `)]).toEqual([key, field.field, 1, true]);
          expect([key, field.field, judged(checked, withItem({ fields: [...item.fields, field] })).length]).toEqual([key, field.field, 1]);
        }
        for (const field of item.fields.filter((other) => other.field === 'completed'))
          for (const name of RUN_KEYS) {
            const varied = item.fields.map((other) => (other === field && other.field === 'completed' ? { ...other, run: { ...other.run, [name]: name === 'exit' ? 99 : `other:${name}` } } : other));
            expect([key, name, judged(checked, withItem({ fields: varied })).length]).toEqual([key, name, 1]);
          }
        if (!item.fields.some((other) => other.field === 'waits')) expect([key, judged(checked, withItem({ fields: [...item.fields, { field: 'waits', ref: 'ref:other' }] }))]).toEqual([key, ['item: waits: due none, given waits ref="ref:other"']]);
        probed++;
      }
      expect(probed).toBeGreaterThan(500);
    });
  test("two items' evidence mispaired, a missing hand-back or an invented item is named", () => {
    const red = (id: string) => ({ id, assignment: ASSIGNED, events: [begin(`${id}-1`, `cmd:${id}`), finish(`${id}-1`, 'fail', 1)] });
    const checked = checkedOf(envelopeOf('verifier', [red('a'), red('b')]));
    const right = owedOf(checked).claim;
    expect([right.verdict, judged(checked, right)]).toEqual(['changes', []]);
    const [a, b] = right.items as [Claim['items'][number], Claim['items'][number]];
    const faults = judged(checked, { ...right, items: [{ ...a, fields: b.fields }, { ...b, fields: a.fields }] });
    expect([faults.some((line) => line.startsWith('a: completed')), faults.some((line) => line.startsWith('b: completed'))]).toEqual([true, true]);
    expect(judged(checked, { ...right, items: [a] })).toEqual(['b: 0 hand-backs, not one']);
    expect(judged(checked, { ...right, items: [...right.items, { ...a, item: 'c' }] })).toEqual(['c: no such item in the step']);
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
    const items = [
      { id: 'p', assignment: ASSIGNED, events: [begin('p1', 'cmd:p'), finish('p1', 'pass', 0)] },
      { id: 'w', assignment: ASSIGNED, events: [begin('w1', 'cmd:w'), finish('w1', 'fail', 1), { kind: 'waitOpen', ref: 'ref:w' }] },
      { id: 'c', assignment: ASSIGNED, events: [begin('c1', 'cmd:c'), { kind: 'hostLost', absent: { tool: 'tool:c', probe: 'probe:c', output: { kind: 'log', digest: 'sha:probe' } } }] },
    ] as const;
    const claim = owedOf(checkedOf(envelopeOf('implementor', items))).claim;
    expect(claim.stop).toEqual([{ id: 'held', item: 'w', value: 'cmd:w (exit 1)' }, { id: 'held', item: 'c', value: 'cannot run here: tool:c' }]);
    const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    for (const order of permutations) {
      const checked = checkedOf(envelopeOf('implementor', order.map((index) => items[index]!)));
      expect([order, judged(checked, claim)]).toEqual([order, []]);
      expect([order, judged(checked, { ...claim, items: order.map((index) => claim.items[index]!), verdict: 'ready' })]).toEqual([order, ['verdict: due blocked, given ready']]);
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
  const pick = Math.floor(next() * 11);
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
  if (pick === 8) return { kind: 'observe', rev: at };
  return { kind: 'begin', rev: rev + 1 };
}

type Stepper = (role: Role, at: Snapshot, event: TraceEvent) => Snapshot;
const completedRev = (record: ItemRecord): number => {
  const run = record.fields.find((one) => one.field === 'completed');
  return run?.field === 'completed' ? Number(run.run.id.split('-r')[1]) : 0;
};

/**
 * Every fault over `traces` seeded traces of up to 12 events, per role: the events go through `stepper` (the snapshot
 * model, or a broken one) and, written as the contract's envelope, through `decode`; the two must agree after every
 * event, the latest completed attempt kept.
 */
function traceFaults(stepper: Stepper, traces = 1000): string[] {
  const out: string[] = [];
  for (const role of ROLES)
    for (let seed = 0; seed < traces && out.length === 0; seed++) {
      const next = random(0x23b + seed);
      const required = role !== 'verifier' || next() < 0.7;
      let at = freshSnapshot(required);
      let rev = 0;
      const seen: TraceEvent[] = [];
      const length = 1 + Math.floor(next() * 12);
      for (let index = 0; index < length; index++) {
        const one = event(next, rev);
        seen.push(one);
        const before = recordOf('t', at);
        const after = stepper(role, at, one);
        // A duplicate delivery changes nothing more; a restart changes nothing at all.
        if (JSON.stringify(stepper(role, after, one)) !== JSON.stringify(after) && one.kind !== 'begin' && one.kind !== 'host' && one.kind !== 'wait') out.push(`${role} seed ${seed}: a duplicate ${one.kind} changed the snapshot`);
        if (one.kind === 'restart' && JSON.stringify(after) !== JSON.stringify(at)) out.push(`${role} seed ${seed}: a restart changed the snapshot`);
        at = after;
        rev = Math.max(rev, 'rev' in one ? one.rev : 0);
        const record = recordOf('t', at);
        if (completedRev(record) < completedRev(before)) out.push(`${role} seed ${seed} after ${JSON.stringify(seen)}: completed went from r${completedRev(before)} to r${completedRev(record)}`);
        const { trace, snapshot } = concrete(role, 't', seen, required);
        const got = decode(stepEnvelope({ role, trace, record: recordOf('t', snapshot) }));
        if (!got.ok) out.push(`${role} seed ${seed} after ${JSON.stringify(seen)}: ${got.error}`);
        else if (!same(got.value.records[0], record)) out.push(`${role} seed ${seed} after ${JSON.stringify(seen)}: decoded ${JSON.stringify(got.value.records[0])}, the model ${JSON.stringify(record)}`);
        else if (owedOf(got.value).states[0]?.state !== stateOf(role, record.facts)) out.push(`${role} seed ${seed}: state ${owedOf(got.value).states[0]?.state}, the oracle ${stateOf(role, record.facts)}`);
      }
    }
  return out;
}

describe('(f) seeded production traces', () => {
  test('1000 traces of up to 12 events per role, seed 0x23b: every envelope decodes to the model, its latest completed attempt kept, its evidence owed', () => {
    expect(traceFaults(step)).toEqual([]);
  });
  test('a denial after a red result keeps the red output beside the denial (22w W03); a late older result is not taken', () => {
    const { trace } = concrete('implementor', 'w', [{ kind: 'begin', rev: 1 }, { kind: 'finish', rev: 1, result: 'fail' }, { kind: 'deny', rev: 2, form: true }]);
    expect(checkedOf(envelopeOf('implementor', [trace])).records[0]?.fields.map((field) => field.field)).toEqual(['completed', 'current', 'refused']);
    const late = concrete('implementor', 'l', [{ kind: 'begin', rev: 3 }, { kind: 'finish', rev: 2, result: 'pass' }]);
    expect(checkedOf(envelopeOf('implementor', [late.trace], [TIMEBOX])).records[0]?.fields.map((field) => field.field)).toEqual(['current']);
  });
  test("a broken model that drops the completed attempt on a denial is caught (the model's `broken` step)", () => {
    const broken: Stepper = (role, at, one) => {
      const next = step(role, at, one);
      return one.kind === 'deny' && next !== at ? { ...next, runs: [], facts: { ...next.facts, attempt: 'started' } } : next;
    };
    expect(traceFaults(broken).length).toBeGreaterThan(0);
  });
});

// ---- (g) the input domain, comparison, absence and the stop's values -------------------------------------------------

/** The text members of one evidence field the B1 envelope carries, each at its own place in the events. */
type Member = 'completed.id' | 'completed.command' | 'completed.digest' | 'completed.receipt' | 'completed.head' | 'current.id' | 'current.command' | 'refused.what' | 'refused.scope' | 'refused.report' | 'refused.form' | 'cannot.tool' | 'cannot.probe' | 'cannot.digest';
const MEMBERS: Record<Member, string> = {
  'completed.id': 't-a1',
  'completed.command': 'cmd:t',
  'completed.digest': 'sha:t',
  'completed.receipt': 'rcpt:t',
  'completed.head': 'head:t',
  'current.id': 't-a2',
  'current.command': 'cmd:t:2',
  'refused.what': 'action:t',
  'refused.scope': 'scope:t',
  'refused.report': 'report:t',
  'refused.form': 'form:t',
  'cannot.tool': 'tool:t',
  'cannot.probe': 'probe:t',
  'cannot.digest': 'sha:t:probe',
};
/** A history that leaves every evidence field: a red run, a denied retry, a lost tool and an open wait. */
const fullEnvelope = (v: Record<Member, string>): Envelope =>
  envelopeOf('implementor', [
    {
      id: 't',
      assignment: ASSIGNED,
      events: [
        { kind: 'begin', attempt: v['completed.id'], command: v['completed.command'] },
        { kind: 'finish', attempt: v['completed.id'], result: 'fail', exit: 1, output: { kind: 'log', digest: v['completed.digest'] }, receipt: v['completed.receipt'], head: v['completed.head'] },
        { kind: 'deny', attempt: v['current.id'], command: v['current.command'], refusal: { what: v['refused.what'], scope: v['refused.scope'], report: v['refused.report'], form: { kind: 'named', form: v['refused.form'] } } },
        { kind: 'hostLost', absent: { tool: v['cannot.tool'], probe: v['cannot.probe'], output: { kind: 'log', digest: v['cannot.digest'] } } },
        { kind: 'waitOpen', ref: 'ref:t' },
      ],
    },
  ]);
/** One member of a claimed field set to `value`, wherever that field keeps it. */
const setMember = (field: Field, member: Member, value: string): Field => {
  const [kind, name] = member.split('.') as [Field['field'], string];
  if (field.field !== kind) return field;
  if (field.field === 'completed') return name === 'digest' ? { ...field, run: { ...field.run, output: { kind: 'log', digest: value } } } : { ...field, run: { ...field.run, [name]: value } };
  if (field.field === 'current') return { ...field, attempt: { ...field.attempt, [name]: value } };
  if (field.field === 'refused') return name === 'form' ? { ...field, refusal: { ...field.refusal, form: { kind: 'named', form: value } } } : { ...field, refusal: { ...field.refusal, [name]: value } };
  if (field.field === 'cannot') return name === 'digest' ? { ...field, absent: { ...field.absent, output: { kind: 'log', digest: value } } } : { ...field, absent: { ...field.absent, [name]: value } };
  return field;
};
/** Every pair of text members printed side by side, with the text a field's shown line puts between their values. */
const BOUNDARIES: ReadonlyArray<readonly [Member, Member, string]> = [
  ['completed.id', 'completed.command', ' command='],
  ['completed.command', 'completed.digest', ' output=log '],
  ['completed.receipt', 'completed.head', ' head='],
  ['current.id', 'current.command', ' command='],
  ['refused.what', 'refused.scope', ' scope='],
  ['refused.scope', 'refused.report', ' report='],
  ['refused.report', 'refused.form', ' form=named '],
  ['cannot.tool', 'cannot.probe', ' probe='],
  ['cannot.probe', 'cannot.digest', ' output=log '],
];

/** One truthful envelope per stop a role has and per remedy a refusal prints. */
function truthfulSteps(role: Role): ReadonlyArray<{ readonly name: string; readonly input: Envelope }> {
  const done = { id: 'done', assignment: ASSIGNED, events: [begin('done-1', 'cmd:done'), finish('done-1', 'pass', 0)] };
  const refused = (form: object) => ({ id: 'r', assignment: ASSIGNED, events: [{ kind: 'deny', attempt: 'r-1', command: 'cmd:r', refusal: { what: 'action:r', scope: 'scope:r', report: 'report:r', form } }] });
  const all = [
    { name: 'refusal printing a command', stop: 'refusalForm', input: envelopeOf(role, [done, refused({ kind: 'named', form: 'form:r' })] as Trace[]) },
    { name: 'refusal printing an allow rule', stop: 'refusalForm', input: envelopeOf(role, [done, refused({ kind: 'allow', allow: 'allow:r' })] as Trace[]) },
    { name: 'refusal printing no remedy', stop: 'refusalNone', input: envelopeOf(role, [done, refused({ kind: 'none' })] as Trace[]) },
    { name: 'a refused write of its own file', stop: 'refusalNone', input: envelopeOf(role, [done], [writeDenied(role)]) },
    { name: 'limit', stop: 'limit', input: envelopeOf(role, [done, { id: 'run', assignment: ASSIGNED, events: [] }], [TIMEBOX]) },
    { name: 'idle with a held item', stop: 'idle', input: envelopeOf(role, [done, { id: 'w', assignment: ASSIGNED, events: [{ kind: 'waitOpen', ref: 'ref:w' }] }]) },
    { name: 'idle with nothing held', stop: 'idle', input: envelopeOf(role, [done]) },
  ] as const;
  return all.filter((one) => STOPS_OF[role].some((stop) => stop === one.stop));
}

describe('(g) the input domain, comparison, absence and the stop values', () => {
  test('B3: the facts that decoded envelopes reach are exactly the oracle\'s valid ones; no envelope reaches an invalid one', () => {
    const items = allItems();
    expect([items.length, new Set(items.map(recordKey)).size]).toEqual([960, 960]);
    for (const role of ROLES) {
      const reached = new Set(generated(role, 5).map((one) => recordKey(checkedOf(stepEnvelope(one)).records[0]!.facts)));
      const valid = new Set(items.filter((item) => validity(role, item) === undefined).map(recordKey));
      expect([role, [...reached].sort()]).toEqual([role, [...valid].sort()]);
    }
  });
  test('B1: two values printed alike across every boundary between them are two values; both varied together are one difference', () => {
    for (const [a, b, between] of BOUNDARIES) {
      // The history holds `b` = "x<between>y"; the claim moves "<between>x" onto `a`: the shown line reads the same.
      const checked = checkedOf(fullEnvelope({ ...MEMBERS, [b]: `x${between}y` }));
      const claim = owedOf(checked).claim;
      const item = claim.items[0]!;
      const moved = item.fields.map((field) => setMember(setMember(field, a, `${MEMBERS[a]}${between}x`), b, 'y'));
      expect([a, b, judged(checked, { ...claim, items: [{ ...item, fields: moved }] }).length]).toEqual([a, b, 1]);
      const both = item.fields.map((field) => setMember(setMember(field, a, 'other:a'), b, 'other:b'));
      expect([a, b, judged(checked, { ...claim, items: [{ ...item, fields: both }] }).length]).toEqual([a, b, 1]);
      expect([a, b, judged(checked, claim)]).toEqual([a, b, []]);
    }
  });
  test('B2: every role × stop × field: absent is admitted exactly where absence is the truth; an empty value, a placeholder or a doubled value never is', () => {
    let cases = 0;
    for (const role of ROLES)
      for (const { name, input } of truthfulSteps(role)) {
        const checked = checkedOf(input);
        const claim = owedOf(checked).claim;
        expect([role, name, judged(checked, claim)]).toEqual([role, name, []]);
        for (const id of ['refused.what', 'refused.form', 'refused.allow', 'limit', 'held'] as const) {
          const entries = claim.stop.filter((one) => one.id === id);
          const others = claim.stop.filter((one) => one.id !== id);
          const at = (stop: ReadonlyArray<StopValue>) => judged(checked, { ...claim, stop });
          const valueOf = (value: string): StopValue => (id === 'held' ? { id, item: 'done', value } : { id, value });
          expect([role, name, id, 'absent', at(others).length === 0]).toEqual([role, name, id, 'absent', entries.length === 0]);
          const empty = entries.length === 0 ? [...others, valueOf('')] : [...others, ...entries.map((one) => ({ ...one, value: '' }))];
          expect([role, name, id, 'empty', at(empty).length > 0]).toEqual([role, name, id, 'empty', true]);
          if (entries.length === 0) expect([role, name, id, 'placeholder', at([...others, valueOf('nothing')]).length > 0]).toEqual([role, name, id, 'placeholder', true]);
          else expect([role, name, id, 'doubled', at([...claim.stop, ...entries]).length > 0]).toEqual([role, name, id, 'doubled', true]);
          cases += 3;
        }
      }
    expect(cases).toBeGreaterThan(80);
  });
  test('T1: each owed stop value changed alone, dropped, or moved across its item boundary is named; the owed values are admitted', () => {
    let forged = 0;
    for (const role of ROLES)
      for (const { name, input } of truthfulSteps(role)) {
        const checked = checkedOf(input);
        const claim = owedOf(checked).claim;
        claim.stop.forEach((value, index) => {
          const swap = (other: StopValue) => judged(checked, { ...claim, stop: claim.stop.map((one, at) => (at === index ? other : one)) });
          const changed = swap({ ...value, value: `${value.value}:forged` });
          expect([role, name, value.id, changed.length, changed[0]?.startsWith(`stop ${value.id}: due `)]).toEqual([role, name, value.id, 1, true]);
          expect([role, name, value.id, judged(checked, { ...claim, stop: claim.stop.filter((_, at) => at !== index) }).length]).toEqual([role, name, value.id, 1]);
          if (value.id === 'held') expect([role, name, 'item', swap({ ...value, item: 'done' }).length]).toEqual([role, name, 'item', 1]);
          if (value.id === 'held') expect([role, name, swap({ id: 'held', item: `${value.item}: ${value.value.split(' ')[0]}`, value: value.value.split(' ').slice(1).join(' ') }).length]).toEqual([role, name, 1]);
          forged++;
        });
      }
    expect(forged).toBeGreaterThan(20);
  });
});

// ---- (h) envelopes: the one input, against an oracle that reads each history backwards ---------------------------------

/**
 * The record a legal history leaves, read backwards from its end (no state machine, no fold): the latest finish, the
 * newest attempt after it (begun, or a call denied before it began), the latest refusal no lift follows, the latest
 * host loss and wait that nothing closed or settled. Written here by hand, independent of the leaf and the snapshot model.
 */
function backwards(role: Role, trace: Trace): ItemRecord {
  const { assignment, events } = trace;
  const base = { assigned: true, required: true, attempt: 'never', settled: false, refused: false, hostCannot: false, wait: false, provenance: 'none' } as const;
  if (assignment.kind === 'found') return { id: trace.id, facts: { ...base, assigned: false, required: false, settled: true, provenance: assignment.provenance }, fields: [] };
  const lastIndex = (pick: (event: Trace['events'][number]) => boolean, from = 0) => {
    let found = -1;
    events.forEach((event, index) => {
      if (index >= from && pick(event)) found = index;
    });
    return found;
  };
  const settles = (event: Trace['events'][number]) => event.kind === 'finish' && (event.result === 'pass' || (role === 'verifier' && event.result === 'fail'));
  const fields: Field[] = [];
  const done = lastIndex((event) => event.kind === 'finish');
  const finished = events[done];
  let result: 'pass' | 'fail' | 'unclear' | undefined;
  if (finished?.kind === 'finish') {
    const prior = events.slice(0, done).filter((event) => 'attempt' in event && event.attempt === finished.attempt);
    const begun = prior.find((event) => event.kind === 'begin');
    const output = finished.output.kind === 'missing' ? lastPartial(prior) ?? finished.output : finished.output;
    result = finished.result;
    fields.push({ field: 'completed', run: { id: finished.attempt, command: begun?.kind === 'begin' ? begun.command : '?', output, exit: finished.exit, receipt: finished.receipt, head: finished.head, result } });
  }
  const newest = lastIndex((event) => event.kind === 'begin' || event.kind === 'deny', done + 1);
  const opened = events[newest];
  const started = events.some((event) => event.kind === 'begin' || event.kind === 'deny');
  if (opened?.kind === 'begin' || opened?.kind === 'deny') {
    const id = opened.attempt;
    const after = events.slice(newest + 1).filter((event) => 'attempt' in event && event.attempt === id);
    const cut = after.filter((event) => event.kind === 'interrupt').at(-1);
    const seen = after.filter((event) => event.kind === 'observe').at(-1);
    const attempt: Field =
      opened.kind === 'deny'
        ? { field: 'current', attempt: { id, command: opened.command, status: 'denied', output: { kind: 'missing', why: 'not-started' } } }
        : cut?.kind === 'interrupt'
          ? { field: 'current', attempt: { id, command: opened.command, status: 'interrupted', output: lastPartial(after) ?? cut.output } }
          : { field: 'current', attempt: { id, command: opened.command, status: 'started', output: seen?.kind === 'observe' ? { kind: 'partial', digest: seen.digest } : { kind: 'missing', why: 'missing-authenticated-evidence' } } };
    fields.push(attempt);
  }
  const denied = lastIndex((event) => event.kind === 'deny' || event.kind === 'refuse');
  const deny = events[denied];
  if ((deny?.kind === 'deny' || deny?.kind === 'refuse') && lastIndex((event) => event.kind === 'lift', denied) < 0) fields.push({ field: 'refused', refusal: deny.refusal });
  const settledAt = lastIndex(settles);
  const lost = lastIndex((event) => event.kind === 'hostLost');
  const loss = events[lost];
  if (loss?.kind === 'hostLost' && lastIndex((event) => event.kind === 'hostBack', lost) < 0 && settledAt < lost) fields.push({ field: 'cannot', absent: loss.absent });
  const waited = lastIndex((event) => event.kind === 'waitOpen');
  const wait = events[waited];
  if (wait?.kind === 'waitOpen' && lastIndex((event) => event.kind === 'waitClose', waited) < 0 && settledAt < waited) fields.push({ field: 'waits', ref: wait.ref });
  const has = (id: Field['field']) => fields.some((one) => one.field === id);
  const attempt = result ?? (started ? 'started' : 'never');
  const facts = { ...base, required: assignment.required, attempt, settled: settledAt >= 0 || events.some((event) => event.kind === 'settle'), refused: has('refused'), hostCannot: has('cannot'), wait: has('waits') } as const;
  return { id: trace.id, facts, fields };
}

/** Look backwards for the newest actual partial output, not a later observation that had no new bytes. */
function lastPartial(events: Trace['events']) {
  for (const event of [...events].reverse()) {
    if (event.kind === 'interrupt' && event.output.kind === 'partial') return event.output;
    if (event.kind === 'observe') return { kind: 'partial' as const, digest: event.digest };
  }
}

/** A path into a JSON value, and the value there. */
type Path = ReadonlyArray<string | number>;
const leaves = (value: unknown, path: Path = []): Array<{ readonly path: Path; readonly value: unknown }> => {
  const here = [{ path, value }];
  if (Array.isArray(value)) return [...here, ...value.flatMap((inner, index) => leaves(inner, [...path, index]))];
  if (value !== null && typeof value === 'object') return [...here, ...Object.entries(value).flatMap(([key, inner]) => leaves(inner, [...path, key]))];
  return here;
};
/** A copy of `root` with the value at `path` replaced by what `change` makes of it (undefined deletes an object member). */
const changedAt = (root: unknown, path: Path, change: (value: unknown, key: string | number, parent: unknown) => unknown): unknown => {
  const copy = json(root);
  if (path.length === 0) return change(copy, '', undefined);
  let parent: unknown = copy;
  for (const key of path.slice(0, -1)) parent = (parent as Record<string | number, unknown>)[key];
  const key = path.at(-1)!;
  const record = parent as Record<string | number, unknown>;
  const next = change(record[key], key, parent);
  if (next === DELETE) {
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete record[key];
  } else if (next === MISSPELL) {
    record[`${key}_`] = record[key];
    delete record[key];
  } else record[key] = next;
  return copy;
};
const DELETE = Symbol('delete');
const MISSPELL = Symbol('misspell');
const RESULT_WORDS: ReadonlyArray<string> = ['pass', 'fail', 'unclear'];
const OUTPUT_WORDS: ReadonlyArray<string> = ['log', 'partial', 'missing', 'not-started', 'interrupted', 'missing-authenticated-evidence'];
const KINDS = ['begin', 'observe', 'finish', 'interrupt', 'deny', 'refuse', 'lift', 'hostLost', 'hostBack', 'waitOpen', 'waitClose', 'settle', 'limit', 'writeDenied', 'timebox', 'failureCap', 'named', 'none', 'allow', 'assigned', 'found'];

/**
 * Every JSON mutation of an envelope, at every path: delete the member or element, misspell its key, null it, the
 * wrong container, retype it (a string for a number or boolean, a number for a string), alter it (a mark on a
 * string, a number moved, a closed word swapped for another), and per array: duplicate or swap neighbours (resequence).
 */
function mutations(input: Envelope): Array<{ readonly edit: string; readonly input: unknown }> {
  const out: Array<{ readonly edit: string; readonly input: unknown }> = [];
  for (const { path, value } of leaves(input)) {
    const at = path.join('.');
    const put = (edit: string, change: (value: unknown) => unknown) => out.push({ edit: `${edit} ${at}`, input: changedAt(input, path, change) });
    if (path.length > 0) put('delete', () => DELETE);
    if (path.length > 0 && typeof path.at(-1) === 'string') put('misspell', () => MISSPELL);
    put('null', () => null);
    if (Array.isArray(value)) {
      put('object for array', () => ({}));
      value.forEach((_, index) => {
        put(`duplicate ${index} of`, (array) => [...(array as unknown[]).slice(0, index + 1), ...(array as unknown[]).slice(index)]);
        if (index + 1 < value.length) put(`swap ${index} of`, (array) => (array as unknown[]).map((one, other, all) => (other === index ? all[index + 1] : other === index + 1 ? all[index] : one)));
      });
    } else if (value !== null && typeof value === 'object') put('array for object', () => []);
    else if (typeof value === 'string') {
      put('number for string', () => 1);
      put('mark on', () => `${value}'`);
      for (const word of [...RESULT_WORDS, ...OUTPUT_WORDS, ...KINDS]) if (word !== value && [...RESULT_WORDS, ...OUTPUT_WORDS, ...KINDS].includes(value)) put(`${word} for`, () => word);
    } else if (typeof value === 'number') {
      put('string for number', () => String(value));
      put('moved', () => value + 1);
      put('fraction', () => value + 0.5);
    } else if (typeof value === 'boolean') {
      put('string for boolean', () => String(value));
      put('negated', () => !value);
    }
  }
  return out;
}

const TYPED = /^(envelope: |item [^:]+: |items: |step: )/;

describe('(h) envelopes: the contract reads only the persisted envelope, and every evidence value is derived from it', () => {
  test('(a) every generated envelope decodes to the snapshot model\'s record and the backward reading; the oracle\'s claim is the owed one, and admitted', () => {
    const misses: string[] = [];
    const counts: Record<string, number> = {};
    for (const role of ROLES) {
      const all = generated(role, 5);
      counts[role] = all.length;
      for (const one of all) {
        const input = stepEnvelope(one);
        const got = decode(input);
        if (!got.ok || !same(got.value.records[0], one.record) || !same(backwards(role, one.trace), one.record)) {
          misses.push(`${role} ${same(backwards(role, one.trace), one.record) ? 'decode' : 'backwards'} ${JSON.stringify(one.trace.events)} ${got.ok ? '' : got.error}`);
          continue;
        }
        const due = owedOf(got.value);
        const want = oracleClaim(role, [one.record], input.step, due.claim.items);
        if (due.states[0]?.state !== stateOf(role, one.record.facts) || !same(due.claim, want)) misses.push(`${role} owed ${JSON.stringify(due.claim)}, the oracle ${JSON.stringify(want)}`);
        const faults = judged(got.value, want);
        if (faults.length > 0) misses.push(`${role} truthful rejected ${JSON.stringify(one.trace.events)}: ${faults.join('; ')}`);
      }
    }
    expect(misses.slice(0, 5)).toEqual([]);
    expect(Object.values(counts).every((count) => count > 2000)).toBe(true);
  });

  test('(b) every JSON mutation of every member at every depth: a typed rejection, or a legal envelope whose evidence is exactly what its new history implies; never a throw', () => {
    const misses: string[] = [];
    const tally = { rejected: 0, legal: 0, changed: 0, neutral: 0 };
    for (const role of ROLES)
      for (const one of generated(role, 3)) {
        const input = stepEnvelope(one);
        const before = owedOf(checkedOf(input));
        for (const { edit, input: mutated } of mutations(input)) {
          const got = decode(mutated);
          if (!got.ok) {
            tally.rejected++;
            if (!TYPED.test(got.error)) misses.push(`${role} ${edit}: untyped rejection ${got.error}`);
            continue;
          }
          tally.legal++;
          // Legal: this mutation's own obligation, against the independent oracle on the mutated history itself.
          const envelope = mutated as Envelope;
          const implied = envelope.items.map((item) => backwards(role, item));
          if (!same(got.value.records, implied)) {
            misses.push(`${role} ${edit} of ${JSON.stringify(one.trace.events)}: decoded ${JSON.stringify(got.value.records)}, implied ${JSON.stringify(implied)}`);
            continue;
          }
          const due = owedOf(got.value);
          const want = oracleClaim(role, implied, envelope.step, due.claim.items);
          if (!same(due.claim, want)) misses.push(`${role} ${edit}: owed ${JSON.stringify(due.claim)}, the oracle ${JSON.stringify(want)}`);
          // Never the old answer for a changed history: an implied change must show in the owed claim.
          const oldWant = oracleClaim(role, input.items.map((item) => backwards(role, item)), input.step, before.claim.items);
          if (same(want, oldWant)) tally.neutral++;
          else if (same(due.claim, before.claim)) misses.push(`${role} ${edit}: the history changed, the claim did not`);
          else tally.changed++;
        }
      }
    expect(misses.slice(0, 5)).toEqual([]);
    expect([tally.rejected > 10000, tally.legal > 100, tally.changed > 100]).toEqual([true, true, true]);
  });

  // Separate roles and attack families so one giant test doesn't need more than Bun's default budget.
  for (const role of ROLES) for (const attack of ['second envelope', 'placeholder'] as const)
    test(`(c) ${role}: every legal envelope × every would-be evidence value forged by ${attack} is rejected`, () => {
      const misses: string[] = [];
      let probed = 0;
      for (const one of generated(role, 4)) {
        const input = stepEnvelope(one);
        const first = checkedOf(input);
        const right = owedOf(first).claim;
        if (attack === 'second envelope') for (const { path, value } of leaves({ items: input.items, step: input.step })) {
          if (typeof value !== 'string' && typeof value !== 'number') continue;
          const second = changedAt(input, path.slice(), (old) => (typeof old === 'number' ? old + 1 : `${old}'`));
          const got = decode(second);
          if (!got.ok) continue;
          const theirs = owedOf(got.value).claim;
          if (same(theirs, right)) continue;
          probed++;
          if (judged(first, theirs).length === 0) misses.push(`${role} ${path.join('.')} of ${JSON.stringify(one.trace.events)}: the second envelope's claim was admitted against the first`);
        }
        // Placeholders and the empty value, in every value of the owed claim.
        else for (const { path, value } of leaves(right)) {
          if (typeof value !== 'string') continue;
          for (const placeholder of ['nothing', 'none', 'n/a', '-', '']) {
            if (placeholder === value) continue;
            probed++;
            if (judged(first, changedAt(right, path.slice(), () => placeholder)).length === 0) misses.push(`${role} ${path.join('.')} = ${JSON.stringify(placeholder)} admitted`);
          }
        }
      }
      expect(misses.slice(0, 5)).toEqual([]);
      expect(probed).toBeGreaterThan(0);
    });

  test('the limit is the observed one: a second envelope with another length or count, claimed against the first, is rejected', () => {
    const items = [{ id: 'run', assignment: ASSIGNED, events: [] }];
    for (const [ours, theirs] of [
      [{ kind: 'timebox', length: '2h' }, { kind: 'timebox', length: '3h' }],
      [{ kind: 'failureCap', count: 3 }, { kind: 'failureCap', count: 2 }],
      [{ kind: 'timebox', length: '2h' }, { kind: 'failureCap', count: 3 }],
    ] as const) {
      const first = checkedOf(envelopeOf('planner', items, [{ kind: 'limit', limit: ours }]));
      const claim = owedOf(checkedOf(envelopeOf('planner', items, [{ kind: 'limit', limit: theirs }]))).claim;
      expect([ours, judged(first, claim).length]).toEqual([ours, 1]);
      expect(judged(first, owedOf(first).claim)).toEqual([]);
    }
  });

  test("the verifier's round-2 records as envelopes: a dropped denial, an attempt after a settled pass and a run that never started are not admitted", () => {
    const denied = concrete('verifier', 'ci', [{ kind: 'begin', rev: 1 }, { kind: 'finish', rev: 1, result: 'unclear' }, { kind: 'deny', rev: 2, form: false }]).trace;
    const checked = checkedOf(envelopeOf('verifier', [denied]));
    const claim = owedOf(checked).claim;
    const dropped = { ...claim, items: claim.items.map((one) => ({ ...one, fields: one.fields.filter((field) => field.field !== 'current') })) };
    expect(judged(checked, dropped)[0]?.startsWith('ci: current: due current id="ci-r2"')).toBe(true);
    const passed = concrete('verifier', 'ci', [{ kind: 'begin', rev: 1 }, { kind: 'finish', rev: 1, result: 'pass' }]).trace;
    const after = decode(envelopeOf('verifier', [{ ...passed, events: [...passed.events, { kind: 'begin', attempt: 'ci-r2', command: 'cmd:ci' }] }]));
    expect([after.ok, !after.ok && after.error]).toEqual([false, 'item ci: event 3 (begin): the item is settled: no event follows']);
    const never = decode(envelopeOf('verifier', [{ ...passed, events: passed.events.map((event) => (event.kind === 'finish' ? { ...event, output: { kind: 'missing', why: 'not-started' } } : event)) }]));
    expect([never.ok, !never.ok && never.error.startsWith('item ci: event 2 (finish): ')]).toEqual([false, true]);
  });
});

/** The role's own file, as the hand-back the final message carries when it cannot be written. */
test('a refused write of each role\'s own file: the step stops on it, the verdict reads one refused item, and nothing else changes', () => {
  for (const role of ROLES) {
    const done = { id: 'done', assignment: ASSIGNED, events: [begin('d1', 'cmd:d'), finish('d1', 'pass', 0)] };
    const checked = checkedOf(envelopeOf(role, [done], [writeDenied(role)]));
    const due = owedOf(checked);
    expect([role, due.states.map((one) => one.state), due.claim.verdict, due.claim.stop]).toEqual([role, ['done'], VERDICT(role, ['done', 'refused']), [{ id: 'refused.what', value: `write:${OWN_FILE[role]}` }]]);
  }
});
