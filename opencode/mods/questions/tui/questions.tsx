// What the TUI shares between the dock, /answer and the hotkey: each
// session's last reading of its open questions. Plain Solid signals, with no
// JSX (a .tsx file only for the package's ./tui/* export, like
// mods/btw/tui/controller.tsx), so cmd/questions/setup.ts and its seam test
// use it.
import { createSignal } from "solid-js"
import type { Question } from "../question.ts"

export interface Questions {
  readonly open: (sessionID: string) => ReadonlyArray<Question>
  readonly setOpen: (sessionID: string, questions: ReadonlyArray<Question>) => void
}

export const createQuestions = (): Questions => {
  const [open, setOpenAll] = createSignal<Readonly<Record<string, ReadonlyArray<Question>>>>({})
  return {
    open: (sessionID) => open()[sessionID] ?? [],
    setOpen: (sessionID, questions) => setOpenAll((all) => ({ ...all, [sessionID]: questions })),
  }
}
