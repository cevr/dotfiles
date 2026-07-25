# Teachings — The Universal Format

One format for every teaching document: sermon messages, topical studies,
chapter readings (e.g. Bible Readings regenerations), and structural analyses.
The old per-type formats are gone; what a document is *for* is a frontmatter
tag (`kind`), never a change in shape. Organization is **by topic**, not by
type.

## When to use

Any request for preaching/teaching content that isn't a Sabbath School weekly
outline (→ `references/sabbath-school.md`, which shares this voice but keeps
its PDF-driven weekly mechanics).

## The two-phase workflow

**Phase 1 — Gather the cloud of witnesses.** Before writing a word:

1. Pull every Bible passage via `bible verse "<ref>" --json` — the source
   verses (if regenerating from a source reading, **all** of them) plus the
   cross-references you intend to chain.
2. Gather EGW + pioneer testimony on each movement of the argument:
   `bible egw search` → `bible egw lookup` → quote `paragraphs[].text`
   verbatim with refcode. Pioneer voices (Miller, Uriah Smith, Andrews,
   James White, Jones, …) cited by name.
3. For large documents, fan the gathering out (one gatherer per theme);
   never write from memory.

Full command surface: `references/source-material.md`. Hermeneutic: the
"Hermeneutic & Sources" section of `SKILL.md` — Miller's 14 Rules, literal
historicism, **historic pioneer Adventism, not modern Adventism**.

**Phase 2 — Write.** The witnesses are on the desk; now build the document
per the format below.

## Voice — Teacher at the Whiteboard

- **Scannable above all.** The reader is preaching/teaching from this page.
  A glance at any line must yield the next point.
- **Telegraphic**: noun phrases, fragments, `keyword: explanation`. Max 1–2
  short sentences per bullet.
- **No prose paragraphs.** Ever. If a thought needs development, it becomes
  bullets, a marker line, or a `[→]` connection.
- **Points and connections** — the value is the links the reader may not have
  made: Scripture chained to Scripture, type to antitype, witness to text.
- **Bible-centered**: every doctrinal claim carries a quoted verse inline.
- **Practical**: each document lands on the reader's feet — what changes on
  Monday morning.

## Structure

```markdown
---
created_at: '2026-07-25T14:00:00Z'
topic: great-controversy
title: 'Origin, History, and Destiny of Satan'
kind: reading            # reading | study | message | analysis — a tag, not a format
series: bible-readings    # optional
chapter: 102              # optional
---

# [Title]

**[Thesis — 2-4 bold sentences. The whole argument compressed. A reader who
sees only this paragraph still carries the burden of the document away.]**

---

## [Topic Section]

- **key term** — telegraphic point
  - "inline KJV text" (Book X:Y)
  - supporting detail / second witness verse
- [→] the connection: why this section hands off to the next

[SOP] "Verbatim EGW sentence(s) — the punchline, not the page." — GC 492.2

[PIONEER: U. Smith] "Verbatim pioneer sentence(s)." — DAR 552.1

[DYK🔎] fact / word study / historical context (1-2 lines)

[Q] **anticipated objection**
→ concise answer with scripture

[ILL] simple parable, Christ's method — vivid, familiar, brief

[TANGENT] optional Spirit-led deep-dive: chain of refs the teacher can take live

---

## [Next Topic Section]

...

---

## Appeal

- the burden pressed home — decision language
- **"closing scripture"** (Book X:Y)
```

### Optional: Acts

Long documents (full chapter regenerations, multi-movement arguments) may
group sections under `# Act I — [Name]` … headers to give the argument a
narrative spine. Short pieces skip this.

### Structural devices

Chiasms, parallel tables, timelines belong **inside** the document wherever
they serve — a table or fenced block under the relevant section (often as a
`[TANGENT]`). Structural analysis is a device of every teaching, not a
separate output type.

## Markers

| Marker            | Use                                                          |
| ----------------- | ------------------------------------------------------------ |
| `[→]`             | Transition / the connection between points                   |
| `[SOP]`           | Ellen G. White witness — verbatim quote `— REFCODE`          |
| `[PIONEER: name]` | Pioneer witness (Miller, Smith, Andrews, …) — verbatim quote |
| `[DYK🔎]`         | Word study, historical fact, context                         |
| `[Q]`             | Anticipated question → concise answer with scripture         |
| `[ILL]`           | Illustration, Christ's parable method                        |
| `[TANGENT]`       | Optional deep-dive branch                                    |

Witness rules:

- **Isaiah 8:20 order** — Scripture establishes; `[SOP]`/`[PIONEER]` confirm.
  Never let a witness carry a point no verse has made.
- Quote the **punchline**, verbatim, from `bible egw lookup` output — never
  from memory, never paraphrased. Refcode always attached; pioneer named.
- Every major movement of the document should carry at least one witness;
  don't stack three where one lands.

## Scripture rules

- **Regenerating from a source reading** → every verse in the source appears
  in the output. No skipping, no summarizing.
- Quote inline: `"verse text" (Book X:Y)` — KJV. The reader never flips.
- 1–3 quotations per bullet cluster; 5+ verses per section; the document
  reads as a Bible tour, not commentary.
- Chain OT ↔ NT; multiple witnesses (2-3 verses) for load-bearing points.
- Strong's / Greek is auxiliary confirmation only — a point that *needs* the
  Greek isn't established yet.

## Output location

```
outputs/teachings/<topic-slug>/<slug>.md
```

Topic slugs are kebab-case doctrinal topics (`great-controversy`,
`sanctuary`, `law-and-gospel`, `second-coming`, `state-of-the-dead`, …).
Reuse an existing topic dir before minting a new one (`ls outputs/teachings`).

Legacy files in `outputs/{messages,studies,readings,analyses}/` stay where
they are (the Sure Word site reads `outputs/studies/`; note IDs are live).
New and regenerated documents go in the teachings tree.

## Export — folder per topic

```bash
bible export -f outputs/teachings/great-controversy/<slug>.md --folder "Great Controversy"
```

Folder = the topic, Title-Cased. A regenerated legacy document keeps its
`apple_note_id` — `bible sync -f <file>` then updates the existing note in
place (it stays in whatever Notes folder it already lives in).

## Updates

```bash
# edit file in place, then:
bible sync -f outputs/teachings/<topic>/<slug>.md
```

## Anti-patterns

- **Don't write before gathering** — Phase 1 is not optional; the cloud of
  witnesses is collected before composition starts.
- **Don't write prose paragraphs** — the thesis block is the only multi-
  sentence run in the document.
- **Don't paraphrase Scripture, EGW, or pioneers** — pull, then quote.
- **Don't let SOP outrank Scripture** — witnesses confirm (Isa 8:20).
- **Don't soften the historicist / pioneer position** — historic Adventism is
  the voice; factual and citation fixes only, never tone softening.
- **Don't spiritualize the plain text** — literal unless the text marks a
  figure; figures interpreted by the Bible's own usage (Miller's Rules 6-12).
- **Don't drop source verses** in a regeneration.
- **Don't organize by output type** — topic dirs, topic folders, `kind` is
  only a tag.
