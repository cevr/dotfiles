// Background questions above the composer: the one-line tray while questions
// are open, and the /answer pane in its place once opened. Thin: it reads the
// questions of the session on screen and of its subagents (tray.ts `under`)
// over the questions RPC, again on every `changed` event and every 2 seconds,
// and keeps the last reading when a read fails. The pane (pane.tsx) sends an
// answer or a dismissal; the question leaves the list at once, and a call that
// fails reads the list again, so the question comes back, with a toast.
// cmd/questions/setup.ts registers it on `session.composer.top` and opens the
// pane from /answer and shift+← through `Questions` (questions.ts).
import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { Option, Schema } from "effect"
import { createEffect, createMemo, onCleanup, Show } from "solid-js"
import { type Open, type Question, QUESTIONS, Reply } from "../question.ts"
import { changedSession, decodeOpen } from "../reading.ts"
import { under } from "../tray.ts"
import { Pane } from "./pane.tsx"
import type { Questions } from "./questions.tsx"
import { Tray } from "./tray.tsx"

const decodeReply = Schema.decodeUnknownOption(Reply)

/** How often the questions are read again. */
const POLL_MS = 2000
/** The sidebar's columns, when it shows beside the transcript. */
const SIDEBAR = 42
/** The transcript's inset on both sides, and the glyph and its space. */
const CHROME = 6

export function Dock(props: { ctx: Plugin.Context; sessionID: string; questions: Questions }) {
  const ctx = props.ctx
  const dimensions = useTerminalDimensions()
  const members = createMemo(() => {
    const family = ctx.data.session.family(props.sessionID)
    return under(
      props.sessionID,
      family.map((id) => ({ id, parentID: ctx.data.session.get(id)?.parentID })),
    )
  })
  const questions = () => props.questions.open(props.sessionID)
  const abort = new AbortController()
  const options = () => ({ location: ctx.location, signal: abort.signal })
  let pending = false
  let again = false
  let closed = false

  const refresh = async (): Promise<void> => {
    if (pending) {
      again = true
      return
    }
    pending = true
    const sessionID = props.sessionID
    const answer = await ctx.client
      .rpc(QUESTIONS)
      .open({ sessionIDs: [...members()] }, options())
      .then(decodeOpen, () => Option.none<Open>())
    pending = false
    if (closed) return
    if (Option.isSome(answer)) props.questions.setOpen(sessionID, answer.value.questions)
    if (again) {
      again = false
      return refresh()
    }
  }

  const without = (question: Question) =>
    props.questions.setOpen(
      props.sessionID,
      questions().filter((other) => other.sessionID !== question.sessionID || other.id !== question.id),
    )

  /** Send `call` for `question`: it leaves the list now; a failed call or a refusal says so. */
  const send = async (question: Question, call: Promise<unknown>, failed: string) => {
    without(question)
    const reply = await call.then(decodeReply, () => Option.none<Reply>())
    if (closed) return
    if (Option.isNone(reply)) ctx.ui.toast.show({ message: failed, variant: "error" })
    else if (!reply.value.ok) ctx.ui.toast.show({ message: reply.value.message ?? failed, variant: "warning" })
    await refresh()
  }

  const answer = (question: Question, text: string) =>
    send(
      question,
      ctx.client.rpc(QUESTIONS).answer({ sessionID: question.sessionID, id: question.id, answer: text }, options()),
      `The answer to ${question.id} was not sent`,
    )
  const dismiss = (question: Question) =>
    send(question, ctx.client.rpc(QUESTIONS).dismiss({ sessionID: question.sessionID, id: question.id }, options()), `${question.id} was not dismissed`)

  void refresh()
  const timer = setInterval(() => void refresh(), POLL_MS)
  const stop = ctx.data.listen((event) => {
    const changed = changedSession(event.details)
    if (changed !== undefined && members().includes(changed)) void refresh()
  })
  onCleanup(() => {
    closed = true
    abort.abort()
    clearInterval(timer)
    stop()
  })

  const paneOpen = () => props.questions.pane() === props.sessionID
  const close = () => props.questions.setPane(undefined)
  // The pane closes with the last question, so a question asked later shows in the tray, not in a pane nobody opened.
  createEffect(() => {
    if (paneOpen() && questions().length === 0) close()
  })
  const width = () => Math.max(20, dimensions().width - CHROME - (ctx.ui.sidebar.visible(props.sessionID) ? SIDEBAR : 0))
  /** Who asked, when it was not the session on screen. */
  const askerOf = (question: Question) => {
    if (question.sessionID === props.sessionID) return undefined
    const session = ctx.data.session.get(question.sessionID)
    return session?.agent ?? session?.title ?? question.sessionID
  }
  return (
    <Show when={questions().length > 0}>
      <Show when={paneOpen()} fallback={<Tray ctx={ctx} questions={questions()} width={width()} />}>
        <Pane
          ctx={ctx}
          questions={questions()}
          askerOf={askerOf}
          onAnswer={(question, text) => void answer(question, text)}
          onDismiss={(question) => void dismiss(question)}
          onClose={close}
        />
      </Show>
    </Show>
  )
}
