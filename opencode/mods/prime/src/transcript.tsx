// Transcript rows in the Prime look: a full-width band for the user prompt,
// one dim line of reasoning, and plain assistant text.
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

export function UserBand(props: { context: Context; sessionID: string; messageID: string }) {
  const text = createMemo(() => {
    const message = props.context.data.session.message.get(props.sessionID, props.messageID)
    return message?.type === "user" ? message.text.trim() : undefined
  })
  return (
    <Show when={text()}>
      {(value) => (
        <box
          width="100%"
          backgroundColor={props.context.theme.background.raised.base}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
        >
          <text fg={props.context.theme.text.base}>{value()}</text>
        </box>
      )}
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
    <Show when={props.detail() !== "overview" && content()}>
      <box paddingLeft={GUTTER}>
        <text fg={props.context.theme.text.faint} wrapMode={props.detail() === "all" ? "word" : "none"} truncate>
          {props.detail() === "all" ? content() : content().split("\n")[0]}
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
