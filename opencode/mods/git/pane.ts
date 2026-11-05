// What the /git pane draws, as text: a title naming the branch, its upstream
// and the totals, one row per changed file (`M  path  +12 −3`, the path cut
// from its start to fit), the branch's pull request, and the notes that say
// what could not be read. tui/pane.tsx reads the git RPC and draws these rows.
import { aheadBehind, branchName, type ChangedFile, type Checkout, delta, plural, totals } from "./checkout.ts"
import type { CheckoutAnswer, PullRequestAnswer } from "./git.ts"

/** `main ↑2 → origin/main · 3 files +40 −12`; `no changes` for a clean checkout. */
export const paneTitle = (checkout: Checkout): string => {
  const { head, files } = checkout
  const apart = aheadBehind(head)
  const branch = `${branchName(head) ?? "no branch"}${apart.length > 0 ? ` ${apart}` : ""}`
  const upstream = head.upstream === undefined ? "" : ` → ${head.upstream}`
  const changes = files.length === 0 ? "no changes" : `${plural(files.length, "file")} ${delta(totals(files))}`
  return `${branch}${upstream} · ${changes}`
}

/** `…/to/file.ts`: the end of `path` in `room` cells, the start cut with an ellipsis. */
export const cutStart = (path: string, room: number): string => {
  if (path.length <= room) return path
  if (room <= 1) return path.slice(path.length - Math.max(0, room))
  return `…${path.slice(path.length - room + 1)}`
}

/** `M  src/a.ts  +12 −3`; a rename shows `from → path`; a file with no line counts (binary) shows `binary`. */
export const fileRow = (file: ChangedFile, width: number): string => {
  const counts = file.added === undefined || file.deleted === undefined ? "binary" : delta({ added: file.added, deleted: file.deleted })
  const name = file.from === undefined ? file.path : `${file.from} → ${file.path}`
  const lead = `${file.status}  `
  const room = Math.max(8, width - lead.length - counts.length - 2)
  return `${lead}${cutStart(name, room)}  ${counts}`
}

/** What the pane says about the reads: the checkout's failure, `gh`'s, and the last review's. */
export const notes = (checkout: CheckoutAnswer | undefined, pullRequest: PullRequestAnswer | undefined, review: string | undefined): ReadonlyArray<string> => [
  ...(checkout?.error === undefined ? [] : [`git: ${checkout.error}`]),
  ...(pullRequest?.note === undefined ? [] : [pullRequest.note]),
  ...(review === undefined ? [] : [review]),
]

/** What the pane shows in place of the file rows. */
export const emptyText = (checkout: CheckoutAnswer | undefined): string | undefined =>
  checkout === undefined
    ? "Reading the checkout…"
    : checkout.checkout === undefined
      ? checkout.error === undefined
        ? "Not a git checkout"
        : undefined
      : checkout.checkout.files.length === 0
        ? `No changes against ${checkout.checkout.base === "HEAD" ? "HEAD" : "the empty tree"}`
        : undefined

/** The row `selected` moves to by `step`, kept within `count` rows. */
export const moved = (selected: number, step: number, count: number): number => (count === 0 ? 0 : Math.min(count - 1, Math.max(0, selected + step)))
