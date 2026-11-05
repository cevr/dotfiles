// The frame around the transcript in the Prime look: a one-line top bar, a
// text splash, the detail-mode hint above the editor, and the tray, rule,
// activity line and a live row per subagent under it.
import type { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, onCleanup, Show, type Accessor } from "solid-js"
import { SubagentRows, working } from "./live"
import { navigationHint, neighbour, subagentOrder, topTitle } from "./subagent"
import { compactTokens, detailHint, elapsed, type Detail } from "./view"
import { GUTTER } from "./transcript"

type Context = Plugin.Context

/**
 * Where a session sits among its subagents: whether it is one, its parent,
 * the subagent ←/→ moves to, and how many others run. Plain reads, so a
 * keymap can use them outside a component; reactive inside one.
 */
export function useFamily(context: Context, sessionID: () => string | undefined) {
  const data = context.data
  const parentID = () => {
    const id = sessionID()
    return (id ? data.session.get(id)?.parentID : undefined) ?? undefined
  }
  // Running as its row reads it: one waiting on its own background work counts.
  const running = () => {
    const id = sessionID()
    return id ? working(data, id) : () => false
  }
  const order = () => {
    const id = sessionID()
    return id ? subagentOrder(data.session.list(), id) : []
  }
  return {
    parentID,
    child: () => parentID() !== undefined,
    /** In a subagent, the other subagents running; in a session, its running subagents. */
    others: () => {
      const runs = running()
      return order().filter((id) => id !== sessionID() && runs(id)).length
    },
    step: (by: 1 | -1) => {
      const id = sessionID()
      return id ? neighbour(order(), id, by, running()) : undefined
    },
  }
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export function TopBar(props: { context: Context; sessionID: string }) {
  const data = props.context.data
  // A subagent's title reads behind its parent's.
  const title = createMemo(() => {
    const session = data.session.get(props.sessionID)
    return topTitle(session, session?.parentID ? data.session.get(session.parentID) : undefined)
  })
  const cost = createMemo(() => money.format(data.session.cost(props.sessionID)))
  return (
    <box height={1} flexShrink={0} flexDirection="row" justifyContent="center">
      <text wrapMode="none" truncate fg={props.context.theme.text.base}>
        <Show when={title().parent}>
          {(parent) => <span style={{ fg: props.context.theme.text.muted }}>{parent()} › </span>}
        </Show>
        {title().title}
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
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const cwd = createMemo(() => {
    const directory = session()?.location.directory
    return directory ? props.context.ui.format.path(directory) : ""
  })
  // A subagent runs its own agent and model, not the prompt's.
  const agent = createMemo(() => (session()?.parentID ? session()?.agent : undefined))
  const model = createMemo(() => {
    const own = session()?.parentID ? session()?.model : undefined
    return own ? `${own.providerID}/${own.id}` : modelLabel(props.context)
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
      <Show when={agent()}>{(name) => line("agent", name())}</Show>
      {line("model", model())}
      {line("cwd", cwd())}
    </box>
  )
}

/** The hints above the composer: how to move among subagents on the left, the detail mode on the right. */
export function ModeHint(props: { context: Context; sessionID: string; detail: Accessor<Detail> }) {
  const family = useFamily(props.context, () => props.sessionID)
  const navigation = createMemo(() => navigationHint({ child: family.child(), others: family.others() }))
  return (
    <box flexDirection="row" justifyContent="space-between" marginTop={1} flexShrink={0}>
      <text wrapMode="none" truncate fg={props.context.theme.text.faint} paddingLeft={GUTTER}>
        {navigation()}
      </text>
      <text wrapMode="none" flexShrink={0} fg={props.context.theme.text.faint}>
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
    // A subagent waiting on its own background work is idle to the host but counts, as its row runs.
    const runs = working(props.context.data, id)
    return data.session.family(id).filter((child) => child !== id && runs(child)).length
  })
  const shells = createMemo(() => {
    if (!props.sessionID) return 0
    return data.shell.list(props.context.location).filter((shell) => shell.metadata.sessionID === props.sessionID)
      .length
  })
  const goal = createMemo(() => (props.sessionID ? data.session.goal(props.sessionID) : undefined))
  // The count opens the host's Subagents picker, as Down on an empty prompt does.
  const [pickerHover, setPickerHover] = createSignal(false)
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
      <box flexDirection="row" height={1}>
        <box
          flexShrink={0}
          onMouseOver={() => setPickerHover(true)}
          onMouseOut={() => setPickerHover(false)}
          onMouseUp={() => props.context.keymap.dispatch("session.child.first")}
        >
          <text wrapMode="none">
            <span
              style={{
                fg: pickerHover()
                  ? theme().text.base
                  : subagents()
                    ? theme().text.feedback.success.base
                    : theme().text.muted,
              }}
            >
              ◆ {plural(subagents(), "subagent")}
            </span>
          </text>
        </box>
        <text wrapMode="none" truncate fg={theme().text.faint}>
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
      {/* A row per subagent under the count, unless the sidebar shows; inside a subagent they sit above its picker (index.tsx). */}
      <Show when={props.sessionID && !data.session.get(props.sessionID)?.parentID ? props.sessionID : undefined}>
        {(id) => <SubagentRows context={props.context} sessionID={id()} child={false} />}
      </Show>
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
