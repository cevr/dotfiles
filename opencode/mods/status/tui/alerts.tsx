// The pool's alerts in the TUI: one watcher per TUI asks the pool's `alerts`
// RPC every few seconds, toasts each new occurrence once (alert.ts's `fresh`)
// and asks for an OS notification beside it, and holds the newest answer for
// the sidebar's Pool section to draw. An answer that fails or does not decode
// counts as no alert. cmd/status/tui.tsx starts it.
import type { Plugin } from "@opencode/plugin/tui"
import { Option, Schema } from "effect"
import { createSignal, type Accessor } from "solid-js"
import { POOL_STATUS } from "@dotfiles/opencode-pool/status"
import { AlertsAnswer, fresh, NO_ALERTS } from "../alert.ts"

const decode = Schema.decodeUnknownOption(AlertsAnswer)

/** How often the watcher asks the pool. */
export const ALERTS_EVERY_MS = 5_000
/** How long an alert's toast stays: longer than the host's default, as it asks for an action. */
const TOAST_MS = 10_000

export interface AlertFeed {
  /** The newest answer, and when it came. Reactive. */
  readonly answer: Accessor<AlertsAnswer>
  readonly at: Accessor<number>
  readonly stop: () => void
}

export function watchAlerts(ctx: Plugin.Context): AlertFeed {
  const [answer, setAnswer] = createSignal<AlertsAnswer>(NO_ALERTS)
  const [at, setAt] = createSignal(Date.now())
  const abort = new AbortController()
  let seen: ReadonlySet<string> = new Set()
  let asking = false
  const ask = () => {
    if (asking || abort.signal.aborted) return
    asking = true
    ctx.client
      .rpc(POOL_STATUS)
      .alerts({}, { location: ctx.location, signal: abort.signal })
      .then(
        (value) => Option.getOrElse(decode(value), () => NO_ALERTS),
        () => NO_ALERTS,
      )
      .then((value) => {
        asking = false
        if (abort.signal.aborted) return
        const now = Date.now()
        const next = fresh(seen, value, now)
        seen = next.seen
        setAnswer(value)
        setAt(now)
        for (const toast of next.toasts) {
          ctx.ui.toast.show({ variant: "warning", title: toast.title, message: toast.message, duration: TOAST_MS })
          // An OS notification when the terminal is not focused, if the TUI config allows them.
          void ctx.attention.notify({ title: toast.title, message: toast.message, notification: true, sound: false }).catch(() => undefined)
        }
      })
  }
  ask()
  const timer = setInterval(ask, ALERTS_EVERY_MS)
  return {
    answer,
    at,
    stop: () => {
      abort.abort()
      clearInterval(timer)
    },
  }
}
