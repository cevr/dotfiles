// The fx-style tool-call group, without rendering: a step's run of calls
// reads as one header (`Read 3 files · ran 2 commands · 1 failed`) with one
// tree row per run of one tool under it, and each of the step's thoughts as
// a `thinking` node in its place in the tree.
import { close, stretch } from "./burst.ts"
import {
  background,
  canonical,
  editedFiles,
  errorText,
  latched,
  movedToBackground,
  outcome,
  subagentName,
  toolInput,
  toolMetadata,
  toolOutput,
  toolPreview,
  type Call,
  type EditedFile,
  type Outcome,
} from "./call.ts"
import { blink } from "./clock.ts"
import type { Detail } from "./detail.ts"
import { cellCalls, expand, operations, toolsInCode } from "./kernel.ts"
import { words, type AssistantMessage, type Fields, type Message, type Part, type ToolPart, type WordsPart } from "./session.ts"

/** Whether a part draws a transcript row: a call, or text or reasoning with words in it. */
function drawn(part: Part) {
  return part.type === "tool" || words(part.text) !== ""
}

/** Whether a part ends a run: answer text with words in it. Reasoning and blank text do not. */
function answer(part: Part | undefined) {
  return part?.type === "text" && words(part.text) !== ""
}

/**
 * The host's id for part `index` of a step: a call's own id, and
 * `text:<n>`/`reasoning:<n>` (the nth part of that type) for words, as the
 * host's slots name them.
 */
export function partKey(content: ReadonlyArray<Part>, index: number): string {
  const part = content[index]
  if (!part) return ""
  if (part.type === "tool") return part.id
  return `${part.type}:${content.slice(0, index).filter((item) => item.type === part.type).length}`
}

/** Where the part the host names `key` sits in a step's content; -1 when it is none of them. */
function indexOfKey(content: ReadonlyArray<Part>, key: string) {
  return content.findIndex((_, index) => partKey(content, index) === key)
}

/**
 * Whether the transcript row just above a group, whose first node is part
 * `firstKey`, is a node of another group: a call or a thought. The host gives
 * each part its own row, so row gaps cannot tell two steps' groups apart; the
 * group's header adds the blank row between them itself.
 */
export function followsGroup(messages: ReadonlyArray<Message>, messageID: string, firstKey: string): boolean {
  const at = messages.findIndex((message) => message.id === messageID)
  const message = messages[at]
  if (message?.type !== "assistant") return false
  const start = indexOfKey(message.content, firstKey)
  const before = message.content.slice(0, Math.max(0, start)).filter(drawn).at(-1)
  if (before) return before.type !== "text"
  const previous = messages[at - 1]
  if (previous?.type !== "assistant") return false
  const last = previous.content.filter(drawn).at(-1)
  return last !== undefined && last.type !== "text"
}

/** A thought of a step, as its group's `thinking` node: the host's id for it, its words, and whether it still streams. */
export type Thought = { readonly id: string; readonly text: string; readonly streaming: boolean }

/** One node of a group's tree, in the order the step made them: a call, or a thought. */
export type Entry = { readonly type: "call"; readonly call: Call } | { readonly type: "thought"; readonly thought: Thought }

/** The calls among a group's entries. */
export function entryCalls(entries: ReadonlyArray<Entry>): Call[] {
  return entries.flatMap((entry) => (entry.type === "call" ? [entry.call] : []))
}

/** The host's id for the part an entry draws under. */
export function entryKey(entry: Entry) {
  return entry.type === "call" ? entry.call.part.id : entry.thought.id
}

/** A thought streams while its step does and the host has not ended it. */
function streams(message: AssistantMessage, part: WordsPart) {
  return message.time.completed === undefined && part.time?.completed === undefined
}

/** The entries of a step's content: each call (a kernel call as its cell's calls), and each thought with words in it. */
function entriesOf(message: AssistantMessage, from = 0, to = message.content.length - 1): Entry[] {
  return message.content.slice(from, to + 1).flatMap((part, offset): Entry[] => {
    if (part.type === "tool") return expand({ tool: canonical(part.name), part }, canonical).map((call) => ({ type: "call", call }))
    if (part.type !== "reasoning" || words(part.text) === "") return []
    const thought = { id: partKey(message.content, from + offset), text: part.text, streaming: streams(message, part) }
    return [{ type: "thought", thought }]
  })
}

