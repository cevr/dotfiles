// Prose that reads like the transcript: the host's Markdown, with the reply's
// emphasis (`[[Word]]` chips, the queue's lead labels) drawn into it
// (tui/emphasis.ts). The emphasis attaches when the Markdown mounts, before
// its first highlight, so no frame shows the pill as typed.
import type { BoxRenderable } from "@opentui/core"
import { Option } from "effect"
import { onMount } from "solid-js"
import type { Label, Pill } from "../emphasis.ts"
import { attach, findMarkdown, type Look } from "./emphasis.ts"
import type { Host } from "./host.ts"
import { chipColors, toneColor } from "./tone.ts"

/** The look of the theme in use, read at each draw. */
export const lookOf = (host: Host): Look => ({
  chip: (pill: Pill) => chipColors(host.theme(), pill.word.tone, pill.word.form),
  mark: (label: Label) => toneColor(host.theme(), label.tone),
})

/** The host's Markdown for `content`; with `emphasis`, its chips and labels drawn. */
export function Prose(props: { host: Host; content: string; streaming: boolean; emphasis: boolean }) {
  const Markdown = props.host.Markdown
  let box = Option.none<BoxRenderable>()
  onMount(() => {
    if (!props.emphasis) return
    Option.map(Option.flatMap(box, findMarkdown), (markdown) => attach(markdown, lookOf(props.host)))
  })
  return (
    <box flexShrink={0} ref={(found: BoxRenderable) => (box = Option.some(found))}>
      <Markdown content={props.content} streaming={props.streaming} />
    </box>
  )
}
