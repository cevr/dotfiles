// A lane's one-line purpose, kept as Git keeps what a branch is for: the description of the branch checked out in the
// workspace (`branch.<branch>.description` in its Git config, what `git branch --edit-description` writes). One record
// of the one branch a lane is, in the lane itself; for both process providers.
import { Effect, Option } from "effect"
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

/** Sets the description of the branch checked out at `path` to `purpose`; fails on a detached checkout. */
export const describeBranch = Effect.fn("describeBranch")(function* (runner: GitRunner, path: string, purpose: string) {
  const branch = (yield* runner.git(path, "branch", "--show-current")).trim()
  if (branch === "") return yield* new RiftFailed({ operation: "git config", message: `${path} is detached: a purpose is its branch's description, and it has no branch` })
  yield* runner.git(path, "config", keyOf(branch), purpose.trim())
})
