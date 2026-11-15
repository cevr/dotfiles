// The Rex mod's TUI plugin: the composition root of the TUI half of
// @dotfiles/opencode-rex. It does two things in a Rex pane.
//
// It hands the pane to the family. The host's TUI sets the environment of
// the session it shows to its own (its pane's REX_SESSION and REX_BLOCK
// among it); the subagents of that session's family get none from it, so
// their shells ran in the server's environment and named whatever pane the
// server started in. This plugin hands them the same environment the host
// sends, when each appears and each time it starts to run again
// (`@dotfiles/opencode-rex/opencode/family`), so `rex-show` from a subagent
// draws beside the TUI that shows its family. Like the host, it does so only
// when the TUI runs on the server's machine: attached to another
// (`--server`), its pane means nothing there.
//
// It shows OpenCode's state in Rex's tab header and sidebar. It takes the
// terminal's program status from the host and writes one OSC 7501 record for
// the family on screen: working with what runs, blocked on a permission, a
// question or the owner's background questions (followed over the questions
// plugin's RPC, as the herdr reporter does), idle, or error
// (`@dotfiles/opencode-rex/opencode/state`). The record lives in the TUI's
// own terminal, so this holds attached to another machine too. A stop signal
// clears it at once, ahead of the teardown, and closing the plugin clears it
// and hands the program status back. Outside Rex nothing is written.
import { followAsked, keptView } from "@dotfiles/opencode-herdr/opencode/asked"
import { membersOf } from "@dotfiles/opencode-herdr/opencode/view"
import { QUESTIONS } from "@dotfiles/opencode-questions/question"
import { followFamily } from "@dotfiles/opencode-rex/opencode/family"
import { reportState, seenOf } from "@dotfiles/opencode-rex/opencode/state"
import { sessionVariables } from "@dotfiles/opencode-rex/pane"
import { inRex } from "@dotfiles/opencode-rex/state"
import { Plugin } from "@opencode/plugin/tui"
import { Option } from "effect"
import { createRoot } from "solid-js"

/** Whether this TUI was told to attach to a server elsewhere, as the host's `--server` (or `attach`) does. */
const attached = (argv: ReadonlyArray<string>) => argv.some((arg) => arg === "attach" || arg === "--server" || arg.startsWith("--server="))

/**
 * The signals that start OpenCode's teardown: OpenCode already listens for
 * both, so a listener here changes no default action (the herdr reporter
 * listens the same way).
 */
const STOP_SIGNALS = ["SIGTERM", "SIGINT"] as const

/** Hands the TUI's environment to each subagent of the family on screen. */
const handFamily = (context: Plugin.Context) => {
  const variables = sessionVariables(process.env)
  followFamily(
    context.data,
    () => context.ui.router.current(),
    (sessionID) =>
      void context.client.session
        .environment({ sessionID, variables })
        .catch((error: unknown) => context.ui.toast.show({ title: "Rex pane not handed to a subagent", message: String(error), variant: "warning" })),
  )
}

/** Reports the family on screen to the pane's program status until the root is disposed; returns its stop-signal handler's removal. */
const showState = (context: Plugin.Context) => {
  const route = () => context.ui.router.current()
  const asked = followAsked(
    {
      open: (sessionIDs, signal) => context.client.rpc(QUESTIONS).open({ sessionIDs: [...sessionIDs] }, { location: context.location, signal }),
      listen: context.data.listen,
    },
    () => membersOf(context.data, route()),
  )
  const kept = keptView(context.data, route, asked)
  const reporter = reportState({
    rex: true,
    claim: () => context.ui.programStatus.claim(),
    seen: () => {
      const view = kept.view()
      return seenOf(
        view,
        Option.exists(Option.fromUndefinedOr(view.root), (root) => context.data.session.get(root.id)?.outcome === "failed"),
      )
    },
  })
  for (const signal of STOP_SIGNALS) process.on(signal, reporter.exit)
  return () => {
    for (const signal of STOP_SIGNALS) process.off(signal, reporter.exit)
    reporter.exit()
    kept.dispose()
  }
}

export default Plugin.define({
  id: "dotfiles-opencode.rex",
  setup(context) {
    const family = !attached(process.argv.slice(2))
    const state = inRex(process.env)
    if (!family && !state) return
    return createRoot((dispose) => {
      if (family) handFamily(context)
      const stopState = Option.map(Option.liftPredicate(context, () => state), showState)
      return () => {
        Option.map(stopState, (stop) => stop())
        dispose()
      }
    })
  },
})
