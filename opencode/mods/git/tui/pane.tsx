// The /git pane: the session's branch, its changed files and its pull
// request. Thin: it reads the git RPC (git.ts) every 2 seconds and draws the
// rows pane.ts projects. Up and down (or k and j) pick a file; Enter asks the
// server how to review it (review.ts: hunk when it is on PATH, else git's
// pager) and hands the terminal to that command, the way OpenCode's external
// editor does: the renderer suspends, the command runs on the terminal, and
// the renderer resumes when it ends. That command is the only program the TUI
// runs; every read runs on the server. An answer that fails or does not
// decode keeps the last reading. cmd/git/tui.tsx registers it.
import type { Plugin } from "@opencode/plugin/tui"
import { Option, Schema } from "effect"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { CheckoutAnswer, type Command, GIT, PullRequestAnswer, ReviewAnswer } from "../git.ts"
import { emptyText, fileRow, moved, notes, paneTitle } from "../pane.ts"
import { pullRequestLine } from "../pull-request.ts"
import { pullRequestTone, type Tone } from "../sidebar.ts"

const decodeCheckout = Schema.decodeUnknownOption(CheckoutAnswer)
const decodePullRequest = Schema.decodeUnknownOption(PullRequestAnswer)
const decodeReview = Schema.decodeUnknownOption(ReviewAnswer)

/** What an answer decodes to; a call that failed decodes to nothing. */
const settle = <A,>(call: Promise<unknown>, decode: (input: unknown) => Option.Option<A>) =>
  call.then(decode, () => Option.none<A>())

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

type PanelInput = { readonly focused: boolean; readonly width: number; readonly close: () => void }

export function Pane(props: { ctx: Plugin.Context; sessionID: string; panel: PanelInput }) {
  const ctx = props.ctx
  const [checkout, setCheckout] = createSignal<CheckoutAnswer>()
  const [pullRequest, setPullRequest] = createSignal<PullRequestAnswer>()
  const [selected, setSelected] = createSignal(0)
  const [reviewNote, setReviewNote] = createSignal<string>()
  const abort = new AbortController()
  const options = () => ({ location: ctx.location, signal: abort.signal })
  let pending = false
  let closed = false
  let handedOver = false

  const files = createMemo(() => checkout()?.checkout?.files ?? [])
  const refresh = async () => {
    if (pending || handedOver) return
    pending = true
    const rpc = ctx.client.rpc(GIT)
    const query = { sessionID: props.sessionID }
    const [read, request] = await Promise.all([
      settle(rpc.checkout(query, options()), decodeCheckout),
      settle(rpc.pullRequest(query, options()), decodePullRequest),
    ])
    pending = false
    if (closed) return
    if (Option.isSome(read)) setCheckout(read.value)
    if (Option.isSome(request)) setPullRequest(request.value)
    setSelected((row) => moved(row, 0, files().length))
  }

  /** Runs `command` on the terminal, the renderer suspended until it ends; what went wrong, if anything. */
  const handOver = async (command: Command): Promise<string | undefined> => {
    handedOver = true
    await ctx.renderer.suspend()
    try {
      const run = Bun.spawn([...command.argv], { cwd: command.cwd, stdio: ["inherit", "inherit", "inherit"] })
      const code = await run.exited
      return code === 0 ? undefined : `${command.argv[0] ?? command.program} exited ${code}`
    } catch (cause) {
      return `${command.argv[0] ?? command.program}: ${messageOf(cause)}`
    } finally {
      await ctx.renderer.resume()
      handedOver = false
    }
  }

  const review = async () => {
    const file = files()[selected()]
    if (file === undefined || handedOver) return
    const answer = await settle(ctx.client.rpc(GIT).review({ sessionID: props.sessionID, path: file.path }, options()), decodeReview)
    if (closed) return
    if (Option.isNone(answer)) return setReviewNote(`Could not ask how to review ${file.path}`)
    const command = answer.value.command
    const failed = command === undefined ? undefined : await handOver(command)
    if (closed) return
    setReviewNote([answer.value.note, failed].filter((part) => part !== undefined).join(" · ") || undefined)
    void refresh()
  }

  // The pane holds focus once open; Esc or q hands it back to the prompt.
  ctx.keymap.layer(() => ({
    enabled: () => props.panel.focused,
    commands: [
      { title: "Close the git pane", group: "Git", bind: "escape,q", run: () => props.panel.close() },
      { title: "Previous file", group: "Git", bind: "up,k", run: () => setSelected((row) => moved(row, -1, files().length)) },
      { title: "Next file", group: "Git", bind: "down,j", run: () => setSelected((row) => moved(row, 1, files().length)) },
      { title: "Review the file", group: "Git", bind: "return", run: () => void review() },
    ],
  }))

  void refresh()
  const timer = setInterval(() => void refresh(), 2000)
  onCleanup(() => {
    closed = true
    abort.abort()
    clearInterval(timer)
  })

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
  const muted = (text: string) => <text fg={theme().text.muted}>{text}</text>
  const rowWidth = () => Math.max(20, props.panel.width - 4)
  return (
    <scrollbox flexGrow={1}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <text fg={theme().text.base} attributes={1}>
          Git
        </text>
        <Show when={checkout()?.checkout}>{(read) => muted(paneTitle(read()))}</Show>
        <For each={notes(checkout(), pullRequest(), reviewNote())}>
          {(note) => <text fg={theme().text.feedback.warning.base}>{note}</text>}
        </For>
        <Show when={pullRequest()?.pullRequest}>
          {(pr) => (
            <text fg={colour(pullRequestTone(pr()))} marginTop={1}>
              {pullRequestLine(pr())}
            </text>
          )}
        </Show>
        <text fg={theme().text.base} attributes={1} marginTop={1}>
          Changed files
        </text>
        <Show when={emptyText(checkout())}>{(text) => muted(text())}</Show>
        <For each={files()}>
          {(file, index) => (
            <text fg={index() === selected() ? theme().text.base : theme().text.muted}>
              {index() === selected() ? "▸ " : "  "}
              {fileRow(file, rowWidth())}
            </text>
          )}
        </For>
        <Show when={files().length > 0}>{muted("↑↓ pick · Enter review · Esc close")}</Show>
      </box>
    </scrollbox>
  )
}
