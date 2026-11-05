// The session sidebar's Pool section: the account this session is on, its
// weekly and 5-hour use, and when each resets. Thin: it asks the pool's
// `session` RPC about the prompt's model's provider when it mounts, when that
// provider changes, when a step of the session starts or ends, and every 10
// seconds, and draws the lines sidebar.ts projects. An answer that fails or
// does not decode draws nothing. cmd/status/tui.tsx registers it.
import type { Plugin } from "@opencode/plugin/tui"
import { Option, Schema } from "effect"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { POOL_STATUS } from "@dotfiles/opencode-pool/status"
import { SidebarAnswer, sidebarLines, type Tone } from "../sidebar.ts"

const decode = Schema.decodeUnknownOption(SidebarAnswer)

/** How often the section reads the pool between the session's steps. */
const REFRESH_MS = 10_000

export function PoolSidebar(props: { ctx: Plugin.Context; sessionID: string }) {
  const ctx = props.ctx
  const provider = createMemo(() => ctx.ui.model.current()?.providerID)
  const [answer, setAnswer] = createSignal<SidebarAnswer>({})
  const [now, setNow] = createSignal(Date.now())
  const abort = new AbortController()
  let asked = 0
  const refresh = () => {
    const ask = ++asked
    const providerID = provider()
    ctx.client
      .rpc(POOL_STATUS)
      .session(
        { sessionID: props.sessionID, ...(providerID === undefined ? {} : { providerID }) },
        { location: ctx.location, signal: abort.signal },
      )
      .then(
        (value) => Option.getOrElse(decode(value), () => ({})),
        () => ({}),
      )
      .then((value) => {
        // Only the newest question's answer counts.
        if (ask !== asked || abort.signal.aborted) return
        setAnswer(value)
        setNow(Date.now())
      })
  }
  createEffect(on([provider, () => props.sessionID], refresh))
  const step = (event: { readonly data: { readonly sessionID: string } }) => {
    if (event.data.sessionID === props.sessionID) refresh()
  }
  const unsubscribe = [ctx.data.on("session.step.started", step), ctx.data.on("session.step.ended", step)]
  const timer = setInterval(refresh, REFRESH_MS)
  onCleanup(() => {
    abort.abort()
    clearInterval(timer)
    for (const stop of unsubscribe) stop()
  })
  const lines = createMemo(() => sidebarLines(answer(), now()))
  const theme = () => ctx.theme
  const colour = (tone: Tone) =>
    tone === "error"
      ? theme().text.feedback.error.base
      : tone === "warning"
        ? theme().text.feedback.warning.base
        : tone === "base"
          ? theme().text.base
          : theme().text.muted
  return (
    <Show when={lines().length > 0}>
      <box>
        <text fg={theme().text.base}>
          <b>Pool</b>
        </text>
        <For each={lines()}>{(line) => <text fg={colour(line.tone)}>{line.text}</text>}</For>
      </box>
    </Show>
  )
}
