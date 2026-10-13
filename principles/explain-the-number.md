# Explain the Number

Before you trust, report or act on a number you measured (a speedup, a regression, a failure count, a token cost, an eval score), name what limits it and rule out that it measured something else.

**Why:** A number is evidence about whatever it actually measured. A count of the wrong thing reads exactly like a count of the right thing, and every decision built on it inherits the error.

**Pattern:** Answer these with evidence from a run, not a guess about the code:

1. **Why not double?** Name the resource or code path that bounds the result: a core, a lock, the disk, the network, the load generator, other work on the machine. Get it from a profile or system counters, then map it to source. If you cannot say why it is not twice as good, you do not know what you measured.
2. **Did it even happen?** Confirm the work ran inside the measured region: the request reached the server, the rows were written, the result was used. Lazy code, cached results and early exits produce numbers for work that never ran.
3. **Did it error?** Count failures and non-success results, and check outputs are correct, not just present. Rejections are fast; timeouts and retries are slow.
4. **Does it reproduce?** Run each side at least 5 times, alternating A, B, A, B. Report the median and range. A gap smaller than the run-to-run spread is no difference. Read the load (`uptime`, `sysctl -n vm.loadavg`) against the core count before each run; above it, timings claim nothing.
5. **Does it matter?** Report a micro result as a share of the end-to-end path a user waits on. A piece that takes 10% of the run can make the run at most about 11% faster.

**Keep the evidence with the number:** the run count, the spread, the load and the limiter, in the report or a linked file. A claim with none of these is a guess with a unit.

**Example:** bible-tools p5. The task notification's token count read as each agent's spend; it was the agent's final context, 50 to 1000 times under its real spend (now read from the transcript by `orchestrate/scripts/agent-cost.ts`). The laptop e2e failures (base 799/28, sheet R2 845/18) read as unit regressions; they were load timeouts at a load of 38 to 45 on 12 cores, and each passed when rerun alone.

**See also:** [[prove-it-works]] checks that an output is real; this checks that a measurement measured the work. [[fix-root-causes]]: when verification fails, suspect the observation first.
