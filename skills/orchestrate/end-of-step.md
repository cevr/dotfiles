# How a step ends

Generated from `opencode/mods/orchestrate/round-policy.ts`, the one round policy: edit that, then run `scripts/agents.ts`. Each role's prompt carries its own block, as below; `decodeBlock` reads a delivered block back and `policyFaults` compares it with the source. A stop field with no value is left out, never written as a placeholder (`nothing`, `none`, `n/a`): the contract derives each value from the step's persisted history (each item's events, and the step's own: the limit passing, a refused write of its own file), so a placeholder is a value that differs from it.

## planner

**How your step ends** (round policy v1). It stops the moment a refusal comes (the Refusals paragraph) or the round's limit passes; else it goes on until no runnable item is left. Each item takes one row of the first table, and that row alone gives its state, its rule and its label, whatever stopped the step; the last row takes every item no row above it took. The states present give your verdict and what you write (second table), and why the step stopped gives the evidence fields of the third. Effort is no state and no label. Assigned work is the spec items; whatever else you find is not assigned. Your required work: every section of the spec filled, and its acceptance check runnable and recorded red. You never implement, so the product behavior its Done line names stays unbuilt and is no item left.

Each item's hand-back gives its rule, its label and each of these fields its record holds, with the exact values recorded; a field the record lacks is left out, never filled in or asserted, and a label wins only the presentation, never dropping another field: `completed`: the last attempt that finished: its id, the command it ran, its output's digest, its exit code, its receipt, the head it ran at and its result; `current`: an attempt newer than that, with no result: its id, its command, its status (started, interrupted or denied) and its partial output's digest or why it has none; `refused`: what was refused, as the refusal said it, its scope, where its safe report is, and the `!` command or allow rule it printed, or none; `cannot`: the check or tool, with the probe that found it absent: its command and output; `waits`: the id it waits on.

Take the first row that is true of the item; stop there.

