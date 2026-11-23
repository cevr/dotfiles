# Commitment reasons

Every reason in the commitment record is data the plugin checks, never prose. A worker's `follow_up` names why the work waits: a dependency on an open commitment (its chain open and acyclic) or a measurement (a receipt envelope under `tmp/orchestrate/` in the checkout, read and hashed). The root's `commitments decide` closes only with a guarantee on an invariant the root declared from a committed document; `defer` keeps a commitment open with its reason; `reopen` clears the reason and keeps the history's. A reason the plugin cannot check is refused by name (a pointer kind not shipped yet, a commitment that is not open, a receipt it does not find, a caller's `validated: true`). `list` and `history` show each reason; an imported close reads `historical, unclassified`, a placeholder split into parts reads `placed in its parts`.

## Sub-features

- `follow-up-reason`: `follow_up` needs `reason_class` (`dependency` or `measured`) and `referent`; an idempotency `key` files once: a retry repeats its filing exactly; the same key saying something else, the same key on another id, or another key on a filed id is refused.
- `decide-guarantee`: `decide` is the root's, with `why` and `reason_class: "guarantee"` on a declared invariant; a measurement or a dependency never closes.
- `defer`: `defer` keeps an open commitment open with a dependency or a measurement; it closes nothing.
- `invariant`: `commitments invariant { id, doc_path, anchor }` declares an invariant bound to the document's blob at HEAD; the same again is nothing, an edited document takes a new id.
- `receipt-evidence`: a measured reason's receipt is a JSON envelope (`receipt`, `command`, `exit`, `output`, `run`, `checkout`) inside the checkout's evidence root, its realpath contained, its bytes and output hashed into the event. The root is configured (`<checkout top>/tmp/orchestrate`, the top canonical once), never discovered: a root that is itself a link, or sits under one, is refused; a link above the checkout (macOS `/var`) is fine.
- `close-kind`: each decided row has one close kind (guarantee, placed, historical; not-asked is unit C's), bound to its state in the schema.
- `reopen-history`: a reopen clears the row's reason; `history` keeps every event's.
- `no-echo`: refusals name declared fields or stray-key positions, never the caller's value. The store and outputs share one redactor: detect spans on the original text, widen to whole token runs, and replace each merged span once. Tool defects pass this boundary before the host can display them.

## How to get to it (user POV)

- A worker's `follow_up({ id, title, reason_class, referent, key? })`.
- The root's `commitments` tool: `{ "action": "decide", "id", "why", "reason_class": "guarantee", "referent": { "kind": "invariant", "id" } }`, `{ "action": "defer", "id", "reason_class", "referent" }`, `{ "action": "invariant", "id", "doc_path", "anchor" }`, `{ "action": "reopen", "id" }`, `{ "action": "list" }`, `{ "action": "history", "id" }`.
- In a shell: `bun cmd/orchestrate/record.ts <action> --json '<fields>'` (the same actions, on the repository's record file).

## Driving it with the world

- **Preconditions:** orchestrate loaded on a scratch record file; a root session and its child.
- **States:** default (a reason taken), refused (no reason, a kind not shipped, a closed or missing dependency, a receipt not found, a worker's decide, a measured close), open (a deferral), error `n/a` (the simulated host reads no files: receipts and declarations are refused there and proved on real files by `cmd/orchestrate/record-cli.test.ts`), loading and empty `n/a`.
- **World suites:** `cmd/orchestrate/commitments.sim.test.ts`, `cmd/orchestrate/record-model.sim.test.ts`, `cmd/orchestrate/canary.sim.test.ts`, `cmd/orchestrate/canary-follow-up.sim.test.ts`, `cmd/orchestrate/secrets.sim.test.ts`, `cmd/orchestrate/secrets-follow-up.sim.test.ts`
- **Code:** `mods/orchestrate/reasons.ts`, `mods/orchestrate/record.ts`, `mods/orchestrate/sqlite/`, `mods/orchestrate/commitments-tool.ts`, `cmd/orchestrate/record.ts`, `cmd/orchestrate/record-model.ts`, `cmd/orchestrate/record-subject.ts`

1. **No reason.** The child calls `follow_up` with `{ "id": "spare", "title": "Retain status" }`. The answer is an error naming the reason it needs; nothing is filed.
2. **A dependency.** The root adds `base`; the child calls `follow_up` with `{ "id": "f1", "title": "a missing test", "reason_class": "dependency", "referent": { "kind": "commitment", "id": "base" } }`. The answer reads `filed f1, unowned, waiting on dependency commitment/base`; `orchestrate status` lists `f1` unowned.
3. **Once by key.** The child files `f2` with `"key": "finding-1"` twice: the second answers `f2 is filed already by this key`; the same key on `f3` is refused. The same key on `f2` with another title, and another key on `f2`, are refused too.
4. **No close by prose.** The root calls `decide` with only `why`: refused, `decide needs reason_class`. A measured close, an undeclared invariant, a `spec-item` pointer and a self-dependency are each refused by name, and `list` shows the row open with no reason.
5. **Against the model.** `record-model.sim.test.ts` drives seeded runs of follow-ups, deferrals, declarations, decisions, reopens and restarts against the reference model, and enumerates caller × operation × state × reason class × pointer kind × existence; four reason mutants (`SUBJECT=accept-arbitrary-receipt`, `accept-measured-close`, `clear-historic-reason-on-reopen`, `accept-closed-dependency`) . **No secret printed.** A refusal names the field it refuses, never its value (`the owner is not one token of at most 120 characters; the value is not repeated`). Every answer, refusal and log line leaves through `mods/orchestrate/printable.ts`, which replaces each secret shape in the whole text and cuts nothing. `canary.sim.test.ts` and `canary-follow-up.sim.test.ts` put a token-shaped canary in every key and value. `secrets.sim.test.ts` and `secrets-follow-up.sim.test.ts` put a secret of every kind the redactor knows at any place in a value: after text of any length, glued to a word, twice, inside JSON or encoded. No answer, log line or record byte holds six characters of it.

## Driving it with real OpenCode

- **Real:** `cmd/orchestrate/record-cli.test.ts`, `cmd/orchestrate/printable.test.ts`, `cmd/orchestrate/overlap.test.ts`, `mods/orchestrate/sqlite/boundary.test.ts`, `mods/orchestrate/node/evidence.test.ts`

The CLI test runs `bun cmd/orchestrate/record.ts`'s `main` on a scratch git checkout and record file: no reason refused, an invariant declared from a committed document, a decide by guarantee, a measured close refused, a deferral and a follow-up by a receipt read from the evidence root, a missing receipt refused. `node/evidence.test.ts` runs the evidence reader on real files: a receipt or its output outside the evidence root, linked out of it, missing, of another shape (a `validated` key, prose), blank or too large is each refused; a document is found only in git at HEAD.

`overlap.test.ts` composes pairs and triples of token shapes at intersecting and adjacent offsets, checks CLI list, history and export against raw record bytes, and injects a throwing reader through the host's registered tools. `sqlite/boundary.test.ts` varies crossing tokens at every offset in each text field and searches the database, WAL and refusals for six-character fragments.

1. **Scratch root.** `bun run verify:seed $ROOT`, `bun run verify:launch --root $ROOT --port $PORT`, then `pilotty spawn --name verify-$PORT bun run verify:tui --root $ROOT`.
2. **Declare.** Type `verify: call commitments {"action":"invariant","id":"notes","doc_path":"notes.txt","anchor":"notes"}`, Enter. The answer reads `invariant notes declared: notes.txt#notes at <blob>`.
3. **Close by guarantee.** Type `verify: call commitments {"action":"add","source_kind":"plan-part","source_ref":"plan:1","parts":[{"id":"p1","title":"a part"}]}`, Enter; then `verify: call commitments {"action":"decide","id":"p1","why":"the notes hold it","reason_class":"guarantee","referent":{"kind":"invariant","id":"notes"}}`, Enter. `verify: call commitments {"action":"history","id":"p1"}` shows the decision with `guarantee invariant/notes`.
4. **Proof.** Snapshot after each step into `$EVIDENCE/commitment-reasons/`.

## Gotchas

- The world's host reads no files (its evidence reader is `noEvidence`): a receipt or a declaration there is refused, by design. Prove them on real files, never by a fake reader in the world.
- A receipt lives under the checkout's `tmp/orchestrate/`; one elsewhere, or reached through a symlink out of it, is refused. So is every receipt when `tmp/orchestrate` (or `tmp`) is itself a link.
- An unreadable stored reason (unit C's `ask/<id>` pointer, before C ships) fails the whole read with a named error, so a record written by a later unit is never misread.
