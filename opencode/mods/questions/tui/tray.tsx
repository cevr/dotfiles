// The tray: one line above the composer while questions are open, `? 1 open
// question · <label> · assuming <assume> · /answer`, fitted to the width
// (tray.ts). dock.tsx draws it. It is tappable: a click on the line (mouse up,
// where the terminal reports the mouse) runs `open`, which opens the form as
// shift+← does; `/answer` is underlined to say so, and the line brightens
// under the pointer.
import type { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import type { Question } from "../question.ts"
import { COMMAND, GLYPH, trayLine } from "../tray.ts"

/** The line before its closing `/answer` (trayLine always closes with it), and that `/answer`. */
export const splitLine = (line: string) => {
  const command = COMMAND.slice(0, Number(line.endsWith(COMMAND)) * COMMAND.length)
  return { lead: line.slice(0, line.length - command.length), command }
}

export function Tray(props: { ctx: Plugin.Context; questions: ReadonlyArray<Question>; width: number; open: () => void }) {
  const theme = () => props.ctx.theme
  const [hover, setHover] = createSignal(false)
  const line = () => splitLine(trayLine(props.questions, props.width))
  const fg = () => [theme().text.muted, theme().text.base][Number(hover())]
  return (
    <box flexDirection="row" paddingLeft={2} paddingRight={2} onMouseOver={() => setHover(true)} onMouseOut={() => setHover(false)} onMouseUp={() => props.open()}>
      <text fg={theme().text.feedback.warning.base} wrapMode="none">
        {`${GLYPH} `}
      </text>
      <text fg={fg()} wrapMode="none">
        {line().lead}
        <u>{line().command}</u>
      </text>
    </box>
  )
}
