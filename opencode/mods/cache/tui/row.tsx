// The transcript rows of a turn's large cache misses, under the turn's last
// step: `◌ cache miss · 48k tokens · $0.31 · expired during a 6m shell call`,
// the glyph in the warning colour and the words muted. Thin: it draws what
// the ledger answers. cmd/cache/tui.tsx places it after the host's assistant
// footer slot, which Prime empties but keeps as a boundary.
import type { Plugin } from "@opencode/plugin/tui"
import { createMemo, For, Show } from "solid-js"
import type { Ledger } from "./ledger.tsx"

const GLYPH = "◌"

export function MissRows(props: { ctx: Plugin.Context; ledger: Ledger; sessionID: string; messageID: string }) {
  const rows = createMemo(() => props.ledger.rows(props.sessionID, props.messageID))
  const theme = () => props.ctx.theme
  return (
    <Show when={rows().length > 0}>
      <box marginTop={1} paddingLeft={1}>
        <For each={rows()}>
          {(row) => (
            <text wrapMode="none" truncate>
              <span style={{ fg: theme().text.feedback.warning.base }}>{GLYPH} </span>
              <span style={{ fg: theme().text.muted }}>{row}</span>
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}
