// The default branch held in memory, for the plugin's tests: per checkout, its name and its first-parent line, oldest
// first. A line entry is a commit on the branch (a fast-forward land puts the unit's own commits there); a merge names
// the tips it merged (`merged`), which the branch then holds.
import { Array as Arr, Effect, Layer, Option } from "effect"
import { MainLine } from "../service.ts"
import type { Merge } from "../tools.ts"

/** One commit on the default branch's first-parent line. */
export interface Entry {
  readonly sha: string
  readonly subject: string
  /** The tips a merge took in (its other parents); empty for a commit that is no merge. */
  readonly merged: ReadonlyArray<string>
}

/** A checkout's default branch: its name and its first-parent line, oldest first. */
export interface Branch {
  readonly branch: string
  readonly line: ReadonlyArray<Entry>
}

/** Every checkout's branch, read at each call (a test's world may grow it); none outside a repository. */
export type World = (checkout: string) => Option.Option<Branch>

/** The full commit `rev` names in `checkout`, outside the line: a test's other refs (the fleet's checkouts). */
export type Refs = (checkout: string, rev: string) => Option.Option<string>

const indexOf = (branch: Branch, sha: string) => branch.line.findIndex((entry) => entry.sha === sha)

/** The first entry that holds `sha`: the entry itself, or the merge that took it in; -1 when none does. */
const heldAt = (branch: Branch, sha: string) => branch.line.findIndex((entry) => entry.sha === sha || entry.merged.includes(sha))

/**
 * `git rev-list base..head` for a `head` a merge took in and `base` on the line: nothing when the merge is at or
 * before `base` (the tip is an ancestor), else the tip itself (its own commits are outside this history).
 */
const mergedBetween = (branch: Branch, base: string, head: string): ReadonlyArray<string> => {
  const from = indexOf(branch, base)
  const at = heldAt(branch, head)
  if (from < 0 || at < 0) return []
  return Arr.filter([head], () => at > from)
}

export const layer = (world: World, refs: Refs = () => Option.none()) =>
  Layer.succeed(
    MainLine,
    MainLine.of({
      tip: (checkout, at) =>
        Effect.sync(() =>
          Option.flatMap(world(checkout), (branch) =>
            Option.map(
              Option.match(at, {
                onNone: () => Option.map(Arr.last(branch.line), (entry) => entry.sha),
                onSome: (rev) => Option.liftPredicate(rev, () => indexOf(branch, rev) >= 0),
              }),
              (head) => ({ branch: branch.branch, head }),
            ),
          ),
        ),
      merges: (checkout, head, base, limit) =>
        Effect.sync((): ReadonlyArray<Merge> =>
          Option.match(world(checkout), {
            onNone: () => [],
            onSome: (branch) => {
              const to = indexOf(branch, head)
              const from = Option.match(base, { onNone: () => -1, onSome: (sha) => indexOf(branch, sha) })
              return branch.line
                .slice(from + 1, to + 1)
                .map((entry, at) => ({ entry, parent: branch.line[from + at]?.sha ?? "" }))
                .filter(({ entry }) => entry.merged.length > 0)
                .map(({ entry, parent }) => ({ sha: entry.sha, parent, subject: entry.subject }))
                .toReversed()
                .slice(0, limit)
            },
          }),
        ),
      between: (checkout, base, head) =>
        Effect.sync(() =>
          Option.getOrElse(
            Option.flatMap(world(checkout), (branch) =>
              Option.map(
                Option.liftPredicate([indexOf(branch, base), indexOf(branch, head)] as const, ([from, to]) => from >= 0 && to >= 0),
                ([from, to]) => branch.line.slice(from + 1, to + 1).flatMap((entry) => [entry.sha, ...entry.merged]),
              ).pipe(Option.orElse(() => Option.some(mergedBetween(branch, base, head)))),
            ),
            (): ReadonlyArray<string> => [],
          ),
        ),
      // A merged tip is a commit of the repository too, as `git rev-parse` resolves it.
      commitOf: (checkout, rev) =>
        Effect.sync(() =>
          Option.orElse(
            Option.flatMap(world(checkout), (branch) => Option.liftPredicate(rev, () => heldAt(branch, rev) >= 0)),
            () => refs(checkout, rev),
          ),
        ),
    }),
  )