/**
 * The run around part `key` (a call, or a thought with words in it): one
 * step's calls and thoughts, as gent draws a run without `acrossSteps`, so
 * each model step (a kernel cell, a batch of parallel calls) is a group of
 * its own and the newest call is always a line at the transcript's end.
 * Within the step, thoughts and blank text between calls do not end the run;
 * answer text does. Each kernel call stands as the calls its cell made
 * (kernel.ts). Empty when `key` is no call or thought with words of message
 * `at`.
 */
export function stepEntries(messages: ReadonlyArray<Message>, at: number, key: string): Entry[] {
  const message = messages[at]
  if (message?.type !== "assistant") return []
  const content = message.content
  const index = indexOfKey(content, key)
  const part = content[index]
  if (!part || part.type === "text" || (part.type === "reasoning" && words(part.text) === "")) return []
  // Back to the start of the run, then forward to its end, both within the step.
  let start = index
  while (start > 0 && !answer(content[start - 1])) start--
  let end = index
  while (end < content.length - 1 && !answer(content[end + 1])) end++
  return entriesOf(message, start, end)
}

/** The calls of the run around call `partID` of message `at` (`stepEntries`, less its thoughts). */
export function toolRun(messages: ReadonlyArray<Message>, at: number, partID: string): Call[] {
  return entryCalls(stepEntries(messages, at, partID))
}

/** Whether a message is a step that only starts background agents: every row it draws is such a launch. */
function launches(message: Message | undefined): boolean {
  if (message?.type !== "assistant") return false
  const shown = message.content.filter(drawn)
  return (
    shown.length > 0 &&
    shown.every((part) => part.type === "tool" && canonical(part.name) === "subagent" && (background(part) || latched(part)))
  )
}

/**
 * The entries a part's group draws: its step's run, or, for a step that only
 * starts background agents, every such step next to it in the transcript,
 * each starting within the burst window of the one before.
 */
export function groupEntries(messages: ReadonlyArray<Message>, messageID: string, key: string): Entry[] {
  const at = messages.findIndex((message) => message.id === messageID)
  const message = messages[at]
  if (message?.type !== "assistant") return []
  const own = stepEntries(messages, at, key)
  if (!launches(message) || own.length === 0) return own
  return stretch(messages, at, (previous, next) => launches(previous) && launches(next) && close(previous, next)).flatMap(
    (step) => (step.type === "assistant" ? entriesOf(step) : []),
  )
}

/** The calls a call's group draws (`groupEntries`, less its thoughts). */
export function groupRun(messages: ReadonlyArray<Message>, messageID: string, partID: string): Call[] {
  return entryCalls(groupEntries(messages, messageID, partID))
}

type Kind = { readonly key: string; readonly past: string; readonly running: string; readonly unit: (count: number) => string }

const plural = (word: string) => (count: number) => `${count} ${word}${count === 1 ? "" : "s"}`
const times = (word: string) => (count: number) => `${word} ${count}×`

