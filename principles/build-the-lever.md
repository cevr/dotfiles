# Build the Lever

When work is not trivial, build the tool that does it or proves it (a script, a codemod, a generator, a seed, a skill the delegates read) instead of doing it by hand. A helper a worker has rebuilt twice is no longer optional: it becomes a committed script or a follow-up unit.

**Why:** A tool does the work the same way every time and reruns for free. It is one artifact a reviewer can read and rerun; hand work can only be re-verified by redoing it. A helper left in a scratch dir dies with the session, so the next worker pays for it again, and the next.

**Pattern:**

- **First by hand, then the lever.** Do one instance by hand to learn the recipe, then build the tool and prove it by rerunning it on that instance.
- **Commit it where the gate sees it.** In a repo, a lever is a script the repo runs (`bun run <name>` in the owning package), with a test when it holds logic. The gate keeps it alive, a docs guard can check its name, and the safety classifier allows `bun run` where it refuses an ad-hoc file in `/tmp`.
- **Second rebuild, promote.** When a worker writes a helper that an earlier worker already wrote (a CDP driver, a rerun-alone harness, a seed root), the second copy is the trigger: move it into the repo's tooling or its `verify-<app>` skill, now or as a follow-up unit.
- **Fan-out reads one lever.** When delegates share a recipe, write it once as a skill or script they all read, outside their write scope.
- **Smallest tool that does or proves the job.** A script, not a framework.

**Test:** If you cited this principle and the diff holds no script, codemod, generator or skill, you did not apply it.

**Example:** bible-tools p5. Verifiers wrote their own browser driver four times (`cdp.ts` in sheet's verify rounds 3, R1 and R2, and in rings' verify 1), two units wrote a rerun-alone harness (`sheet/rerun-alone.ts`, `laptopgate/rerun-alone.sh`), and the retro hand-rolled transcript parsers that became `orchestrate/scripts/agent-cost.ts`. Each verifier spent setup time and tokens rebuilding a tool the last one had thrown away.

**See also:** [[encode-lessons-in-structure]] turns a repeated *instruction* into a guardrail; this turns repeated *work* into a tool. [[prove-it-works]]: a rerunnable check is the strongest proof.
