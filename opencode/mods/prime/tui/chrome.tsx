// The frame around the transcript in the Prime look: a one-line top bar, a
// text splash, the hint line (with the update notice) and the goal line
// above the editor, and
// the tray, rule, dock line (subagents, shells, wakes; drawn only while one
// is active) and a live row per subagent under it. The words are
// chrome.ts's; this file draws them.
import * as TuiClock from "@dotfiles/decider/tui-clock"
import { pendingIn } from "@dotfiles/opencode-model-next/pending"
import { board } from "@dotfiles/opencode-queue/board"
import { tally } from "@dotfiles/opencode-queue/plan"
import { keptMemo } from "@dotfiles/opencode-subagents/solid/kept"
import type { BoxRenderable, RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { Option } from "effect"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Accessor } from "solid-js"
import {
  cost,
  dockShown,
  plural,
  queueItem,
  splashAgent,
  splashModel,
  trayModel,
  trayModelQueued,
  usageLabel,
} from "../chrome.ts"
import { inboxOf, LEADER_REST, leaderLabel, loader, queuedRow, SEND_COMMAND, sendHint, waitingPrompts } from "../pending.ts"
import { elapsed } from "../clock.ts"
import { GOAL_LINGER_MS, goalLine, goalShown, type Goal } from "../goal.ts"
import { startingLine } from "../starting.ts"
import { jobItem, jobsOf, runningJobs } from "../jobs.ts"
import { type HintMove, navigationHint, neighbour, othersWorking, subagentOrder, topTitle } from "../subagent.ts"
import { UPDATE_LEAD, UPDATE_REST, upstreamNotice } from "../update.ts"
import { sameWakeItem, wakeItem } from "../wakes.ts"
import { useNow } from "./clock.ts"
import { useWorking, working } from "./family.ts"
import type { Host } from "./host.ts"
import { SubagentRows } from "./live.tsx"
import { toneColor } from "./tone.ts"
import { QUEUE_TAB } from "./queue.tsx"
import { GUTTER } from "./transcript.tsx"

/**
 * Where a session sits among its subagents: whether it is one, its parent,
 * and the subagent ←/→ moves to. Plain reads, so a keymap can use them
 * outside a component; reactive inside one. How many others run is
 * family.ts `useOthers`, a memo.
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
    step: (by: 1 | -1) => {
      const id = sessionID()
      return id ? neighbour(order(), id, by, running()) : undefined
    },
  }
}

/**
 * A run of text a click acts on: brighter while the pointer is over it, the
 * same cells either way. A drag that selected text is a copy, not a click.
 */
function Pressable(props: { host: Host; text: string; fg: RGBA; shrink: number; press: () => void }) {
  const [hover, setHover] = createSignal(false)
  const fg = () => {
    if (hover()) return props.host.theme().text.base
    return props.fg
  }
  return (
    <box
      flexShrink={props.shrink}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (!props.host.selecting()) props.press()
      }}
    >
      <text wrapMode="none" truncate fg={fg()}>
        {props.text}
      </text>
    </box>
  )
}

