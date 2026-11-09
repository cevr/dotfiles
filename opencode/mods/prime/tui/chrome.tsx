// The frame around the transcript in the Prime look: a one-line top bar, a
// text splash, the detail-mode hint and the goal line above the editor, and
// the tray, rule, dock line (subagents, shells, wakes) and a live row
// per subagent under it. The words are
// chrome.ts's; this file draws them.
import type { BoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Accessor } from "solid-js"
import {
  cost,
  plural,
  splashAgent,
  splashModel,
  SPINNER,
  SPINNER_MS,
  trayModel,
  usageLabel,
} from "../chrome.ts"
import { loader, queuedRow, SEND_COMMAND, sendHint, waitingPrompts } from "../pending.ts"
import { elapsed } from "../clock.ts"
import { detailHint, type Detail } from "../detail.ts"
import { GOAL_LINGER_MS, goalLine, goalShown, type Goal } from "../goal.ts"
import { navigationHint, neighbour, othersWorking, subagentOrder, topTitle } from "../subagent.ts"
import { wakeItem } from "../wakes.ts"
import type { Host } from "./host.ts"
import { SubagentRows, working } from "./live.tsx"
import { toneColor } from "./tone.ts"
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
  // Working as the host's live state says, as its row reads it: one waiting on its own running shell or subagent counts.
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

/**
 * The hints above the composer: how to move among subagents and, while a
 * turn runs with a prompt waiting, the key that interrupts it and sends
 * (pending.ts `sendHint`) on the left; the detail mode on the right.
 */
