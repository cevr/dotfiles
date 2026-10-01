# Architecture loop — <date>

Goal: <the run's goal, in the user's words>

## Baseline

- HEAD: `<hash>`
- Count: `<the git ls-files pathspec command every pass uses>`

| Package | Lines | Files |
| ------- | ----- | ----- |

## Coverage

| Directory | Files | Mark (swept-before / unswept) | Pass |
| --------- | ----- | ----------------------------- | ---- |

## Prior art

| Idea | Source (slug, path) | North star | Verdict (adopt / rejected: reason) |
| ---- | ------------------- | ---------- | ---------------------------------- |

## Project passes

One row per pass per loop pass, as `NORTH_STAR.md` → Passes defines it (a measurement, a matrix row, a baseline).

| Pass | Loop pass | Result | Done when met? |
| ---- | --------- | ------ | -------------- |

## Owner questions

| Question | Raised (pass) | North stars or rule involved | Answer |
| -------- | ------------- | ---------------------------- | ------ |

## Pass <N>

Reports: `~/.cache/architecture-loop/<repo>/pass<N>/`

Verdict: <one line>

Triage:

| Batch | Workspace | Items |
| ----- | --------- | ----- |

Findings:

| ID  | Candidate | North star | Files | Lines removed | Risk | Status (`done <hash>` / `rejected: <receipt>`, decided by <principle>) |
| --- | --------- | ---------- | ----- | ------------- | ---- | ------------------------------------------------------------------------ |

Guardrails added:

| Defect class | Check (lint rule / upstream rule / type / test / CI step) | Red on | Hash |
| ------------ | -------------------------------------------------------- | ------ | ---- |

Carried: each decision a batch handed to files it did not own, open until a batch takes it. The next sweep brief copies the open rows.

| Decision | From (batch) | Files | Status (`open` / `done <hash>` / `rejected: <receipt>`) |
| -------- | ------------ | ----- | ------------------------------------------------------- |

Counsel defects:

| ID  | Defect | Red test | Status |
| --- | ------ | -------- | ------ |

Merges: `<batch>: done <hash> … <hash>, merged <hash>, GATE EXIT 0`

Live check: `<what was driven, and what the state view showed>`

## Close

- Unswept directories: `<none>`
- Largest sweep finding: `<lines of value>`
- Project passes: `<each meets its done when>`
- To survey: `<empty>`
- Open Carried rows: `<none>`
- Structural change named by the loop reader: `<none>`
