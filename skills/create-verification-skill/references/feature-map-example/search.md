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

## Driving it with browse

- **Preconditions:** the baseline seed; no dialog open.
- **States:** default, focus-visible, open, loading, empty. Error is `n/a` (search is local).
- **Regression:** `e2e/search.test.ts`.

1. **Toolbar entry.** `await page.getByRole("button", { name: "Search", exact: true }).click()`. A dialog named `Search notes` opens with focus in its searchbox.
2. **Keyboard entry.** `await page.keyboard.press("Escape"); await page.keyboard.press("/")`. The same dialog opens, and no `/` is typed into the page.
3. **Title match.** `await page.getByRole("searchbox", { name: "Search notes", exact: true }).fill("quarterly")`. The `Search results` list holds `Quarterly plan` and not `Grocery list`.
4. **Body match.** Fill `budget` the same way. `Quarterly plan` stays, with a body excerpt.
5. **Open result.** `await page.getByRole("link", { name: "Quarterly plan", exact: true }).click()`. The dialog closes, and the URL ends `/notes/quarterly-plan`.
6. **Empty state.** Reopen search and fill `volcano`. A status `No matching notes` appears after the results settle.
7. **Clear.** `await page.getByRole("button", { name: "Clear search", exact: true }).click()`. The searchbox is empty and the `Recent notes` region is back.
8. **Proof.** At step 3, in the same execute: `await files.write("$EVIDENCE/search/results.aria.txt", String(await snapshot()))` and `await page.screenshot({ path: "$EVIDENCE/search/results.png" })`. Both show the query and `Quarterly plan`.

## Gotchas

- `/` typed while the editor has focus inserts a slash instead of opening search.
- Results update after a debounce. Wait for the results list or the empty status (`locator.waitFor()`), never a fixed sleep.
- Without `exact: true`, the name `Search` also matches `Search notes` and `Clear search`.
