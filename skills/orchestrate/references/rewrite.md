# Rewrite

The unit failed three rounds. Repair is over: rewrite it.

1. **Diagnose first.** Start a fresh agent (`orchestrate-worker`) from the family that did not implement the unit, with the `diagnosing-bugs` skill. Its message names the spec, every `round-*-findings.md` and `round-*-verify.md`, `state.md` and the branch. It writes `<unit dir>/diagnosis.md`: the premise every failed repair assumed (`~/Developer/personal/dotfiles/principles/attack-the-premise.md`), the census of triggers from every round, and the root cause with a reproduction that is red at the branch head. It changes no code. Three repairs on one premise show that the cause was never found; a rewrite from the same reading repeats it.
2. Rewrite the spec from `diagnosis.md`, on a new premise, or on the old one kept with proof. Its acceptance check adds a property or model test that owns the repeated class, red on every earlier counterexample. The property ranges over the rule's whole domain as the rule is written (every paint, direction and value the rule names; every input path and modality), not the space around the last counterexample: papercut's shading rule failed three times after its property. The property is part of the acceptance check, never "if cheap": sheet's optional one compared the code with itself, and two more rounds failed on its class.
3. Start a fresh implementor on a new branch from the base commit. The old branch and findings are data, never a starting point.
4. Number the rewrite's rounds from 1 again.

A rewrite that fails three rounds goes to the owner with both premises and the census.
