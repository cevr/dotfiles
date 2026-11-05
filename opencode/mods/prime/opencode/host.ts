// The Prime look's Host (tui/host.ts), from OpenCode's TUI plugin context.
// Every read delegates to the context when it is called and hands the host's
// value over unchanged, so a read inside a Solid computation stays reactive;
// the compiler checks that the host's values fit the look's own types.
import { read } from "@dotfiles/opencode-subagents/opencode/view"
import type { Plugin } from "@opencode/plugin/tui"
import type { Host } from "../tui/host.ts"

/** The part of a plugin's `ui` that says whether a session's sidebar shows; a host without it leaves `sidebar` out. */
interface SidebarHost {
  readonly sidebar?: { visible(sessionID: string): boolean }
}

/**
 * Whether the host shows `sessionID`'s sidebar now, through the fork's
 * `ui.sidebar.visible`. A host without it never says so, and the rows always
 * show. `ui` is a plugin's `context.ui`, taken as any object so this compiles
 * against a host whose `UI` has no `sidebar` at all.
 */
export function sidebarShown(ui: object, sessionID: string): boolean {
  const host: SidebarHost = ui
  return host.sidebar?.visible(sessionID) ?? false
}

export function host(context: Plugin.Context): Host {
  const data = context.data
  return {
    theme: () => context.theme,
    version: () => context.app.version,
    session: (sessionID) => data.session.get(sessionID),
    sessions: () => data.session.list(),
    messages: (sessionID) => data.session.message.list(sessionID),
    message: (sessionID, messageID) => data.session.message.get(sessionID, messageID),
    part: (sessionID, messageID, partID) => data.session.part.get(sessionID, messageID, partID),
    cost: (sessionID) => data.session.cost(sessionID),
    status: (sessionID) => data.session.status(sessionID),
    usage: (sessionID) => data.session.usage(sessionID),
    hasGoal: (sessionID) => data.session.goal(sessionID) !== undefined,
    familyIDs: (sessionID) => data.session.family(sessionID),
    subagents: (sessionID) => read(data, sessionID),
    shells: (sessionID) =>
      data.shell.list(context.location).filter((shell) => shell.metadata.sessionID === sessionID).length,
    model: () => context.ui.model.current(),
    path: (directory) => context.ui.format.path(directory),
    sidebarShown: (sessionID) => sidebarShown(context.ui, sessionID),
    route: () => {
      const current = context.ui.router.current()
      return current.type === "session" ? current.sessionID : undefined
    },
    open: (sessionID) => context.ui.router.navigate({ type: "session", sessionID }),
    selecting: () => Boolean(context.renderer.getSelection()?.getSelectedText()),
    openSubagents: () => {
      context.keymap.dispatch("session.child.first")
    },
    Markdown: context.ui.Markdown,
    Code: context.ui.Code,
  }
}
