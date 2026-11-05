// Tool calls as fx draws them, in Prime's colours: a step's run of calls and
// thoughts is one group, a `●` header naming what it did (`Read 3 files ·
// ran 2 commands · 1 failed`, `Thought` for thoughts alone) and a `├`/`└`
// tree under it: a `thinking` node per thought where it came, and a row per
// run of one tool. Steps that only start background agents, close in time,
// share one group.
//
// The host renders each call and thought in its own slot, so each part draws
// its share: the run's first part draws the header, and every part draws the
// nodes it owns. A group of one row of calls is that row alone, behind the
// group's glyph. Ctrl+O picks how much of the tree shows:
// - overview: the header, and a row per failure; no thought;
// - details: a thought's first line, a row per run of one tool, an edit's
//   diff, and the head of a failure's or the last command's output;
// - all: a thought whole, a row per call with its counts and time, whole
//   diffs and output.
import type { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, For, Match, Show, Switch, type Accessor, type JSX } from "solid-js"
import {
  background,
  callGlyph,
  countLabel,
  duration,
  errorName,
  errorText,
  lineCounts,
  outcome,
  startOf,
  subagentName,
  toolInput,
  toolOutput,
  toolPreview,
  type Call,
} from "../call.ts"
import { elapsed } from "../clock.ts"
import type { Detail } from "../detail.ts"
import { diffRows, diffSign, numberWidth, type DiffRow } from "../diff.ts"
import {
  alone,
  branch,
  callBody,
  edits,
  entryCalls,
  entryKey,
  failureRuns,
  followsGroup,
  groupEntries,
  groupHeader,
  groupLead,
  groupShows,
  hasBody,
  lastCommand,
  levelNodes,
  nodeOwner,
  nodeRows,
  rowEnding,
  rowFiles,
  subject,
  subjectRoom,
  thinking,
  THOUGHT_LABEL,
  thoughtLine,
  verb,
  type Branch,
  type Entry,
  type Node,
  type Row,
  type Run,
} from "../group.ts"
import { words, type ToolPart } from "../session.ts"
import { subagentSession } from "../subagent.ts"
import { useNow } from "./clock.ts"
import type { Host } from "./host.ts"
import { useSessionLink } from "./link.ts"
import { toneColor } from "./tone.ts"
import { GUTTER, type PartProps } from "./transcript.tsx"

/** Lines of output under a row before the rest is counted. */
const HEAD_LINES = 5
/** The columns a header or a row has after its glyph or connector: the transcript's insets, the gutter, the lead and its space, and the terminal's last column, kept free as gent keeps it. */
const LEAD_COLUMNS = 2 + GUTTER + 2 + 1

/** The columns a group's line has for its words. */
function useLineWidth() {
  const terminal = useTerminalDimensions()
  return () => Math.max(10, terminal().width - LEAD_COLUMNS)
}

/**
 * A part's share of its group: a call's rows, or a thought's `thinking`
 * node, and, for the group's first part, its header. The host draws calls
 * and thoughts in slots of their own; both draw through this.
 */
