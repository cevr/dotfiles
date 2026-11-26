import * as TuiClock from "@dotfiles/decider/tui-clock"
import { CHANGED, PANE_AGENT, type PaneWorkerView, RowsReply } from "@dotfiles/opencode-pane-agent/worker"
import type { Plugin } from "@opencode/plugin/tui"
import { Option, Schema } from "effect"
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

const POLL_MS = 2000
const EMPTY: ReadonlyArray<PaneWorkerView> = []

const decodeReply = Schema.decodeUnknownOption(RowsReply)
const decodeChanged = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal(CHANGED), data: Schema.Struct({ sessionID: Schema.String }) }),
)

export function readPaneAgents(
  context: Plugin.Context,
  sessionID: Accessor<Option.Option<string>>,
): Accessor<ReadonlyArray<PaneWorkerView>> {
  const [workers, setWorkers] = createSignal<ReadonlyArray<PaneWorkerView>>(EMPTY)
  createEffect(() => {
    const id = sessionID()
    setWorkers(EMPTY)
    if (Option.isNone(id)) return
    const abort = new AbortController()
    const state = { busy: false, again: false }
    const refresh = (): void => {
      if (state.busy) {
        state.again = true
        return
      }
      state.busy = true
      void context.client
        .rpc(PANE_AGENT)
        .rows({ sessionID: id.value }, { location: context.location, signal: abort.signal })
        .then(decodeReply, () => Option.none<RowsReply>())
        .then((answer) => {
          state.busy = false
          if (abort.signal.aborted) return
          if (Option.isSome(answer)) setWorkers(answer.value.workers)
          if (!state.again) return
          state.again = false
          refresh()
        })
    }
    refresh()
    const unpoll = TuiClock.every(POLL_MS, refresh)
    const stop = context.data.listen((event) => {
      const changed = decodeChanged(event.details)
      if (Option.isSome(changed) && changed.value.data.sessionID === id.value) refresh()
    })
    onCleanup(() => {
      abort.abort()
      unpoll()
      stop()
    })
  })
  return workers
}