/** What a call does, in words: one kind per tool family, as gent's header names them. */
export function kind(tool: string, part?: ToolPart): Kind {
  if (tool === "read") return { key: "read", past: "Read", running: "Reading", unit: plural("file") }
  if (tool === "grep" || tool === "glob")
    return { key: "search", past: "Searched", running: "Searching", unit: plural("pattern") }
  if (tool === "websearch") return { key: "websearch", past: "Searched", running: "Searching", unit: times("the web") }
  if (tool === "webfetch") return { key: "webfetch", past: "Fetched", running: "Fetching", unit: plural("page") }
  if (tool === "patch" || tool === "edit") return { key: "edit", past: "Edited", running: "Editing", unit: plural("file") }
  if (tool === "write") return { key: "write", past: "Wrote", running: "Writing", unit: plural("file") }
  if (tool === "shell") return shellKind(part ? toolInput(part) : {})
  // The background-shell tools older transcripts used, before the shell tool's handles took their place.
  if (tool === "shell_list")
    return { key: "shell_list", past: "Listed", running: "Listing", unit: (count) => (count === 1 ? "shells" : `shells ${count}×`) }
  if (tool === "shell_read") return { key: "shell_read", past: "Read", running: "Reading", unit: plural("shell output") }
  if (tool === "shell_kill") return { key: "shell_kill", past: "Killed", running: "Killing", unit: plural("command") }
  if (tool === "kernel") return { key: "kernel", past: "Ran", running: "Running", unit: plural("cell") }
  if (tool === "subagent" && part && latched(part))
    return { key: "subagent-latch", past: "Latched", running: "Latching", unit: plural("agent") }
  if (tool === "subagent" && part && background(part))
    return { key: "subagent-start", past: "Started", running: "Starting", unit: plural("agent") }
  if (tool === "subagent") return { key: "subagent", past: "Ran", running: "Running", unit: plural("agent") }
  if (tool === "question") return { key: "question", past: "Asked", running: "Asking", unit: plural("question") }
  return { key: tool, past: "", running: "", unit: times(tool) }
}

/**
 * The shell call's form: a command that runs (`Ran`), or starts in the
 * background (`Started`); a list of the session's shells; or a call on one
 * shell's handle that kills it, waits on it or checks it.
 */
function shellKind(input: Fields): Kind {
  if (input.list === true)
    return { key: "shell_list", past: "Listed", running: "Listing", unit: (count) => (count === 1 ? "shells" : `shells ${count}×`) }
  if (input.command === undefined && typeof input.id === "string") {
    if (input.kill === true) return { key: "shell_kill", past: "Killed", running: "Killing", unit: plural("shell") }
    if (typeof input.wait === "number") return { key: "shell-wait", past: "Waited on", running: "Waiting on", unit: plural("shell") }
    return { key: "shell-check", past: "Checked", running: "Checking", unit: plural("shell") }
  }
  if (input.background === true)
    return { key: "shell-start", past: "Started", running: "Starting", unit: (count) => `${plural("command")(count)} in the background` }
  return { key: "shell", past: "Ran", running: "Running", unit: plural("command") }
}

/** Whether a row starts its commands in the background: its subject says so. */
function startsInBackground(row: Row) {
  return row.tool === "shell" && toolInput(row.calls[0]).background === true && toolInput(row.calls[0]).command !== undefined
}

const IN_THE_BACKGROUND = " in the background"

/** A cell whose code spells out no call it can name: `ran code`, never the code (gent's `CODE_KIND`). */
const CODE: Kind = {
  key: "code",
  past: "Ran",
  running: "Running",
  unit: (count) => (count === 1 ? "code" : `code ${count}×`),
}

/**
 * The kinds one call counts as, each with its units. A kernel call that
 * recorded no calls counts the calls its code spells out (`cellCalls`), else
 * `code`; the kernel call left after a recorded cell's calls counts as code
 * while it computes and only among the failures once it ends. An edit counts
 * its files.
 */
function tallies(call: Call): Array<{ readonly kind: Kind; readonly units: number }> {
  if (call.tool === "kernel") {
    if (operations(call.part).length > 0) return outcome(call.part) === "running" ? [{ kind: CODE, units: 1 }] : []
    const spelled = cellCalls(String(toolInput(call.part).code ?? ""))
    if (spelled.length === 0) return [{ kind: CODE, units: 1 }]
    return spelled.map((spell) => ({ kind: kind(canonical(spell.tool)), units: 1 }))
  }
  const which = kind(call.tool, call.part)
  return [{ kind: which, units: which.key === "edit" ? Math.max(1, editedFiles(call.part).length) : 1 }]
}

/** One stretch of the header or a row, with the tone it is drawn in: `base` is the normal text colour, `faint` the dimmest. */
export type Run = { readonly text: string; readonly tone: "base" | "muted" | "faint" | "error" | "warning" }

/**
 * What the group's kernel cells say they do (`Call.cell`), in order and once
 * each; empty when no cell gave a description.
 */
export function cellWords(calls: ReadonlyArray<Call>): string {
  return [...new Set(calls.flatMap((call) => (call.cell === undefined ? [] : [call.cell])))].join(" · ")
}

