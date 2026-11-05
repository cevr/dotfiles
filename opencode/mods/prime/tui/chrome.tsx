// The frame around the transcript in the Prime look: a one-line top bar, a
// text splash, the detail-mode hint above the editor, and the tray, rule,
// activity line and a live row per subagent under it. The words are
// chrome.ts's; this file draws them.
import { createMemo, createSignal, onCleanup, Show, type Accessor } from "solid-js"
import {
  cost,
  plural,
  splashAgent,
  splashModel,
  SPINNER,
  SPINNER_MS,
  trayModel,
  turnStart,
  usageLabel,
} from "../chrome.ts"
import { elapsed } from "../clock.ts"
import { detailHint, type Detail } from "../detail.ts"
import { navigationHint, neighbour, othersWorking, subagentOrder, topTitle } from "../subagent.ts"
import type { Host } from "./host.ts"
import { SubagentRows, working } from "./live.tsx"
import { GUTTER } from "./transcript.tsx"

/**
 * Where a session sits among its subagents: whether it is one, its parent,
 * the subagent ←/→ moves to, and how many others run. Plain reads, so a
 * keymap can use them outside a component; reactive inside one.
 */
export function useFamily(host: Host, sessionID: () => string | undefined) {
  const parentID = () => {
    const id = sessionID()
    return (id ? host.session(id)?.parentID : undefined) ?? undefined
  }
  // Running as its row reads it: one waiting on its own background work counts.
  const running = () => {
    const id = sessionID()
    return id ? working(host, id) : () => false
  }
  const order = () => {
    const id = sessionID()
    return id ? subagentOrder(host.sessions(), id) : []
  }
  return {
    parentID,
    child: () => parentID() !== undefined,
    /** In a subagent, the other subagents running; in a session, its running subagents. */
    others: () => othersWorking(order(), sessionID(), running()),
    step: (by: 1 | -1) => {
      const id = sessionID()
      return id ? neighbour(order(), id, by, running()) : undefined
    },
  }
}

export function TopBar(props: { host: Host; sessionID: string }) {
  // A subagent's title reads behind its parent's.
  const title = createMemo(() => {
    const session = props.host.session(props.sessionID)
    return topTitle(session, session?.parentID ? props.host.session(session.parentID) : undefined)
  })
  const spent = createMemo(() => cost(props.host.cost(props.sessionID)))
  return (
    <box height={1} flexShrink={0} flexDirection="row" justifyContent="center">
      <text wrapMode="none" truncate fg={props.host.theme().text.base}>
        <Show when={title().parent}>
          {(parent) => <span style={{ fg: props.host.theme().text.muted }}>{parent()} › </span>}
        </Show>
        {title().title}
        <span style={{ fg: props.host.theme().text.faint }}>
          {"  "}
          {spent()}
        </span>
      </text>
    </box>
  )
}

export function Splash(props: { host: Host; sessionID: string }) {
  const theme = () => props.host.theme()
  const session = createMemo(() => props.host.session(props.sessionID))
  const cwd = createMemo(() => {
    const directory = session()?.location?.directory
    return directory ? props.host.path(directory) : ""
  })
  // A subagent runs its own agent and model, not the prompt's.
  const agent = createMemo(() => splashAgent(session()))
  const model = createMemo(() => splashModel(session(), props.host.model()))
  const line = (label: string, value: string) => (
    <text wrapMode="none" truncate fg={theme().text.base}>
      <span style={{ fg: theme().text.muted }}>{label} </span>
      {value}
    </text>
  )
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={GUTTER} marginTop={1}>
      {line("opencode", `v${props.host.version()}`)}
      <Show when={agent()}>{(name) => line("agent", name())}</Show>
      {line("model", model())}
      {line("cwd", cwd())}
    </box>
  )
}

/** The hints above the composer: how to move among subagents on the left, the detail mode on the right. */
export function ModeHint(props: { host: Host; sessionID: string; detail: Accessor<Detail> }) {
  const family = useFamily(props.host, () => props.sessionID)
  const navigation = createMemo(() => navigationHint({ child: family.child(), others: family.others() }))
  return (
    <box flexDirection="row" justifyContent="space-between" marginTop={1} flexShrink={0}>
      <text wrapMode="none" truncate fg={props.host.theme().text.faint} paddingLeft={GUTTER}>
        {navigation()}
      </text>
      <text wrapMode="none" flexShrink={0} fg={props.host.theme().text.faint}>
        {detailHint(props.detail())}
      </text>
    </box>
  )
}

export function Dock(props: { host: Host; sessionID?: string }) {
  const theme = () => props.host.theme()
  const usage = createMemo(() => (props.sessionID ? usageLabel(props.host.usage(props.sessionID)) : undefined))
  const model = createMemo(() => trayModel(props.host.model()))
  const subagents = createMemo(() => {
    if (!props.sessionID) return 0
    const id = props.sessionID
    // A subagent waiting on its own background work is idle to the host but counts, as its row runs.
    return othersWorking(props.host.familyIDs(id), id, working(props.host, id))
  })
  const shells = createMemo(() => (props.sessionID ? props.host.shells(props.sessionID) : 0))
  const goal = createMemo(() => (props.sessionID ? props.host.hasGoal(props.sessionID) : false))
  // The count opens the host's Subagents picker, as Down on an empty prompt does.
  const [pickerHover, setPickerHover] = createSignal(false)
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
          onMouseUp={() => props.host.openSubagents()}
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
      {/* A row per subagent under the count, sidebar open or closed; inside a subagent they sit above its picker (cmd/prime/tui.tsx). */}
      <Show when={props.sessionID && !props.host.session(props.sessionID)?.parentID ? props.sessionID : undefined}>
        {(id) => <SubagentRows host={props.host} sessionID={id()} child={false} />}
      </Show>
    </box>
  )
}

/** While a turn runs: a blank row, then a braille spinner in the primary accent (Prime #7c6faf) and `Executing · 13s` (Prime's loader rows). */
export function Working(props: { host: Host; sessionID: string }) {
  const running = createMemo(() => props.host.status(props.sessionID) === "running")
  // The turn started with the newest user message.
  const started = createMemo(() => turnStart(props.host.messages(props.sessionID)))
  const [now, setNow] = createSignal(Date.now())
  const [frame, setFrame] = createSignal(0)
  const timer = setInterval(() => {
    setNow(Date.now())
    setFrame((value) => (value + 1) % SPINNER.length)
  }, SPINNER_MS)
  onCleanup(() => clearInterval(timer))
  return (
    <Show when={running()}>
      <box paddingLeft={GUTTER} marginTop={1} flexShrink={0}>
        <text wrapMode="none" fg={props.host.theme().text.muted}>
          <span style={{ fg: props.host.theme().hue.accent[300] }}>{SPINNER[frame()]} </span>
          Executing · {elapsed(now() - started())}
        </text>
      </box>
    </Show>
  )
}
