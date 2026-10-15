# Agent lens

Read by every architecture sweep and by the single pass's codebase walker.

Judge the code as its next contributor will meet it: an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. A design is sound when a change that looks right from one file is right for the whole repo. Four shapes fail that test; each is a candidate:

| Red flag | Why an agent breaks it | Direction |
| --- | --- | --- |
| **Split ownership**: more than one module writes the same state or keeps its own copy | It edits one writer and cannot see the others, so their rules diverge | One owner per piece of state; others read it or ask the owner |
| **Two ways to do one task** | It copies whichever way it finds first, so every way keeps gaining callers | Keep one way; move callers off the others and delete them in the same change |
| **Importable internals**: a caller can reach a module's internals | It imports them directly, and they become part of the interface | Make internals unreachable, so an import from outside fails the build |
| **Hand-synced list**: two places list the same items | It updates the list it sees and misses the others | Derive every list from one; when one cannot be derived, fail the build when they disagree |
