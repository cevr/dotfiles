// A Rift workspace as the tool reads it, and the rule for removing one.
//
// A Rift is a copy-on-write copy of a repository's warm source. Removing one
// moves it to Rift's trash, which `rift gc` (on the workbox, the nightly
// `workrift prune`) empties for good, so the tool refuses a removal that would
// lose work: changes not committed, commits that exist only in this Rift (on
// no remote and in no branch of its source), stashes its source does not also
// hold. `force` overrides that,
// and only that: a warm source, a Rift that holds the calling session, and a
// Rift with Rifts of its own are always refused.
import { Effect, Schema } from "effect"

/** What the tool knows about one workspace. */
export interface Workspace {
  /** Its directory, absolute. */
  readonly path: string
  /** A Rift root: a warm source, never removed through the tool. */
  readonly source: boolean
  /** Its own Rifts, which a removal would trash with it. */
  readonly children: ReadonlyArray<string>
  /** Whether it is a Git checkout; outside Git the tool cannot tell what is unsaved. */
  readonly git: boolean
  /** The checked-out branch, undefined when HEAD is detached. */
  readonly branch: string | undefined
  /** HEAD's short hash. */
  readonly head: string
  /** `git status --porcelain` lines: changes not committed, untracked files among them. */
  readonly uncommitted: ReadonlyArray<string>
  /** `<hash> <subject>` of each commit found only here, newest first. */
  readonly unpushed: ReadonlyArray<string>
  /** How many stash entries it holds of its own: ones not inherited from the workspaces it was copied from (ownStashes). */
  readonly stashes: number
}

/**
 * How many of a Rift's stash entries are its own. A Rift is a copy-on-write
 * copy, so it inherits its source's stash: an entry whose commit the source
 * (or a Rift above it) still holds is found elsewhere, and counts for nothing.
 * Both lists are stash commits (`git stash list --format=%H`).
 */
export const ownStashes = (rift: ReadonlyArray<string>, above: ReadonlyArray<string>): number => {
  const inherited = new Set(above)
  return rift.filter((commit) => !inherited.has(commit)).length
}

/** The workspace is a warm source. */
export class SourceKept extends Schema.TaggedError<SourceKept>()("SourceKept", { path: Schema.String }) {}

/** The calling session runs inside the workspace. */
export class SessionInside extends Schema.TaggedError<SessionInside>()("SessionInside", {
  path: Schema.String,
  directory: Schema.String,
}) {}

/** The workspace has Rifts of its own. */
export class ChildrenKept extends Schema.TaggedError<ChildrenKept>()("ChildrenKept", {
  path: Schema.String,
  children: Schema.Array(Schema.String),
}) {}

/** The workspace holds work found nowhere else. */
export class WorkUnsaved extends Schema.TaggedError<WorkUnsaved>()("WorkUnsaved", {
  path: Schema.String,
  git: Schema.Boolean,
  uncommitted: Schema.Array(Schema.String),
  unpushed: Schema.Array(Schema.String),
  stashes: Schema.Number,
}) {}

/** A land's step (a batch, its accept check, a post-land step) runs in the Rift now; `force` does not override it. */
export class StepRunning extends Schema.TaggedError<StepRunning>()("StepRunning", {
  path: Schema.String,
  step: Schema.String,
}) {}

export type RemoveRefused = SourceKept | SessionInside | ChildrenKept | WorkUnsaved | StepRunning

/** Whether `path` is `directory` or holds it. */
export const holds = (path: string, directory: string): boolean => directory === path || directory.startsWith(`${path.replace(/\/+$/, "")}/`)

/** Succeeds when `workspace` may go to the trash, for a session in `sessionDirectory`; else fails with why. */
export const removal = (
  workspace: Workspace,
  request: { readonly force: boolean; readonly sessionDirectory: string },
): Effect.Effect<void, RemoveRefused> => {
  if (workspace.source) return Effect.fail(new SourceKept({ path: workspace.path }))
  if (holds(workspace.path, request.sessionDirectory))
    return Effect.fail(new SessionInside({ path: workspace.path, directory: request.sessionDirectory }))
  if (workspace.children.length > 0) return Effect.fail(new ChildrenKept({ path: workspace.path, children: [...workspace.children] }))
  const unsaved = !workspace.git || workspace.uncommitted.length > 0 || workspace.unpushed.length > 0 || workspace.stashes > 0
  if (unsaved && !request.force)
    return Effect.fail(
      new WorkUnsaved({
        path: workspace.path,
        git: workspace.git,
        uncommitted: [...workspace.uncommitted],
        unpushed: [...workspace.unpushed],
        stashes: workspace.stashes,
      }),
    )
  return Effect.void
}

/** At most `limit` lines of `lines`, and how many more there are. */
const some = (lines: ReadonlyArray<string>, limit = 10): string =>
  [...lines.slice(0, limit).map((line) => `  ${line}`), ...(lines.length > limit ? [`  … and ${lines.length - limit} more`] : [])].join("\n")

/** What the model reads when a removal is refused. */
export const explainRefusal = (refusal: RemoveRefused): string => {
  switch (refusal._tag) {
    case "SourceKept":
      return `${refusal.path} is a warm source, not a Rift made from one; the rift tool never removes a source.`
    case "SessionInside":
      return `This session runs in ${refusal.directory}, inside ${refusal.path}. Move the session out first (session_move to the source), then remove it.`
    case "ChildrenKept":
      return `${refusal.path} has Rifts of its own, which would go with it. Remove them first:\n${some(refusal.children)}`
    case "StepRunning":
      return `${refusal.path} is busy: ${refusal.step}. Remove it after its wake.`
    case "WorkUnsaved": {
      if (!refusal.git) return `${refusal.path} is not a Git checkout, so its unsaved work cannot be checked. Pass force: true to remove it anyway.`
      const parts = [
        ...(refusal.uncommitted.length > 0 ? [`${refusal.uncommitted.length} uncommitted change(s):\n${some(refusal.uncommitted)}`] : []),
        ...(refusal.unpushed.length > 0 ? [`${refusal.unpushed.length} commit(s) on no remote and in no branch of its source:\n${some(refusal.unpushed)}`] : []),
        ...(refusal.stashes > 0 ? [`${refusal.stashes} stash entr${refusal.stashes === 1 ? "y" : "ies"}`] : []),
      ]
      return `${refusal.path} holds work found nowhere else:\n${parts.join("\n")}\nCommit and push it, or pass force: true to remove it anyway (it goes to Rift's trash until the next gc).`
    }
  }
}
