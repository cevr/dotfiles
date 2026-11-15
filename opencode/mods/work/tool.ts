// The `work` tool's own words (cmd/work), and the alias `rift` it keeps for one release: the same input
// and the same answers as cmd/rift's `rift` tool, over Ergo's `work` binary. The answers themselves are
// rift.ts's, model.ts's and land.ts's, one model under both roots.

/** The day the alias `rift` (and the land input's `rifts`) goes: work-cleanup deletes both. */
export const RIFT_ALIAS_REMOVAL = "2026-12-06"

export const WORK_DESCRIPTION = [
  "Isolated workspaces: a copy-on-write clone of the repository's base (Ergo's `work`), with its installed packages and build output, on its own branch. Use it in place of git worktrees, and in place of any script of your own around work, rift or workrift.",
  'create ({ action: "create", branch, name? }) answers the workspace\'s directory and branch; it does not move this session. On the workbox it runs `workrift create <branch>`, which first refreshes the base and carries over gh stack metadata, and names the workspace after the branch. A name a removed workspace still holds (in the trash until a gc) gets a suffix, and the answer says so.',
  'list ({ action: "list" }) shows each workspace with its branch and its unsaved work. remove ({ action: "remove", name | path, withChildren? }) moves a workspace to the trash once its work is committed and pushed; it refuses one with uncommitted changes, stashes or unpushed commits and names them, unless force: true; it refuses the integration and post-land workspaces while a land\'s step runs there, force or not.',
  'land ({ action: "land", workspaces: ["feat-x", "feat-y"] }) lands the workspaces (each by path, name or branch) as one batch: in the base\'s integration workspace it merges each one\'s branch in order onto origin\'s newest default branch, checks the merge, pushes to the default branch and trashes the landed workspaces. A conflict or a red check stops before the push and names the workspace. Its accept check and the repository\'s post-land step then run in the background, each in a workspace of its own, and wake this session with the result; the next land does not wait for them. Commit everything first. A repository that lands through pull requests (`rift.push` false) merges and checks the same way, pushes no default branch, keeps every workspace and answers each green or red.',
  "A root session that runs orchestrate units makes and lands its units' workspaces with the orchestrate tool's lane and land, not with work create and land.",
  'On the workbox, { action: "refresh" | "check" | "deps" | "sources" | "prune" | "storage" | "init" } runs `workrift <action>` (prune only as --dry-run; storage is the workspace file system\'s check and use; init needs repository). Elsewhere they answer that they need the workbox.',
  "Never do feature work in the base itself.",
].join("\n\n")

/** The alias's description: the alias sentence, then the tool's own. */
export const RIFT_ALIAS_DESCRIPTION = `Alias of the \`work\` tool; removed ${RIFT_ALIAS_REMOVAL}. Call \`work\` with the same input.\n\n${WORK_DESCRIPTION}`
