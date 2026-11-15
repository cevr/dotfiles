# Interrogate

Adversaries try to break a change or a design. A finding counts only when a run proves it. Adapted from pstack (`cursor/plugins`, `pstack/skills/interrogate`), MIT.

Use it when a defect would be costly: ownership, authority, a stored or wire format, money, security. It is the adversary of the orchestrate skill's `deep` mode; outside a run, the caller starts it on any change. Inside a run, the batch verifier's bar in the orchestrate skill's `protocol.md` (Verifier) is the same bar; this page does not replace its steps.

## Start the adversaries

The caller starts two by default, each a fresh `verifier` or `worker` subagent in its own workspace or a clean checkout of the head, with any uncommitted changes copied in. Give each the scope (a diff from its merge base, or the files named), the intent in one line, and this brief:

> Break this change. Prove each finding with a run against the real code: a failing test, a repro script, a command whose output shows the wrong behavior. For a design, run a prototype or probe the current tree. Keep your repros in your own checkout. Report each finding with a title, the exact command, the output it printed, and the output the intent requires. Leave out what you did not run: style, naming, structure, and risks that need a future change to matter. No findings is a valid result. Report; do not fix.

## Keep what holds

A finding survives only when a run proves it: rerun its command yourself, and keep it when the output shows the failure and the failure breaks the intent. Drop the rest. Merge findings that share a root cause. Adversaries find different failures, so keep every verified finding, not one adversary's list.

## Report

- **Intent**: the one-line restatement.
- **Findings**: for each, the command, the output it printed, the output the intent requires, how it breaks the intent, and which adversaries found it. Write "no verified findings" when none survive.
- **Dropped**: per adversary, how many were dropped and why.

Findings are reported, not fixed; fixing is the caller's next step, in code-review's Phase 5 or a new round.
