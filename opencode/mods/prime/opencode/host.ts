// The Prime look's Host (tui/host.ts), from OpenCode's TUI plugin context.
// Every read delegates to the context when it is called and hands the host's
// value over unchanged, so a read inside a Solid computation stays reactive;
// the compiler checks that the host's values fit the look's own types.
// The part, the context usage and the goal are worked out here from the
// host's base reads (`partOf`, `contextUsage`, `opencode/goal.ts`).
import { familyReader } from "@dotfiles/opencode-subagents/solid/reader"
import type { Plugin } from "@opencode/plugin/tui"
import type { Goal } from "../goal.ts"
import { partOf } from "../session.ts"
import type { Host } from "../tui/host.ts"
import { contextUsage } from "../usage.ts"
import { openPending } from "./pending.ts"
import { openShells } from "./shells.ts"
import { cancelWake, readWakes } from "./wakes.ts"

/** The Host over `context`, with each session's goal read through `goal` (`goals` in opencode/goal.ts). */
export function host(context: Plugin.Context, goal: (sessionID: string) => Goal | undefined): Host {
  const data = context.data
  // The rows, the dock's count and the hints all read the family; a token re-reads only its own message.
  const family = familyReader()
  return {
    theme: () => context.theme,
    version: () => context.app.version,
    session: (sessionID) => data.session.get(sessionID),
    sessions: () => data.session.list(),
    messages: (sessionID) => data.session.message.list(sessionID),
    message: (sessionID, messageID) => data.session.message.get(sessionID, messageID),
    part: (sessionID, messageID, partID) => partOf(data.session.message.get(sessionID, messageID), partID),
    cost: (sessionID) => data.session.cost(sessionID),
    status: (sessionID) => data.session.status(sessionID),
    usage: (sessionID) => {
      const session = data.session.get(sessionID)
      if (!session) return undefined
      const models = data.location.model.list(session.location)
      return contextUsage(
        data.session.message.list(sessionID),
        (model) => models?.find((item) => item.providerID === model.providerID && item.id === model.id)?.limit.context,
        session.revert?.messageID,
      )
    },
    goal,
    pending: (sessionID) => data.session.pending.list(sessionID),
    openPending: (sessionID, inboxID) => void openPending(context, sessionID, inboxID),
    wakes: (sessionID) => readWakes(context, sessionID),
    familyIDs: (sessionID) => data.session.family(sessionID),
    // The same registry as the shells count, so a row waits on a shell exactly while the dock counts it.
    subagents: (sessionID) => family(data, sessionID, context.location),
    shells: (sessionID) =>
      data.shell.list(context.location).filter((shell) => shell.metadata.sessionID === sessionID).length,
    model: () => context.ui.model.current(),
    path: (directory) => context.ui.format.path(directory),
    route: () => {
      const current = context.ui.router.current()
      return current.type === "session" ? current.sessionID : undefined
    },
    open: (sessionID) => context.ui.router.navigate({ type: "session", sessionID }),
    selecting: () => Boolean(context.renderer.getSelection()?.getSelectedText()),
    openSubagents: () => {
      context.keymap.dispatch("session.child.first")
    },
    openShells: (sessionID) => void openShells(context, sessionID),
    cancelWake: (sessionID, id) => cancelWake(context, sessionID, id),
    showDetail: (title, message) => void context.ui.dialog.alert({ title, message }),
    notify: (message, tone) => context.ui.toast.show({ message, variant: tone }),
    // Priority 1, as the host's own tabs bind theirs; the tab mounts only while it is the active one.
    composerKeys: (commands) => context.keymap.layer(() => ({ mode: "composer", priority: 1, commands: [...commands()] })),
    Markdown: context.ui.Markdown,
    Code: context.ui.Code,
  }
}
