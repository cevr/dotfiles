// The /btw pane (gent's ForkPane), in the host's session panel: the fork's
// name, each question it was asked with its answer as the transcript draws
// markdown, a question on its way, and an ask line. The answers are the
// controller's reading of the fork, which it keeps current while the pane is
// open; nothing here writes to the session the fork came from except ctrl+s.
// Keys while the pane has focus: Enter asks the line (or, on an empty line,
// opens the fork as the session on screen), ctrl+s brings the newest answer
// back, Esc closes. cmd/btw/tui.tsx registers it.
import type { Plugin } from "@opencode/plugin/tui"
import type { InputRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { canBringBack, hints, paneTitle, rows } from "../pane.ts"
import type { Controller } from "./controller.tsx"

type PanelInput = { readonly focused: boolean; readonly presentation: "panel" | "fullscreen"; readonly close: () => void }

export function Pane(props: { ctx: Plugin.Context; sessionID: string; panel: PanelInput; controller: Controller }) {
  const ctx = props.ctx
  const theme = () => ctx.theme
  const fork = createMemo(() => props.controller.fork(props.sessionID))
  const forkID = () => fork()?.sessionID
  const turns = () => props.controller.reading(props.sessionID).turns
  const replying = () => props.controller.reading(props.sessionID).replying
  const [draft, setDraft] = createSignal("")
  let input: InputRenderable | undefined

  // Reads the fork when the pane opens or follows a new one, and as it answers.
  onCleanup(props.controller.watch(props.sessionID))
  createEffect(
    on(forkID, (id) => {
      if (id !== undefined) void props.controller.refresh(props.sessionID)
    }),
  )

  // The ask line takes the keys whenever the pane has focus.
  createEffect(() => {
    if (!props.panel.focused) return input?.blur()
    setTimeout(() => {
      if (input !== undefined && !input.isDestroyed && props.panel.focused) input.focus()
    }, 1)
  })

  const clear = () => {
    setDraft("")
    if (input !== undefined && !input.isDestroyed) input.value = ""
  }

  const submit = async () => {
    const question = draft()
    const current = fork()
    if (question.trim().length === 0 && current !== undefined) {
      // Enter on an empty line goes to the fork, as Enter on a session row does.
      props.panel.close()
      return ctx.ui.router.navigate({ type: "session", sessionID: current.sessionID })
    }
    if (await props.controller.followUp(props.sessionID, question)) clear()
  }

  const bringBack = async () => {
    if (await props.controller.bringBack(props.sessionID)) props.panel.close()
  }

  ctx.keymap.layer(() => ({
    enabled: () => props.panel.focused,
    priority: 1,
    commands: [
      { title: "Close the btw pane", group: "btw", bind: "escape", run: () => props.panel.close() },
      { title: "Bring the answer back", group: "btw", bind: "ctrl+s", run: () => void bringBack() },
      { title: "Ask the fork, or open it", group: "btw", bind: "return", run: () => void submit() },
    ],
  }))

  const surface = () => (props.panel.presentation === "panel" ? theme().background.raised.base : theme().background.base)
  const muted = (text: string) => <text fg={theme().text.muted}>{text}</text>
  const question = (text: string) => (
    <text fg={theme().text.action.primary.base} attributes={1}>
      {text}
    </text>
  )
  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <text fg={theme().text.base} attributes={1}>
        {paneTitle(fork())}
      </text>
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        <For each={rows(turns(), replying(), props.controller.pending(props.sessionID))}>
          {(row, index) => (
            <box flexDirection="column" marginTop={index() === 0 ? 1 : 2}>
              {question(row.question)}
              <Show when={row._tag === "Answer" ? row : undefined} fallback={muted(row._tag === "Waiting" ? row.note : "")}>
                {(answer) => <ctx.ui.Markdown content={answer().answer} streaming={answer().streaming} bg={surface()} />}
              </Show>
              <Show when={row.error}>{(error) => <text fg={theme().text.feedback.error.base}>{error()}</text>}</Show>
            </box>
          )}
        </For>
      </scrollbox>
      <box flexDirection="row" marginTop={1}>
        <text fg={theme().text.muted}>ask › </text>
        <input
          flexGrow={1}
          placeholder={fork() === undefined ? "a question on the side" : "a follow-up"}
          placeholderColor={theme().text.faint}
          textColor={theme().text.base}
          focusedTextColor={theme().text.base}
          backgroundColor={surface()}
          focusedBackgroundColor={surface()}
          cursorColor={theme().text.base}
          onInput={setDraft}
          ref={(value: InputRenderable) => (input = value)}
        />
      </box>
      {muted(hints({ draft: draft(), fork: fork() !== undefined, canBringBack: canBringBack(fork(), turns(), replying()) }))}
    </box>
  )
}
