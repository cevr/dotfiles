# Test runtime inputs

The gate discovers the full unit, acceptance and workbox populations through the same functions the runners use. `bun scripts/check-test-reads.ts --files` lists that union. `--inventory` adds inferred patterns, classification, opaque sites, and enforced patterns.

The checker follows reachable local imports (including re-exports) and reports the actual read site. Static paths and literal globs feed selection directly. Do not add a declaration for an inferred input or for a pure imported function.

A computed path is not bounded by `join("fixtures", input)`: `input` could contain `..`. Wrap its operand in `matchingInput("fixtures/**", file)` and add `// @reads-indirect fixtures/**`. For a bounded non-directory glob, use `// @reads fixtures/*.json`. The checker requires the same scope as the runtime helper. The helper rejects paths outside that scope and symlink aliases; it does not turn an entire checkout into a named scope. Use a scratch-only helper for output created by a test.

Paths are expressed from `opencode/`: `scripts/gate.ts` is inside; `../linux/hetzner-workbox/**` names the sibling directory. An inner glob never matches a sibling merely because it has a leading `**`. Merge sees the full repository diff, using both names of a rename; this does not extend lint, debt or typecheck's scope.

If an operation cannot be statically resolved or enforced, use `// @reads all` and `// @reads-reason <reported kind> at <file>: <opaque operation>`. This makes a merge-eligible suite run on every nonempty repository diff, and invalidates an unknown unit or acceptance cache key on every new Git head. It is rejected if no opaque read remains.

For subprocesses, a checkout filename in argv is an input, not a claim that all descendant opens were observed. The checker models fixed command/operand forms and treats opaque argv, unmodeled commands and shell programs conservatively. The preload used to check coverage sees instrumented JavaScript operations and argv, but cannot see native descendant or loader opens.