/** `text` cut to `width` columns, an ellipsis marking the cut. */
export function truncate(text: string, width: number) {
  if (text.length <= width) return text
  if (width <= 1) return text.slice(0, Math.max(0, width))
  return `${text.slice(0, width - 1)}…`
}

/**
 * The header's words, as gent's `activityHeaderRuns`: ended kinds first, the
 * largest count first (ties keep the order they ran in), then the kinds
 * still running, then the failures and the cancels. Only the first phrase is
 * capitalised. Wider than `width` columns, kinds drop from the right; the
 * first kind, the failures and the cancels stay.
 *
 * A group whose kernel cell described itself (`cellWords`) reads as that
 * description instead, in the normal text colour, cut to what the failures
 * and the cancels leave of `width`; the rows beneath name what it ran.
 */
export function headerRuns(calls: ReadonlyArray<Call>, width = Number.POSITIVE_INFINITY): Run[] {
  const counts = (running: boolean) => {
    const totals = new Map<string, { kind: Kind; count: number }>()
    for (const call of calls) {
      if ((outcome(call.part) === "running") !== running) continue
      for (const tally of tallies(call)) {
        const entry = totals.get(tally.kind.key)
        if (entry) entry.count += tally.units
        else totals.set(tally.kind.key, { kind: tally.kind, count: tally.units })
      }
    }
    // A Map keeps the order its keys were first set in: the order the kinds ran in.
    return [...totals.values()]
  }
  const phrase = (entry: { kind: Kind; count: number }, running: boolean, first: boolean) => {
    const verb = running ? entry.kind.running : entry.kind.past
    if (!verb) return entry.kind.unit(entry.count)
    return `${first ? verb : verb.toLowerCase()} ${entry.kind.unit(entry.count)}`
  }
  const ended = counts(false).toSorted((a, b) => b.count - a.count)
  const phrases = [
    ...ended.map((entry) => ({ entry, running: false })),
    ...counts(true).map((entry) => ({ entry, running: true })),
  ].map((item, index) => phrase(item.entry, item.running, index === 0))
  const failed = calls.filter((call) => outcome(call.part) === "failed").length
  const cancelled = calls.filter((call) => outcome(call.part) === "cancelled").length
  const tail: Run[] = [
    ...(failed ? [{ text: `${failed} failed`, tone: "error" as const }] : []),
    ...(cancelled ? [{ text: `${cancelled} cancelled`, tone: "warning" as const }] : []),
  ]
  const joined = (runs: ReadonlyArray<Run>) =>
    runs.flatMap((part, index) => (index === 0 ? [part] : [{ text: " · ", tone: "muted" as const }, part]))
  const described = cellWords(calls)
  if (described) {
    const room = width - tail.reduce((sum, part) => sum + 3 + part.text.length, 0)
    return joined([{ text: truncate(described, Math.max(1, room)), tone: "base" }, ...tail])
  }
  const parts = (kept: number): Run[] => [
    ...(kept > 0 ? [{ text: phrases.slice(0, kept).join(" · "), tone: "muted" as const }] : []),
    ...tail,
  ]
  const text = (kept: number) => parts(kept).map((part) => part.text).join(" · ")
  let kept = phrases.length
  while (kept > 1 && text(kept).length > width) kept--
  return joined(parts(kept))
}

/** One tree row: a run of calls to one tool with one outcome, named by its first call. */
export type Row = {
  readonly tool: string
  readonly outcome: Outcome
  readonly calls: readonly [ToolPart, ...ToolPart[]]
  /** The call the row is drawn under: its first. */
  readonly owner: string
}

/** A row of one call. */
function single(call: Call): Row {
  return { tool: call.tool, outcome: outcome(call.part), calls: [call.part], owner: call.part.id }
}

/**
 * The tree rows of a run: calls to one tool with one outcome fold into a
 * row; a failure, a cancel, a nonzero exit or an agent always stands alone.
 */
