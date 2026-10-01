---
name: improve-codebase-architecture
description: Scan a codebase for deepening opportunities against its north stars and prior arts, present them as a visual HTML report, then grill through whichever one you pick.
disable-model-invocation: true
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities**: refactors that turn shallow modules into deep ones. The aim is testability and AI-navigability, judged against what this project says good is. This is one pass with the user in the loop; `architecture-loop` runs the same lens autonomously, pass after pass, until it finds polish only.

The lens has four sources:

- Call the Skill tool with "codebase-design" for the architecture vocabulary (**module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**) and its principles (the deletion test, "the interface is the test surface", "one adapter = hypothetical seam, two = real"). Use these terms exactly in every suggestion, and don't drift into "component," "service," "API," or "boundary."
- `NORTH_STAR.md` at the repo root: the north stars every candidate serves, the tiebreaks between them, the owner rules no candidate goes against, and the rejected candidates not to re-suggest. Format: [NORTH-STAR-FORMAT.md](NORTH-STAR-FORMAT.md).
- `PRIOR_ARTS.md` at the repo root: the codebases to compare against and the comparisons already settled. Format: [PRIOR-ARTS-FORMAT.md](PRIOR-ARTS-FORMAT.md).
- The domain language in `CONTEXT.md` gives names to good seams; ADRs in `docs/adr/` record decisions this command should not re-litigate.

## Process

### 1. Explore

**Scope before you scan: YAGNI.** Deepening a module pays off by making future changes to it easier, so put extra weight on the parts of the codebase that have recently changed. Decide *where* to look before you look:

- If the user named a direction (a module, a subsystem, a pain point), take it, and skip the inference below.
- Otherwise, walk back a good stretch of the commit history (`git log --oneline`) to find the codebase's hot spots, the files and areas that keep coming up, and let those paths pull your attention first. If the changes are scattered with no clear hot spot, widen the net.

Read `NORTH_STAR.md`, `PRIOR_ARTS.md`, `CONTEXT.md` and any ADRs in the area you're touching first. A north star, prior art or owner direction the user names in the prompt counts as if written there; step 4 writes it down.

Then spawn sub-agents in one message: one to walk the codebase, and one per prior art in `PRIOR_ARTS.md` whose "Compare with" paths overlap the scope, reading the paths in "Read it for" and skipping what "Settled" already answers. The codebase walker doesn't follow rigid heuristics; it explores organically and notes where it experiences friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow**, with an interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are untested, or hard to test through their current interface?
- Where does the code break a north star, by its own "breaks when" column?

Apply the **deletion test** to anything you suspect is shallow: would deleting it concentrate complexity, or just move it? A "yes, concentrates" is the signal you want. A prior-art agent reports where the other codebase carries the same behavior with fewer concepts, and the seam it put there.

### 2. Present candidates as an HTML report

Write a self-contained HTML file to the OS temp directory so nothing lands in the repo. Resolve the temp dir from `$TMPDIR`, falling back to `/tmp`, and write to `<tmpdir>/architecture-review-<timestamp>.html` so each run gets a fresh file. When Sideshow answers (`curl -sf -m 2 http://localhost:8228`), publish the report there as an html post; otherwise open it (`open` on macOS, `xdg-open` on Linux). Tell the user the absolute path either way.

The report uses **Tailwind via CDN** for layout and styling, and **Mermaid via CDN** for diagrams where a graph/flow/sequence reliably communicates the structure. Mix Mermaid with hand-crafted CSS/SVG visuals: use Mermaid when relationships are graph-shaped (call graphs, dependencies, sequences), and hand-built divs/SVG when you want something more editorial (mass diagrams, cross-sections, collapse animations). Each candidate gets a **before/after visualisation**. Be visual.

For each candidate, render a card with:

- **Files**: which files/modules are involved
- **Problem**: why the current architecture is causing friction
- **Solution**: plain English description of what would change
- **North star**: the one it serves, by its name in `NORTH_STAR.md`
- **Prior art**: the codebase and path that already has this shape, when one does
- **Benefits**: explained in terms of locality and leverage, and how tests would improve
- **Before / After diagram**: side-by-side, custom-drawn, illustrating the shallowness and the deepening
- **Recommendation strength**: one of `Strong`, `Worth exploring`, `Speculative`, rendered as a badge

End the report with a **Top recommendation** section: which candidate you'd tackle first and why.

**Use CONTEXT.md vocabulary for the domain, and the `/codebase-design` vocabulary for the architecture.** If `CONTEXT.md` defines "Order," talk about "the Order intake module," not "the FooBarHandler," and not "the Order service."

**Conflicts with settled decisions**: a candidate that trades one north star for another, contradicts an ADR, or reopens a row of `NORTH_STAR.md`'s Rejected table is surfaced only when the friction is real enough to warrant revisiting, and its card carries a warning callout (e.g. _"reopens Rejected: fold the cell trio, because…"_). A candidate against an owner rule is never listed. Don't list every theoretical refactor a settled decision forbids.

See [HTML-REPORT.md](HTML-REPORT.md) for the full HTML scaffold, diagram patterns, and styling guidance.

The report stops at the problem and the direction; interfaces take shape in the grilling loop. After the report is up, ask the user: "Which of these would you like to explore?"

### 3. Grilling loop

Once the user picks a candidate, call the Skill tool with "grilling" to walk the decision tree with them: constraints, dependencies, the shape of the deepened module, what sits behind the seam, what tests survive, which north star it serves and which it strains.

Side effects happen inline as decisions crystallize; call the Skill tool with "domain-modeling" to keep the domain model current as you go:

- **Naming a deepened module after a concept not in `CONTEXT.md`?** Add the term to `CONTEXT.md`. Create the file lazily if it doesn't exist.
- **Sharpening a fuzzy term during the conversation?** Update `CONTEXT.md` right there.
- **User rejects the candidate with a load-bearing reason?** Add a row to `NORTH_STAR.md`'s Rejected table, so future reviews and loops don't re-suggest it. A reason that needs more than a line becomes an ADR, and the row links it. Skip ephemeral reasons ("not worth it right now") and self-evident ones.
- **User settles a tiebreak or states a standing rule?** Write it into `NORTH_STAR.md`, dated.
- **Want to explore alternative interfaces for the deepened module?** Call the Skill tool with "codebase-design" and use its design-it-twice parallel sub-agent pattern.

### 4. Project files

Before you finish, bring `NORTH_STAR.md` and `PRIOR_ARTS.md` up to date with the session: north stars and prior arts the user named, comparisons the prior-art agents settled (into Settled), and questions they left open (into To survey). Create either file from its format when it doesn't exist, drafting the north stars from the user's direction, `AGENTS.md`/`CLAUDE.md`, the README and the ADRs. Done when both files exist and say everything the session decided.
