// A lane's one-line purpose, kept as Git keeps what a branch is for: the description of the branch checked out in the
// workspace (`branch.<branch>.description` in its Git config, what `git branch --edit-description` writes). One record
// of the one branch a lane is, in the lane itself; for both process providers.
import { Array as Arr, Effect, Option } from "effect"
import { RiftFailed } from "../service.ts"
import type { GitRunner } from "./unpushed.ts"

const keyOf = (branch: string): string => `branch.${branch}.description`

/** The description of `branch` in the checkout at `path`, trimmed; none when detached (no branch), unset or blank. */
export const purposeOf = Effect.fn("purposeOf")(function* (runner: GitRunner, path: string, branch: Option.Option<string>) {
  if (Option.isNone(branch)) return Option.none<string>()
  const ran = yield* runner.spawn(["git", "-C", path, "config", "--get", keyOf(branch.value)], path)
  return Option.filter(Option.some(ran.stdout.trim()), (text) => ran.code === 0 && text !== "")
})

/** A workspace's `purpose` field: present only when it has one. */
export const purposeField = (purpose: Option.Option<string>): { readonly purpose?: string } =>
  Option.match(purpose, { onNone: () => ({}), onSome: (text) => ({ purpose: text }) })

// A lane's mark: `orchestrate lane` made it, on its branch. `branch.<branch>.orchestrate-lane` holds the lane's path,
// in the same Git config as the purpose: Git keeps it through a merge, a rebase, a switch to another branch and a
// detached head, and a clone made from the lane copies it with the lane's path, which the clone never reads as its own.
const MARK = "orchestrate-lane"

/** The branch whose mark names `path`, from `git config --get-regexp` lines (`branch.<branch>.orchestrate-lane <path>`). */
export const madeOnIn = (lines: string, path: string): Option.Option<string> =>
  Arr.findFirst(lines.split("\n"), (line) => {
    const at = line.indexOf(" ")
    const key = line.slice(0, at)
    return Option.liftPredicate(key.slice("branch.".length, -`.${MARK}`.length), () => at > 0 && key.startsWith("branch.") && key.endsWith(`.${MARK}`) && line.slice(at + 1).trim() === path)
  })

/** The branch `orchestrate lane` made the checkout at `path` on, by its mark; none when unmarked. */
export const madeOnOf = Effect.fn("madeOnOf")(function* (runner: GitRunner, path: string) {
  const ran = yield* runner.spawn(["git", "-C", path, "config", "--get-regexp", `^branch\\..*\\.${MARK}$`], path)
  return Option.flatMap(Option.liftPredicate(ran.stdout, () => ran.code === 0), (out) => madeOnIn(out, path))
})

/** A workspace's `madeOn` field: present only when it is marked. */
export const madeOnField = (madeOn: Option.Option<string>): { readonly madeOn?: string } =>
  Option.match(madeOn, { onNone: () => ({}), onSome: (branch) => ({ madeOn: branch }) })

/** Marks the checkout at `path` as a lane made on the branch checked out there; fails on a detached checkout. */
export const markBranch = Effect.fn("markBranch")(function* (runner: GitRunner, path: string) {
  const branch = (yield* runner.git(path, "branch", "--show-current")).trim()
  if (branch === "") return yield* new RiftFailed({ operation: "git config", message: `${path} is detached: a lane's mark is on its branch, and it has no branch` })
  yield* runner.git(path, "config", `branch.${branch}.${MARK}`, path)
})

/** Sets the description of the branch checked out at `path` to `purpose`; fails on a detached checkout. */
export const describeBranch = Effect.fn("describeBranch")(function* (runner: GitRunner, path: string, purpose: string) {
  const branch = (yield* runner.git(path, "branch", "--show-current")).trim()
  if (branch === "") return yield* new RiftFailed({ operation: "git config", message: `${path} is detached: a purpose is its branch's description, and it has no branch` })
  yield* runner.git(path, "config", keyOf(branch), purpose.trim())
})
