// The `rift` tool: an isolated workspace for a branch, made from the
// repository's warm source, listed with its state, and removed when its work
// is done. It replaces OpenCode's worktree tools, which do not know Rift.
// One input with an `action`, like the shell tool's; the words the model
// reads for each answer and each refusal are here.
import { Schema } from "effect"
import type { Workspace } from "./workspace.ts"

/** The actions that run the workbox's own scripts as they are. */
export const WORKBOX_ACTIONS = ["init", "refresh", "deps", "check", "sources", "prune", "storage"] as const

export const RiftInput = Schema.Struct({
  action: Schema.Literals(["create", "list", "remove", "land", ...WORKBOX_ACTIONS]).annotate({
    description:
      "create: a new Rift for a branch. list: the Rifts of this repository's warm source, with their branch and unsaved work. remove: move a Rift to the trash when its work is done. land: merge the Rifts onto main as one batch, gate once, push, remove them, check in the background (a PR repository, rift.push false: gate and check only, and answer each Rift green or red). Workbox only (workrift): init, refresh, deps, check, sources, prune (a dry run), storage.",
  }),
  name: Schema.optional(Schema.String).annotate({
    description: "create: the Rift's directory name (default: the branch, with / as -). remove and deps: the Rift, by that name.",
  }),
  branch: Schema.optional(Schema.String).annotate({
    description: "create: the branch to check out: the local branch, else the remote one, else a new branch from the source's HEAD. Default: the name.",
  }),
  source: Schema.optional(Schema.String).annotate({
    description: "create, list, refresh and check: a directory of the repository whose warm source to use. Default: this session's directory.",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "remove and deps: the Rift's directory, in place of its name. init: where to clone (default: /workspaces/<repository>).",
  }),
  rifts: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "land: the Rifts to land, in order, each by name or by path (a path starts with / or .).",
  }),
  repository: Schema.optional(Schema.String).annotate({ description: "init: the repository to clone as a new warm source (a Git URL)." }),
  force: Schema.optional(Schema.Boolean).annotate({
    description: "remove: remove it although it holds uncommitted changes, stashes or commits found nowhere else. Only when the user said to drop that work.",
  }),
  withChildren: Schema.optional(Schema.Boolean).annotate({
    description: "remove: remove the Rift's own Rifts with it (each still refused while it holds unsaved work, unless force).",
  }),
})
export type RiftInput = typeof RiftInput.Type

export const RIFT_DESCRIPTION = [
  "Isolated workspaces (Rifts): a copy-on-write copy of the repository's warm source, with its installed packages and build output, on its own branch. Use it in place of git worktrees, and in place of any script of your own around rift or workrift.",
  'create ({ action: "create", branch, name? }) answers the Rift\'s directory and branch; it does not move this session. On the workbox it runs `workrift create <branch>`, which first refreshes the warm source and carries over gh stack metadata, and names the Rift after the branch.',
  'list ({ action: "list" }) shows each Rift with its branch and its unsaved work. remove ({ action: "remove", name | path, withChildren? }) moves a Rift to the trash once its work is committed and pushed; it refuses one with uncommitted changes, stashes or unpushed commits and names them, unless force: true.',
  'land ({ action: "land", rifts: ["feat-x", "feat-y"] }) lands the Rifts as one batch, in the warm source\'s integration Rift (`integrate`): it starts at origin\'s newest default branch, merges each Rift\'s branch in order (a conflict in lock files or the repository\'s generated files is settled by writing them again; any other stops the batch, aborts the merge and names the Rift and the files), runs the repository\'s gate once (`rift.gate` in the warm source\'s Git config), pushes to the default branch and trashes the landed Rifts. Then its accept check (`rift.accept`) runs once, in the background, on everything the batch changed, and wakes this session with the result; a red one is fixed forward. A red gate stops before the push. Commit everything first. A repository that lands through pull requests sets `rift.push` false: land then merges, gates and checks the same way but pushes no default branch and keeps every Rift, and answers each Rift green or red (a conflict makes only that Rift red); with `rift.pushBranches` true a green Rift\'s own branch is pushed, for its PR.',
  'On the workbox, { action: "refresh" | "check" | "deps" | "sources" | "prune" | "storage" | "init" } runs `workrift <action>` (prune only as --dry-run; storage is the Rift file system\'s check and use; init needs repository). Elsewhere they answer that they need the workbox.',
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

/** A land that names no Rift. */
export class RiftsMissing extends Schema.TaggedError<RiftsMissing>()("RiftsMissing", {}) {}

/** An init that names no repository. */
export class RepositoryMissing extends Schema.TaggedError<RepositoryMissing>()("RepositoryMissing", {}) {}

/** Why the tool did not act on its input, before asking Rift. */
export type InputRefused = BranchMissing | TargetMissing | NoSuchRift | RiftsMissing | RepositoryMissing

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

/** The answer to a workbox command: what it printed. */
export const ranOnWorkbox = (command: string, output: string): string => {
  const said = output.trim()
  return said === "" ? `${command}: done, it printed nothing.` : `${command}:\n${said}`
}

/** What the model reads when a workbox command runs where there is no workrift. */
export const notOnWorkbox = (command: string): string =>
  `${command} runs the workbox's workrift, which this machine does not have. Here the rift tool offers create, list, remove and land.`

/** What the model reads when its input names too little. */
export const explainInput = (refusal: InputRefused): string => {
  switch (refusal._tag) {
    case "BranchMissing":
      return 'create needs a branch (or a name, which becomes the branch): { action: "create", branch: "feat/x" }.'
    case "TargetMissing":
      return 'remove needs the Rift: { action: "remove", name: "feat-x" } or { action: "remove", path: "/…/.rifts/repo/feat-x" }.'
    case "RiftsMissing":
      return 'land needs the Rifts to land, in order: { action: "land", rifts: ["feat-x"] }.'
    case "RepositoryMissing":
      return 'init needs the repository to clone: { action: "init", repository: "git@github.com:owner/repo.git", path? }.'
    case "NoSuchRift":
      return refusal.rifts.length === 0
        ? `The warm source ${refusal.source} has no Rift named ${refusal.name}; it has no Rifts.`
        : `The warm source ${refusal.source} has no Rift named ${refusal.name}. Its Rifts:\n${refusal.rifts.map((path) => `  ${path}`).join("\n")}`
  }
}