export function rows(calls: ReadonlyArray<Call>): Row[] {
  const result: Row[] = []
  for (const call of calls) {
    const state = outcome(call.part)
    const last = result.at(-1)
    const same = last && last.tool === call.tool && kind(last.tool, last.calls[0]).key === kind(call.tool, call.part).key
    const alone = state === "failed" || state === "warning" || state === "cancelled"
    // Each agent keeps its own row: it is a worker to follow, not one of a batch of reads.
    if (last && same && last.outcome === state && !alone && call.tool !== "subagent")
      result[result.length - 1] = { ...last, calls: [...last.calls, call.part] }
    else result.push(single(call))
  }
  return result
}

/** Whether a row ended badly: the collapsed level draws a line for each. */
export function ended(row: Row) {
  return row.outcome === "failed" || row.outcome === "warning" || row.outcome === "cancelled"
}

/**
 * The tree rows a group's calls show at a level, in order: a row per call
 * at All, a row per run of one tool at Details, and only the rows that ended
 * badly at the overview.
 */
export function levelRows(calls: ReadonlyArray<Call>, detail: Detail): Row[] {
  if (detail === "all") return calls.map(single)
  const all = rows(calls)
  return detail === "overview" ? all.filter(ended) : all
}

/** One node of a group's tree as a level draws it: a row of calls, or a thought. */
export type Node = { readonly type: "row"; readonly row: Row } | { readonly type: "thought"; readonly thought: Thought }

/**
 * The nodes a group shows at a level, in the order the step made them: each
 * thought where it came, with the rows of the calls between (`levelRows`; a
 * thought ends a fold of calls to one tool). The overview shows no thought.
 */
export function levelNodes(entries: ReadonlyArray<Entry>, detail: Detail): Node[] {
  if (detail === "overview") return levelRows(entryCalls(entries), detail).map((row) => ({ type: "row", row }))
  const nodes: Node[] = []
  let calls: Call[] = []
  const flush = () => {
    nodes.push(...levelRows(calls, detail).map((row): Node => ({ type: "row", row })))
    calls = []
  }
  for (const entry of entries) {
    if (entry.type === "call") calls.push(entry.call)
    else {
      flush()
      nodes.push({ type: "thought", thought: entry.thought })
    }
  }
  flush()
  return nodes
}

/** The host's id for the part a node draws under: a row's first call, a thought's own. */
export function nodeOwner(node: Node) {
  return node.type === "row" ? node.row.owner : node.thought.id
}

/** The rows among a group's nodes. */
export function nodeRows(nodes: ReadonlyArray<Node>): Row[] {
  return nodes.flatMap((node) => (node.type === "row" ? [node.row] : []))
}

/** The group's last command row once it has ended: the one row whose output shows at Details. */
export function lastCommand(shown: ReadonlyArray<Row>, running: boolean): Row | undefined {
  return running ? undefined : shown.findLast((row) => row.tool === "shell")
}

/**
 * Whether a group's one node stands alone as its line, with no header: a
 * group of one row of calls below the overview, unless a kernel cell in it
 * described itself, whose description heads the row. A thought never stands
 * alone: a group of one thought keeps its header over a `└ thinking` node,
 * so a thought always reads as a node of a tree.
 */
export function alone(calls: ReadonlyArray<Call>, shown: ReadonlyArray<Node>, detail: Detail) {
  return detail !== "overview" && shown.length === 1 && shown[0]?.type === "row" && !cellWords(calls)
}

/**
 * The header's words for a group's entries: the calls' header
 * (`headerRuns`), as before thoughts were drawn, for a thought is no action
 * the header counts. A group of thoughts alone (a step that thought, then
 * answered, or whose calls have not arrived yet) reads `Thinking` while one
 * streams, then `Thought`: what the step did, in the tense the call verbs
 * use.
 */
export function groupHeader(entries: ReadonlyArray<Entry>, width = Number.POSITIVE_INFINITY): Run[] {
  const calls = entryCalls(entries)
  if (calls.length > 0) return headerRuns(calls, width)
  return [{ text: thinking(entries) ? "Thinking" : "Thought", tone: "muted" }]
}

/** Whether one of a group's thoughts still streams. */
export function thinking(entries: ReadonlyArray<Entry>) {
  return entries.some((entry) => entry.type === "thought" && entry.thought.streaming)
}

