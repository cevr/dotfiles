export interface TestSources {
  readonly files: ReadonlyArray<string>
  readonly siblings?: ReadonlyArray<string>
}

/** The test files outside tests/ and the gamut fixture: the gate's unit tests. */
export const unitTests = (workspace: TestSources) =>
  workspace.files.filter((file) => /\.test\.tsx?$/.test(file) && !file.startsWith("tests/") && !file.startsWith("testbeds/gamut/fixture/"))

/** tests/*.test.ts: the acceptance tests, most of which run real OpenCode. */
export const acceptanceTests = (workspace: TestSources) => workspace.files.filter((file) => /^tests\/[^/]+\.test\.tsx?$/.test(file))

/** Workbox tests the merge gate can start, expressed from the gate's cwd (opencode/). */
export const workboxTestFiles = (workspace: TestSources) =>
  (workspace.siblings ?? []).filter((file) => /^\.\.\/workbox\/test\/[^/]+\.test\.tsx?$/.test(file))

/** Merge checks run top-level script tests; the full unit gate also runs the nested ones. */
export const mergeScriptTests = (workspace: TestSources) =>
  unitTests(workspace).filter((file) => /^scripts\/[^/]+\.test\.tsx?$/.test(file))

export const isSimSuite = (file: string) => /\.sim\.test\.tsx?$/.test(file)

/** Every suite eligible to run in the acceptance swarm. */
export const swarmTests = (workspace: TestSources) => workspace.files.filter(isSimSuite).toSorted()

/** Fixed-seed unit tests not already assigned to the scripts leg or acceptance swarm. */
export const mergeUnitTests = (workspace: TestSources) => {
  const scripts = new Set(mergeScriptTests(workspace))
  return unitTests(workspace).filter((file) => !scripts.has(file) && !isSimSuite(file))
}

/** The read guard covers the union of the runner populations, not a parallel glob list. */
export const checkedTests = (workspace: TestSources) =>
  [...new Set([...unitTests(workspace), ...acceptanceTests(workspace), ...workboxTestFiles(workspace)])].toSorted()

/** A workspace package, not just a directory whose name is mentioned in the source. */
export const packageOf = (file: string) => {
  if (file === "decider" || file.startsWith("decider/")) return "decider"
  return /^(?:mods|cmd)\/[^/]+(?=\/[^/])/.exec(file)?.[0]
}

/** A package's tests, benchmarks and prose are not reached through that package by acceptance. */
export const isAcceptInput = (file: string) =>
  !packageOf(file) || !/(\.test\.tsx?|\.bench\.ts|\.md)$/.test(file)
