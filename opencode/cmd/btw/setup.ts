/**
 * The btw plugin's setup, apart from the JSX that draws the pane so the seam
 * test can run it (Bun's test runner has no Solid JSX transform; OpenCode's
 * TUI preloads one). It picks the OpenCode implementation of each contract
 * (the session client for Forks, the message list and session status for
 * ForkReadings, durable plugin storage for SideQuestions), builds the btw
 * model once, and registers /btw and the session.panel slot, and hands the
 * controller the host's events by the session each is about. `draw` renders
 * the pane. It returns the cleanup that stops the controller listening, as a
 * plugin's setup does (the host does not own `data.listen`).
 */
import { layer as btwLayer, Btw } from "@dotfiles/opencode-btw/model"
import { sessionOf } from "@dotfiles/opencode-btw/opencode/events"
import * as OpencodeForks from "@dotfiles/opencode-btw/opencode/forks"
import * as OpencodeReadings from "@dotfiles/opencode-btw/opencode/readings"
import * as OpencodeStore from "@dotfiles/opencode-btw/opencode/store"
import { type Controller, controller } from "@dotfiles/opencode-btw/tui/controller"
import type { Plugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid"
import { Effect, Layer } from "effect"

/** The panel's name in the host's session.panel slot. */
export const PANEL = "btw"

/** The session.panel slot's input, as far as the pane reads it. */
export interface PanelInput {
  readonly focused: boolean
  readonly presentation: "panel" | "fullscreen"
  readonly close: () => void
}

export type Draw = (input: { readonly sessionID: string; readonly panel: PanelInput; readonly controller: Controller }) => JSX.Element

export const setup = (ctx: Plugin.Context, draw: Draw) => {
  const [stored, write] = ctx.storage.store<OpencodeStore.Stored>(OpencodeStore.STORE_KEY, { initial: OpencodeStore.EMPTY })
  const live = Layer.mergeAll(
    OpencodeForks.layer(ctx.client.session),
    OpencodeReadings.layer({ messages: (input) => ctx.client.message.list(input), status: (sessionID) => ctx.data.session.status(sessionID) }),
    OpencodeStore.layer({ read: () => stored, write }),
  )
  const btw = Effect.runSync(Btw.pipe(Effect.provide(btwLayer.pipe(Layer.provide(live)))))
  const control = controller({
    btw,
    state: (sessionID) => OpencodeStore.stateOf(stored, sessionID),
    listen: (handler) =>
      ctx.data.listen(({ details }) => {
        const about = sessionOf(details)
        if (about !== undefined) handler(about)
      }),
    notify: (message) => ctx.ui.toast.show({ message, variant: "warning" }),
  })

  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "dotfiles-opencode.btw.ask",
        title: "Ask on the side (btw)",
        description: "Fork this session into a side session and ask it a question in a pane; the session keeps working",
        group: "Session",
        palette: true,
        slash: { name: "btw", aliases: ["side"], arguments: true },
        run(input) {
          const route = ctx.ui.router.current()
          if (route.type !== "session") return ctx.ui.toast.show({ message: "btw: open a session first", variant: "warning" })
          ctx.ui.panel.open(PANEL)
          void control.ask(route.sessionID, input ?? "")
        },
      },
    ],
  }))
  ctx.ui.slot({
    append: "session.panel",
    render: (input) => (input.name === PANEL ? draw({ sessionID: input.sessionID, panel: input, controller: control }) : null),
  })
  return control.dispose
}
