// Tool calls as fx draws them, in Prime's colours: a step's run of calls is
// one group, a `●` header naming what it did (`Read 3 files · ran 2 commands
// · 1 failed`) and a `├`/`└` tree row per run of one tool under it. Steps
// that only start background agents, close in time, share one group.
//
// The host renders each call in its own slot, so each call draws its share:
// the run's first call draws the header, and every call draws the rows it
// owns. A group of one row is that row alone, behind the group's glyph.
// Ctrl+O picks how much of the tree shows:
// - overview: the header, and a row per failure;
// - details: a row per run of one tool, an edit's diff, and the head of a
//   failure's or the last command's output;
// - all: a row per call with its counts and time, whole diffs and output.
import type { Plugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, For, Match, Show, Switch, type Accessor, type JSX } from "solid-js"
import { useNow } from "./clock"
import {
  background,
  branch,
  callBody,
  errorText,
  failureRuns,
  followsCall,
  groupRun,
  hasBody,
  headerRuns,
  outcome,
  rowEnding,
  rowFiles,
  rows,
  subject,
  verb,
  type Branch,
  type Call,
  type Row,
  type Run,
} from "./group"
import { useSessionLink } from "./link"
import { subagentSession } from "./subagent"
import { GUTTER, type PartProps } from "./transcript"
import {
  countLabel,
  diffRows,
  duration,
  elapsed,
  errorName,
  lineCounts,
  subagentName,
  toolInput,
  toolOutput,
  toolPreview,
  type Detail,
  type DiffRow,
  type ToolPart,
} from "./view"

type Context = Plugin.Context

/** Lines of output under a row before the rest is counted. */
const HEAD_LINES = 5
/** The columns a header or a row has after its glyph or connector: the transcript's insets, the gutter, the lead and its space, and the terminal's last column, kept free as gent keeps it. */
const LEAD_COLUMNS = 2 + GUTTER + 2 + 1

/** The columns a group's line has for its words. */
function useLineWidth() {
  const terminal = useTerminalDimensions()
  return () => Math.max(10, terminal().width - LEAD_COLUMNS)
}

/** A run's colour: hue only where the reader must look, a failure in the error colour and a cancel in the warning colour. */
function toneColor(context: Context, tone: Run["tone"]) {
  if (tone === "error") return context.theme.text.feedback.error.base
  if (tone === "warning") return context.theme.text.feedback.warning.base
  return context.theme.text.muted
}

/** Whether a row ended badly: the collapsed level draws a line for each. */
const ended = (row: Row) => row.outcome === "failed" || row.outcome === "warning" || row.outcome === "cancelled"

export function ToolRow(props: PartProps & { tool: string; detail: Accessor<Detail> }) {
  const run = createMemo((): Call[] => {
    return groupRun(props.context.data.session.message.list(props.sessionID), props.messageID, props.partID)
  })
  const first = createMemo(() => run()[0]?.part.id === props.partID)
  // Two steps' groups stack as adjacent call rows; the later one opens with a blank row.
  const apart = createMemo(
    () =>
      first() &&
      props.detail() !== "overview" &&
      followsCall(props.context.data.session.message.list(props.sessionID), props.messageID, props.partID),
  )
  // The rows the tree shows at this level, in order; the connector depends on the whole list.
  const shown = createMemo((): Row[] => {
    const detail = props.detail()
    if (detail === "all")
      return run().map((call) => ({ tool: call.tool, outcome: outcome(call.part), calls: [call.part], owner: call.part.id }))
    const all = rows(run())
    return detail === "overview" ? all.filter(ended) : all
  })
  const running = createMemo(() => run().some((call) => outcome(call.part) === "running"))
  const now = useNow(running)
  // One row needs no header: the row is the group's line.
  const single = createMemo(() => props.detail() !== "overview" && shown().length === 1)
  const glyph = createMemo(() => groupGlyph(props.context, run(), now()))
  return (
    <Show when={run().length > 0}>
      <box flexDirection="column" flexShrink={0} paddingTop={apart() ? 1 : 0}>
        <Show when={first() && !single()}>
          <Header context={props.context} calls={run()} glyph={glyph()} />
        </Show>
        <For each={shown()}>
          {(row, index) => (
            <Show when={row.owner === props.partID}>
              <TreeRow
                context={props.context}
                row={row}
                branch={branch(index(), shown().length, single())}
                glyph={glyph()}
                detail={props.detail()}
                lastCommand={!running() && row === shown().findLast((item) => item.tool === "shell")}
                now={now}
              />
            </Show>
          )}
        </For>
      </box>
    </Show>
  )
}

