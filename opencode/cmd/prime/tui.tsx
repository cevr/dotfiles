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
import { readUpstream } from "@dotfiles/opencode-prime/filestore/upstream"
import { builds } from "@dotfiles/opencode-prime/opencode/build"
import { host } from "@dotfiles/opencode-prime/opencode/host"
import { inboxOf, isWaiting } from "@dotfiles/opencode-prime/pending"
import { Compaction } from "@dotfiles/opencode-prime/tui/compaction"
import { hints as wakeHints, WakeTab } from "@dotfiles/opencode-prime/tui/composer"
import { Dock, GoalLine, HintLine, Queued, Splash, TopBar, UpdateNotice, useFamily, Working } from "@dotfiles/opencode-prime/tui/chrome"
import { SubagentRows } from "@dotfiles/opencode-prime/tui/live"
import { Completion, StepEnd } from "@dotfiles/opencode-prime/tui/notice"
import { GroupRow, ToolRow } from "@dotfiles/opencode-prime/tui/tools"
import { AssistantText, GUTTER, PinnedAsk, UserBand } from "@dotfiles/opencode-prime/tui/transcript"
import { createSignal, Show } from "solid-js"

export default Plugin.define({
  id: "gent.prime",
  setup(context) {
    const goal = goals(context)
    const build = builds(context, () => readUpstream())
    const h = host(context, goal.read, build)
    const [detail, setDetail] = createSignal<Detail>("details")
    // A prompt the runner has not taken draws nothing in the transcript (tui/transcript.tsx UserBand), so its row takes no gap either.
    const hidden = (messageID: string | undefined) => {
      const sessionID = h.route()
      return messageID !== undefined && sessionID !== undefined && isWaiting(inboxOf(h, sessionID), messageID)
    }

    context.ui.layout({
      inset: 1,
      // The host's own rows (a program's notice, a `+ N commands` summary, an error) start where Prime's do (the fork's layout `gutter`).
      gutter: GUTTER,
      composer: { chrome: "rail" },
      rowGap: (row) => (hidden(row.messageID) ? 0 : rowGap(detail(), row)),
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
    // The prompts the runner has not taken, steers and queued ones in one list, in place of the host's queued box (tui/chrome.tsx).
    context.ui.slot({
      replace: "session.composer.queued",
      render: (input) => <Queued host={h} sessionID={input.sessionID} />,
    })
    // Navigation hints on the left, the update notice on the right; no standing Ctrl+O hint (tui/chrome.tsx).
    context.ui.slot({
      append: "session.composer.top",
      render: (input) => <HintLine host={h} sessionID={input.sessionID} />,
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
    // On the home screen the update notice sits in the footer's status, beside the MCP count (the line above the composer holds it in a session).
    context.ui.slot({
      append: "home.footer.status",
      render: () => <UpdateNotice host={h} />,
    })

    // The composer panel's Wakes and Monitors tabs, after the host's own (the fork's ui.composerTab; an older build has none).
    for (const [id, title, tab] of [["wakes", "Wakes", "alarm"], ["monitors", "Monitors", "monitor"]] as const)
      context.ui.composerTab?.({
        id,
        title,
        hints: () => wakeHints,
        render: (input) => <WakeTab host={h} sessionID={input.sessionID} tab={tab} close={input.close} />,
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
    return () => {
      goal.stop()
      build.stop()
    }
  },
})
