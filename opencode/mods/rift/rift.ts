// The `rift` tool: an isolated workspace for a branch, made from the
// repository's warm source, listed with its state, and removed when its work
// is done. It replaces OpenCode's worktree tools, which do not know Rift.
// One input with an `action`, like the shell tool's; the words the model
// reads for each answer and each refusal are here.
import { Schema } from "effect"
import type { Workspace } from "./workspace.ts"

export const RiftInput = Schema.Struct({
  action: Schema.Literals(["create", "list", "remove"]).annotate({
    description: "create: a new Rift for a branch. list: the Rifts of this repository's warm source, with their branch and unsaved work. remove: move a Rift to the trash when its work is done.",
  }),
  name: Schema.optional(Schema.String).annotate({
    description: "create: the Rift's directory name (default: the branch, with / as -). remove: the Rift to remove, by that name.",
  }),
  branch: Schema.optional(Schema.String).annotate({
    description: "create: the branch to check out: the local branch, else the remote one, else a new branch from the source's HEAD. Default: the name.",
  }),
  source: Schema.optional(Schema.String).annotate({
    description: "create and list: a directory of the repository whose warm source to use. Default: this session's directory.",
  }),
  path: Schema.optional(Schema.String).annotate({ description: "remove: the Rift's directory, in place of its name." }),
  force: Schema.optional(Schema.Boolean).annotate({
    description: "remove: remove it although it holds uncommitted changes, stashes or commits found nowhere else. Only when the user said to drop that work.",
  }),
})
export type RiftInput = typeof RiftInput.Type

export const RIFT_DESCRIPTION = [
  "Isolated workspaces (Rifts): a copy-on-write copy of the repository's warm source, with its installed packages and build output, on its own branch. Use it in place of git worktrees.",
  'create ({ action: "create", branch, name? }) answers the Rift\'s directory and branch; it does not move this session. On the workbox it runs `workrift create <branch>`, which first refreshes the warm source and carries over gh stack metadata, and names the Rift after the branch.',
  'list ({ action: "list" }) shows each Rift with its branch and its unsaved work. remove ({ action: "remove", name | path }) moves a Rift to the trash once its work is committed and pushed; it refuses one with uncommitted changes, stashes or unpushed commits and names them, unless force: true.',
  "Never do feature work in the warm source itself.",
].join("\n\n")

/** A create that names neither a branch nor a name. */
export class BranchMissing extends Schema.TaggedError<BranchMissing>()("BranchMissing", {}) {}

/** A remove that names neither a Rift nor a path. */
export class TargetMissing extends Schema.TaggedError<TargetMissing>()("TargetMissing", {}) {}

/** A remove whose name matches no Rift of the source. */
export class NoSuchRift extends Schema.TaggedError<NoSuchRift>()("NoSuchRift", {
  name: Schema.String,
  source: Schema.String,
  rifts: Schema.Array(Schema.String),
}) {}

/** Why the tool did not act on its input, before asking Rift. */
export type InputRefused = BranchMissing | TargetMissing | NoSuchRift

/** The directory name a branch makes, as `workrift` names it: `/` and spaces become `-`, other punctuation goes. */
export const workspaceName = (branch: string): string =>
  branch
    .replace(/[/\s]/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/^-+|-+$/g, "")

/** The last segment of a path. */
export const baseName = (path: string): string => path.replace(/\/+$/, "").split("/").pop() ?? path

/** Where a Rift's HEAD is: its branch, or the detached commit. */
const at = (workspace: Workspace): string => (workspace.branch === undefined ? `detached at ${workspace.head}` : `branch ${workspace.branch}`)

/** A Rift's unsaved work in a few words. */
export const stateOf = (workspace: Workspace): string => {
  if (!workspace.git) return "not a Git checkout"
  const parts = [
    ...(workspace.uncommitted.length > 0 ? [`${workspace.uncommitted.length} uncommitted`] : []),
    ...(workspace.unpushed.length > 0 ? [`${workspace.unpushed.length} unpushed`] : []),
    ...(workspace.stashes > 0 ? [`${workspace.stashes} stashed`] : []),
    ...(workspace.children.length > 0 ? [`${workspace.children.length} Rift(s) of its own`] : []),
  ]
  return parts.length === 0 ? "clean" : parts.join(", ")
}

/** The answer to a create. */
export const created = (workspace: Workspace, source: string): string =>
  [
    `Created the Rift ${workspace.path} from ${source}, on ${at(workspace)}.`,
    `This session still runs in its own directory. To work in the Rift, move the session there with the session_move tool (directory: "${workspace.path}"), or give each shell call workdir "${workspace.path}".`,
  ].join("\n")

/** The answer to a list. */
export const listed = (source: string, workspaces: ReadonlyArray<Workspace>): string =>
  workspaces.length === 0
    ? `The warm source ${source} has no Rifts.`
    : [`Rifts of ${source}:`, ...workspaces.map((workspace) => `- ${workspace.path} · ${at(workspace)} · ${stateOf(workspace)}`)].join("\n")

/** The answer to a remove. */
export const removed = (workspace: Workspace): string =>
  `Moved the Rift ${workspace.path} (${at(workspace)}) to Rift's trash${stateOf(workspace) === "clean" ? "" : `; it held ${stateOf(workspace)}`}.`

/** What the model reads when its input names too little. */
export const explainInput = (refusal: InputRefused): string => {
  switch (refusal._tag) {
    case "BranchMissing":
      return 'create needs a branch (or a name, which becomes the branch): { action: "create", branch: "feat/x" }.'
    case "TargetMissing":
      return 'remove needs the Rift: { action: "remove", name: "feat-x" } or { action: "remove", path: "/…/.rifts/repo/feat-x" }.'
    case "NoSuchRift":
      return refusal.rifts.length === 0
        ? `The warm source ${refusal.source} has no Rift named ${refusal.name}; it has no Rifts.`
        : `The warm source ${refusal.source} has no Rift named ${refusal.name}. Its Rifts:\n${refusal.rifts.map((path) => `  ${path}`).join("\n")}`
  }
}
