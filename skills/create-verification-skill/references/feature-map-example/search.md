# Search notes

A user finds notes by title or body text, opens a result, and can tell "no matches" apart from a search that is still running.

## Sub-features

- `search-open`: opens search from each entry point.
- `search-match`: returns title and body matches without changing any note.
- `search-open-result`: opens a result in the editor.
- `search-empty`: shows a complete empty state for a query with no matches.
- `search-clear`: clears the query and restores the recent notes.

## How to get to it (user POV)

- The `Search` button in the toolbar.
- `/` while focus is outside a text field.

## Driving it with agent-browser

- **Preconditions:** the baseline seed; no dialog open.
- **States:** default, focus-visible, open, loading, empty. Error is `n/a` (search is local).
- **Regression:** `e2e/search.test.ts`.

1. **Toolbar entry.** `ab find role button click --name "Search" --exact`. A dialog named `Search notes` opens with focus in its searchbox.
2. **Keyboard entry.** `ab press Escape`, then `ab press /`. The same dialog opens, and no `/` is typed into the page.
3. **Title match.** `ab find role searchbox fill "quarterly" --name "Search notes" --exact`. The `Search results` list holds `Quarterly plan` and not `Grocery list`.
4. **Body match.** Fill `budget` the same way. `Quarterly plan` stays, with a body excerpt.
5. **Open result.** `ab find role link click --name "Quarterly plan" --exact`. The dialog closes, and the URL ends `/notes/quarterly-plan`.
6. **Empty state.** Reopen search and fill `volcano`. A status `No matching notes` appears after the results settle.
7. **Clear.** `ab find role button click --name "Clear search" --exact`. The searchbox is empty and the `Recent notes` region is back.
8. **Proof.** `ab snapshot > $EVIDENCE/search/results.aria.txt` and `ab screenshot $EVIDENCE/search/results.png` at step 3. Both show the query and `Quarterly plan`.

## Gotchas

- `/` typed while the editor has focus inserts a slash instead of opening search.
- Results update after a debounce. Wait for the results list or the empty status, never a fixed sleep.
- Without `--exact`, the name `Search` also matches `Search notes` and `Clear search`.
