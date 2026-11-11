// The open background questions (`ask_user_async`) of the sessions herdr
// reports, as the questions plugin (mods/questions) keeps them. They live in
// that plugin's server, so they are read over its RPC: when the sessions
// change, again on every `changed` event naming one of them (an ask, a
// withdrawal, an answer, a dismissal), and every POLL_MS as a backstop for a
// missed event. Never per render. A failed read keeps the last reading; with
// no questions plugin loaded, none are open. Create it inside a Solid root;
// disposing the root stops it.
import { changedSession, decodeOpen, sameQuestions } from "@dotfiles/opencode-questions/reading"
import type { Question } from "@dotfiles/opencode-questions/question"
import { labelOf } from "@dotfiles/opencode-questions/tray"
import { Option } from "effect"
import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import type { Asked } from "../activity.ts"
import type { AskedOf } from "./view.ts"

/** How often the questions are read again without an event. */
export const POLL_MS = 10_000

/** The questions plugin as the reader reaches it; the TUI plugin's context provides both. */
export interface Source {
  /** The questions RPC's `open` for `sessionIDs`: its raw answer; rejects when it cannot be read. */
  readonly open: (sessionIDs: ReadonlyArray<string>, signal: AbortSignal) => Promise<unknown>
  /** The TUI's event stream (`context.data.listen`), where the RPC's `changed` events arrive. */
  readonly listen: (handler: (event: { readonly details: unknown }) => void) => () => void
}

const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.length === b.length && a.every((id, at) => id === b[at])

/** Follow the open questions of `sessions` (the view's members); what each session has open, oldest first. */
export const followAsked = (source: Source, sessions: Accessor<ReadonlyArray<string>>): AskedOf => {
  const members = createMemo(sessions, [], { equals: sameIds })
  const [open, setOpen] = createSignal<ReadonlyArray<Question>>([], { equals: sameQuestions })
  const abort = new AbortController()
  let pending = false
  let again = false

  const refresh = async (): Promise<void> => {
    if (pending) {
      again = true
      return
    }
    const sessionIDs = untrack(members)
    if (sessionIDs.length === 0) return void setOpen([])
    pending = true
    const answer = await source.open(sessionIDs, abort.signal).then(decodeOpen, () => Option.none())
    pending = false
    if (abort.signal.aborted) return
    if (Option.isSome(answer)) setOpen(answer.value.questions)
    if (again) {
      again = false
      return refresh()
    }
  }

  createEffect(on(members, () => void refresh()))
  const timer = setInterval(() => void refresh(), POLL_MS)
  const stop = source.listen((event) => {
    const changed = changedSession(event.details)
    if (changed !== undefined && untrack(members).includes(changed)) void refresh()
  })
  onCleanup(() => {
    abort.abort()
    clearInterval(timer)
    stop()
  })

  const bySession = createMemo(() => {
    const grouped = new Map<string, Array<Asked>>()
    for (const question of open()) grouped.set(question.sessionID, [...(grouped.get(question.sessionID) ?? []), { label: labelOf(question), at: question.askedAt }])
    return grouped
  })
  return (sessionID) => bySession().get(sessionID) ?? []
}