export function GroupRow(props: PartProps & { detail: Accessor<Detail> }) {
  const entries = createMemo((): Entry[] => groupEntries(props.host.messages(props.sessionID), props.messageID, props.partID))
  const run = createMemo((): Call[] => entryCalls(entries()))
  const first = createMemo(() => {
    const head = entries()[0]
    return head !== undefined && entryKey(head) === props.partID
  })
  // Two steps' groups stack as adjacent rows; the later one opens with a blank row.
  const apart = createMemo(
    () =>
      first() &&
      props.detail() !== "overview" &&
      followsGroup(props.host.messages(props.sessionID), props.messageID, props.partID),
  )
  // The nodes the tree shows at this level, in order; the connector depends on the whole list.
  const shown = createMemo((): Node[] => levelNodes(entries(), props.detail()))
  const rowsShown = createMemo(() => nodeRows(shown()))
  const running = createMemo(() => run().some((call) => outcome(call.part) === "running") || thinking(entries()))
  const now = useNow(running)
  // One row needs no header, the row is the group's line, unless a cell's description heads it.
  const single = createMemo(() => alone(run(), shown(), props.detail()))
  const glyph = createMemo((): Lead => {
    const lead = groupLead(run(), now(), thinking(entries()))
    return { char: lead.char, color: toneColor(props.host.theme(), lead.tone) }
  })
  return (
    <Show when={groupShows(entries(), props.detail())}>
      <box flexDirection="column" flexShrink={0} paddingTop={apart() ? 1 : 0}>
        <Show when={first() && !single()}>
          <Header host={props.host} runs={(width) => groupHeader(entries(), width)} glyph={glyph()} />
        </Show>
        <For each={shown()}>
          {(node, index) => (
            <Show when={nodeOwner(node) === props.partID}>
              <Switch>
                <Match when={node.type === "thought" ? node.thought : undefined}>
                  {(thought) => (
                    <ThoughtNode
                      host={props.host}
                      text={thought().text}
                      branch={branch(index(), shown().length, false)}
                      detail={props.detail()}
                    />
                  )}
                </Match>
                <Match when={node.type === "row" ? node.row : undefined}>
                  {(row) => (
                    <TreeRow
                      host={props.host}
                      row={row()}
                      branch={branch(index(), shown().length, single())}
                      glyph={glyph()}
                      detail={props.detail()}
                      lastCommand={row() === lastCommand(rowsShown(), running())}
                      now={now}
                    />
                  )}
                </Match>
              </Switch>
            </Show>
          )}
        </For>
      </box>
    </Show>
  )
}

/** A call's share of its group (`GroupRow`), as the tool slot draws it. */
export const ToolRow = GroupRow

/**
 * A thought as a node of its step's tree: `├ thinking  <first line>` below
 * All, the label in the call rows' colour and the words faint; at All the
 * label alone, with the whole thought hung under it as a call's body hangs.
 */
function ThoughtNode(props: { host: Host; text: string; branch: Branch; detail: Detail }) {
  const theme = () => props.host.theme()
  return (
    <box flexDirection="column" flexShrink={0}>
      <box paddingLeft={GUTTER}>
        <text wrapMode="none" truncate fg={theme().text.muted}>
          {props.branch.connector ?? ""} {THOUGHT_LABEL}
          <Show when={props.detail !== "all"}>
            {"  "}
            <span style={{ fg: theme().text.faint }}>{thoughtLine(props.text)}</span>
          </Show>
        </text>
      </box>
      <Show when={props.detail === "all"}>
        <Hang host={props.host} rail={props.branch.rail}>
          <text fg={theme().text.faint} wrapMode="word">
            {words(props.text)}
          </text>
        </Hang>
      </Show>
    </box>
  )
}

/** What leads a line: the group's glyph, or a tree connector (muted when it has no colour). */
type Lead = { readonly char: string; readonly color?: RGBA }

function Header(props: { host: Host; runs: (width: number) => Run[]; glyph: Lead }) {
  const theme = () => props.host.theme()
  const width = useLineWidth()
  return (
    <box paddingLeft={GUTTER}>
      <text wrapMode="none" truncate fg={theme().text.muted}>
        <span style={{ fg: props.glyph.color ?? theme().text.muted }}>{props.glyph.char}</span>{" "}
        <Runs host={props.host} runs={props.runs(width())} />
      </text>
    </box>
  )
}

/** A line drawn in runs, each in its tone's colour; it goes inside a `<text>`. */
function Runs(props: { host: Host; runs: ReadonlyArray<Run> }) {
  return <For each={[...props.runs]}>{(run) => <span style={{ fg: toneColor(props.host.theme(), run.tone) }}>{run.text}</span>}</For>
}

