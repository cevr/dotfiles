// The Prime Agent look for the session screen, built on the public plugin API
// only: slots, ui.layout, ui.Markdown and the session data reads. Load it by
// path through the tui config's `plugins`, and pair it with themes/prime.json.
import { Plugin } from "@opencode/plugin/tui"
import type { TranscriptRowKind } from "@opencode/plugin/tui/context"
import { createSignal, Show } from "solid-js"
import { Dock, ModeHint, Splash, TopBar, useFamily, Working } from "./chrome"
import { SubagentRows } from "./live"
import { Completion, StepEnd } from "./notice"
import { ToolRow } from "./tools"
import { AssistantText, PinnedAsk, ReasoningLine, UserBand } from "./transcript"
import { nextDetail, type Detail } from "./view"

// Blank rows between transcript rows. Overview packs everything; Details
// and All keep a blank line around prose but stack calls tight: the host gives
// each call its own row, so a group's header adds the blank row between two
// steps' groups (tools.tsx).
export function rowGap(detail: Detail, row: { kind: TranscriptRowKind; previous?: TranscriptRowKind }) {
  if (detail === "overview") return 0
  if (row.kind === "footer") return 0
  const call = (kind?: TranscriptRowKind) => kind === "tool" || kind === "group"
  if (call(row.kind) && call(row.previous)) return 0
  // Notices stack like calls; a folded notice draws nothing, so it must add no gap either.
  if (row.kind === "notice" && row.previous === "notice") return 0
  // A turn that opens with a thought opens with the host's reasoning group,
  // which draws nothing below All: there it takes no gap, so the row after it
  // keeps the prompt's one blank row and no second one.
  if (row.kind === "group" && row.previous === "user") return detail === "all" ? 1 : 0
  // Below All a thought draws nothing (transcript.tsx), so it takes no gap, and
  // a call after it stacks on the run it belongs to.
  if (detail !== "all" && row.kind === "reasoning") return 0
  if (detail !== "all" && row.previous === "reasoning" && call(row.kind)) return 0
  return 1
}

export default Plugin.define({
  id: "gent.prime",
  setup(context) {
    const [detail, setDetail] = createSignal<Detail>("details")

    context.ui.layout({
      inset: 1,
      composer: { chrome: "rail" },
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
    // Scrolled up, the prompt the top of the view answers sits pinned over it (the fork's overlay slot).
    context.ui.slot({
      append: "session.transcript.overlay",
      render: (input) => <PinnedAsk context={context} input={input} />,
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
    context.ui.slot({
      replace: "session.message.completion",
      render: (input) => <Completion context={context} sessionID={input.sessionID} messageID={input.messageID} />,
    })
    // Prime closes a turn with no agent, model or duration line; a step that
    // ended badly draws its retry, interrupt or error row (notice.tsx).
    context.ui.slot({
      replace: "session.message.assistant.footer",
      render: (input) => <StepEnd context={context} sessionID={input.sessionID} messageID={input.messageID} detail={detail} />,
    })
    context.ui.slot({
      append: "session.composer.top",
      render: (input) => <ModeHint context={context} sessionID={input.sessionID} detail={detail} />,
    })
    // Inside a subagent the host's picker takes the prompt's place, and the
    // dock with it: the family's rows sit above the picker instead.
    context.ui.slot({
      append: "session.composer.top",
      render: (input) => (
        <Show when={context.data.session.get(input.sessionID)?.parentID}>
          <SubagentRows context={context} sessionID={input.sessionID} child={true} />
        </Show>
      ),
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

    // In a subagent the host keeps its Subagents picker open in place of the
    // prompt, and the picker's ←/→ switch its tabs. Above it, ↑ goes back to
    // the parent and ←/→ move to the other running subagents; with none
    // running, ←/→ fall through to the tabs.
    const route = () => {
      const current = context.ui.router.current()
      return current.type === "session" ? current.sessionID : undefined
    }
    const family = useFamily(context, route)
    const go = (sessionID: string | undefined) => {
      if (!sessionID) return false
      context.ui.router.navigate({ type: "session", sessionID })
    }
    context.keymap.layer(() => ({
      mode: "composer",
      priority: 2,
      enabled: family.child,
      commands: [
        {
          id: "prime.subagent.parent",
          title: "Go to parent session",
          group: "Session",
          bind: "up",
          run: () => go(family.parentID()),
        },
        {
          id: "prime.subagent.next",
          title: "Go to next subagent",
          group: "Session",
          bind: "right",
          run: () => go(family.step(1)),
        },
        {
          id: "prime.subagent.previous",
          title: "Go to previous subagent",
          group: "Session",
          bind: "left",
          run: () => go(family.step(-1)),
        },
      ],
    }))
  },
})