/** What leads a line: the group's glyph, or a tree connector (muted when it has no colour). */
type Lead = { readonly char: string; readonly color?: RGBA }

/**
 * The group's glyph: `✗` when a call failed, a blinking `○`/`●` while one
 * runs, else `●`, warning-coloured after a nonzero exit or a cancel (a cut
 * call is no failure, as in gent).
 */
function groupGlyph(context: Context, calls: Call[], now: number): Lead {
  const theme = context.theme
  const states = calls.map((call) => outcome(call.part))
  if (states.includes("failed")) return { char: "✗", color: theme.text.feedback.error.base }
  if (states.includes("running")) return { char: Math.floor(now / 500) % 2 ? "○" : "●", color: theme.hue.accent[300] }
  if (states.includes("warning") || states.includes("cancelled")) return { char: "●", color: theme.text.feedback.warning.base }
  return { char: "●", color: theme.text.muted }
}

function Header(props: { context: Context; calls: Call[]; glyph: Lead }) {
  const theme = () => props.context.theme
  const width = useLineWidth()
  return (
    <box paddingLeft={GUTTER}>
      <text wrapMode="none" truncate fg={theme().text.muted}>
        <span style={{ fg: props.glyph.color ?? theme().text.muted }}>{props.glyph.char}</span>{" "}
        <Runs context={props.context} runs={headerRuns(props.calls, width())} />
      </text>
    </box>
  )
}

/** A line drawn in runs, each in its tone's colour; it goes inside a `<text>`. */
function Runs(props: { context: Context; runs: ReadonlyArray<Run> }) {
  return <For each={[...props.runs]}>{(run) => <span style={{ fg: toneColor(props.context, run.tone) }}>{run.text}</span>}</For>
}

function TreeRow(props: {
  context: Context
  row: Row
  /** The row's place in the tree (`branch`): its connector, and whether what hangs under it keeps the `│` rail. */
  branch: Branch
  /** The group's glyph, which leads a row that is the group's line alone. */
  glyph: Lead
  detail: Detail
  lastCommand: boolean
  now: Accessor<number>
}) {
  const theme = () => props.context.theme
  const part = () => props.row.calls[0]!
  const width = useLineWidth()
  const leadOf = (): Lead => (props.branch.connector ? { char: props.branch.connector } : props.glyph)
  const lead = () => <span style={{ fg: leadOf().color ?? theme().text.muted }}>{leadOf().char}</span>
  // A subagent's row opens its session.
  const link = useSessionLink(props.context, () => (props.row.tool === "subagent" ? subagentSession(part()) : undefined))
  const timer = createMemo(() => {
    if (props.row.outcome !== "running") return ""
    const ms = props.now() - startOf(part())
    return ms >= 1000 ? elapsed(ms) : ""
  })
  const ending = createMemo(() => rowEnding(props.row))
  // The subjects get what the verb, the timer and the ending leave of the line; the rest is counted.
  const room = createMemo(() => {
    const tail = [timer(), ending()?.text ?? ""].filter(Boolean).reduce((sum, text) => sum + 3 + text.length, 0)
    return width() - verb(props.row).length - 1 - tail
  })
  return (
    <Switch>
      <Match when={props.detail === "all"}>
        <CallRow
          context={props.context}
          connector={props.branch.connector}
          rail={props.branch.rail}
          tool={props.row.tool}
          part={part()}
        />
      </Match>
      <Match when={props.detail === "overview"}>
        <box paddingLeft={GUTTER} {...link.handlers}>
          <text wrapMode="none" truncate fg={theme().text.muted}>
            {lead()} <Runs context={props.context} runs={failureRuns(props.row, width())} />
          </text>
        </box>
      </Match>
      <Match when={true}>
        <box flexDirection="column" flexShrink={0}>
          <box paddingLeft={GUTTER} {...link.handlers}>
            <text wrapMode="none" truncate fg={link.hover() ? theme().text.base : theme().text.muted}>
              {lead()} {verb(props.row)}{" "}
              <Show when={props.row.tool === "patch" || props.row.tool === "edit"} fallback={subject(props.row, room())}>
                <EditCounts context={props.context} row={props.row} />
              </Show>
              <Show when={timer()}>
                {" · "}
                {timer()}
              </Show>
              <Show when={ending()}>
                {(run) => (
                  <>
                    {" · "}
                    <span style={{ fg: toneColor(props.context, run().tone) }}>{run().text}</span>
                  </>
                )}
              </Show>
            </text>
          </box>
          <RowBody context={props.context} row={props.row} lastCommand={props.lastCommand} rail={props.branch.rail} />
        </box>
      </Match>
    </Switch>
  )
}

