// How one changed file is reviewed: with hunk when it is on PATH (`hunk diff
// --watch <base> -- <path>` at the checkout's top), else with git's own pager.
// The TUI hands the terminal to the command (renderer suspend and resume, as
// OpenCode's external editor does) and takes it back when it ends.
import type { ChangedFile, Checkout } from "./checkout.ts"
import type { ReviewAnswer } from "./git.ts"

/** The note a review through the pager leaves, so the reader knows hunk was looked for. */
export const HUNK_MISSING = "hunk not found · using the git pager"

/** The paths a review names: a rename's source and destination, else the path. */
const pathspecs = (file: ChangedFile): ReadonlyArray<string> => (file.from === undefined ? [file.path] : [file.from, file.path])

/**
 * The review of `path` in `checkout`. hunk compares the work tree with the
 * base, so a staged change counts. Without hunk, git pages its own diff; an
 * untracked file has no base, so it is diffed against nothing. A path that is
 * no longer changed has no review.
 */
export const reviewOf = (checkout: Checkout, path: string, hunk: boolean): ReviewAnswer => {
  const file = checkout.files.find((item) => item.path === path)
  if (file === undefined) return { note: `${path} has no changes now` }
  const cwd = checkout.root
  if (hunk) return { command: { program: "hunk", argv: ["hunk", "diff", "--watch", checkout.base, "--", ...pathspecs(file)], cwd } }
  const argv =
    file.status === "?"
      ? ["git", "--paginate", "diff", "--no-index", "--", "/dev/null", file.path]
      : ["git", "--paginate", "diff", checkout.base, "--", ...pathspecs(file)]
  return { command: { program: "pager", argv, cwd }, note: HUNK_MISSING }
}
