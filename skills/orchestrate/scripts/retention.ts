// Rule retention against the installed prompts (4afe1fda): every sentence of the planner, implementor and verifier
// prompts there that the generated prompts no longer hold word for word, and where its rule went. ending.test.ts
// pins this list both ways: a sentence lost with no entry is red, and so is an entry whose sentence still stands or
// whose destination is gone. Every other sentence of those prompts is kept word for word.
//   reworded  the rule stands in the prompt as `now`, word for word (a later accepted unit or this one rewrote it);
//   moved     the rule is one or more cells of ending.ts's two functions, rendered into the role's block;
//   replaced  this design decides it differently, by the design line `by`, at the cells in `to`.
// A destination: `F1 <role> <state>` (a label), `F2 <role> <verdict>` (a verdict rule and its files),
// `F2 <role> evidence <stop>` (what a stop writes), `REQUIRED <role>` (the role's required-work line).

export const INSTALLED = '4afe1fda';

export type Fate =
  | { readonly kind: 'reworded'; readonly now: string; readonly to?: ReadonlyArray<string> }
  | { readonly kind: 'moved'; readonly to: ReadonlyArray<string> }
  | { readonly kind: 'replaced'; readonly by: string; readonly to: ReadonlyArray<string> };

const TABLE_ROW = (role: 'planner' | 'implementor', ...verdicts: string[]): Fate => ({ kind: 'moved', to: verdicts.map((verdict) => `F2 ${role} ${verdict}`) });