function startOf(part: ToolPart) {
  return part.time.ran ?? part.time.created
}

/** `src/net.py +1 / -1`, with the counts in the diff colours. */
function EditCounts(props: { context: Context; row: Row }) {
  const theme = () => props.context.theme
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
function RowBody(props: { context: Context; row: Row; lastCommand: boolean; rail: boolean }) {
  const part = () => props.row.calls[0]!
  // Everything under the row hangs past the connector, beside the tree's rail while rows follow.
  return (
    <Switch>
      <Match when={props.row.outcome === "failed" ? errorText(part()) : undefined}>
        {(text) => (
          <Hang context={props.context} rail={props.rail}>
            <Head context={props.context} text={text()} />
          </Hang>
        )}
      </Match>
      <Match when={props.row.tool === "patch" || props.row.tool === "edit"}>
        <Hang context={props.context} rail={props.rail}>
          <For each={rowFiles(props.row)}>
            {(file) => <DiffBands context={props.context} path={file.path} rows={diffRows(file.patch, 1)} />}
          </For>
        </Hang>
      </Match>
      <Match when={props.row.tool === "shell" && (props.lastCommand || props.row.outcome === "warning")}>
        <Hang context={props.context} rail={props.rail}>
          <Head context={props.context} text={toolOutput(part())} />
        </Hang>
      </Match>
      <Match when={props.row.tool === "subagent" && props.row.outcome === "done" && !background(part())}>
        <Hang context={props.context} rail={props.rail}>
          <AgentMessage context={props.context} from={subagentName(toolInput(part()))} />
        </Hang>
      </Match>
    </Switch>
  )
}

/**
 * What hangs under a tree row, under its words: fx keeps the tree's rail
 * (`│`) beside it while rows follow, and blank past the last row.
 */
function Hang(props: { context: Context; rail: boolean; children: JSX.Element }) {
  return (
    <box flexDirection="row" paddingLeft={GUTTER} flexShrink={0}>
      <box width={2} flexShrink={0} flexDirection="column">
        <Show when={props.rail}>
          <box
            flexGrow={1}
            border={["left"]}
            borderColor={props.context.theme.text.muted}
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
function Head(props: { context: Context; text: string }) {
  const theme = () => props.context.theme
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
function AgentMessage(props: { context: Context; from: string }) {
  const theme = () => props.context.theme
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

function Glyph(props: { context: Context; part: ToolPart }) {
  const theme = () => props.context.theme
  const glyph = createMemo((): { char: string; color: RGBA } => {
    const state = outcome(props.part)
    if (state === "done") return { char: "✓", color: theme().text.feedback.success.base }
    if (state === "failed") return { char: "✗", color: theme().text.feedback.error.base }
    if (state === "warning") return { char: "✓", color: theme().text.feedback.warning.base }
    return { char: "◆", color: theme().text.feedback.success.base }
  })
  return <span style={{ fg: glyph().color }}>{glyph().char} </span>
}

/**
 * The all level's row: one call, as Prime draws it (`✓ shell · preview ·
 * ↑ 1 ↓ 2 lines · 12ms`) behind the tree connector (none when the group is
 * this call alone), then its whole diff and the tail of its output, hung as
 * the details level hangs a row's body: beside the tree's rail while rows
 * follow.
 */
function CallRow(props: { context: Context; connector?: string; rail: boolean; tool: string; part: ToolPart }) {
  const theme = () => props.context.theme
  const preview = createMemo(() => toolPreview(props.tool, toolInput(props.part)))
  const counts = createMemo(() => countLabel(lineCounts(props.tool, props.part)))
  const body = createMemo(() => callBody({ tool: props.tool, part: props.part }))
  const tail = createMemo(() => [counts(), duration(props.part)].filter(Boolean).join(" · "))
  const sep = () => <span style={{ fg: theme().text.faint }}> · </span>
  const link = useSessionLink(props.context, () => (props.tool === "subagent" ? subagentSession(props.part) : undefined))
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" paddingLeft={GUTTER} {...link.handlers}>
        <text flexShrink={0} wrapMode="none">
          <Show when={props.connector}>{(lead) => <span style={{ fg: theme().text.muted }}>{lead()} </span>}</Show>
          <Glyph context={props.context} part={props.part} />
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
        <Hang context={props.context} rail={props.rail}>
          <For each={[...body().files]}>
            {(file) => (
              <>
                <text wrapMode="none" fg={theme().text.faint}>
                  ╰─ <span style={{ fg: theme().text.muted }}>{file.path}</span>{" "}
                  <span style={{ fg: theme().diff.text.added }}>+{file.additions}</span>{" "}
                  <span style={{ fg: theme().diff.text.removed }}>-{file.deletions}</span>
                </text>
                <DiffBands context={props.context} path={file.path} rows={diffRows(file.patch, Infinity)} />
              </>
            )}
          </For>
          <Show when={body().reply}>
            <AgentMessage context={props.context} from={subagentName(toolInput(props.part))} />
          </Show>
          <Show when={body().output}>
            <ShellTail context={props.context} output={body().output} />
          </Show>
        </Hang>
      </Show>
    </box>
  )
}

// Expanded output: the last five lines under a dim gutter, in a row's hang.
function ShellTail(props: { context: Context; output: string }) {
  const lines = createMemo(() => props.output.replace(/\n+$/, "").split("\n"))
  const hidden = createMemo(() => Math.max(0, lines().length - 5))
  return (
    <box flexDirection="column">
      <Show when={hidden()}>
        <text fg={props.context.theme.text.faint}>... {hidden()} earlier lines</text>
      </Show>
      <For each={lines().slice(-5)}>
        {(line, index) => (
          <text wrapMode="none" truncate fg={props.context.theme.text.muted}>
            <span style={{ fg: props.context.theme.text.faint }}>{index() === 0 ? "╰─ " : "   "}</span>
            {line}
          </text>
        )}
      </For>
    </box>
  )
}

/** Prime's diff rows: ` 42 - ` then the code in its syntax colours, on a full-width band. */
function DiffBands(props: { context: Context; path: string; rows: DiffRow[] }) {
  const theme = () => props.context.theme
  const width = createMemo(() =>
    Math.max(2, ...props.rows.map((row) => (row.kind === "gap" ? 0 : String(row.line).length))),
  )
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
                    {line().kind === "added" ? "+" : line().kind === "removed" ? "-" : " "}{" "}
                  </text>
                  <props.context.ui.Code content={line().text} path={props.path} />
                </box>
              )}
            </Match>
          </Switch>
        )}
      </For>
    </box>
  )
}
