// The composer's `$` popup. Thin: it reads the catalog over the skills RPC
// when the plugin starts and again, at most every 2 seconds, whenever the
// popup reads its rows; the rows are catalog.ts's projection of the latest
// answer. A failed or undecodable answer keeps the rows it had.
// cmd/skills/tui.tsx registers it.
import type { Plugin } from "@opencode/plugin/tui"
import { Option, Schema } from "effect"
import { createSignal } from "solid-js"
import { Answer, row, SKILLS, type Entry, type Row } from "../catalog.ts"
import { TRIGGER } from "../mention.ts"

const decode = Schema.decodeUnknownOption(Answer)

/** How long an answer is fresh enough to draw without asking again. */
const FRESH_MS = 2000

/** A popup as the host's `ui.autocomplete` takes it: its trigger and the rows to draw now. */
export interface Source {
  readonly trigger: string
  readonly options: () => ReadonlyArray<Row>
}

/** The popup source and a cleanup that stops its reads. */
export const popup = (ctx: Plugin.Context): { readonly source: Source; readonly stop: () => void } => {
  const [entries, setEntries] = createSignal<ReadonlyArray<Entry>>([])
  const abort = new AbortController()
  let asked = 0
  let pending = false
  const refresh = async () => {
    if (pending || abort.signal.aborted) return
    pending = true
    asked = Date.now()
    const answer = await ctx.client
      .rpc(SKILLS)
      .catalog({}, { location: ctx.location, signal: abort.signal })
      .then(decode, () => Option.none<Answer>())
    pending = false
    if (abort.signal.aborted || Option.isNone(answer)) return
    setEntries(answer.value.entries)
  }
  void refresh()
  return {
    source: {
      trigger: TRIGGER,
      options: () => {
        if (Date.now() - asked > FRESH_MS) void refresh()
        return entries().map(row)
      },
    },
    stop: () => abort.abort(),
  }
}