export function ModeHint(props: { host: Host; sessionID: string; detail: Accessor<Detail> }) {
  const family = useFamily(props.host, () => props.sessionID)
  const send = createMemo(() =>
    sendHint({
      shortcut: props.host.shortcut(SEND_COMMAND),
      running: props.host.status(props.sessionID) === "running",
      waiting: waitingPrompts(props.host.pending(props.sessionID)).length,
    }),
  )
  const navigation = createMemo(() =>
    [navigationHint({ child: family.child(), others: family.others() }), send()].filter(Boolean).join(" · "),
  )
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

/**
 * The session's goal while it shows (goal.ts `goalShown`): a met goal is
 * dropped once its moment passes, by a timer set for that moment.
 */
function useGoal(host: Host, sessionID: () => string | undefined): Accessor<Goal | undefined> {
  const [now, setNow] = createSignal(Date.now())
  const goal = createMemo(() => {
    const id = sessionID()
    return id ? host.goal(id) : undefined
  })
  createEffect(() => {
    const current = goal()
    if (current?.status !== "complete") return
    const left = current.updatedAt + GOAL_LINGER_MS - Date.now()
    if (left <= 0) return setNow(Date.now())
    const timer = setTimeout(() => setNow(Date.now()), left)
    onCleanup(() => clearTimeout(timer))
  })
  return createMemo(() => {
    const current = goal()
    return goalShown(current, now()) ? current : undefined
  })
}

/** The cells a dock item takes. */
const cellsOf = (text: string) => [...text].length
const DOCK_SEP = "  ·  "

export function Dock(props: { host: Host; sessionID?: string }) {
  const theme = () => props.host.theme()
  const usage = createMemo(() => (props.sessionID ? usageLabel(props.host.usage(props.sessionID)) : undefined))
  const model = createMemo(() => trayModel(props.host.model()))
  const subagents = createMemo(() => {
    if (!props.sessionID) return 0
    const id = props.sessionID
    // A subagent waiting on a shell or subagent of its own that still runs is idle to the host but counts, as its row does.
    return othersWorking(props.host.familyIDs(id), id, working(props.host, id))
  })
  const shells = createMemo(() => (props.sessionID ? props.host.shells(props.sessionID) : 0))
  const wakes = props.host.wakes(() => props.sessionID)
  const terminal = useTerminalDimensions()
  const [measured, setMeasured] = createSignal<number>()
  const subagentText = () => `◆ ${plural(subagents(), "subagent")}`
  const shellText = () => plural(shells(), "shell")
  // The wake item takes what the row has left after the other items.
  const wake = createMemo(() => {
    const reading = wakes()
    if (!reading) return undefined
    const others = cellsOf(subagentText()) + DOCK_SEP.length * 2 + cellsOf(shellText())
    return wakeItem(reading, (measured() ?? terminal().width - 2) - others)
  })
  // The count opens the host's Subagents picker, as Down on an empty prompt does.
  const [pickerHover, setPickerHover] = createSignal(false)
  // The shells count opens the session's shell list, where one can be read or killed.
  const [shellsHover, setShellsHover] = createSignal(false)
  const sep = () => <span style={{ fg: theme().text.faint }}>{DOCK_SEP}</span>
  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1}>
      <box flexDirection="row" justifyContent="flex-end" height={1}>
        <text wrapMode="none" truncate fg={theme().text.faint}>
          {[model(), usage()].filter(Boolean).join(" · ")}
        </text>
      </box>
      <box height={1} border={["top"]} borderColor={theme().border.base} />
      <box
        flexDirection="row"
        height={1}
        onSizeChange={function (this: BoxRenderable) {
          const value = this.width
          queueMicrotask(() => setMeasured(value))
        }}
      >
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
              {subagentText()}
            </span>
          </text>
        </box>
        <text wrapMode="none" flexShrink={0}>
          {sep()}
        </text>
        <box
          flexShrink={0}
          onMouseOver={() => setShellsHover(true)}
          onMouseOut={() => setShellsHover(false)}
          onMouseUp={() => {
            if (props.sessionID) props.host.openShells(props.sessionID)
          }}
        >
          <text wrapMode="none">
            <span
              style={{
                fg: shellsHover()
                  ? theme().text.base
                  : shells()
                    ? theme().text.feedback.success.base
                    : theme().text.muted,
              }}
            >
              {shellText()}
            </span>
          </text>
        </box>
        <text wrapMode="none" truncate fg={theme().text.faint}>
          <Show when={wake()}>
            {(item) => (
              <>
                {sep()}
                <span style={{ fg: toneColor(theme(), item().tone) }}>{item().text}</span>
              </>
            )}
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

/**
 * The goal line right above the composer while the session has a goal, in
 * its state's colour (goal.ts): what it is after, the rounds sent and the
 * commands that pause, resume or cancel it. Nothing without a goal.
 */
export function GoalLine(props: { host: Host; sessionID: string }) {
  const theme = () => props.host.theme()
  const goal = useGoal(props.host, () => props.sessionID)
  const terminal = useTerminalDimensions()
  const [measured, setMeasured] = createSignal<number>()
  const line = createMemo(() => {
    const shown = goal()
    return shown ? goalLine(shown, (measured() ?? terminal().width - 2) - GUTTER) : undefined
  })
  return (
    <Show when={line()}>
      {(shown) => (
        <box
          flexDirection="row"
          flexShrink={0}
          paddingLeft={GUTTER}
          onSizeChange={function (this: BoxRenderable) {
            const value = this.width
            queueMicrotask(() => setMeasured(value))
          }}
        >
          <text wrapMode="none" truncate fg={theme().text.faint}>
            <span style={{ fg: toneColor(theme(), shown().tone) }}>{shown().lead}</span>
            <span style={{ fg: shown().tone === "muted" ? theme().text.muted : theme().text.base }}>{shown().body}</span>
            {shown().rest}
          </text>
        </box>
      )}
    </Show>
  )
}

/**
 * Above the composer, in place of the host's queued box, one row per prompt
 * the runner has not taken, steers and queued prompts in one list, oldest
 * first (`◌ queued · Also update the docs.`, `◌ after the turn · …`,
 * pending.ts): the prompt leaves the transcript until the runner takes it,
 * and its row goes the moment it does. A click offers that kind's actions
 * (`pendingActions`). Nothing while none waits.
 */
export function Queued(props: { host: Host; sessionID: string }) {
  const theme = () => props.host.theme()
  const prompts = createMemo(() => waitingPrompts(props.host.pending(props.sessionID)))
  const terminal = useTerminalDimensions()
  const [measured, setMeasured] = createSignal<number>()
  return (
    <Show when={prompts().length > 0}>
      <box
        flexDirection="column"
        flexShrink={0}
        marginTop={1}
        paddingLeft={GUTTER}
        onSizeChange={function (this: BoxRenderable) {
          const value = this.width
          queueMicrotask(() => setMeasured(value))
        }}
      >
        <For each={prompts()}>
          {(prompt) => {
            const [hover, setHover] = createSignal(false)
            return (
              <box
                height={1}
                onMouseOver={() => setHover(true)}
                onMouseOut={() => setHover(false)}
                onMouseUp={() => {
                  if (!props.host.selecting()) props.host.openPending(props.sessionID, prompt)
                }}
              >
                <text wrapMode="none" truncate fg={hover() ? theme().text.base : theme().text.muted}>
                  {queuedRow(prompt, (measured() ?? terminal().width - 2) - GUTTER)}
                </text>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}

/**
 * While a turn runs: a blank row, then a braille spinner in the primary
 * accent (Prime #7c6faf) and `Executing · 13s` (Prime's loader row), timed
 * as pending.ts `loader` says. While the run compacts it draws nothing: the
 * compaction's own row spins and counts (`Automatic compaction · 4s`).
 */
export function Working(props: { host: Host; sessionID: string }) {
  const running = createMemo(() => props.host.status(props.sessionID) === "running")
  const shown = createMemo(() => loader(props.host.messages(props.sessionID), props.host.pending(props.sessionID)))
  const [now, setNow] = createSignal(Date.now())
  const [seen, setSeen] = createSignal(Date.now())
  const [frame, setFrame] = createSignal(0)
  // The spinner turns only while the turn runs; an idle session sets no timer.
  createEffect(() => {
    if (!running()) return
    setNow(Date.now())
    setSeen(Date.now())
    const timer = setInterval(() => {
      setNow(Date.now())
      setFrame((value) => (value + 1) % SPINNER.length)
    }, SPINNER_MS)
    onCleanup(() => clearInterval(timer))
  })
  return (
    <Show when={running() ? shown() : undefined}>
      {(loader) => (
        <box paddingLeft={GUTTER} marginTop={1} flexShrink={0}>
          <text wrapMode="none" fg={props.host.theme().text.muted}>
            <span style={{ fg: props.host.theme().hue.accent[300] }}>{SPINNER[frame()]} </span>
            Executing · {elapsed(now() - (loader().since ?? seen()))}
          </text>
        </box>
      )}
    </Show>
  )
}
