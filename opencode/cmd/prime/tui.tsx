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
import { inboxOf, isWaiting, waitingPrompts } from "@dotfiles/opencode-prime/pending"
import { arrowMoves } from "@dotfiles/opencode-prime/subagent"
import { Compaction } from "@dotfiles/opencode-prime/tui/compaction"
import { hints as wakeHints, WakeTab } from "@dotfiles/opencode-prime/tui/composer"
import { hints as jobHints, JobTab } from "@dotfiles/opencode-prime/tui/jobs"
import { Dock, GoalLine, HintLine, Queued, Splash, StartingNotice, TopBar, UpdateNotice, useFamily, Working } from "@dotfiles/opencode-prime/tui/chrome"
import { PanelFooter, PanelRow, PanelTabs } from "@dotfiles/opencode-prime/tui/panel"
import { Completion, StepEnd } from "@dotfiles/opencode-prime/tui/notice"
import { GroupRow, ToolRow } from "@dotfiles/opencode-prime/tui/tools"
import { AssistantText, GUTTER, PinnedAsk, UserBand } from "@dotfiles/opencode-prime/tui/transcript"
import { ownerZone } from "@dotfiles/opencode-prime/turn-time"
import { Option } from "effect"
import { createSignal } from "solid-js"

export default Plugin.define({
  id: "dotfiles-opencode.prime",
  setup(context) {
    const goal = goals(context)
    const build = builds(context, () => readUpstream())
    const h = host(context, goal.read, build)
    const [detail, setDetail] = createSignal<Detail>("details")
    // The owner's time zone, for when each turn ended (mods/prime/turn-time.ts).
    const zone = ownerZone(context.options)
    // A prompt the runner has not taken draws nothing in the transcript (tui/transcript.tsx UserBand), so its row takes no gap either.
    const hidden = (messageID: string | undefined) => {
      const sessionID = h.route()
      return messageID !== undefined && sessionID !== undefined && isWaiting(inboxOf(h, sessionID), messageID)
    }

    context.ui.layout({
      inset: 1,
      // The host's own rows (a program's notice, a `+ N commands` summary, an error) start where Prime's do (the fork's layout `gutter`).
      gutter: GUTTER,
      // A subagent's view opens on its prompt, as a session's does: the family's rows under it already list what the
      // Subagents picker would (the fork's layout `composer.subagentPicker`; Down still opens the panel).
      composer: { chrome: "rail", subagentPicker: "closed" },
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
    // Prime closes a turn with no agent, model or duration line, only when it ended (in the owner's zone, the
    // option `zone`, and the host's when it differs); a step that ended badly draws its retry, interrupt or error
    // row first (tui/notice.tsx).
    context.ui.slot({
      replace: "session.message.assistant.footer",
      render: (input) => <StepEnd host={h} sessionID={input.sessionID} messageID={input.messageID} detail={detail} zone={zone} />,
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
    // And beside it while the service or its plugins start (in a session the line above the composer says it).
    context.ui.slot({
      append: "home.footer.status",
      render: () => <StartingNotice host={h} />,
    })

    // The background-work panel (Down on an empty prompt) in the Prime look: its tab bar, each
    // row of the host's tabs in shared columns with a live time, and its footer (the fork's
    // session.composer.panel.* slots; the host keeps the panel's keys).
    context.ui.slot({
      replace: "session.composer.panel.tabs",
      render: (input) => <PanelTabs host={h} input={input} />,
    })
    context.ui.slot({
      replace: "session.composer.panel.row",
      render: (input) => <PanelRow host={h} input={input} />,
    })
    context.ui.slot({
      replace: "session.composer.panel.footer",
      render: (input) => <PanelFooter host={h} input={input} />,
    })

    // The composer panel's Wakes and Monitors tabs, after the host's own (the fork's ui.composerTab; an older build has none).
    for (const [id, title, tab] of [["wakes", "Wakes", "alarm"], ["monitors", "Monitors", "monitor"]] as const)
      context.ui.composerTab?.({
        id,
        title,
        hints: () => wakeHints,
        render: (input) => <WakeTab host={h} sessionID={input.sessionID} tab={tab} close={input.close} />,
      })
    // The Jobs tab: the session's jobs (the wake mod's long commands), running and lately ended, the highlighted one's log tail, kill.
    context.ui.composerTab?.({
      id: "jobs",
      title: "Jobs",
      hints: () => jobHints,
      render: (input) => <JobTab host={h} sessionID={input.sessionID} close={input.close} />,
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

    // In a subagent's view ↑ goes back to the parent (as Escape does there) and
    // ←/→ move to the other running subagents; with none running, ←/→ fall
    // through. With the composer panel open (Down), ←/→ stay above its tabs,
    // whose ←/→ switch tabs then; ↑ is the panel's.
    const family = useFamily(h, h.route)
    const go = (sessionID: string | undefined) => {
      if (!sessionID) return false
      h.open(sessionID)
    }
    // On the prompt, above its own history layer (priority 1): only while it is empty and, for ↑, no prompt waits to
    // be taken back (subagent.ts `arrowMoves`); a draft keeps the arrows, and ↑ walks its history.
    const moves = (key: "up" | "left" | "right") =>
      Option.exists(Option.fromNullishOr(h.route()), (sessionID) =>
        arrowMoves(key, {
          draft: Option.map(Option.fromNullishOr(context.renderer.currentFocusedEditor), (editor) => editor.plainText),
          waiting: waitingPrompts(inboxOf(h, sessionID)).length,
        }),
      )
    context.keymap.layer(() => ({
      priority: 2,
      enabled: family.child,
      commands: [
        {
          id: "prime.subagent.prompt.parent",
          title: "Go to parent session",
          group: "Session",
          bind: "up",
          run: () => moves("up") && go(family.parentID()),
        },
        {
          id: "prime.subagent.prompt.next",
          title: "Go to next subagent",
          group: "Session",
          bind: "right",
          run: () => moves("right") && go(family.step(1)),
        },
        {
          id: "prime.subagent.prompt.previous",
          title: "Go to previous subagent",
          group: "Session",
          bind: "left",
          run: () => moves("left") && go(family.step(-1)),
        },
      ],
    }))
    // ↑ stays the panel's: it moves up its list and, at the top, closes the panel back to the prompt.
    context.keymap.layer(() => ({
      mode: "composer",
      priority: 2,
      enabled: family.child,
      commands: [
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
