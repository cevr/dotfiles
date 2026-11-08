# Rewrite

The unit failed three rounds. Repair is over: rewrite it.

1. **Diagnose first.** Start a fresh agent (`worker`, on Opus first like every role), with the `diagnosing-bugs` skill. Its message names the spec, every `round-*-findings.md`, `state.md` and the branch. It writes `<unit dir>/diagnosis.md`: the premise every failed repair assumed (`~/Developer/personal/dotfiles/principles/attack-the-premise.md`), the census of triggers from every round, and the root cause with a reproduction that is red at the branch head. It changes no code. Three repairs on one premise show that the cause was never found; a rewrite from the same reading repeats it.
2. Rewrite the spec from `diagnosis.md`, on a new premise, or on the old one kept with proof. Its acceptance check adds a property or model test that owns the repeated class, red on every earlier counterexample. The property ranges over the rule's whole domain as the rule is written (every paint, direction and value the rule names; every input path and modality), not the space around the last counterexample: a property that covers only that space lets the next counterexample through. The property is part of the acceptance check, never "if cheap": an optional property ends up comparing the code with itself, and its class keeps failing rounds.
3. Start a fresh implementor on a new branch. The old branch and findings are data, never a starting point. Where the failed rounds already landed on main (`Lands: push`), the branch starts from main and the rewrite replaces their code rather than building beside it; otherwise it starts from the unit's base commit.
4. Number the rewrite's rounds from 1 again.

A rewrite that fails three rounds goes to the owner with both premises and the census.
