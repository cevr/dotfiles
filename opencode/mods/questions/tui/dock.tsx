// Background questions above the composer: the one-line tray while questions
// are open. Thin: it reads the questions of the session on screen and of its
// subagents (tray.ts `under`) over the questions RPC, again on every `changed`
// event and every 2 seconds, and keeps the last reading when a read fails.
// /answer, shift+← and a click on the tray (cmd/questions/setup.ts) open the host's question form
// for what it read, through `Questions` (questions.ts); the host draws that
// form in the composer's place, so the tray is hidden while it shows.
// cmd/questions/setup.ts registers the dock on `session.composer.top`.
import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { Option } from "effect"
import { createMemo, onCleanup, Show } from "solid-js"
import { type Open, QUESTIONS } from "../question.ts"
import { changedSession, decodeOpen } from "../reading.ts"
import { under } from "../tray.ts"
import type { Questions } from "./questions.tsx"
import { Tray } from "./tray.tsx"

/** How often the questions are read again. */
const POLL_MS = 2000
/** The sidebar's columns, when it shows beside the transcript. */
const SIDEBAR = 42
/** The transcript's inset on both sides, and the glyph and its space. */
const CHROME = 6

export function Dock(props: { ctx: Plugin.Context; sessionID: string; questions: Questions; open: () => void }) {
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

  const width = () => Math.max(20, dimensions().width - CHROME - (ctx.ui.sidebar.visible(props.sessionID) ? SIDEBAR : 0))
  return (
    <Show when={questions().length > 0}>
      <Tray ctx={ctx} questions={questions()} width={width()} open={props.open} />
    </Show>
  )
}