function TreeRow(props: {
  host: Host
  row: Row
  /** The row's place in the tree (`branch`): its connector, and whether what hangs under it keeps the `│` rail. */
  branch: Branch
  /** The group's glyph, which leads a row that is the group's line alone. */
  glyph: Lead
  detail: Detail
  lastCommand: boolean
  now: Accessor<number>
}) {
  const theme = () => props.host.theme()
  const part = () => props.row.calls[0]
  const width = useLineWidth()
  const leadOf = (): Lead => (props.branch.connector ? { char: props.branch.connector } : props.glyph)
  const lead = () => <span style={{ fg: leadOf().color ?? theme().text.muted }}>{leadOf().char}</span>
  // A subagent's row opens its session.
  const link = useSessionLink(props.host, () => (props.row.tool === "subagent" ? subagentSession(part()) : undefined))
  const timer = createMemo(() => {
    if (props.row.outcome !== "running") return ""
    const ms = props.now() - startOf(part())
    return ms >= 1000 ? elapsed(ms) : ""
  })
  const ending = createMemo(() => rowEnding(props.row))
  // The subjects get what the verb, the timer and the ending leave of the line; the rest is counted.
  const room = createMemo(() => subjectRoom(props.row, width(), timer()))
  return (
    <Switch>
      <Match when={props.detail === "all"}>
        <CallRow
          host={props.host}
          connector={props.branch.connector}
          rail={props.branch.rail}
          tool={props.row.tool}
          part={part()}
        />
      </Match>
      <Match when={props.detail === "overview"}>
        <box paddingLeft={GUTTER} {...link.handlers}>
          <text wrapMode="none" truncate fg={theme().text.muted}>
            {lead()} <Runs host={props.host} runs={failureRuns(props.row, width())} />
          </text>
        </box>
      </Match>
      <Match when={true}>
        <box flexDirection="column" flexShrink={0}>
          <box paddingLeft={GUTTER} {...link.handlers}>
            <text wrapMode="none" truncate fg={link.hover() ? theme().text.base : theme().text.muted}>
              {lead()} {verb(props.row)}{" "}
              <Show when={edits(props.row)} fallback={subject(props.row, room())}>
                <EditCounts host={props.host} row={props.row} />
              </Show>
              <Show when={timer()}>
                {" · "}
                {timer()}
              </Show>
              <Show when={ending()}>
                {(run) => (
                  <>
                    {" · "}
                    <span style={{ fg: toneColor(props.host.theme(), run().tone) }}>{run().text}</span>
                  </>
                )}
              </Show>
            </text>
          </box>
          <RowBody host={props.host} row={props.row} lastCommand={props.lastCommand} rail={props.branch.rail} />
        </box>
      </Match>
    </Switch>
  )
}

/** `src/net.py +1 / -1`, with the counts in the diff colours. */
function EditCounts(props: { host: Host; row: Row }) {
  const theme = () => props.host.theme()
  const files = createMemo(() => rowFiles(props.row))
  return (
    <Show when={files().length > 0} fallback={subject(props.row)}>
      <For each={files()}>
        {(file, index) => (
          <>
            {index() > 0 ? ", " : ""}
            {file.path} <span style={{ fg: theme().diff.text.added }}>+{file.additions}</span>
            {" / "}
            <span style={{ fg: theme().diff.text.removed }}>-{file.deletions}</span>
          </>
        )}
      </For>
    </Show>
  )
}

/**
 * What hangs under a row at the details level: an edit's diff, a failure's
 * reason, the last command's output, a subagent's reply (a background
 * agent's reply comes later, in its own row).
 */
function RowBody(props: { host: Host; row: Row; lastCommand: boolean; rail: boolean }) {
  const part = () => props.row.calls[0]
  const last = () => props.row.calls.at(-1) ?? props.row.calls[0]
  // Everything under the row hangs past the connector, beside the tree's rail while rows follow.
  return (
    <Switch>
      <Match when={props.row.outcome === "failed" ? errorText(part()) : undefined}>
        {(text) => (
          <Hang host={props.host} rail={props.rail}>
            <Head host={props.host} text={text()} />
          </Hang>
        )}
      </Match>
      <Match when={edits(props.row)}>
        <Hang host={props.host} rail={props.rail}>
          <For each={rowFiles(props.row)}>
            {(file) => <DiffBands host={props.host} path={file.path} rows={diffRows(file.patch, 1)} />}
          </For>
        </Hang>
      </Match>
      <Match when={props.row.tool === "shell" && (props.lastCommand || props.row.outcome === "warning")}>
        <Hang host={props.host} rail={props.rail}>
          <Head host={props.host} text={toolOutput(last())} />
        </Hang>
      </Match>
      <Match when={props.row.tool === "subagent" && props.row.outcome === "done" && !background(part())}>
        <Hang host={props.host} rail={props.rail}>
          <AgentMessage host={props.host} from={subagentName(toolInput(part()))} />
        </Hang>
      </Match>
    </Switch>
  )
}

