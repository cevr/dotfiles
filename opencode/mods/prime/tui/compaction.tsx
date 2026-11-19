// A compaction in the Prime look. Below All it is one line,
// `◇ Compacted automatically · 171k → 6k tokens · 12s`; while it runs, a
// live spinner and its time (`Automatic compaction · 57s`), the wait's only
// row; a failure or cancel in the warning tone. At All (Ctrl+O)
// it is everything the host draws today: a rule with its label and usage,
// then the summary or the error (compaction.ts).
import { createMemo, For, Match, Show, Switch, type Accessor } from "solid-js"
import { compactionAt, compactionBlock, compactionLine } from "../compaction.ts"
import type { Detail } from "../detail.ts"
import { useNow } from "./clock.ts"
import type { Host } from "./host.ts"
import { Prose } from "./prose.tsx"
import { toneColor } from "./tone.ts"
import { GUTTER } from "./transcript.tsx"

export function Compaction(props: { host: Host; sessionID: string; messageID: string; detail: Accessor<Detail>; emphasis: boolean }) {
  const found = createMemo(() => compactionAt(props.host.messages(props.sessionID), props.messageID))
  const running = () => found()?.message.status === "running"
  // While it runs the row is the wait's only one, so it counts its own time on the shared clock.
  const now = useNow(running)
  return (
    <Show when={found()}>
      {(at) => (
        <Show
          when={props.detail() === "all"}
          fallback={<Line host={props.host} line={compactionLine(at().message, at().next, now())} />}
        >
          <Block host={props.host} block={compactionBlock(at().message, now())} emphasis={props.emphasis} />
        </Show>
      )}
    </Show>
  )
}

function Line(props: { host: Host; line: ReturnType<typeof compactionLine> }) {
  const color = () => toneColor(props.host.theme(), props.line.tone)
  return (
    <box paddingLeft={GUTTER} flexShrink={0} flexDirection="row" gap={1}>
      <Show when={props.line.glyph === "spinner"} fallback={<text flexShrink={0} fg={color()}>{props.line.glyph}</text>}>
        <props.host.Spinner color={props.host.theme().hue.accent[300]} />
      </Show>
      <text wrapMode="none" truncate fg={color()}>
        {props.line.text}
      </text>
    </box>
  )
}

/** The host's compaction block, as the fork draws it (packages/tui/src/routes/session/index.tsx, CompactionMessage). */
function Block(props: { host: Host; block: ReturnType<typeof compactionBlock>; emphasis: boolean }) {
  const theme = () => props.host.theme()
  const color = () => (props.block.failed ? theme().text.feedback.error.base : theme().text.muted)
  return (
    <box flexShrink={0}>
      <box flexDirection="row" alignItems="center">
        <box border={["top"]} borderColor={color()} flexGrow={1} />
        <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
          <Switch>
            <Match when={props.block.running}>
              <props.host.Spinner color={color()} />
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
          <Prose host={props.host} content={props.block.body} streaming={props.block.running} emphasis={props.emphasis} />
        </box>
      </Show>
    </box>
  )
}