export const RETENTION: Readonly<Record<string, Fate>> = {
  'When it is done, end with a final message whose **first line** is:': {
    kind: 'reworded',
    now: "Your final message's **first line** is:",
    to: ['F2 planner ready', 'F2 implementor ready', 'F2 verifier accepted'],
  },
  '| You are | Your file | Verdict |': { kind: 'moved', to: ['F2 planner ready', 'F2 implementor ready', 'F2 verifier accepted'] },
  '| planner | `<unit dir>/spec.md` | `ready` or `blocked` |': TABLE_ROW('planner', 'ready', 'blocked'),
  '| implementor | `<unit dir>/round-N-request.md`, committed | `ready` or `blocked` |': TABLE_ROW('implementor', 'ready', 'blocked'),
  '| verifier | the findings file beside its batch file, and a `round-N-findings.md` per unit | `accepted`, `changes` or `stuck` |': {
    kind: 'moved',
    to: ['F2 verifier accepted', 'F2 verifier changes', 'F2 verifier stuck'],
  },
  'A compaction does not end your step: after one, read the spec and `state.md` again and go on.': {
    kind: 'reworded',
    now: 'A compaction does not end your step, nor does a long context: after one, read the spec and `state.md` again and go on.',
  },
  'When something blocks you, write `<unit dir>/blocked.md` (what blocks you, what you tried, the options and your pick) and end with verdict `blocked` and that path.': {
    kind: 'replaced',
    by: "(F2) implementor/planner: `ready` only when every required item is done, else `blocked`, with blocked.md holding the stop event's evidence; verifier: any required check refused, unable to run, unclear or waiting is `stuck` (a verifier never writes blocked.md)",
    to: ['F2 planner blocked', 'F2 implementor blocked', 'F2 implementor evidence idle', 'F2 verifier stuck', 'F1 implementor waits'],
  },
  'A weak test or a written-rule break with no failing run never fails a round: it becomes a follow-up unit.': {
    kind: 'replaced',
    by: '(F1) work no spec item asks for carries its provenance for the verifier: unit-introduced, by measured attribution, to the same lane\'s next round; shown on the base head too, to a follow-up unit (B2)',
    to: ['F1 verifier unitFinding', 'F1 verifier baseFinding'],
  },
  '`stuck` is for when no round can help (a spec that contradicts itself).': {
    kind: 'reworded',
    now: 'A `stuck` verdict means no round can help until its cause changes.',
    to: ['F1 verifier waits', 'F2 verifier stuck', 'F2 planner blocked'],
  },
  '**Decide** an open choice by the simpler, reversible option, in `state.md` as "decided by <principle>" (a `principle-*` skill: the `principles` tool in OpenCode, else `~/.claude/skills/principle-*/SKILL.md`).': {
    kind: 'reworded',
    now: '**Decide** an open choice by the principles, never by effort (where they leave it open, the reversible option), in `state.md` as "decided by <principle>" (a `principle-*` skill: the `principles` tool in OpenCode, else `~/.claude/skills/principle-*/SKILL.md`).',
  },
  "**Request.** `round-N-request.md`: this protocol, the spec and the head commit first; then base and head with `git diff --stat <base>..HEAD | tail -1`, what changed by file, how to run it, the gate's exit line and receipt, the acceptance check's command and exit line at the head, known gaps.": {
    kind: 'reworded',
    now: "**Request.** `round-N-request.md`: this protocol, the spec and the head commit first; then base and head with `git diff --stat <base>..HEAD | tail -1`, what changed by file, how to run it, the gate's exit line and receipt, the acceptance check's command and exit line at the head, known gaps (each item left, with its label from How your step ends).",
  },
  'Hand back once `bun ~/.claude/skills/orchestrate/scripts/request.ts <unit dir> <N>` exits 0.': { kind: 'moved', to: ['F2 implementor ready'] },
  '**Timebox.** Past it, hand back `blocked` with `state.md` current.': {
    kind: 'moved',
    to: ['F2 implementor blocked', 'F2 implementor evidence limit', 'F1 implementor runnable'],
  },
  '**Scope.** Work outside the spec goes in `state.md` under "Follow-ups".': {
    kind: 'reworded',
    now: '**Scope.** A finding outside the spec goes in `state.md` under "Follow-ups"; a spec item never does.',
    to: ['F1 implementor discovery'],
  },
  'A `Heads: dotfiles=<sha> fork=<sha>` line must name your head and its fork commit (`git rev-parse`), else the batch is `stuck`.': {
    kind: 'moved',
    to: ['REQUIRED verifier'],
  },
  'Everything else you prove goes under Test strength (a weak test, a surviving mutant, a narrow generator, a vacuous assertion, an oracle that excuses) or under On base (a written-rule break with no failing run, as `guard: <kind> <what it catches>`); neither fails a round, and both become follow-up units.': {
    kind: 'replaced',
    by: '(F1) a discovery carries its provenance: `unit` to the same lane\'s next round, `base` to a follow-up unit (B2)',
    to: ['F1 verifier unitFinding', 'F1 verifier baseFinding'],
  },
  'What this host cannot run goes under Unproven, with the probe that would settle it.': {
    kind: 'reworded',
    now: 'What this host cannot run, beyond the checks of step 1, goes under Unproven, with the probe that would settle it.',
    to: ['F1 verifier cannot', 'REQUIRED verifier'],
  },
  "**Findings.** `<unit dir>/round-N-findings.md`, under 10 KB: `Verdict: ACCEPTED`, `Verdict: CHANGES REQUIRED` or `Verdict: STUCK` first; Check (command, expected, observed, evidence); the sections Blockers and Major, Test strength, Unproven (3 at most) and On base (a defect the base has), each finding with an id, file:line, failure, proof, repair and guard (`M3 repeat of r2 M1` for a new trigger); each command's exit code.": {
    kind: 'reworded',
    now: "**Findings.** `<unit dir>/round-N-findings.md`, under 10 KB: `Verdict: ACCEPTED`, `Verdict: CHANGES REQUIRED` or `Verdict: STUCK` first; Check (command, expected, observed, evidence); the sections Blockers and Major, Test strength, Unproven (3 at most) and On base (a written-rule break), each Test strength and On base finding marked `unit` if the unit's change introduced it or `base` if the base head shows it too, each finding with an id, file:line, failure, proof, repair and guard (`M3 repeat of r2 M1` for a new trigger); each command's exit code.",
  },
  "Then the batch's findings file: its verdict, the acceptance result, a row per unit (round, verdict, findings path), its On base.": {
    kind: 'reworded',
    now: "Then the batch's findings file: its verdict, the acceptance result, a row per unit (round, verdict, findings path), its On base (the findings marked `base`).",
  },
  '**Verdict.** A proven Blocker or Major is `changes`; a check that could not run or ran unclear is `stuck`, never `accepted`; else `accepted`.': {
    kind: 'moved',
    to: ['F2 verifier stuck', 'F2 verifier changes', 'F2 verifier accepted', 'F1 verifier unclear', 'REQUIRED verifier'],
  },
};
