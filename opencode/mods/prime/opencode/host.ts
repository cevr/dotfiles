// The Prime look's Host (tui/host.ts), from OpenCode's TUI plugin context.
// Every read delegates to the context when it is called and hands the host's
// value over unchanged, so a read inside a Solid computation stays reactive;
// the compiler checks that the host's values fit the look's own types.
import { familyReader } from "@dotfiles/opencode-subagents/solid/reader"
import type { Plugin } from "@opencode/plugin/tui"
import type { Host } from "../tui/host.ts"
import { openShells } from "./shells.ts"
import { readWakes } from "./wakes.ts"

export function host(context: Plugin.Context): Host {
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
    part: (sessionID, messageID, partID) => data.session.part.get(sessionID, messageID, partID),
    cost: (sessionID) => data.session.cost(sessionID),
    status: (sessionID) => data.session.status(sessionID),
    usage: (sessionID) => data.session.usage(sessionID),
    goal: (sessionID) => data.session.goal(sessionID),
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
    Markdown: context.ui.Markdown,
    Code: context.ui.Code,
  }
}
