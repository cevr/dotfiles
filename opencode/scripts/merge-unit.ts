import observations from "./merge-unit-observations.json" with { type: "json" }
import type { UnitTests } from "./merge-check.ts"
import { inspectReads, reach, type Workspace } from "./reach.ts"
import { mergeUnitTests } from "./test-population.ts"

const observed: Readonly<Record<string, ReadonlyArray<string>>> = observations

/** The merge leg's fixed-seed population and its positive input evidence. */
export const mergeUnitInputs = (workspace: Workspace): UnitTests => {
  const memo = new Map<string, ReadonlyArray<string>>()
  const known = new Set(workspace.files)
  return {
    files: mergeUnitTests(workspace),
    inputs: (test) => reach(workspace, [test], memo, known),
    reads: (test) => inspectReads(workspace, test).patterns,
    observed: (test) => observed[test] ?? [],
  }
}