| # | Rule | State | An item that is | Its label |
| --- | --- | --- | --- | --- |
| 1 | `discovery` | a discovery | not assigned | `finding outside the unit`, under Follow-ups in your file |
| 2 | `refused` | refused | a refusal stopped it (or your own file's write: then your final message gives it after the verdict line) | `refused: <what>`, adding `; form: <the form it named>` only when the refusal named one: this unit's work, never a follow-up, never tried another way |
| 3 | `cannot` | cannot run | this host cannot run it (its check or tool is absent or will not start) | `cannot run here: <check or tool>`, with its command and output |
| 4 | `waits` | waiting | waits on an open unit, question, commitment or two contradicting spec lines | `waits on <id>` |
| 5 | `done` | done | its acceptance holds | none: it is no item left |
| 6 | `runnable` | runnable | otherwise | `continues next round`: this unit's work, in its next round (or its rewrite after the failure cap); never a follow-up |

Take the first row that holds for the step; stop there.

| # | Rule | Verdict | When | You write |
| --- | --- | --- | --- | --- |
| 1 | `ready` | `ready` | every item is done or a discovery | `<unit dir>/spec.md` |
| 2 | `blocked` | `blocked` | otherwise | `<unit dir>/state.md` current (even with no commit since) and `<unit dir>/blocked.md`: the stop's evidence, and each item left with its label |

Why the step stopped gives the evidence fields you write:

| Stop | Field | Its evidence | How many |
| --- | --- | --- | --- |
| a refusal named an accepted form | `refused.what` | what was refused, as the refusal said it | one |
| a refusal named an accepted form | `refused.form` | the `!` command it printed | one if printed, else none |
| a refusal named an accepted form | `refused.allow` | the allow rule it printed | one if printed, else none |
| a refusal named no accepted form | `refused.what` | what was refused, as the refusal said it | one |
| the round's limit passed | `limit` | `timebox <its length>` or `failure cap <its count>` | one |
| no runnable item is left | `held` | `<command> (exit <code>)` of its last run, else its label | one per item waiting or cannot run, naming it, else none |

## implementor

**How your step ends** (round policy v1). It stops the moment a refusal comes (the Refusals paragraph) or the round's limit passes; else it goes on until no runnable item is left. Each item takes one row of the first table, and that row alone gives its state, its rule and its label, whatever stopped the step; the last row takes every item no row above it took. The states present give your verdict and what you write (second table), and why the step stopped gives the evidence fields of the third. Effort is no state and no label. Assigned work is the spec items; whatever else you find is not assigned. Your required work: every item of the spec, built, gated and requested.

Each item's hand-back gives its rule, its label and each of these fields its record holds, with the exact values recorded; a field the record lacks is left out, never filled in or asserted, and a label wins only the presentation, never dropping another field: `completed`: the last attempt that finished: its id, the command it ran, its output's digest, its exit code, its receipt, the head it ran at and its result; `current`: an attempt newer than that, with no result: its id, its command, its status (started, interrupted or denied) and its partial output's digest or why it has none; `refused`: what was refused, as the refusal said it, its scope, where its safe report is, and the `!` command or allow rule it printed, or none; `cannot`: the check or tool, with the probe that found it absent: its command and output; `waits`: the id it waits on.

Take the first row that is true of the item; stop there.

| # | Rule | State | An item that is | Its label |
| --- | --- | --- | --- | --- |
| 1 | `discovery` | a discovery | not assigned | `finding outside the unit`, in `state.md` under Follow-ups |
| 2 | `refused` | refused | a refusal stopped it (or your own file's write: then your final message gives it after the verdict line) | `refused: <what>`, adding `; form: <the form it named>` only when the refusal named one: this unit's work, never a follow-up, never tried another way |
| 3 | `cannot` | cannot run | this host cannot run it (its check or tool is absent or will not start) | `cannot run here: <check or tool>`, with its command and output |
| 4 | `waits` | waiting | waits on an open unit, question, commitment or two contradicting spec lines | `waits on <id>` |
| 5 | `done` | done | its acceptance holds | none: it is no item left |
| 6 | `runnable` | runnable | otherwise | `continues next round`: this unit's work, in its next round (or its rewrite after the failure cap); never a follow-up |

Take the first row that holds for the step; stop there.

| # | Rule | Verdict | When | You write |
| --- | --- | --- | --- | --- |
| 1 | `ready` | `ready` | every item is done or a discovery | `<unit dir>/round-N-request.md`, committed, once `request.ts` exits 0 |
| 2 | `blocked` | `blocked` | otherwise | `<unit dir>/state.md` current (even with no commit since) and `<unit dir>/blocked.md`: the stop's evidence, and each item left with its label |

Why the step stopped gives the evidence fields you write:

| Stop | Field | Its evidence | How many |
| --- | --- | --- | --- |
| a refusal named an accepted form | `refused.what` | what was refused, as the refusal said it | one |
| a refusal named an accepted form | `refused.form` | the `!` command it printed | one if printed, else none |
| a refusal named an accepted form | `refused.allow` | the allow rule it printed | one if printed, else none |
| a refusal named no accepted form | `refused.what` | what was refused, as the refusal said it | one |
| the round's limit passed | `limit` | `timebox <its length>` or `failure cap <its count>` | one |
| no runnable item is left | `held` | `<command> (exit <code>)` of its last run, else its label | one per item waiting or cannot run, naming it, else none |

## verifier

**How your step ends** (round policy v1). It stops the moment a refusal comes (the Refusals paragraph); else it goes on until no runnable item is left. Each item takes one row of the first table, and that row alone gives its state, its rule and its label, whatever stopped the step; the last row takes every item no row above it took. The states present give your verdict and what you write (second table; an optional probe is only ever done, proven, refused or unproven, and unproven never changes it), and why the step stopped gives the evidence fields of the third. Effort is no state and no label. Assigned work is the checks of step 1, which are required, and the wider probes you run, which are optional; whatever else you find is not assigned. Your required work: every check of step 1 ran to a result that settles pass or fail, for every unit; a check of step 1 that could not run or ran unclear is `stuck`, never `accepted`, and a wider probe this host cannot run goes under Unproven and does not stop `accepted`. Before any unit, a `Heads: dotfiles=<sha> fork=<sha>` line must name your head and its fork commit (`git rev-parse`), else the batch is `stuck`. The batch: `stuck` on a wrong heads line, else `accepted` if every unit is, `changes` if any is, else `stuck`.

Each item's hand-back gives its rule, its label and each of these fields its record holds, with the exact values recorded; a field the record lacks is left out, never filled in or asserted, and a label wins only the presentation, never dropping another field: `completed`: the last attempt that finished: its id, the command it ran, its output's digest, its exit code, its receipt, the head it ran at and its result; `current`: an attempt newer than that, with no result: its id, its command, its status (started, interrupted or denied) and its partial output's digest or why it has none; `refused`: what was refused, as the refusal said it, its scope, where its safe report is, and the `!` command or allow rule it printed, or none; `cannot`: the check or tool, with the probe that found it absent: its command and output; `waits`: the id it waits on.

Take the first row that is true of the item; stop there.

| # | Rule | State | An item that is | Its label |
| --- | --- | --- | --- | --- |
| 1 | `unitFinding` | a unit finding | not assigned, the unit's change introduced it, shown by measured attribution (whether or not a spec item names it) | marked `unit`: the same lane closes it in its next round |
| 2 | `baseFinding` | a base finding | not assigned, shown on the base head too | marked `base`: a follow-up unit |
| 3 | `refused` | refused | a refusal stopped it (or your own file's write: then your final message gives it after the verdict line) | `refused: <what>`, adding `; form: <the form it named>` only when the refusal named one: never tried another way |
| 4 | `cannot` | cannot run | required, this host cannot run it (its check or tool is absent or will not start) | `cannot run here: <check or tool>`, with its command and output |
| 5 | `waits` | waiting | required, waits on an open unit, question, commitment or two contradicting spec lines | `waits on <id>` |
| 6 | `proven` | proven | ran and proves a Blocker or Major | a Blocker or Major, filed with its proof |
| 7 | `done` | done | ran and passed | none: it is no item left |
| 8 | `unclear` | ran unclear | required, ran, with a result that settles neither pass nor fail, no retry can settle it here | `ran unclear: <check>`, with its command and the output that settles nothing |
| 9 | `unproven` | unproven | optional (a wider probe) | `unproven: <probe>`, under Unproven with the probe that would settle it; it never changes the verdict |
| 10 | `retry` | runnable | required, attempted (it ran at least once), can still advance in this lane | `retry: <check>`, named under Check; it continues to a result |
| 11 | `notRun` | runnable | otherwise | `not run`, named under Check |

Take the first row that holds for the step; stop there.

| # | Rule | Verdict | When | You write |
| --- | --- | --- | --- | --- |
| 1 | `stuck` | `stuck` | any item is runnable, waiting, refused, cannot run or ran unclear | each unit's `round-N-findings.md` and the batch's findings file: under Check, and the stop's evidence, and each item left with its label |
| 2 | `changes` | `changes` | any item is proven | each unit's `round-N-findings.md` and the batch's findings file: under Check, and the stop's evidence, and each item left with its label |
| 3 | `accepted` | `accepted` | otherwise | each unit's `round-N-findings.md` and the batch's findings file: under Check, and the stop's evidence, and each item left with its label |

Why the step stopped gives the evidence fields you write:

| Stop | Field | Its evidence | How many |
| --- | --- | --- | --- |
| a refusal named an accepted form | `refused.what` | what was refused, as the refusal said it | one |
| a refusal named an accepted form | `refused.form` | the `!` command it printed | one if printed, else none |
| a refusal named an accepted form | `refused.allow` | the allow rule it printed | one if printed, else none |
| a refusal named no accepted form | `refused.what` | what was refused, as the refusal said it | one |
| no runnable item is left | `held` | `<command> (exit <code>)` of its last run, else its label | one per item waiting, cannot run or ran unclear, naming it, else none |

## worker

**How your step ends** (round policy v1). It stops the moment a refusal comes; else it goes on until no runnable item is left. Each item takes one row of the first table, and that row alone gives its state, its rule and its label, whatever stopped the step; the last row takes every item no row above it took. The states present give your verdict and what you write (second table), and why the step stopped gives the evidence fields of the third. Effort is no state and no label. Assigned work is the task in your first message; whatever else you find is not assigned. Your required work: the task in your first message.

Each item's hand-back gives its rule, its label and each of these fields its record holds, with the exact values recorded; a field the record lacks is left out, never filled in or asserted, and a label wins only the presentation, never dropping another field: `completed`: the last attempt that finished: its id, the command it ran, its output's digest, its exit code, its receipt, the head it ran at and its result; `current`: an attempt newer than that, with no result: its id, its command, its status (started, interrupted or denied) and its partial output's digest or why it has none; `refused`: what was refused, as the refusal said it, its scope, where its safe report is, and the `!` command or allow rule it printed, or none; `cannot`: the check or tool, with the probe that found it absent: its command and output; `waits`: the id it waits on.

Take the first row that is true of the item; stop there.

| # | Rule | State | An item that is | Its label |
| --- | --- | --- | --- | --- |
| 1 | `discovery` | a discovery | not assigned | `outside the task`, named in your result |
| 2 | `refused` | refused | a refusal stopped it (or your own file's write: then your final message gives it after the verdict line) | `refused: <what>`, adding `; form: <the form it named>` only when the refusal named one: never tried another way |
| 3 | `cannot` | cannot run | this host cannot run it (its check or tool is absent or will not start) | `cannot run here: <check or tool>`, with its command and output |
| 4 | `waits` | waiting | waits on an open unit, question, commitment or two contradicting spec lines | `waits on <id>` |
| 5 | `done` | done | its acceptance holds | none: it is no item left |
| 6 | `runnable` | runnable | otherwise | `left`, named in your result |

Take the first row that holds for the step; stop there.

| # | Rule | Verdict | When | You write |
| --- | --- | --- | --- | --- |
| 1 | `none` | no verdict word | always | your result as text: the stop's evidence, and each item left with its label |

Why the step stopped gives the evidence fields you write:

| Stop | Field | Its evidence | How many |
| --- | --- | --- | --- |
| a refusal named an accepted form | `refused.what` | what was refused, as the refusal said it | one |
| a refusal named an accepted form | `refused.form` | the `!` command it printed | one if printed, else none |
| a refusal named an accepted form | `refused.allow` | the allow rule it printed | one if printed, else none |
| a refusal named no accepted form | `refused.what` | what was refused, as the refusal said it | one |
| no runnable item is left | `held` | `<command> (exit <code>)` of its last run, else its label | one per item waiting or cannot run, naming it, else none |
