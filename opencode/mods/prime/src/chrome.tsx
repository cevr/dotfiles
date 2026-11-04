// The frame around the transcript in the Prime look: a one-line top bar, a
// text splash, the detail-mode hint above the editor, and the tray, rule and
// activity line under it.
import type { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, onCleanup, Show, type Accessor } from "solid-js"
import { compactTokens, detailHint, elapsed, type Detail } from "./view"
import { GUTTER } from "./transcript"

type Context = Plugin.Context

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export function TopBar(props: { context: Context; sessionID: string }) {
  const title = createMemo(() => props.context.data.session.get(props.sessionID)?.title ?? "")
  const cost = createMemo(() => money.format(props.context.data.session.cost(props.sessionID)))
  return (
    <box height={1} flexShrink={0} flexDirection="row" justifyContent="center">
      <text wrapMode="none" truncate fg={props.context.theme.text.base}>
        {title()}
        <span style={{ fg: props.context.theme.text.faint }}>
          {"  "}
          {cost()}
        </span>
      </text>
    </box>
  )
}

function modelLabel(context: Context) {
  const model = context.ui.model.current()
  if (!model) return ""
  return `${model.providerID}/${model.modelID}`
}

export function Splash(props: { context: Context; sessionID: string }) {
  const theme = () => props.context.theme
  const cwd = createMemo(() => {
    const directory = props.context.data.session.get(props.sessionID)?.location.directory
    return directory ? props.context.ui.format.path(directory) : ""
  })
  const line = (label: string, value: string) => (
    <text wrapMode="none" truncate fg={theme().text.base}>
      <span style={{ fg: theme().text.muted }}>{label} </span>
      {value}
    </text>
  )
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={GUTTER} marginTop={1}>
      {line("opencode", `v${props.context.app.version}`)}
      {line("model", modelLabel(props.context))}
      {line("cwd", cwd())}
    </box>
  )
}

export function ModeHint(props: { context: Context; detail: Accessor<Detail> }) {
  return (
    <box flexDirection="row" justifyContent="flex-end" marginTop={1} flexShrink={0}>
      <text wrapMode="none" fg={props.context.theme.text.faint}>
        {detailHint(props.detail())}
      </text>
    </box>
  )
}

export function Dock(props: { context: Context; sessionID?: string }) {
  const theme = () => props.context.theme
  const data = props.context.data
  const usage = createMemo(() => {
    if (!props.sessionID) return
    const value = data.session.usage(props.sessionID)
    if (!value) return
    return value.percent === undefined
      ? compactTokens(value.tokens)
      : `${compactTokens(value.tokens)} (${value.percent}%)`
  })
  const model = createMemo(() => {
    const current = props.context.ui.model.current()
    if (!current) return ""
    return current.variant ? `${current.modelID}:${current.variant}` : current.modelID
  })
  const subagents = createMemo(() => {
    if (!props.sessionID) return 0
    const id = props.sessionID
    return data.session.family(id).filter((child) => child !== id && data.session.status(child) === "running").length
  })
  const shells = createMemo(() => {
    if (!props.sessionID) return 0
    return data.shell.list(props.context.location).filter((shell) => shell.metadata.sessionID === props.sessionID)
      .length
  })
  const goal = createMemo(() => (props.sessionID ? data.session.goal(props.sessionID) : undefined))
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
  const sep = () => <span style={{ fg: theme().text.faint }}>{"  ·  "}</span>
  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1}>
      <box flexDirection="row" justifyContent="space-between" height={1}>
        <text wrapMode="none" fg={theme().text.muted}>
          ← manage
        </text>
        <text wrapMode="none" truncate fg={theme().text.faint}>
          {[model(), usage()].filter(Boolean).join(" · ")}
        </text>
      </box>
      <box height={1} border={["top"]} borderColor={theme().border.base} />
      <text wrapMode="none" truncate fg={theme().text.faint} paddingLeft={GUTTER}>
        <span style={{ fg: subagents() ? theme().text.feedback.success.base : theme().text.muted }}>
          ◆ {plural(subagents(), "subagent")}
        </span>
        {sep()}
        <span style={{ fg: shells() ? theme().text.feedback.success.base : theme().text.muted }}>
          ▸ {plural(shells(), "shell")}
        </span>
        {sep()}
        <Show when={goal()} fallback={<span style={{ fg: theme().text.muted }}>goal</span>}>
          <span style={{ fg: theme().text.feedback.warning.base }}>goal</span>
        </Show>
      </text>
    </box>
  )
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

/** While a turn runs: a blank row, then a braille spinner in the primary accent (Prime #7c6faf) and `Executing · 13s` (Prime's loader rows). */
export function Working(props: { context: Context; sessionID: string }) {
  const data = props.context.data
  const running = createMemo(() => data.session.status(props.sessionID) === "running")
  // The turn started with the newest user message.
  const started = createMemo(() =>
    Math.max(
      0,
      ...data.session.message
        .list(props.sessionID)
        .flatMap((message) => (message.type === "user" ? [message.time.created] : [])),
    ),
  )
  const [now, setNow] = createSignal(Date.now())
  const [frame, setFrame] = createSignal(0)
  const timer = setInterval(() => {
    setNow(Date.now())
    setFrame((value) => (value + 1) % SPINNER.length)
  }, 100)
  onCleanup(() => clearInterval(timer))
  return (
    <Show when={running()}>
      <box paddingLeft={GUTTER} marginTop={1} flexShrink={0}>
        <text wrapMode="none" fg={props.context.theme.text.muted}>
          <span style={{ fg: props.context.theme.hue.accent[300] }}>{SPINNER[frame()]} </span>
          Executing · {elapsed(now() - started())}
        </text>
      </box>
    </Show>
  )
}
