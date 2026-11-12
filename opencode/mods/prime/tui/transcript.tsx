// Transcript rows in the Prime look: the user prompt behind fx's heavy `┃` rail (bold text, no band)
// and plain assistant text. A thought is a node of its step's group (tools.tsx).
import { RGBA, type BoxRenderable } from "@opentui/core"
import { createMemo, createSignal, Show } from "solid-js"
import { governingAsk, oneLine } from "../ask.ts"
import { inboxOf, isWaiting } from "../pending.ts"
import { attachedLine, promptText } from "../prompt.ts"
import type { Host, Overlay, Palette } from "./host.ts"

export type PartProps = { host: Host; sessionID: string; messageID: string; partID: string }

/** Transcript rows sit one column in from the inset; bands reach the inset. */
export const GUTTER = 1

export function usePart(props: PartProps) {
  return createMemo(() => props.host.part(props.sessionID, props.messageID, props.partID))
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
 * text as typed, bold, on the terminal's own background, with no panel. The rail is the text colour, as fx's marker and the rail
 * composer are. What came with the prompt (files, skills, agents) is one
 * muted line under the text. A prompt the runner has not taken draws nothing
 * here, and its row takes no gap (cmd/prime/tui.tsx's layout rule); it enters
 * the transcript, at the place the host gives it, once taken.
 */
export function UserBand(props: { host: Host; sessionID: string; messageID: string }) {
  const message = createMemo(() => {
    const found = props.host.message(props.sessionID, props.messageID)
    return found?.type === "user" ? found : undefined
  })
  const text = createMemo(() => promptText(message()))
  const attached = createMemo(() => attachedLine(message()))
  // A prompt waiting behind a running turn shows in the queued rows above the composer (chrome.tsx Queued), not here; one sent to an idle session shows here at once.
  const waiting = createMemo(() => isWaiting(inboxOf(props.host, props.sessionID), props.messageID))
  const theme = () => props.host.theme()
  return (
    <Show when={!waiting() && (text() || attached())}>
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

export function AssistantText(props: PartProps) {
  const part = usePart(props)
  const content = createMemo(() => {
    const item = part()
    return item?.type === "text" ? item.text.trim() : ""
  })
  const streaming = createMemo(() => {
    const message = props.host.message(props.sessionID, props.messageID)
    return message?.type === "assistant" && message.time.completed === undefined
  })
  const Markdown = props.host.Markdown
  return (
    <Show when={content()}>
      <box paddingLeft={GUTTER} flexShrink={0}>
        <Markdown content={content()} streaming={streaming()} />
      </box>
    </Show>
  )
}

/**
 * The pin's fill: the terminal's own background, opaque. A cell drawn on a
 * transparent background keeps the character under it, and the Prime theme's
 * background is transparent (the terminal's), so the pin fills with the
 * terminal's default colour instead, which looks the same; a theme with an
 * opaque background fills with that.
 */
function cover(theme: Palette) {
  const base = theme.background.base
  return base.a >= 1 ? base : RGBA.defaultBackground()
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
export function PinnedAsk(props: { host: Host; input: Overlay }) {
  const ask = createMemo(() =>
    props.input.away ? governingAsk(props.host.messages(props.input.sessionID), props.input.messages) : undefined,
  )
  // Unmeasured, the text keeps its length and the host's truncate cuts it.
  const [width, setWidth] = createSignal(Infinity)
  const [hover, setHover] = createSignal(false)
  const theme = () => props.host.theme()
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
