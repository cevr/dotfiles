// The default branch held in memory, for the plugin's tests: per checkout, its name and its first-parent line, oldest
// first. A line entry is a commit on the branch; a merge names the tips it merged (`merged`), which the branch then holds.
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
      holds: (checkout, commit, head) =>
        Effect.sync(() =>
          Option.exists(world(checkout), (branch) => branch.line.slice(0, indexOf(branch, head) + 1).some((entry) => entry.sha === commit || entry.merged.includes(commit))),
        ),
      commitOf: (checkout, rev) =>
        Effect.sync(() =>
          Option.orElse(
            Option.flatMap(world(checkout), (branch) => Option.liftPredicate(rev, () => indexOf(branch, rev) >= 0)),
            () => refs(checkout, rev),
          ),
        ),
    }),
  )
