// The /answer pane, in the tray's place above the composer: the oldest open
// question, its choices with the assumed one marked and the cursor on it
// (choices.ts), and a line to type an answer of one's own. While it shows, it
// holds the keymap mode `questions` and the focus: ↑↓ move, Enter answers,
// ctrl+x arms and a second ctrl+x dismisses (the agent is not told), Esc
// disarms or closes. Closing hands the focus back to what held it. dock.tsx
// draws it.
import type { Plugin } from "@opencode/plugin/tui"
import type { InputRenderable, Renderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { answerOf, ARMED, choicesOf, FREE_TEXT, HINTS, moved, paneTitle } from "../choices.ts"
import type { Question } from "../question.ts"
import { GLYPH } from "../tray.ts"

export const MODE = "questions"

export function Pane(props: {
  ctx: Plugin.Context
  questions: ReadonlyArray<Question>
  askerOf: (question: Question) => string | undefined
  onAnswer: (question: Question, answer: string) => void
  onDismiss: (question: Question) => void
  onClose: () => void
}) {
  const ctx = props.ctx
  const question = createMemo(() => props.questions[0])
  const choices = createMemo(() => {
    const current = question()
    return current === undefined ? { rows: [], assumed: 0 } : choicesOf(current)
  })
  const [cursor, setCursor] = createSignal(0)
  const [typed, setTyped] = createSignal("")
  const [armed, setArmed] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  let input: InputRenderable | undefined

  // A new question starts on its assumption, with nothing typed and nothing armed.
  createEffect(
    on(
      () => {
        const current = question()
        return current === undefined ? "" : `${current.sessionID}/${current.id}`
      },
      () => {
        setCursor(choices().assumed)
        setTyped("")
        setArmed(false)
        if (input !== undefined && !input.isDestroyed) input.value = ""
      },
    ),
  )

  const restore: Renderable | null = ctx.renderer.currentFocusedRenderable
  const pop = ctx.keymap.mode.push(MODE)
  const clock = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => {
    clearInterval(clock)
    pop()
    setTimeout(() => {
      if (restore !== null && !restore.isDestroyed) restore.focus()
    }, 1)
  })

  const submit = () => {
    const current = question()
    if (current === undefined) return
    const answer = answerOf(choices(), cursor(), typed())
    if (answer === undefined) return
    props.onAnswer(current, answer)
  }
  const dismiss = () => {
    const current = question()
    if (current === undefined) return
    if (!armed()) return setArmed(true)
    setArmed(false)
    props.onDismiss(current)
  }
  const move = (delta: number) => {
    setArmed(false)
    setCursor((row) => moved(row, delta, choices()))
  }

  ctx.keymap.layer(() => ({
    mode: MODE,
    commands: [
      { title: "Previous choice", group: "Questions", bind: "up", run: () => move(-1) },
      { title: "Next choice", group: "Questions", bind: "down", run: () => move(1) },
      { title: "Answer", group: "Questions", bind: "return", run: submit },
      { title: "Dismiss the question", group: "Questions", bind: "ctrl+x", run: dismiss },
      {
        title: "Close",
        group: "Questions",
        bind: "escape",
        run: () => {
          if (armed()) setArmed(false)
          else props.onClose()
        },
      },
    ],
  }))

  const theme = () => ctx.theme
  const freeRow = () => choices().rows.length
  return (
    <Show when={question()}>
      {(current) => (
        <box flexDirection="column" paddingLeft={2} paddingRight={2}>
          <text fg={theme().text.muted} wrapMode="none">
            <span style={{ fg: theme().text.feedback.warning.base }}>{`${GLYPH} `}</span>
            {paneTitle(current(), props.questions.length, now(), props.askerOf(current()))}
          </text>
          <text fg={theme().text.base}>
            <b>{current().question}</b>
          </text>
          <For each={choices().rows}>
            {(row, index) => (
              <text fg={index() === cursor() ? theme().text.base : theme().text.muted} wrapMode="none">
                {index() === cursor() ? "▸ " : "  "}
                {row.label}
                <Show when={row.description}>{(description) => <span style={{ fg: theme().text.muted }}>{`  ${description()}`}</span>}</Show>
              </text>
            )}
          </For>
          <box flexDirection="row">
            <text fg={cursor() === freeRow() ? theme().text.base : theme().text.muted} wrapMode="none">
              {cursor() === freeRow() ? "▸ " : "  "}
            </text>
            <input
              flexGrow={1}
              placeholder={FREE_TEXT}
              placeholderColor={theme().text.muted}
              textColor={theme().text.base}
              focusedTextColor={theme().text.base}
              onInput={(value: string) => {
                setTyped(value)
                if (value.trim() !== "") setCursor(freeRow())
              }}
              ref={(renderable: InputRenderable) => {
                input = renderable
                setTimeout(() => {
                  if (!renderable.isDestroyed) renderable.focus()
                }, 1)
              }}
            />
          </box>
          <text fg={armed() ? theme().text.feedback.warning.base : theme().text.muted} wrapMode="none">
            {armed() ? ARMED : HINTS}
          </text>
        </box>
      )}
    </Show>
  )
}
