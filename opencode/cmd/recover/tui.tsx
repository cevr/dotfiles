// The recover mod's TUI plugin: the composition root of
// @dotfiles/opencode-recover. When the session on screen is idle and its
// directory is gone (a removed rift or worktree), it moves the session back to
// the newest earlier location that still exists and says so in a toast. With
// no such location, the host's own "Session location unavailable" prompt
// stays, as it would without the plugin. It has no server half: the move is
// the TUI client's own session API.
import * as FilesystemDirectories from "@dotfiles/opencode-recover/filesystem/directories"
import { recover } from "@dotfiles/opencode-recover/model"
import * as OpencodeSessions from "@dotfiles/opencode-recover/opencode/sessions"
import { movedNotice } from "@dotfiles/opencode-recover/recover"
import { Plugin } from "@opencode/plugin/tui"
import { Effect, Layer } from "effect"
import { createEffect, createRoot } from "solid-js"

export default Plugin.define({
  id: "dotfiles-opencode.recover",
  setup(context) {
    const services = Layer.mergeAll(
      OpencodeSessions.layer({
        messages: (input) => context.client.message.list(input),
        move: (input) => context.client.session.move(input),
      }),
      FilesystemDirectories.layer,
    )
    // A missing directory is tried once per session and directory; a present
    // one is looked at again on each visit, since it may be gone by then.
    const tried = new Set<string>()
    const attempt = (sessionID: string, directory: string, key: string) =>
      recover(sessionID, directory).pipe(
        Effect.provide(services),
        Effect.match({
          onSuccess: (outcome) => {
            if (outcome._tag === "Present") tried.delete(key)
            if (outcome._tag === "Moved")
              context.ui.toast.show({ message: movedNotice(outcome.target, directory, context.ui.format.path), variant: "info" })
          },
          onFailure: (error) => context.ui.toast.show({ title: "Failed to return session", message: error.message, variant: "error" }),
        }),
      )
    return createRoot((dispose) => {
      createEffect(() => {
        const route = context.ui.router.current()
        if (route.type !== "session") return
        const directory = context.data.session.get(route.sessionID)?.location.directory
        if (directory === undefined || context.data.session.status(route.sessionID) !== "idle") return
        const key = `${route.sessionID}\0${directory}`
        if (tried.has(key)) return
        tried.add(key)
        void Effect.runPromise(attempt(route.sessionID, directory, key))
      })
      return dispose
    })
  },
})