export function TopBar(props: { host: Host; sessionID: string }) {
  // A subagent's title reads behind its parent's, which a click goes back to.
  const parent = createMemo(() =>
    // A grandchild's goes to its own parent, the subagent above it, not the session at the top.
    Option.flatMap(Option.fromNullishOr(props.host.session(props.sessionID)?.parentID), (id) => Option.fromNullishOr(props.host.session(id))),
  )
  const title = createMemo(() => topTitle(props.host.session(props.sessionID), Option.getOrUndefined(parent())))
  const spent = createMemo(() => cost(props.host.cost(props.sessionID)))
  return (
    <box height={1} flexShrink={0} flexDirection="row" justifyContent="center">
      <Show when={title().parent}>
        {(parentTitle) => (
          <>
            <Pressable
              host={props.host}
              text={parentTitle()}
              fg={props.host.theme().text.muted}
              shrink={1}
              press={() => {
                const shown = parent()
                if (Option.isSome(shown)) props.host.open(shown.value.id)
              }}
            />
            <text wrapMode="none" flexShrink={0} fg={props.host.theme().text.muted}>
              {" › "}
            </text>
          </>
        )}
      </Show>
      <text wrapMode="none" truncate fg={props.host.theme().text.base}>
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
 * The line above the composer: while a turn runs with a prompt waiting, the
 * key that interrupts it and sends (pending.ts `sendHint`) on the left; the
 * update notice on the right. The way to move among a family's sessions sits
 * under the composer, on the dock's first line (`Dock`), in a session and in
 * a subagent alike. It keeps its row while both are empty, so the composer
 * never jumps.
 */
export function HintLine(props: { host: Host; sessionID: string }) {
  const send = createMemo(() =>
    sendHint({
      shortcut: props.host.shortcut(SEND_COMMAND),
      running: props.host.status(props.sessionID) === "running",
      waiting: waitingPrompts(inboxOf(props.host, props.sessionID)).length,
    }),
  )
  return (
    <box flexDirection="row" justifyContent="space-between" gap={2} height={1} marginTop={1} flexShrink={0}>
      {/* While a leader chord waits for its next key, that takes the hint's place, until the chord completes, is
          cancelled or times out. */}
      <Show
        when={Option.getOrUndefined(props.host.leader())}
        fallback={
          /* While the service or its plugins start, that takes the hint's place: a prompt sent then waits for it. */
          <Show
            when={Option.isSome(props.host.starting())}
            fallback={
              // opentui before 0.9 never painted a text's own left padding: these cells only reserved room on the right.
              <text wrapMode="none" truncate fg={props.host.theme().text.faint} paddingRight={GUTTER}>
                {send()}
              </text>
            }
          >
            <box paddingLeft={GUTTER} flexShrink={1}>
              <StartingNotice host={props.host} />
            </box>
          </Show>
        }
      >
        {(keys) => (
          // Drawn where the send hint is, so the same right-hand reserve (see above).
          <text wrapMode="none" truncate fg={props.host.theme().text.faint} paddingRight={GUTTER}>
            <span style={{ fg: props.host.theme().hue.accent[300] }}>{leaderLabel(keys())}</span>
            {LEADER_REST}
          </text>
        )}
      </Show>
      <UpdateNotice host={props.host} />
    </box>
  )
}

/**
 * `server starting · 42s · a prompt sent now waits for it` while the TUI waits for its service, then
 * `plugins starting · …` while the location's plugins activate (starting.ts): the lead muted, the rest faint, the
 * time ticking each second. Nothing for a wait under STARTING_SHOWN_AFTER_MS, nor once it is over.
 */
export function StartingNotice(props: { host: Host }) {
  const theme = () => props.host.theme()
  const now = useNow(() => Option.isSome(props.host.starting()))
  const line = createMemo(() => startingLine(props.host.starting(), now()))
  return (
    <Show when={Option.getOrUndefined(line())}>
      {(shown) => (
        <text wrapMode="none" truncate fg={theme().text.faint}>
          <span style={{ fg: theme().text.muted }}>{shown().lead}</span>
          {shown().rest}
        </text>
      )}
    </Show>
  )
}

/**
 * The session's goal while it shows (goal.ts `goalShown`): a met goal is
 * dropped once its moment passes, by a timer set for that moment.
 */
function useGoal(host: Host, sessionID: () => string | undefined): Accessor<Goal | undefined> {
  const [now, setNow] = createSignal(TuiClock.now())
  const goal = createMemo(() => {
    const id = sessionID()
    return id ? host.goal(id) : undefined
  })
  createEffect(() => {
    const current = goal()
    if (current?.status !== "complete") return
    const left = current.updatedAt + GOAL_LINGER_MS - TuiClock.now()
    if (left <= 0) return setNow(TuiClock.now())
    onCleanup(TuiClock.once(left, () => setNow(TuiClock.now())))
  })
  return createMemo(() => {
    const current = goal()
    return goalShown(current, now()) ? current : undefined
  })
}

/**
 * `update available · restart to update` while this TUI runs an older build
 * than its service, then `upstream +12` (` · merge blocked`) while upstream
 * OpenCode has commits the installed build lacks (update.ts). Quiet: each
 * lead muted, the rest faint, no toast. Nothing while neither holds. The
 * right end of the line above the composer holds it in a session
 * (`HintLine`), the home footer's status on the home screen.
 */
export function UpdateNotice(props: { host: Host }) {
  const theme = () => props.host.theme()
  const upstream = createMemo(() => upstreamNotice(props.host.upstream()))
  return (
    <Show when={props.host.update() || upstream()}>
      <text wrapMode="none" truncate fg={theme().text.faint}>
        <Show when={props.host.update()}>
          <span style={{ fg: theme().text.muted }}>{UPDATE_LEAD}</span>
          {UPDATE_REST}
        </Show>
        <Show when={upstream()}>
          {(shown) => (
            <>
              {props.host.update() ? DOCK_SEP : ""}
              <span style={{ fg: theme().text.muted }}>{shown().lead}</span>
              {shown().rest}
            </>
          )}
        </Show>
      </text>
    </Show>
  )
}

/** The cells a dock item takes. */
const cellsOf = (text: string) => [...text].length
const DOCK_SEP = "  ·  "

export function Dock(props: { host: Host; sessionID?: string }) {
  const theme = () => props.host.theme()
  const usage = createMemo(() => (props.sessionID ? usageLabel(props.host.usage(props.sessionID)) : undefined))
  // A switch queued for the session (mods/model-next, in its metadata) shows beside the model until it applies.
  const queuedNext = () =>
    Option.map(
      Option.flatMap(Option.flatMap(Option.fromNullishOr(props.sessionID), (id) => Option.fromNullishOr(props.host.session(id))), pendingIn),
      (queued) => trayModel({ providerID: queued.model.providerID, modelID: queued.model.id, variant: queued.model.variant }),
    )
  const model = createMemo(() => trayModelQueued(trayModel(props.host.model()), queuedNext()))
  // A subagent waiting on a shell or subagent of its own that still runs is idle to the host but counts, as its row does.
  const busy = useWorking(props.host, () => Option.fromNullishOr(props.sessionID))
  // The count is the family's, in a session and in each of its subagents alike, as the rows under it are: the dock
  // keeps its height as the view moves between them, so the composer above it stays put.
  const subagents = createMemo(() => busy().length)
  // The ones ←/→ reach from here: in a session all of them, in a subagent the others.
  const others = createMemo(() => othersWorking(busy(), props.sessionID ?? "", () => true))
  const shells = createMemo(() => (props.sessionID ? props.host.shells(props.sessionID) : 0))
  // A subagent's view keeps the session's layout: its way back and across, and its family's rows, sit where a session's way down and rows do.
  const child = createMemo(() => Boolean(props.sessionID && props.host.session(props.sessionID)?.parentID))
  // Where a click on the hint goes: the parent, as ↑ and Escape do there, or the subagent ← / → moves to; in a
  // session, what ↓ does there (the host's Subagents picker).
  const family = useFamily(props.host, () => props.sessionID)
  const move = (to: HintMove) => {
    if (to === "subagents") return props.host.openSubagents()
    const target = { parent: family.parentID, previous: () => family.step(-1), next: () => family.step(1) }[to]()
    if (target) props.host.open(target)
  }
  const wakes = props.host.wakes(() => props.sessionID)
  // The session's jobs: counted while they run, as the shells are; an ended one drops from the count.
  const jobReading = props.host.jobs(() => Option.fromNullishOr(props.sessionID))
  const jobs = createMemo(() => runningJobs(jobsOf(jobReading())))
  const terminal = useTerminalDimensions()
  const [measured, setMeasured] = createSignal<number>()
  const subagentText = () => `◆ ${plural(subagents(), "subagent")}`
  const shellText = () => plural(shells(), "shell")
  const jobText = createMemo(() => jobItem(jobs()))
  // The root session's queue: what is not done, how much of it needs the owner. A click opens the Queue tab.
  const queue = props.host.queue(() => Option.fromNullishOr(props.sessionID))
  const queued = createMemo(() =>
    Option.match(queue(), { onNone: () => ({ open: 0, needsYou: 0 }), onSome: (shown) => tally(board(shown.items, shown.live, TuiClock.now())) }),
  )
  const queueText = createMemo(() => queueItem(queued()))
  const [queueHover, setQueueHover] = createSignal(false)
  // The wake item takes what the row has left after the other items. The wakes are read
  // again every 2 seconds; a reading that says the same keeps the item, and draws nothing.
  const wake = keptMemo(() => {
    const reading = wakes()
    if (!reading) return undefined
    const job = Option.match(jobText(), { onNone: () => 0, onSome: (text) => DOCK_SEP.length + cellsOf(text) })
    const queue = Option.match(queueText(), {
      onNone: () => 0,
      onSome: (item) => DOCK_SEP.length + cellsOf(item.text) + Option.match(item.needs, { onNone: () => 0, onSome: (needs) => 2 + cellsOf(needs) }),
    })
    const others = cellsOf(subagentText()) + DOCK_SEP.length * 2 + cellsOf(shellText()) + job + queue
    return wakeItem(reading, (measured() ?? terminal().width - 2) - others)
  }, sameWakeItem)
  // The count opens the host's Subagents picker, as Down on an empty prompt does.
  const [pickerHover, setPickerHover] = createSignal(false)
  // The shells count opens the session's shell list, where one can be read or killed.
  const [shellsHover, setShellsHover] = createSignal(false)
  const sep = () => <span style={{ fg: theme().text.faint }}>{DOCK_SEP}</span>
  // The count line shows only while something is active (chrome.ts `dockShown`), read from the same live values it draws.
  const shown = createMemo(() => {
    const entries = wakes()?.entries ?? []
    return dockShown({
      subagents: subagents(),
      shells: shells(),
      jobs: jobs(),
      wakes: entries.filter((entry) => entry.kind === "alarm").length,
      monitors: entries.filter((entry) => entry.kind === "monitor").length,
      notices: wakes()?.notices ?? 0,
      queued: queued().open,
    })
  })
  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1}>
      {/* Right under the composer: the way to move (in a session down to its subagents, in a subagent back to its parent and across), then the model and usage at the right. */}
      <box flexDirection="row" height={1} gap={2}>
        {/* A click on the way back or on an arrow across moves as its key does. */}
        <box flexDirection="row" flexShrink={1}>
          <For each={navigationHint({ child: child(), others: others() })}>
            {(part) => (
              <Show
                when={part.move}
                fallback={
                  <text wrapMode="none" truncate fg={theme().text.faint} flexShrink={1}>
                    {part.text}
                  </text>
                }
              >
                {(to) => <Pressable host={props.host} text={part.text} fg={theme().text.faint} shrink={0} press={() => move(to())} />}
              </Show>
            )}
          </For>
        </box>
        <box flexGrow={1} />
        <text wrapMode="none" truncate fg={theme().text.faint}>
          {[model(), usage()].filter(Boolean).join(" · ")}
        </text>
      </box>
      <box height={1} border={["top"]} borderColor={theme().border.base} />
      <Show when={shown()}>
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
        <Show when={Option.getOrUndefined(queueText())}>
          {(item) => (
            <>
              <text wrapMode="none" flexShrink={0}>
                {sep()}
              </text>
              <box
                flexShrink={0}
                onMouseOver={() => setQueueHover(true)}
                onMouseOut={() => setQueueHover(false)}
                onMouseUp={() => props.host.openTab(QUEUE_TAB)}
              >
                <text wrapMode="none">
                  <span style={{ fg: [theme().text.muted, theme().text.base][Number(queueHover())] }}>{item().text}</span>
                  <Show when={Option.getOrUndefined(item().needs)}>{(needs) => <span style={{ fg: theme().text.feedback.warning.base }}>{`, ${needs()}`}</span>}</Show>
                </text>
              </box>
            </>
          )}
        </Show>
        <Show when={Option.getOrUndefined(jobText())}>
          {(text) => (
            <text wrapMode="none" flexShrink={0}>
              {sep()}
              <span style={{ fg: theme().text.feedback.success.base }}>{text()}</span>
            </text>
          )}
        </Show>
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
      </Show>
      {/* A row per subagent of the family under the count, sidebar open or closed; inside a subagent the one shown is marked. */}
      <Show when={props.sessionID}>
        {(id) => <SubagentRows host={props.host} sessionID={id()} child={child()} />}
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
 * waiting behind the turn the runner is busy on (a prompt sent to an idle
 * session is none), steers and queued prompts in one list, oldest
 * first (`◌ queued · Also update the docs.`, `◌ after the turn · …`,
 * pending.ts): the prompt leaves the transcript until the runner takes it,
 * and its row goes the moment it does. A click offers that kind's actions
 * (`pendingActions`). Nothing while none waits.
 */
export function Queued(props: { host: Host; sessionID: string }) {
  const theme = () => props.host.theme()
  const prompts = createMemo(() => waitingPrompts(inboxOf(props.host, props.sessionID)))
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
 * While a turn runs: a blank row, then the host's spinner in the primary
 * accent (Prime #7c6faf), turning with every other spinner on screen, and
 * `Executing · 13s` (Prime's loader row), timed as pending.ts `loader` says.
 * While the run compacts it draws nothing: the compaction's own row spins and
 * counts (`Automatic compaction · 4s`).
 */
export function Working(props: { host: Host; sessionID: string }) {
  const running = createMemo(() => props.host.status(props.sessionID) === "running")
  const shown = createMemo(() => loader(props.host.messages(props.sessionID), props.host.pending(props.sessionID)))
  // The time counts on the shared clock, which ticks only while the turn runs.
  const now = useNow(running)
  const [seen, setSeen] = createSignal(TuiClock.now())
  createEffect(() => {
    if (running()) setSeen(TuiClock.now())
  })
  return (
    <Show when={running() ? shown() : undefined}>
      {(loader) => (
        <box paddingLeft={GUTTER} marginTop={1} flexShrink={0} flexDirection="row" gap={1}>
          <props.host.Spinner color={props.host.theme().hue.accent[300]} />
          <text wrapMode="none" fg={props.host.theme().text.muted}>
            Executing · {elapsed(now() - (loader().since ?? seen()))}
          </text>
        </box>
      )}
    </Show>
  )
}
