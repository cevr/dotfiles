// The commits a workspace holds and nothing else does: the "unpushed" of the
// removal rule (workspace.ts), for both process providers. workbox/bin/workrift's
// work_own_commits is the same rule in sh, for `workrift remove`.
import { Effect } from "effect"
import type { RiftFailed } from "../service.ts"
import { lines, type Ran } from "./command.ts"

/** How the rule runs Git: `git -C <path> <args>` answering its output, and a spawn whose exit code it reads. */
export interface GitRunner {
  readonly git: (path: string, ...args: ReadonlyArray<string>) => Effect.Effect<string, RiftFailed>
  readonly spawn: (argv: ReadonlyArray<string>, cwd: string, extra?: Readonly<Record<string, string>>) => Effect.Effect<Ran, RiftFailed>
}

/**
 * `<hash> <subject>` of each commit found only in the checkout at `path`, newest first: reachable from HEAD (when
 * `hasHead`) or a branch, and from no remote-tracking ref and none of `tips` (the base's branches). A land merges a
 * branch into main in another workspace and pushes main from there, so this checkout's remote refs may lag: when any
 * commit looks unsaved, origin is fetched (a failed fetch leaves the refs as they are) and they are read again. A
 * merge of two parents whose tree is the one `git merge-tree` makes of them holds nothing of its own (its parents are
 * judged on their own); every other commit, a merge with an edit or a resolved conflict among them, is work.
 */
export const unpushed = Effect.fn("unpushed")(function* (runner: GitRunner, path: string, tips: ReadonlyArray<string>, hasHead: boolean) {
  const found = runner
    .git(path, "rev-list", ...["HEAD"].filter(() => hasHead), "--branches", "--ignore-missing", "--not", "--remotes", ...tips)
    .pipe(Effect.map(lines))
  if ((yield* found).length === 0) return []
  yield* runner.spawn(["git", "-C", path, "fetch", "--quiet", "--no-tags", "origin"], path, { GIT_TERMINAL_PROMPT: "0" })
  const judged = yield* Effect.forEach(yield* found, (commit) => cleanMerge(runner, path, commit).pipe(Effect.map((clean) => ({ commit, clean }))))
  const own = judged.filter((each) => !each.clean).map((each) => each.commit)
  if (own.length === 0) return []
  return lines(yield* runner.git(path, "show", "-s", "--format=%h %s", ...own))
})

/** Whether `commit` is a merge of two parents whose tree is the one `git merge-tree` makes of them. */
const cleanMerge = Effect.fn("unpushed.cleanMerge")(function* (runner: GitRunner, path: string, commit: string) {
  const parents = (yield* runner.git(path, "rev-list", "--parents", "-n", "1", commit)).trim().split(" ").slice(1)
  if (parents.length !== 2) return false
  const merged = yield* runner.spawn(["git", "-C", path, "merge-tree", "--write-tree", ...parents], path)
  if (merged.code !== 0) return false
  const tree = (yield* runner.git(path, "rev-parse", `${commit}^{tree}`)).trim()
  return lines(merged.stdout)[0] === tree
})
