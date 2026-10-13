# Notes verification map

The maintained source for verifying what a Notes user can do. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline

- `bun run verify:seed $DIR` makes a scratch data dir with the notes `Quarterly plan` (body `Draft budget`) and `Grocery list`.
- `bun run verify:launch --root $DIR --port $PORT` serves Notes on `http://127.0.0.1:$PORT`. Never port 4173, the owner's own instance.
- `bun run verify:doctor --port $PORT` passes before the first drive.
- Every browser command runs as `agent-browser --session $RUN --args "--mute-audio,--disable-audio-output" …`; recipes below write it as `ab`.

## Proof and skip reporting

- Each step records the action, the URL after it, `ab snapshot` and `ab screenshot` into `$EVIDENCE/<feature>/`.
- A write is proved by a second view: reopen the note from the list.
- An unreachable entry point is reported with the command tried and the unmet precondition. It never counts as verified through another path.

## Entry contract

Each feature file has an H1, one paragraph of user-visible behavior, then exactly these H2s in order:

1. `Sub-features`: short ids, one line each.
2. `How to get to it (user POV)`: every entry point a user has.
3. `Driving it with agent-browser`: starts with three lines, then labeled steps that pair a user action, an exact command and the observable result.
   - **Preconditions:** the state the steps need beyond the baseline.
   - **States:** which of default, focus-visible, open, loading, empty and error the steps exercise; mark the rest `n/a`.
   - **Regression:** the automated tests that cover the feature.
4. `Gotchas`: traps that waste or invalidate a run.

Name user paths, stable handles, commands and observable results. Keep source seams out.

## Features

- [Search notes](search.md): toolbar and keyboard search, title and body matches, the empty state, clearing.
