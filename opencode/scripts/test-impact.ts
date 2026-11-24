import type { UnitTests } from "./merge-check.ts"
import { reach, testReadInputs, type Workspace } from "./reach.ts"
import { mergeUnitTests } from "./test-population.ts"

const inputsOf = (workspace: Workspace) => {
  const memo = new Map<string, ReadonlyArray<string>>()
  const known = new Set(workspace.files)
  const readers = new Map<string, Pick<ReadonlySet<string>, "has">>()
  return (test: string) => {
    const cached = readers.get(test)
    if (cached) return cached
    const inputs = testReadInputs(workspace, test)
    let reaches = (file: string) => {
      const reached = reach(workspace, [test], memo, known)
      reaches = (path) => reached.has(path)
      return reaches(file)
    }
    const reads = { has: (file: string) => inputs.has(file) || reaches(file) }
    readers.set(test, reads)
    return reads
  }
}

/** The fixed-seed leg and the land swarm use the same conservative read authority. */
export const mergeUnitInputs = (workspace: Workspace): UnitTests => ({ files: mergeUnitTests(workspace), inputs: inputsOf(workspace) })

export const swarmInputs = inputsOf