/**
 * What hangs under a tree row, under its words: fx keeps the tree's rail
 * (`│`) beside it while rows follow, and blank past the last row.
 */
function Hang(props: { host: Host; rail: boolean; children: JSX.Element }) {
  return (
    <box flexDirection="row" paddingLeft={GUTTER} flexShrink={0}>
      <box width={2} flexShrink={0} flexDirection="column">
        <Show when={props.rail}>
          <box
            flexGrow={1}
            border={["left"]}
            borderColor={props.host.theme().text.muted}
            customBorderChars={{ ...NO_BORDER, vertical: "│" }}
          />
        </Show>
      </box>
      <box flexDirection="column" flexGrow={1} flexShrink={1}>
        {props.children}
      </box>
    </box>
  )
}

/** OpenTUI border characters with none drawn: a box sets the one it wants. */
const NO_BORDER = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

/** The first lines of some output under a `│ ` gutter, then how many lines the rest is; it goes in a row's hang. */
function Head(props: { host: Host; text: string }) {
  const theme = () => props.host.theme()
  const lines = createMemo(() => {
    const trimmed = props.text.replace(/\n+$/, "")
    return trimmed ? trimmed.split("\n") : []
  })
  const gutter = (body: JSX.Element) => (
    <text wrapMode="none" truncate fg={theme().text.muted}>
      <span style={{ fg: theme().text.faint }}>│ </span>
      {body}
    </text>
  )
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={lines().slice(0, HEAD_LINES)}>{(line) => gutter(line)}</For>
      <Show when={lines().length > HEAD_LINES}>
        {gutter(<span style={{ fg: theme().text.faint }}>… +{lines().length - HEAD_LINES} lines (ctrl+o)</span>)}
      </Show>
    </box>
  )
}

// A subagent's answer, as Prime shows agent mail: a green envelope, then the
// direction (`↓` received) and the sender, under the tree's gutter.
function AgentMessage(props: { host: Host; from: string }) {
  const theme = () => props.host.theme()
  return (
    <box>
      <text wrapMode="none" truncate fg={theme().text.muted}>
        <span style={{ fg: theme().text.faint }}>│ </span>
        <span style={{ fg: theme().text.feedback.success.base }}>✉ </span>
        Agent message
        <span style={{ fg: theme().text.faint }}> · </span>↓ {props.from}
      </text>
    </box>
  )
}

function Glyph(props: { host: Host; part: ToolPart }) {
  const glyph = createMemo(() => callGlyph(props.part))
  return <span style={{ fg: toneColor(props.host.theme(), glyph().tone) }}>{glyph().char} </span>
}

/**
 * The all level's row: one call, as Prime draws it (`✓ shell · preview ·
 * ↑ 1 ↓ 2 lines · 12ms`) behind the tree connector (none when the group is
 * this call alone), then its whole diff and the tail of its output, hung as
 * the details level hangs a row's body: beside the tree's rail while rows
 * follow.
 */
