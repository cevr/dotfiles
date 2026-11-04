// The Prime Agent look for the session screen, built on the public plugin API
// only: slots, ui.layout, ui.Markdown and the session data reads. Load it by
// path through the tui config's `plugins`, and pair it with themes/prime.json.
import { Plugin } from "@opencode/plugin/tui"
import type { TranscriptRowKind } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import { Dock, ModeHint, Splash, TopBar, Working } from "./chrome"
import { ToolRow } from "./tools"
import { AssistantText, ReasoningLine, UserBand } from "./transcript"
import { nextDetail, type Detail } from "./view"

// Blank rows between transcript rows. Overview packs everything; Details
// and All keep a blank line around prose but stack tool calls tight.
export function rowGap(detail: Detail, row: { kind: TranscriptRowKind; previous?: TranscriptRowKind }) {
  if (detail === "overview") return 0
  if (row.kind === "footer") return 0
  // The host keeps a step's run of calls as one "group" row even with grouping "none".
  const call = (kind?: TranscriptRowKind) => kind === "tool" || kind === "group"
  if (call(row.kind) && call(row.previous)) return 0
  if (row.kind === "reasoning" && row.previous === "user") return 0
  return 1
}

export default Plugin.define({
  id: "gent.prime",
  setup(context) {
    const [detail, setDetail] = createSignal<Detail>("details")

    context.ui.layout({
      inset: 1,
      composer: { chrome: "band", prefix: "> " },
      rowGap: (row) => rowGap(detail(), row),
      // Prime shows every tool call and thought on its own row.
      transcript: { grouping: "none", thinking: "show" },
    })

    context.ui.slot({
      append: "session.header",
      render: (input) => <TopBar context={context} sessionID={input.sessionID} />,
    })
    context.ui.slot({
      append: "session.transcript.start",
      render: (input) => <Splash context={context} sessionID={input.sessionID} />,
    })
    context.ui.slot({
      replace: "session.message.user",
      render: (input) => <UserBand context={context} sessionID={input.sessionID} messageID={input.messageID} />,
    })
    context.ui.slot({
      replace: "session.part.reasoning",
      render: (input) => <ReasoningLine context={context} {...input} detail={detail} />,
    })
    context.ui.slot({
      replace: "session.part.text",
      render: (input) => <AssistantText context={context} {...input} />,
    })
    context.ui.slot({
      replace: "session.part.tool",
      render: (input) => <ToolRow context={context} {...input} detail={detail} />,
    })
    // Prime closes a turn with nothing: no agent, model or duration line.
    context.ui.slot({ replace: "session.message.assistant.footer", render: () => null })
    context.ui.slot({
      append: "session.composer.top",
      render: () => <ModeHint context={context} detail={detail} />,
    })
    // Prime's loader is the transcript's last row, straight under the newest output.
    context.ui.slot({
      append: "session.transcript.end",
      render: (input) => <Working context={context} sessionID={input.sessionID} />,
    })
    context.ui.slot({
      replace: "prompt.footer",
      render: (input) => <Dock context={context} sessionID={input.sessionID} />,
    })

    context.keymap.layer(() => ({
      mode: "global",
      priority: 100,
      commands: [
        {
          id: "prime.detail.cycle",
          title: "Cycle transcript detail",
          group: "Session",
          bind: "ctrl+o",
          run() {
            setDetail(nextDetail)
          },
        },
      ],
    }))
  },
})
