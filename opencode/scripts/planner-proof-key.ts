import { CryptoHasher, resolveSync, revision } from "bun"
import { Data, Effect, FileSystem, Option, Path, Schema } from "effect"
import type { Change } from "./git-paths.ts"
import { checkedTests, importsOf, inspectReads, ROOT, testReadInputs, type Workspace } from "./reach.ts"
import { ALL_READS, readMatcher } from "./read-declarations.ts"

const readMap = "scripts/test-impact-observations.json"
const hash = (value: string) => new CryptoHasher("sha256").update(value).digest("hex")
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

/** Content identity of the executable and its local runtime imports, independent of a ref, tree or scratch cwd. */
export const plannerProgramKey = Effect.fn("PlannerProof.programKey")(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const sources = new Map<string, string>()
  const pending = new Set(["scripts/gate.ts", "scripts/accept.ts", "scripts/planner-proof-key.ts", "package.json", "bun.lock", "bunfig.toml"])
  for (const file of pending) {
    const absolute = path.join(ROOT, file)
    const content = yield* fs.readFileString(absolute)
    sources.set(file, hash(content))
    for (const specifier of importsOf(file, content)) {
      if (!specifier.startsWith(".")) continue
      const next = path.relative(ROOT, resolveSync(specifier, path.dirname(absolute)))
      if (next === readMap || next.includes("/node_modules/")) continue
      pending.add(next)
    }
  }
  return hash(json([revision, [...sources].toSorted()]))
})

export interface PlannerSelection {
  readonly merge: ReadonlySet<string>
  readonly swarm: ReadonlySet<string>
  readonly acceptance: ReadonlySet<string>
}

export interface PlannerProofKey {
  readonly program: string
  readonly inputs: string
}

/** The manifest slice and current actual answers a cached comparison depends on, not an all-map hash. */
export const plannerInputKey = (workspace: Workspace, file: string, selection: PlannerSelection, diff: ReadonlyArray<Change>) => {
  const rows = checkedTests(workspace).flatMap((test) => {
    const authority = testReadInputs(workspace, test)
    if (!authority.has(file)) return []
    const patterns = inspectReads(workspace, test).patterns.filter((pattern) => pattern !== ALL_READS && readMatcher([pattern])(file))
    const reason = Option.getOrElse(Option.fromUndefinedOr(authority.subprocessReason), () => "")
    return [[test, authority.unknown, reason, authority.observationsFor(file), patterns, authority.imports.includes(file), authority.linkKey]]
  })
  const changed = diff.map(({ status, paths }) => [status, paths])
  return hash(json([file, changed, rows, [...selection.merge].toSorted(), [...selection.swarm].toSorted(), [...selection.acceptance].toSorted()]))
}

/** A reused standalone receipt is only valid for the code and exact path dependencies just rechecked. */
class StalePlannerProof extends Data.TaggedError("StalePlannerProof")<{ readonly file: string }> {}
export const assertPlannerProofKey = (file: string, recorded: PlannerProofKey, current: PlannerProofKey) => {
  if (recorded.program !== current.program || recorded.inputs !== current.inputs)
    return Effect.fail(new StalePlannerProof({ file }))
  return Effect.void
}
