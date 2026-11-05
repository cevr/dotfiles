// The tray: one line above the composer while questions are open, `? 1 open
// question · <label> · assuming <assume> · /answer`, fitted to the width
// (tray.ts). dock.tsx draws it.
import type { Plugin } from "@opencode/plugin/tui"
import type { Question } from "../question.ts"
import { GLYPH, trayLine } from "../tray.ts"

export function Tray(props: { ctx: Plugin.Context; questions: ReadonlyArray<Question>; width: number }) {
  const theme = () => props.ctx.theme
  return (
    <box flexDirection="row" paddingLeft={2} paddingRight={2}>
      <text fg={theme().text.feedback.warning.base} wrapMode="none">
        {`${GLYPH} `}
      </text>
      <text fg={theme().text.muted} wrapMode="none">
        {trayLine(props.questions, props.width)}
      </text>
    </box>
  )
}
