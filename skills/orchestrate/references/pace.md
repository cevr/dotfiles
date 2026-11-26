# Pace: when Claude is held

The account pool's pace sets how many Claude agents run; the skill sets no count beyond four lanes. Both paces count only the hours outside the Sabbath.

- **A held role waits.** OpenCode latches it and reopens it by itself. On Claude Code, run `bun ~/.claude/skills/orchestrate/scripts/budget.ts --wait <ticket>` in the background with the hold's ticket; on exit 0 call `Agent` again at once (exit 3: the ticket lapsed, call again). Verification waits for Claude Opus only.
- **Resume after a limit.** While any step is `stuck(quota)`, keep one background command armed that waits until `budget.ts --resume-at` prints a time that has passed; its exit wakes you to rerun those steps.
- `budget.ts` prints the pace; start no heavy agent while host load is above the core count.
