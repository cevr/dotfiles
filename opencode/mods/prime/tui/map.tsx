// A collapsed turn of the transcript map (the host's `session.map.turn`
// slot) in the Prime look, so the map reads as the transcript folded: a
// prompt behind the `┃` rail in bold, as UserBand draws it; a run's first
// sentence in the prose colour, its work as the folded row words it, and the
// time it ended on the right in the faint colour, as StepEnd puts it; a stop
// notice as Completion heads it. The host keeps the row, its place, its
// selected background and its click.
import { Option } from "effect"
import { Match, Switch } from "solid-js"
import { mapNotice, mapNoticeGlyph, mapWorkTail, type MapTurn } from "../map.ts"
import { hostZone, turnTime } from "../turn-time.ts"
import { useNow } from "./clock.ts"
import type { Host } from "./host.ts"
import { toneColor } from "./tone.ts"
import { GUTTER, USER_RAIL } from "./transcript.tsx"

export function MapRow(props: { host: Host; input: MapTurn; zone: string }) {
  const theme = () => props.host.theme()
  // A settled turn's time does not tick: the read is the time now, for the date's "older than today".
  const now = useNow(() => false)
  const notice = () => Option.getOrUndefined(mapNotice(props.input))
  return (
    <Switch>
      <Match when={props.input.kind === "user"}>
        <box flexGrow={1} flexShrink={1} border={["left"]} borderColor={theme().text.base} customBorderChars={USER_RAIL} paddingLeft={1} paddingRight={2}>
          <text fg={theme().text.base} wrapMode="none" truncate>
            <span style={{ bold: true }}>{props.input.text}</span>
          </text>
        </box>
      </Match>
      <Match when={props.input.kind === "agent"}>
        <box flexGrow={1} flexDirection="row" paddingLeft={GUTTER} gap={1}>
          <text fg={theme().markdown.text} wrapMode="none" truncate flexGrow={1}>
            {props.input.text}
            <span style={{ fg: theme().text.muted }}>{mapWorkTail(props.input)}</span>
          </text>
          <text fg={theme().text.faint} wrapMode="none" flexShrink={0}>
            {turnTime(props.input.time, now(), props.zone, hostZone())}
          </text>
        </box>
      </Match>
      <Match when={notice()}>
        {(shown) => (
          <box flexGrow={1} paddingLeft={GUTTER}>
            <text wrapMode="none" truncate fg={theme().text.muted}>
              <span style={{ fg: toneColor(theme(), shown().glyph.tone) }}>{shown().glyph.char}</span>
              {` ${shown().actor} `}
              <span style={{ fg: toneColor(theme(), shown().tone) }}>{shown().word}</span>
              {shown().tail}
            </text>
          </box>
        )}
      </Match>
      <Match when={props.input.kind === "compaction"}>
        <box flexGrow={1} paddingLeft={GUTTER}>
          <text wrapMode="none" truncate fg={theme().text.muted}>{`◇ ${props.input.text}`}</text>
        </box>
      </Match>
      {/* Any other notice as the host's notice row draws it (Prime leaves those to the host). */}
      <Match when={true}>
        <box flexGrow={1} flexDirection="row" paddingLeft={GUTTER}>
          <text width={2} flexShrink={0} fg={theme().text.muted}>
            {mapNoticeGlyph(Option.getOrElse(Option.fromNullishOr(props.input.source), () => ""))}
          </text>
          <text fg={theme().text.muted} wrapMode="none" truncate flexGrow={1}>
            {props.input.text}
          </text>
        </box>
      </Match>
    </Switch>
  )
}
