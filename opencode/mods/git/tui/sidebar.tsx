// The session sidebar's Git section: the branch against its upstream, the
// changed files with their totals and the branch's pull request. Thin: it
// asks the git RPC (git.ts) about this session when it mounts, when the
// session changes, when a step of the session ends, and every 10 seconds, and
// draws the lines sidebar.ts projects. It runs no program: the server reads
// git and `gh` in the session's directory. An answer that fails or does not
// decode draws what the other answer allows, or nothing.
// cmd/git/tui.tsx registers it.
import type { Plugin } from "@opencode/plugin/tui"
import { Option, Schema } from "effect"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { CheckoutAnswer, GIT, PullRequestAnswer } from "../git.ts"
import { sidebarLines, type Tone } from "../sidebar.ts"

const decodeCheckout = Schema.decodeUnknownOption(CheckoutAnswer)
const decodePullRequest = Schema.decodeUnknownOption(PullRequestAnswer)

/** How often the section reads the checkout between the session's steps. */
const REFRESH_MS = 10_000

export function GitSidebar(props: { ctx: Plugin.Context; sessionID: string }) {
  const ctx = props.ctx
  const [checkout, setCheckout] = createSignal<CheckoutAnswer>({})
  const [pullRequest, setPullRequest] = createSignal<PullRequestAnswer>({})
  const abort = new AbortController()
  let asked = 0
  const refresh = () => {
    const ask = ++asked
    const rpc = ctx.client.rpc(GIT)
    const query = { sessionID: props.sessionID }
    const options = { location: ctx.location, signal: abort.signal }
    // Only the newest question's answers count. The checkout comes back from
    // git alone; the pull request waits on `gh`, so each lands on its own.
    const fresh = () => ask === asked && !abort.signal.aborted
    rpc
      .checkout(query, options)
      .then((value) => Option.getOrElse(decodeCheckout(value), () => ({})), () => ({}))
      .then((value) => {
        if (fresh()) setCheckout(value)
      })
    rpc
      .pullRequest(query, options)
      .then((value) => Option.getOrElse(decodePullRequest(value), () => ({})), () => ({}))
      .then((value) => {
        if (fresh()) setPullRequest(value)
      })
  }
  createEffect(on(() => props.sessionID, refresh))
  const unsubscribe = ctx.data.on("session.step.ended", (event) => {
    if (event.data.sessionID === props.sessionID) refresh()
  })
  const timer = setInterval(refresh, REFRESH_MS)
  onCleanup(() => {
    abort.abort()
    clearInterval(timer)
    unsubscribe()
  })
  const lines = createMemo(() => sidebarLines(checkout(), pullRequest()))
  const theme = () => ctx.theme
  const colour = (tone: Tone) =>
    tone === "error"
      ? theme().text.feedback.error.base
      : tone === "warning"
        ? theme().text.feedback.warning.base
        : tone === "success"
          ? theme().text.feedback.success.base
          : tone === "base"
            ? theme().text.base
            : theme().text.muted
  return (
    <Show when={lines().length > 0}>
      <box>
        <text fg={theme().text.base}>
          <b>Git</b>
        </text>
        <For each={lines()}>{(line) => <text fg={colour(line.tone)}>{line.text}</text>}</For>
      </box>
    </Show>
  )
}