/**
 * Whether a group draws at a level: always below the overview; at the
 * overview, which shows no thought, only a group with calls.
 */
export function groupShows(entries: ReadonlyArray<Entry>, detail: Detail) {
  return entries.length > 0 && (detail !== "overview" || entries.some((entry) => entry.type === "call"))
}

/** The label a thought node shows, as a call row shows its verb. */
export const THOUGHT_LABEL = "thinking"

/**
 * A thought folded to the one line its node shows below All: its first line
 * with words, the markdown emphasis it opens with dropped.
 */
export function thoughtLine(text: string) {
  const first = words(text)
    .split("\n")
    .map((line) => line.replace(/\*\*|__/g, "").trim())
    .find((line) => line !== "")
  return first ?? ""
}

/** A tree row's place: its connector (none for a row alone) and whether its body keeps the rail. */
export type Branch = { readonly connector?: "├" | "└"; readonly rail: boolean }

/**
 * Where row `index` of `count` sits in the tree: its connector, `├` while
 * rows follow and `└` on the last, and whether what hangs under it keeps the
 * tree's `│` rail, as fx's continuation rows do (`│ ` while rows follow,
 * blank past the last). A row `alone` is the group's line, behind the
 * group's glyph: no connector and no rail. Every level draws its rows by it.
 */
export function branch(index: number, count: number, alone: boolean): Branch {
  if (alone) return { rail: false }
  const last = index >= count - 1
  return { connector: last ? "└" : "├", rail: !last }
}

/** The tone a group's glyph is drawn in. */
export type LeadTone = "error" | "accent" | "warning" | "muted"

/**
 * The group's glyph: `✗` when a call failed, a blinking `○`/`●` while one
 * runs or a thought streams (`streaming`), else `●`, warning-coloured after a nonzero exit or a cancel (a cut
 * call is no failure, as in gent).
 */
export function groupLead(
  calls: ReadonlyArray<Call>,
  now: number,
  streaming = false,
): { readonly char: string; readonly tone: LeadTone } {
  const states = calls.map((call) => outcome(call.part))
  if (states.includes("failed")) return { char: "✗", tone: "error" }
  if (states.includes("running") || streaming) return { char: blink(now) ? "○" : "●", tone: "accent" }
  if (states.includes("warning") || states.includes("cancelled")) return { char: "●", tone: "warning" }
  return { char: "●", tone: "muted" }
}

/**
 * What hangs under one call's row at the all level: each edited file's
 * whole diff, the agent's reply for a foreground subagent that finished, and
 * the output's tail (none for a patch, whose diff says it). Empty when the
 * row has nothing under it.
 */
export function callBody(call: Call): {
  readonly files: ReadonlyArray<EditedFile>
  readonly reply: boolean
  readonly output: string
} {
  return {
    files: editedFiles(call.part),
    reply: call.tool === "subagent" && call.part.state.status === "completed" && !background(call.part) && !latched(call.part),
    output: call.tool === "patch" ? "" : toolOutput(call.part),
  }
}

/** Whether a call's all-level body draws anything. */
export function hasBody(body: ReturnType<typeof callBody>) {
  return body.files.length > 0 || body.reply || body.output !== ""
}

/**
 * Subjects joined by commas, as many as fit `width` columns, then `+N`
 * counting the rest (gent's `formatActivityRow`). The first always shows.
 */
export function listed(subjects: ReadonlyArray<string>, width = Number.POSITIVE_INFINITY) {
  const text = (kept: number) => {
    const shown = subjects.slice(0, kept).join(", ")
    return kept < subjects.length ? `${shown} +${subjects.length - kept}` : shown
  }
  let kept = subjects.length
  while (kept > 1 && text(kept).length > width) kept--
  return text(kept)
}

