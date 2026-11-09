// A compaction in the Prime look. Below All it is one line,
// `◇ Compacted automatically · 171k → 6k tokens · 12s`; while it runs, a
// live spinner and its time (`Automatic compaction · 57s`), the wait's only
// row; a failure or cancel in the warning tone. At All (Ctrl+O)
// it is everything the host draws today: a rule with its label and usage,
// then the summary or the error (compaction.ts).
import { createMemo, createSignal, For, Match, onCleanup, Show, Switch, type Accessor } from "solid-js"
import { SPINNER, SPINNER_MS } from "../chrome.ts"
import { compactionAt, compactionBlock, compactionLine } from "../compaction.ts"
import type { Detail } from "../detail.ts"
import { useNow } from "./clock.ts"
import type { Host } from "./host.ts"
import { toneColor } from "./tone.ts"
import { GUTTER } from "./transcript.tsx"

/** A braille spinner frame that turns while `on` holds. */
function useSpinner(on: Accessor<boolean>) {
  const [frame, setFrame] = createSignal(0)
  const timer = setInterval(() => {
    if (on()) setFrame((value) => (value + 1) % SPINNER.length)
  }, SPINNER_MS)
  onCleanup(() => clearInterval(timer))
  return () => SPINNER[frame()] ?? ""
}

export function Compaction(props: { host: Host; sessionID: string; messageID: string; detail: Accessor<Detail> }) {
  const found = createMemo(() => compactionAt(props.host.messages(props.sessionID), props.messageID))
  const running = () => found()?.message.status === "running"
  const spinner = useSpinner(running)
  // While it runs the row is the wait's only one, so it counts its own time on the shared clock.
  const now = useNow(running)
  return (
    <Show when={found()}>
      {(at) => (
        <Show
          when={props.detail() === "all"}
          fallback={<Line host={props.host} line={compactionLine(at().message, at().next, now())} spinner={spinner} />}
        >
          <Block host={props.host} block={compactionBlock(at().message, now())} spinner={spinner} />
        </Show>
      )}
    </Show>
  )
}

function Line(props: { host: Host; line: ReturnType<typeof compactionLine>; spinner: Accessor<string> }) {
  const color = () => toneColor(props.host.theme(), props.line.tone)
  return (
    <box paddingLeft={GUTTER} flexShrink={0}>
      <text wrapMode="none" truncate fg={color()}>
        <span style={{ fg: props.line.glyph === "spinner" ? props.host.theme().hue.accent[300] : color() }}>
          {props.line.glyph === "spinner" ? props.spinner() : props.line.glyph}{" "}
        </span>
        {props.line.text}
      </text>
    </box>
  )
}

/** The host's compaction block, as the fork draws it (packages/tui/src/routes/session/index.tsx, CompactionMessage). */
function Block(props: { host: Host; block: ReturnType<typeof compactionBlock>; spinner: Accessor<string> }) {
  const theme = () => props.host.theme()
  const color = () => (props.block.failed ? theme().text.feedback.error.base : theme().text.muted)
  const Markdown = props.host.Markdown
  return (
    <box flexShrink={0}>
      <box flexDirection="row" alignItems="center">
        <box border={["top"]} borderColor={color()} flexGrow={1} />
        <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
          <Switch>
            <Match when={props.block.running}>
              <text fg={color()}>{props.spinner()}</text>
            </Match>
            <Match when={props.block.failed}>
              <text fg={color()}>✗</text>
            </Match>
          </Switch>
          <text fg={color()}>{props.block.label}</text>
          <For each={[...props.block.details]}>{(detail) => <text fg={color()}>· {detail}</text>}</For>
        </box>
        <box border={["top"]} borderColor={color()} flexGrow={1} />
      </box>
      <Show when={props.block.body}>
        <box paddingTop={1} paddingLeft={3}>
          <Markdown content={props.block.body} streaming={props.block.running} />
        </box>
      </Show>
    </box>
  )
}
