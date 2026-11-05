// Transcript rows in the Prime look: the user prompt behind fx's heavy `┃` rail (bold text, no band),
// reasoning only at All (fx keeps thinking out of the inline view), and plain assistant text.
import type { Plugin } from "@opencode/plugin/tui"
import type { TranscriptOverlayInput } from "@opencode/plugin/tui/context"
import { RGBA, type BoxRenderable } from "@opentui/core"
import { createMemo, createSignal, Show, type Accessor } from "solid-js"
import { governingAsk, oneLine } from "./ask"
import type { Detail } from "./view"

type Context = Plugin.Context
export type PartProps = { context: Context; sessionID: string; messageID: string; partID: string }

/** Transcript rows sit one column in from the inset; bands reach the inset. */
export const GUTTER = 1

export function usePart(props: PartProps) {
  return createMemo(() => props.context.data.session.part.get(props.sessionID, props.messageID, props.partID))
}

/** OpenTUI border characters with only the vertical drawn: fx's heavy user-turn rail. */
const USER_RAIL = {
  topLeft: "",
  bottomLeft: "",
  vertical: "┃",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

/**
 * The reader's prompt as fx's user card draws it (user_message_card.zig): a
 * heavy `┃` rail on every row, wrapped and blank rows too, a space, then the
 * text as typed, bold, on the terminal's own background (gent's UserRow, less
 * its panel). The rail is the text colour, as fx's marker and the rail
 * composer are. What came with the prompt (files, skills, agents) is one
 * muted line under the text.
 */
export function UserBand(props: { context: Context; sessionID: string; messageID: string }) {
  const message = createMemo(() => {
    const found = props.context.data.session.message.get(props.sessionID, props.messageID)
    return found?.type === "user" ? found : undefined
  })
  const text = createMemo(() => message()?.text.trim() ?? "")
  const attached = createMemo(() => {
    const found = message()
    if (!found) return ""
    return [
      ...(found.files ?? []).map((file) => {
        const label = file.mime === "application/x-directory" ? "dir" : file.mime.startsWith("image/") ? "image" : "file"
        return `${label} ${file.name ?? (file.source.type === "uri" ? file.source.uri : "attachment")}`
      }),
      ...(found.skills ?? []).map((skill) => `skill ${skill.name}`),
      ...(found.agents ?? []).map((agent) => `agent ${agent.name}`),
    ].join(" · ")
  })
  const theme = () => props.context.theme
  return (
    <Show when={text() || attached()}>
      <box
        width="100%"
        flexDirection="column"
        flexShrink={0}
        border={["left"]}
        borderColor={theme().text.base}
        customBorderChars={USER_RAIL}
        paddingLeft={1}
        paddingRight={2}
      >
        <Show when={text()}>
          <text fg={theme().text.base} wrapMode="word">
            <span style={{ bold: true }}>{text()}</span>
          </text>
        </Show>
        <Show when={attached()}>
          <text fg={theme().text.muted} wrapMode="word">
            {attached()}
          </text>
        </Show>
      </box>
    </Show>
  )
}

export function ReasoningLine(props: PartProps & { detail: Accessor<Detail> }) {
  const part = usePart(props)
  const content = createMemo(() => {
    const item = part()
    if (item?.type !== "reasoning") return ""
    return item.text.replace("[REDACTED]", "").trim()
  })
  return (
    <Show when={props.detail() === "all" && content()}>
      <box paddingLeft={GUTTER}>
        <text fg={props.context.theme.text.faint} wrapMode="word">
          {content()}
        </text>
      </box>
    </Show>
  )
}

export function AssistantText(props: PartProps) {
  const part = usePart(props)
  const content = createMemo(() => {
    const item = part()
    return item?.type === "text" ? item.text.trim() : ""
  })
  const streaming = createMemo(() => {
    const message = props.context.data.session.message.get(props.sessionID, props.messageID)
    return message?.type === "assistant" && message.time.completed === undefined
  })
  const Markdown = props.context.ui.Markdown
  return (
    <Show when={content()}>
      <box paddingLeft={GUTTER} flexShrink={0}>
        <Markdown content={content()} streaming={streaming()} />
      </box>
    </Show>
  )
}

/**
 * While the reader is scrolled up, the prompt the top of the view answers,
 * pinned over the transcript's top row as the prompt draws (the `┃` rail, bold
 * text) on one line; a click scrolls that prompt to the top. It covers the
 * row under it rather than reserving one, so the transcript keeps its height
 * as the reader crosses the bottom; every row still reaches view, since the
 * top row the pin covers moves on with a one-row scroll and the transcript's
 * own first row is the splash's blank margin.
 */
/**
 * The pin's fill: the terminal's own background, opaque. A cell drawn on a
 * transparent background keeps the character under it, and the Prime theme's
 * background is transparent (the terminal's), so the pin fills with the
 * terminal's default colour instead, which looks the same; a theme with an
 * opaque background fills with that.
 */
function cover(theme: Context["theme"]) {
  const base = theme.background.base
  return base.a >= 1 ? base : RGBA.defaultBackground()
}

export function PinnedAsk(props: { context: Context; input: TranscriptOverlayInput }) {
  const ask = createMemo(() =>
    props.input.away
      ? governingAsk(props.context.data.session.message.list(props.input.sessionID), props.input.messages)
      : undefined,
  )
  // Unmeasured, the text keeps its length and the host's truncate cuts it.
  const [width, setWidth] = createSignal(Infinity)
  const [hover, setHover] = createSignal(false)
  const theme = () => props.context.theme
  return (
    <Show when={ask()}>
      {(found) => (
        <box
          width="100%"
          height={1}
          flexShrink={0}
          backgroundColor={cover(theme())}
          border={["left"]}
          borderColor={theme().text.base}
          customBorderChars={USER_RAIL}
          paddingLeft={1}
          onSizeChange={function (this: BoxRenderable) {
            const value = this.width
            queueMicrotask(() => setWidth(value))
          }}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
          onMouseUp={() => props.input.reveal(found().id)}
        >
          <text wrapMode="none" truncate fg={hover() ? theme().text.muted : theme().text.base}>
            <span style={{ bold: true }}>{oneLine(found().text ?? "", width() - 2)}</span>
          </text>
        </box>
      )}
    </Show>
  )
}
