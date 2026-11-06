/**
 * The Prime Agent look for the session screen: the composition root of
 * @dotfiles/opencode-prime. It builds the look's Host from OpenCode's plugin
 * context (`@dotfiles/opencode-prime/opencode/host`), lays the transcript out
 * (`rowGap`, from `@dotfiles/opencode-prime/detail`), fills the session
 * screen's slots with the look's components (`@dotfiles/opencode-prime/tui/*`)
 * and binds its keys. Built on the public plugin API only: slots, ui.layout,
 * ui.Markdown and the session data reads. Load it by path through the tui
 * config's `plugins`, and pair it with themes/prime.json.
 */
import { Plugin } from "@opencode/plugin/tui"
import { nextDetail, rowGap, type Detail } from "@dotfiles/opencode-prime/detail"
import { goals } from "@dotfiles/opencode-prime/opencode/goal"
import { host } from "@dotfiles/opencode-prime/opencode/host"
import { Compaction } from "@dotfiles/opencode-prime/tui/compaction"
import { Dock, GoalLine, ModeHint, Splash, TopBar, useFamily, Working } from "@dotfiles/opencode-prime/tui/chrome"
import { SubagentRows } from "@dotfiles/opencode-prime/tui/live"
import { Completion, StepEnd } from "@dotfiles/opencode-prime/tui/notice"
import { GroupRow, ToolRow } from "@dotfiles/opencode-prime/tui/tools"
import { AssistantText, PinnedAsk, UserBand } from "@dotfiles/opencode-prime/tui/transcript"
import { createSignal, Show } from "solid-js"

export default Plugin.define({
  id: "gent.prime",
  setup(context) {
    const goal = goals(context)
    const h = host(context, goal.read)
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
      render: (input) => <TopBar host={h} sessionID={input.sessionID} />,
    })
    context.ui.slot({
      append: "session.transcript.start",
      render: (input) => <Splash host={h} sessionID={input.sessionID} />,
    })
    // Scrolled up, the prompt the top of the view answers sits pinned over it (the fork's overlay slot).
    context.ui.slot({
      append: "session.transcript.overlay",
      render: (input) => <PinnedAsk host={h} input={input} />,
    })
    context.ui.slot({
      replace: "session.message.user",
      render: (input) => <UserBand host={h} sessionID={input.sessionID} messageID={input.messageID} />,
    })
    // A thought is a node of its step's group, as its calls are (tui/tools.tsx).
    context.ui.slot({
      replace: "session.part.reasoning",
      render: (input) => <GroupRow host={h} {...input} detail={detail} />,
    })
    context.ui.slot({
      replace: "session.part.text",
      render: (input) => <AssistantText host={h} {...input} />,
    })
    context.ui.slot({
      replace: "session.part.tool",
      render: (input) => <ToolRow host={h} {...input} detail={detail} />,
    })
    context.ui.slot({
      replace: "session.message.completion",
      render: (input) => <Completion host={h} sessionID={input.sessionID} messageID={input.messageID} detail={detail} />,
    })
    // Prime closes a turn with no agent, model or duration line; a step that
    // ended badly draws its retry, interrupt or error row (tui/notice.tsx).
    context.ui.slot({
      replace: "session.message.assistant.footer",
      render: (input) => <StepEnd host={h} sessionID={input.sessionID} messageID={input.messageID} detail={detail} />,
    })
    // A compaction is one line below All, and the host's whole block (its summary) at All (tui/compaction.tsx).
    context.ui.slot({
      replace: "session.message.compaction",
      render: (input) => <Compaction host={h} sessionID={input.sessionID} messageID={input.messageID} detail={detail} />,
    })
    context.ui.slot({
      append: "session.composer.top",
      render: (input) => <ModeHint host={h} sessionID={input.sessionID} detail={detail} />,
    })
    // The goal line sits right above the composer while the session has a goal (tui/chrome.tsx).
    context.ui.slot({
      append: "session.composer.top",
      render: (input) => <GoalLine host={h} sessionID={input.sessionID} />,
    })
    // Inside a subagent the host's picker takes the prompt's place, and the
    // dock with it: the family's rows sit above the picker instead.
    context.ui.slot({
      append: "session.composer.top",
      render: (input) => (
        <Show when={h.session(input.sessionID)?.parentID}>
          <SubagentRows host={h} sessionID={input.sessionID} child={true} />
        </Show>
      ),
    })
    // Prime's loader is the transcript's last row, straight under the newest output.
    context.ui.slot({
      append: "session.transcript.end",
      render: (input) => <Working host={h} sessionID={input.sessionID} />,
    })
    context.ui.slot({
      replace: "prompt.footer",
      render: (input) => <Dock host={h} sessionID={input.sessionID} />,
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
    const family = useFamily(h, h.route)
    const go = (sessionID: string | undefined) => {
      if (!sessionID) return false
      h.open(sessionID)
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
    return () => goal.stop()
  },
})