/** A row's subject: what its calls touched, as one line of at most `width` columns' worth of subjects. */
export function subject(row: Row, width = Number.POSITIVE_INFINITY): string {
  const first = row.calls[0]
  // Cells that recorded no calls (kernel.ts): their count, and the tools their code spells out, once each.
  if (row.tool === "kernel") {
    const names = [...new Set(row.calls.flatMap((part) => toolsInCode(String(toolInput(part).code ?? ""))))]
    const cells = row.calls.length === 1 ? "a cell" : `${row.calls.length} cells`
    return names.length > 0 ? `${cells} calling ${names.join(", ")}` : cells
  }
  if (row.tool === "grep") {
    const input = toolInput(first)
    const path = typeof input.path === "string" ? ` in ${input.path}` : ""
    return `/${String(input.pattern ?? "")}/${path}`
  }
  if (row.tool === "subagent") {
    const input = toolInput(first)
    // The description is the model's own short label for the task; the prompt is the brief behind it.
    if (typeof input.description === "string" && input.description.trim()) return input.description.trim()
    const task = toolPreview("subagent", input)
    return task ? `${subagentName(input)} · ${task}` : subagentName(input)
  }
  const subjects = row.calls.map((part) => toolPreview(row.tool, toolInput(part)))
  if (startsInBackground(row)) return `${listed(subjects, width - IN_THE_BACKGROUND.length)}${IN_THE_BACKGROUND}`
  return listed(subjects, width)
}

/**
 * What a row says ended it, after gent's `failureWord`: a command's exit
 * status, `failed`, or `cancelled`, in its tone; for a command the host moved
 * to the background, that it did, muted. None for a row that ran or still
 * runs.
 */
export function rowEnding(row: Row): Run | undefined {
  if (row.outcome === "cancelled") return { text: "cancelled", tone: "warning" }
  if (row.outcome !== "failed" && row.outcome !== "warning") {
    const moved = row.calls.filter(movedToBackground).length
    if (moved === 0 || row.outcome === "running") return undefined
    return { text: row.calls.length === 1 ? "moved to the background" : `${moved} moved to the background`, tone: "muted" }
  }
  const exit = toolMetadata(row.calls[0]).exit
  if (typeof exit === "number" && exit !== 0) return { text: `exit ${exit}`, tone: "error" }
  return { text: "failed", tone: "error" }
}

/**
 * The columns a row's subjects get: what the verb, the running timer and
 * the ending leave of `width`, each of the last two behind a ` · `.
 */
export function subjectRoom(row: Row, width: number, timer: string) {
  const tail = [timer, rowEnding(row)?.text ?? ""].filter(Boolean).reduce((sum, text) => sum + 3 + text.length, 0)
  return width - verb(row).length - 1 - tail
}

/** The narrowest reason a failure line still draws: a word's start and the ellipsis. */
const MIN_REASON = 4

/**
 * A failure as the collapsed level's one line under the header, after gent's
 * `failureRowRuns`: `Read a.ts · failed · File not found: a.ts`, `Ran pytest
 * · exit 1`. Narrow, the reason is cut, then dropped; the verb and the ending
 * always show. `width` counts the columns after the connector.
 */
export function failureRuns(row: Row, width = Number.POSITIVE_INFINITY): Run[] {
  const ending = rowEnding(row)
  const head = `${verb(row)} ${subject(row)}`.trim()
  if (!ending) return [{ text: truncate(head, width), tone: "muted" }]
  const tail = ` · ${ending.text}`
  const reason = (errorText(row.calls[0]).split("\n")[0] ?? "").trim()
  const room = width - head.length - tail.length - 3
  const shown: Run[] = [
    { text: truncate(head, Math.max(verb(row).length, width - tail.length)), tone: "muted" },
    { text: " · ", tone: "muted" },
    ending,
  ]
  if (reason && room >= Math.min(MIN_REASON, reason.length)) shown.push({ text: ` · ${truncate(reason, room)}`, tone: "muted" })
  return shown
}

/** The row's verb, in the tense of its outcome; empty for a tool with no verb. */
export function verb(row: Row) {
  const which = kind(row.tool, row.calls[0])
  if (!which.past) return row.tool
  return row.outcome === "running" ? which.running : which.past
}

/** Whether a row draws its edited files and their counts in place of a subject. */
export function edits(row: Row) {
  return row.tool === "patch" || row.tool === "edit"
}

/** The edited files of an edit row, with their line counts. */
export function rowFiles(row: Row) {
  return row.calls.flatMap((part) => editedFiles(part))
}
