---
name: architect
description: "Sketch types, signatures and module structure before code, from two model families, then implement against the chosen sketch and scrap it when it is wrong. Use for /architect, 'architect this', 'design this', a new seam, or non-trivial work where jumping to code would lock in the wrong shape."
disable-model-invocation: true
---

# Architect

Sketch the types, function signatures and module boundaries with `not implemented` bodies and pseudocode. Get one sketch from each model family, synthesize, then fill in code against the chosen sketch. Adapted from pstack (`cursor/plugins`, `pstack/skills/architect`). Principles named here live in `~/Developer/personal/dotfiles/principles/`.

Open a todo list with one entry per phase: Ground, Sketch, Implement, Scrap.

## Phase A: Ground the problem

Build a real mental model of every system the new code touches: run the **how** skill over each subsystem and keep its explanation. Naming a file is not grounding. When the design moves ownership or layering, also run the **why** skill on the current shape, so its rationale becomes a constraint, not a guess.

Skip Phase A only for greenfield work with no surrounding system.

## Phase B: Sketch twice, judge across families

Design it twice: at least two structurally distinct candidates, whole-shape alternatives, not point fixes inside one shape (`exhaust-the-design-space`).

1. **Candidates.** Write one candidate yourself, or in one `orchestrate-worker` for a large design, in its own Rift or a subdirectory of the sketch dir. Get the other from the other model family through `okra counsel -f <prompt.md>` (the **counsel** skill), with [`references/runner-prompt.md`](references/runner-prompt.md), the Phase A grounding and the task. Neither runner sees the other's candidate.
2. **Screen.** Check every candidate against [`references/design-red-flags.md`](references/design-red-flags.md). Assume the next contributor is an agent that sees only the files it opened, copies the nearest example and takes the shortest path that compiles. Prefer the design where a change that looks right from one file is right for the whole repo.
3. **Compare** on interface depth: the capability hidden behind the public surface against the size of that surface (`small-interface-deep-implementation`).
4. **Synthesize.** Pick a base, graft what the other candidate does better, and record the choice in the rationale's Synthesis decision section ([`references/rationale-template.md`](references/rationale-template.md)). For a seam the owner will live with, send the synthesis back through `okra counsel` once for the other family's judgment before code.

The synthesis can land as its own commit: scaffold first (`foundational-thinking`). Planned breakage during fill-in is fine (`outcome-oriented-execution`).

Proceed to implementation without a checkpoint. Stop and show the sketch first only when the invoker asked for that ("architect with checkpoint", "show me before implementing").

## Phase C: Implement against the sketch

Replace `not implemented` bodies with code and pseudocode with logic. The sketch is the contract. A deviation is a signal to surface, not friction to absorb: when a function needs a parameter the sketch did not have, ask whether the sketch was wrong, a requirement was missed, or the implementation overreaches.

## Phase D: Scrap when the architecture is wrong

When implementation keeps producing friction the sketch cannot absorb, throw the sketch out (`redesign-from-first-principles`, `fix-root-causes`). The signal is a pattern:

- the same shape of workaround in unrelated code;
- several unrelated edge cases that each need a special branch;
- types that need escape hatches (`any`, casts, optional fields always set) to compile;
- a lock, where the sketch said the state was not shared;
- callers that must know the abstraction's internal rules;
- two or more independent Phase C deviations of the same shape.

A few edge cases do not condemn a design; complexity in the data is not complexity in the design. To scrap: run **how** over what was built, redesign as if the new constraints were day-one assumptions, make the new sketch smaller than the old before it grows (`subtract-before-you-add`), and return to Phase B.

## Outputs

The caller's usage first, the type sketch derived from it: one file of new types and signatures for a small change, a module map plus types for larger work. The rationale ships beside it, shaped by [`references/rationale-template.md`](references/rationale-template.md), with the usage sketch and the synthesis decision.
