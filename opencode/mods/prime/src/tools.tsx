// Tool calls as fx draws them, in Prime's colours: a step's run of calls is
// one group, a `●` header naming what it did (`Read 3 files · ran 2 commands
// · 1 failed`) and a `├`/`└` tree row per run of one tool under it.
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
import { createMemo, For, Match, Show, Switch, type Accessor, type JSX } from "solid-js"
import { useNow } from "./clock"
import {
  errorText,
  followsCall,
  headerRuns,
  outcome,
  rowFiles,
  rowReason,
  rows,
  subject,
  toolRun,
  verb,
  type Call,
  type Row,
} from "./group"
import { GUTTER, type PartProps } from "./transcript"
import {
  countLabel,
  diffRows,
  duration,
  editedFiles,
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
/** Where output and diffs hang under a tree row: past the connector and its space. */
const UNDER = GUTTER + 2

export function ToolRow(props: PartProps & { tool: string; detail: Accessor<Detail> }) {
  const run = createMemo((): Call[] => {
    const message = props.context.data.session.message.get(props.sessionID, props.messageID)
    return message?.type === "assistant" ? toolRun(message.content, props.partID) : []
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
    return detail === "overview" ? all.filter((row) => row.outcome === "failed" || row.outcome === "warning") : all
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
                lead={single() ? glyph() : { char: index() === shown().length - 1 ? "└" : "├" }}
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

/** The group's glyph: `✗` when a call failed, a blinking `○`/`●` while one runs, else `●` (warning-coloured after a nonzero exit). */
function groupGlyph(context: Context, calls: Call[], now: number): Lead {
  const theme = context.theme
  const states = calls.map((call) => outcome(call.part))
  if (states.includes("failed")) return { char: "✗", color: theme.text.feedback.error.base }
  if (states.includes("running")) return { char: Math.floor(now / 500) % 2 ? "○" : "●", color: theme.hue.accent[300] }
  if (states.includes("warning")) return { char: "●", color: theme.text.feedback.warning.base }
  return { char: "●", color: theme.text.muted }
}

function Header(props: { context: Context; calls: Call[]; glyph: Lead }) {
  const theme = () => props.context.theme
  return (
    <box paddingLeft={GUTTER}>
      <text wrapMode="none" truncate fg={theme().text.muted}>
        <span style={{ fg: props.glyph.color ?? theme().text.muted }}>{props.glyph.char}</span>{" "}
        <For each={headerRuns(props.calls)}>
          {(run) => (
            <span style={{ fg: run.tone === "error" ? theme().text.feedback.error.base : theme().text.muted }}>
              {run.text}
            </span>
          )}
        </For>
      </text>
    </box>
  )
}

function TreeRow(props: {
  context: Context
  row: Row
  lead: Lead
  detail: Detail
  lastCommand: boolean
  now: Accessor<number>
}) {
  const theme = () => props.context.theme
  const part = () => props.row.calls[0]!
  const lead = () => <span style={{ fg: props.lead.color ?? theme().text.muted }}>{props.lead.char}</span>
  return (
    <Switch>
      <Match when={props.detail === "all"}>
        <CallRow context={props.context} lead={props.lead.color ? undefined : props.lead.char} tool={props.row.tool} part={part()} />
      </Match>
      <Match when={true}>
        <box flexDirection="column" flexShrink={0}>
          <box paddingLeft={GUTTER}>
            <text wrapMode="none" truncate fg={theme().text.muted}>
              {lead()} {verb(props.row)}{" "}
              <Show when={props.row.tool === "patch" || props.row.tool === "edit"} fallback={subject(props.row)}>
                <EditCounts context={props.context} row={props.row} />
              </Show>
              <Show when={props.row.outcome === "running" && props.now() - startOf(part()) >= 1000}>
                {" · "}
                {elapsed(props.now() - startOf(part()))}
              </Show>
              <Show when={props.row.outcome === "failed" || props.row.outcome === "warning" ? rowReason(props.row) : undefined}>
                {(reason) => (
                  <>
                    {" · "}
                    <span style={{ fg: theme().text.feedback.error.base }}>{reason()}</span>
                  </>
                )}
              </Show>
            </text>
          </box>
          <Show when={props.detail === "details"}>
            <RowBody context={props.context} row={props.row} lastCommand={props.lastCommand} />
          </Show>
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

/** What hangs under a row at the details level: an edit's diff, a failure's reason, the last command's output, a subagent's reply. */
function RowBody(props: { context: Context; row: Row; lastCommand: boolean }) {
  const part = () => props.row.calls[0]!
  return (
    <Switch>
      <Match when={props.row.outcome === "failed" ? errorText(part()) : undefined}>
        {(text) => <Head context={props.context} text={text()} />}
      </Match>
      <Match when={props.row.tool === "patch" || props.row.tool === "edit"}>
        <For each={rowFiles(props.row)}>
          {(file) => <DiffBands context={props.context} path={file.path} rows={diffRows(file.patch, 1)} />}
        </For>
      </Match>
      <Match when={props.row.tool === "shell" && (props.lastCommand || props.row.outcome === "warning")}>
        <Head context={props.context} text={toolOutput(part())} />
      </Match>
      <Match when={props.row.tool === "subagent" && props.row.outcome === "done"}>
        <AgentMessage context={props.context} from={subagentName(toolInput(part()))} />
      </Match>
    </Switch>
  )
}

/** The first lines of some output under a `│ ` gutter, then how many lines the rest is. */
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
    <box flexDirection="column" paddingLeft={UNDER} flexShrink={0}>
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
    <box paddingLeft={UNDER}>
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
 * this call alone), then its whole diff and the tail of its output.
 */
function CallRow(props: { context: Context; lead?: string; tool: string; part: ToolPart }) {
  const theme = () => props.context.theme
  const preview = createMemo(() => toolPreview(props.tool, toolInput(props.part)))
  const counts = createMemo(() => countLabel(lineCounts(props.tool, props.part)))
  const files = createMemo(() => editedFiles(props.part))
  const output = createMemo(() => toolOutput(props.part))
  const tail = createMemo(() => [counts(), duration(props.part)].filter(Boolean).join(" · "))
  const sep = () => <span style={{ fg: theme().text.faint }}> · </span>
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" paddingLeft={GUTTER}>
        <text flexShrink={0} wrapMode="none">
          <Show when={props.lead}>{(lead) => <span style={{ fg: theme().text.muted }}>{lead()} </span>}</Show>
          <Glyph context={props.context} part={props.part} />
          <span style={{ fg: theme().text.muted }}>{props.tool}</span>
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
      <For each={files()}>
        {(file) => (
          <>
            <box paddingLeft={UNDER}>
              <text wrapMode="none" fg={theme().text.faint}>
                ╰─ <span style={{ fg: theme().text.muted }}>{file.path}</span>{" "}
                <span style={{ fg: theme().diff.text.added }}>+{file.additions}</span>{" "}
                <span style={{ fg: theme().diff.text.removed }}>-{file.deletions}</span>
              </text>
            </box>
            <DiffBands context={props.context} path={file.path} rows={diffRows(file.patch, Infinity)} />
          </>
        )}
      </For>
      <Show when={props.tool === "subagent" && props.part.state.status === "completed"}>
        <AgentMessage context={props.context} from={subagentName(toolInput(props.part))} />
      </Show>
      <Show when={props.tool !== "patch" && output()}>
        <ShellTail context={props.context} output={output()} />
      </Show>
    </box>
  )
}

// Expanded output: the last five lines under a dim gutter.
function ShellTail(props: { context: Context; output: string }) {
  const lines = createMemo(() => props.output.replace(/\n+$/, "").split("\n"))
  const hidden = createMemo(() => Math.max(0, lines().length - 5))
  return (
    <box flexDirection="column" paddingLeft={UNDER}>
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
