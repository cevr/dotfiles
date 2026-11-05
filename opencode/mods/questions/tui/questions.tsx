// What the TUI shares between the dock, /answer and the hotkey: the session
// whose pane is open, and each session's last reading. Plain Solid signals,
// with no JSX (a .tsx file only for the package's ./tui/* export, like
// mods/btw/tui/controller.tsx), so cmd/questions/setup.ts and its seam test
// use it.
import { type Accessor, createSignal } from "solid-js"
import type { Question } from "../question.ts"

export interface Questions {
  readonly pane: Accessor<string | undefined>
  readonly setPane: (sessionID: string | undefined) => void
  readonly open: (sessionID: string) => ReadonlyArray<Question>
  readonly setOpen: (sessionID: string, questions: ReadonlyArray<Question>) => void
}

export const createQuestions = (): Questions => {
  const [pane, setPane] = createSignal<string>()
  const [open, setOpenAll] = createSignal<Readonly<Record<string, ReadonlyArray<Question>>>>({})
  return {
    pane,
    setPane: (sessionID) => setPane(sessionID),
    open: (sessionID) => open()[sessionID] ?? [],
    setOpen: (sessionID, questions) => setOpenAll((all) => ({ ...all, [sessionID]: questions })),
  }
}
