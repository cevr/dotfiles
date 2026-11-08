# Memory: design note

The owner asked for a simple, SQLite-based memory plugin, after reading
Anthropic's [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory)
(Nov 2026) and [VictorTaelin/OptMem](https://github.com/VictorTaelin/OptMem)
(read at `1fb164c`). This note says what v1 took from each and what it left out.
The rules are in the README's Memory section.

## What v1 is

- One SQLite file per host, `notes` with an FTS5 index over text and tags,
  and `digests`, the block each session started with.
- Three tools: `memory_save` (with repeat detection and correction by id),
  `memory_search`, `memory_forget`.
- A digest at the start of every session, bounded (30 notes, 4,000
  characters of lines) and fixed for the session.
- A CLI for a reviewer, which the weekly dream uses to audit and repair the
  notes on each host.

## From Anthropic's post

- **The hierarchy.** Transcripts → notes → representations → injected
  context. v1 builds two layers: notes (the agent writes them) and injected
  context (the digest). Transcripts are already a searchable log in
  OpenCode's database; v1 does not copy them.
- **Tell the model what memory is for, not how to use it.** Fixed rules
  ("record only failures") cost the stronger models much of their gain. The
  tool descriptions say what is worth keeping (what the agent could not read
  off the code or screen and a later session would want) and leave salience to
  the model, with a short list of what not to save (task state, plans, what the
  repository already says, secrets), the Pokémon contrast between 413 files
  and 9.
- **Keep the injected layer small.** Injected tokens are paid every request,
  a wrong note travels into every session, and long instruction files are
  followed less. The digest is bounded by a count and by characters, and
  points to `memory_search` for the rest, like Claude Code's 200-line
  `MEMORY.md` index.
- **Dreaming corrects and prunes.** v1 has no background consolidation. The
  weekly `dream` skill does it with the CLI instead: on each host it merges
  near repeats, corrects notes the week's sessions contradict, prunes stale
  ones and adds the owner's repeated corrections no note holds, recording what
  changed so the next dream can check whether it helped. It runs where the
  owner already reviews the week, not on every turn, and spends no extra model
  calls.

## From OptMem

OptMem's core idea: memory as an append-only log of one-line notes (at most
280 bytes), with a binary tree of summaries over it. `memo wake` prints a
fixed budget of lines in which recent notes stay verbatim and older ones
collapse into coarser summaries ("detail decays with age"); the agent itself
writes the summaries in-band (`memo nap`), never in the background.

- **One line per note, with a hard limit.** Taken: 400 characters, one line
  (whitespace folded), so a note is one fact and the digest stays readable.
- **A reading budget, not a storage budget.** Taken: the store keeps every
  note; only the digest is bounded, and its bounds are options that can change
  at any time without recomputing anything.
- **Recency decides detail.** Taken as the rank: a note loses half its weight
  every 60 days since it was last updated, and gains with use.
- **Subagents do not write.** Taken: a subagent cannot judge what is already
  known, so its notes would repeat. It searches, and its refusal tells it to
  put the fact in its answer.
- **Left out: the summary tree and `nap`.** Summaries need model calls, either
  in-band (they cost the agent's attention mid-task, which the Anthropic post
  names as the price of writing memory in the moment) or in the background
  (out of scope). Without them, an old note is either in the digest or found
  by search. If the store grows past what the digest and search serve, the
  tree is the first thing to try.
- **Left out: append-only and never edit.** Notes here are corrected in place
  (`memory_save` with an id, the CLI's `edit` and `merge`), since a wrong note
  in the digest misleads every session until it changes.

## Other choices

- **Scope by OpenCode's project id**, not the directory: every clone, worktree
  and Rift of one repository shares it, so a convention learned in one Rift
  holds in the next. Each note also keeps the directory it was saved in
  (`place`), for the CLI's `projects`.
- **Repeats** are notes of one bucket whose words are at least 60% the same
  (Jaccard), found among the bucket's top FTS matches. The new text replaces
  the old (the newer wording is usually the fuller one). Pairs from 40% are
  only listed by `stats`, for a reviewer.
- **Two counters.** `uses` (searches, repeated saves) ranks the digest;
  `shown` (digests) never does, so the injected notes cannot keep themselves
  in place. `used` is the last time either happened, which `stats` turns into
  idle days.
- **The digest is fixed per session** and kept in the file (pruned after 30
  days), so every request of a session, across a server restart too, carries
  the same system prompt and the provider's cache holds. It goes last in the
  system prompt, so nothing before it moves.
- **No sync** between the Mac and the workbox in v1: each host has its own
  file, and the dream audits each.
