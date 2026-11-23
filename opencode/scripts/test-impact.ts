import observations from "./test-impact-observations.json" with { type: "json" }
import type { UnitTests } from "./merge-check.ts"
import { ALL_READS, readMatcher } from "./read-declarations.ts"
import { inspectReads, reach, type Workspace } from "./reach.ts"
import { mergeUnitTests } from "./test-population.ts"

const observed: Readonly<Record<string, ReadonlyArray<string>>> = observations
const readPatterns = (workspace: Workspace, test: string) => inspectReads(workspace, test).patterns.filter((glob) => glob !== ALL_READS)

/** The merge leg's fixed-seed population and its positive input evidence. */
export const mergeUnitInputs = (workspace: Workspace): UnitTests => {
  const memo = new Map<string, ReadonlyArray<string>>()
  const known = new Set(workspace.files)
  return {
    files: mergeUnitTests(workspace),
    inputs: (test) => reach(workspace, [test], memo, known),
    reads: (test) => readPatterns(workspace, test),
    observed: (test) => observed[test] ?? [],
  }
}

/** The existing swarm selects known reads too, including fixture paths outside opencode/. */
export const swarmInputs = (workspace: Workspace) => {
  const memo = new Map<string, ReadonlyArray<string>>()
  const known = new Set(workspace.files)
  const candidates = [...known, ...(workspace.siblings ?? [])]
  const cache = new Map<string, ReadonlySet<string>>()
  return (suite: string) => {
    const prior = cache.get(suite)
    if (prior) return prior
    const matches = readMatcher(readPatterns(workspace, suite))
    const inputs = new Set([...reach(workspace, [suite], memo, known), ...candidates.filter(matches), ...(observed[suite] ?? [])])
    cache.set(suite, inputs)
    return inputs
  }
}