function CallRow(props: { host: Host; connector?: string; rail: boolean; tool: string; part: ToolPart }) {
  const theme = () => props.host.theme()
  const preview = createMemo(() => toolPreview(props.tool, toolInput(props.part)))
  const counts = createMemo(() => countLabel(lineCounts(props.tool, props.part)))
  const body = createMemo(() => callBody({ tool: props.tool, part: props.part }))
  const tail = createMemo(() => [counts(), duration(props.part)].filter(Boolean).join(" · "))
  const sep = () => <span style={{ fg: theme().text.faint }}> · </span>
  const link = useSessionLink(props.host, () => (props.tool === "subagent" ? subagentSession(props.part) : undefined))
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" paddingLeft={GUTTER} {...link.handlers}>
        <text flexShrink={0} wrapMode="none">
          <Show when={props.connector}>{(lead) => <span style={{ fg: theme().text.muted }}>{lead()} </span>}</Show>
          <Glyph host={props.host} part={props.part} />
          <span style={{ fg: link.hover() ? theme().text.base : theme().text.muted }}>{props.tool}</span>
          <Show when={preview()}>{sep()}</Show>
        </text>
        <text flexShrink={1} wrapMode="none" truncate fg={theme().text.faint}>
          {preview()}
        </text>
        <text flexShrink={0} wrapMode="none" fg={theme().text.faint}>
          {sep()}
          {tail()}
          <Show when={errorName(props.part)}>
            {(name) => (
              <>
                {sep()}
                <span style={{ fg: theme().text.feedback.error.base }}>{name()}</span>
              </>
            )}
          </Show>
        </text>
      </box>
      <Show when={hasBody(body())}>
        <Hang host={props.host} rail={props.rail}>
          <For each={[...body().files]}>
            {(file) => (
              <>
                <text wrapMode="none" fg={theme().text.faint}>
                  ╰─ <span style={{ fg: theme().text.muted }}>{file.path}</span>{" "}
                  <span style={{ fg: theme().diff.text.added }}>+{file.additions}</span>{" "}
                  <span style={{ fg: theme().diff.text.removed }}>-{file.deletions}</span>
                </text>
                <DiffBands host={props.host} path={file.path} rows={diffRows(file.patch, Infinity)} />
              </>
            )}
          </For>
          <Show when={body().reply}>
            <AgentMessage host={props.host} from={subagentName(toolInput(props.part))} />
          </Show>
          <Show when={body().output}>
            <ShellTail host={props.host} output={body().output} />
          </Show>
        </Hang>
      </Show>
    </box>
  )
}

// Expanded output: the last five lines under a dim gutter, in a row's hang.
function ShellTail(props: { host: Host; output: string }) {
  const lines = createMemo(() => props.output.replace(/\n+$/, "").split("\n"))
  const hidden = createMemo(() => Math.max(0, lines().length - 5))
  return (
    <box flexDirection="column">
      <Show when={hidden()}>
        <text fg={props.host.theme().text.faint}>... {hidden()} earlier lines</text>
      </Show>
      <For each={lines().slice(-5)}>
        {(line, index) => (
          <text wrapMode="none" truncate fg={props.host.theme().text.muted}>
            <span style={{ fg: props.host.theme().text.faint }}>{index() === 0 ? "╰─ " : "   "}</span>
            {line}
          </text>
        )}
      </For>
    </box>
  )
}

/** Prime's diff rows: ` 42 - ` then the code in its syntax colours, on a full-width band. */
function DiffBands(props: { host: Host; path: string; rows: DiffRow[] }) {
  const theme = () => props.host.theme()
  const width = createMemo(() => numberWidth(props.rows))
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={props.rows}>
        {(row) => (
          <Switch>
            <Match when={row.kind === "gap"}>
              <text fg={theme().text.faint}> ⋮</text>
            </Match>
            <Match when={row.kind !== "gap" ? row : undefined}>
              {(line) => (
                <box
                  width="100%"
                  flexDirection="row"
                  backgroundColor={
                    line().kind === "added"
                      ? theme().diff.background.added
                      : line().kind === "removed"
                        ? theme().diff.background.removed
                        : theme().diff.background.context
                  }
                >
                  <text
                    wrapMode="none"
                    flexShrink={0}
                    fg={
                      line().kind === "added"
                        ? theme().diff.text.added
                        : line().kind === "removed"
                          ? theme().diff.text.removed
                          : theme().text.muted
                    }
                  >
                    {" "}
                    {String(line().line).padStart(width())}{" "}
                    {diffSign(line().kind)}{" "}
                  </text>
                  <props.host.Code content={line().text} path={props.path} />
                </box>
              )}
            </Match>
          </Switch>
        )}
      </For>
    </box>
  )
}
