// Transcript rows in the Prime look: the user prompt behind fx's heavy `┃` rail (bold text, no band),
// reasoning only at All (fx keeps thinking out of the inline view), and plain assistant text.
import type { Plugin } from "@opencode/plugin/tui"
import { createMemo, Show, type Accessor } from "solid-js"
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
