// When a land's merge check (scripts/gate.ts --merge) runs the verify-opencode docs guard,
// scripts/verify-docs.test.ts. The guard holds the skill's docs to the tree, so a change can turn it red
// from either side:
// - the docs: the skill's folder (its SKILL.md, the feature map), AGENTS.md (it must point at the skill),
//   package.json (every `bun run` named is a script), and the guard's own code (verify-map.ts, the test);
// - the tree they name: a file deleted or renamed (a doc may name it), or a world suite added
//   (`*.sim.test.ts(x)`; the feature whose Code holds it must list it).
// Any other change leaves the guard as green as it was on the base, which the land already checked.

import type { Change } from "./git-paths.ts"

/** The files and folders (ending in `/`) the guard reads, from opencode/. */
export const GUARD_READS = [".claude/skills/verify-opencode/", "AGENTS.md", "package.json", "scripts/verify-map.ts", "scripts/verify-docs.test.ts"] as const

const read = (path: string) => GUARD_READS.some((each) => (each.endsWith("/") && path.startsWith(each)) || path === each)
const suite = (path: string) => /\.sim\.test\.tsx?$/.test(path)

/** Whether `change` can turn the docs guard red. */
const touchesGuard = (change: Change) =>
  change.paths.some(read) || change.status === "D" || change.status === "R" || ((change.status === "A" || change.status === "C") && change.paths.some(suite))

/** Whether the merge check must run the docs guard over `changes`. */
export const docsGuardDue = (changes: ReadonlyArray<Change>): boolean => changes.some(touchesGuard)
