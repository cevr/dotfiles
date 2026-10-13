# Attack the Premise

When two fixes that rest on one premise have failed the same check, suspect the premise, not the fixes. Write the premise down before the next fix.

**Why:** Each failure under a shared premise is evidence against the premise. A third fix that assumes it buys one more trigger and the same failure. A property test owns the *class* of defect; only questioning the premise changes the *design* that keeps producing it.

**Pattern:**

- **Write the premise.** One sentence that every failed fix assumed. If you cannot write it, you have not found what the fixes share.
- **Take a census.** List every trigger that reaches the bad state, not only the ones that failed so far. Keep it as a rerunnable test or script ([[build-the-lever]]).
- **Read the census.** If every trigger enters through one assumption (state read back from layout, a cache kept in sync by events, an order the scheduler never promised), that assumption is the next "why" ([[fix-root-causes]]).
- **Replace the premise, or keep it on proof.** Either the property test proves the premise holds for every trigger in the census, or the design stops depending on it. Another trigger fix on the same premise is not progress.
- **Sweep for survivors.** A replaced premise often lives on in one corner of the design. Check each trigger in the census against the new premise.

**Stop:** Do not start the next fix before the premise is written and the census exists. If the census shows the failures share no assumption, the premise is not the cause: look elsewhere, and keep the census as evidence.

**Example:** bible-tools p5, the `sheet` unit. It failed rounds r1, r2, r3 and R1. Each fix covered one more trigger (a resize, a breakpoint crossing, the entrance, a scroll clamp, a wheel snap), and every fix rested on one premise: *the sheet's state can be read from scroll and layout observers*. The premise was replaced only at R2 ("dismissal by user gesture only"). R2 still failed, with a repeat of r3's defect, because the entrance geometry kept the old premise. Writing the premise at the second failure would have saved two rounds.

**See also:** [[derive-dont-sync]]: "state read back from layout" is usually synchronization in disguise. [[redesign-from-first-principles]] rebuilds around a new requirement; this principle questions a fact the current design assumes. [[fix-root-causes]] is the single-bug analogue.
