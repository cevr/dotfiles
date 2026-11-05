// The session sidebar's cache line: `Cache 91% · missed $0.42` for the session
// and its subagents together. Thin: it draws what the ledger answers, and
// nothing before the session reports cache activity.
import type { Plugin } from "@opencode/plugin/tui"
import { createMemo, Show } from "solid-js"
import type { Ledger } from "./ledger.tsx"

export function CacheSidebar(props: { ctx: Plugin.Context; ledger: Ledger; sessionID: string }) {
  const line = createMemo(() => props.ledger.sidebar(props.sessionID))
  return (
    <Show when={line()}>{(text) => <text fg={props.ctx.theme.text.muted}>{text()}</text>}</Show>
  )
}
