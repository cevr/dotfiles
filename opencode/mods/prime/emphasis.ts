// Emphasis in an assistant reply: a few `[[Word]]` chips and the queue's lead
// labels, drawn by the TUI (tui/emphasis.ts) and taught by one prompt section
// (`guidance`), both read from the tables here.
//
//   ✓ Done the build passed.        ← `[[Done]] the build passed.`
//   ◈ Running (mine): the 95% watch ← `**Running (mine):** the 95% watch`
//
// A chip is exactly as wide as its source (`[[Done]]` and ` ✓ Done ` are both
// 8 cells), so a pill closing mid-stream never reflows the reply. A label
// keeps its words and gains its state's diamond in front, the glyph and tone
// the subagent rows give that state (mods/subagents/line.ts). Nothing is
// rewritten: an unknown word, a pill in code and the stored text stay as
// typed. Plain TypeScript, no renderer: the splitting works on runs of text
// with offsets, and the TUI says how a piece looks.
import { SYMBOLS, stateTone, type StateTone } from "@dotfiles/opencode-subagents/line"
import type { State } from "@dotfiles/opencode-subagents/subagent-row"
import { Array as Arr, Option } from "effect"

/** A chip's ground: `soft` the tone on a tinted ground, `solid` the tone as the ground, for what costs or cannot be undone. */
export type Form = "soft" | "solid"

/** Which part of the prompt section a word sits in. */
export type Group = "evidence" | "outcome" | "consequence"

/** A word a pill may open with: its mark, tone, form, and the hint the prompt section gives it. */
export interface Word {
  readonly word: string
  readonly mark: string
  readonly tone: StateTone
  readonly form: Form
  readonly group: Group
  /** What the agent adds or means by it, in the prompt section; empty when the word says it. */
  readonly hint: string
}

const word = (name: string, mark: string, tone: StateTone, form: Form, group: Group, hint: string): Word => ({
  word: name,
  mark,
  tone,
  form,
  group,
  hint,
})

/**
 * The words taught, in the order the prompt section lists them. Marks are
 * Prime's own, one cell each, no Nerd Font: ✓ ✗ ● ○ ◆ ◌ are drawn already
 * (call.ts, line.ts, pending.ts) and ? $ ! are ASCII.
 */
export const WORDS: ReadonlyArray<Word> = [
  word("Measured", "●", "success", "soft", "evidence", "you ran or read it"),
  word("Inferred", "○", "info", "soft", "evidence", "say from what"),
  word("Guess", "?", "warning", "soft", "evidence", "not checked"),
  word("Done", "✓", "success", "soft", "outcome", ""),
  word("Failed", "✗", "error", "soft", "outcome", "say the cause"),
  word("Blocked", "◆", "warning", "soft", "outcome", "say what unblocks it"),
  word("Skipped", "◌", "warning", "soft", "outcome", "a check not run; say why"),
  word("Costs money", "$", "error", "solid", "consequence", "the amount"),
  word("Irreversible", "!", "error", "solid", "consequence", "what is lost"),
]

/** Words drawn though never taught, each as the taught word it means; a word dropped from `WORDS` moves here. */
export const ACCEPTED: ReadonlyArray<readonly [string, string]> = [
  ["Passed", "Done"],
  ["Unverified", "Guess"],
]

/** The longest text a pill holds: past it, `[[…]]` is something else. */
export const PILL_MAX = 32

/** A known pill: its word, and its text as typed (`Failed: 3 tests`). */
export interface Pill {
  readonly word: Word
  readonly text: string
}

const taught = (name: string) => Arr.findFirst(WORDS, (entry) => entry.word === name)

/** Every word a pill may open with, with what it draws as: the taught, then the accepted, longest first. */
const OPENERS: ReadonlyArray<readonly [string, Word]> = [
  ...WORDS.map((entry) => [entry.word, entry] as const),
  ...ACCEPTED.flatMap(([name, as]) => Option.toArray(Option.map(taught(as), (entry) => [name, entry] as const))),
].toSorted((a, b) => b[0].length - a[0].length)

/** Whether `text` opens with `opener` as a whole word: the text itself, or the word and then a space or colon. */
const opensWith = (text: string, opener: string, after: ReadonlyArray<string>) =>
  text === opener || (text.startsWith(opener) && after.includes(text.charAt(opener.length)))

/**
 * The pill a `[[…]]` holds: a known word, alone or with short detail after a
 * space or colon (`Done 12/12`, `Failed: 3 tests`), within `PILL_MAX`
 * characters on one line. Anything else (`acknowledge-before-processing`,
 * ` -f x `, `Doneness`) is not one and stays as typed.
 */
export function pillOf(text: string): Option.Option<Pill> {
  if (text.length > PILL_MAX || /[[\]\n]/.test(text)) return Option.none()
  return Option.map(
    Arr.findFirst(OPENERS, ([opener]) => opensWith(text, opener, [" ", ":"])),
    ([, entry]) => ({ word: entry, text }),
  )
}

/** A pill as drawn: a space, the mark, a space, its text, a space; as wide as `[[text]]`. */
export const chipText = (pill: Pill) => ` ${pill.word.mark} ${pill.text} `

/** A queue label's state: the subagent state whose diamond and tone it draws with. */
export interface Label {
  readonly state: State
  readonly mark: string
  readonly tone: StateTone
}

/**
 * The lead labels of the "In the queue" section, as replies wrote them before
 * the Queue tab took the queue over and as older transcripts still hold them
 * (`- **Running (mine):**`), each with the subagent state it names.
 * Longest first, so `Waiting on you` is not read as `Waiting`.
 */
export const LABELS: ReadonlyArray<readonly [string, State]> = [
  ["Waiting on you", "blocked"],
  ["Waiting (yours)", "blocked"],
  ["Scheduled", "latched"],
  ["Waiting", "waiting"],
  ["Running", "working"],
  ["Dated", "latched"],
  ["Held", "latched"],
  ["Next", "idle"],
]

/** The label a bold lead span's text names (`Running (mine):`, `Next:`), with the state's diamond and tone. */
export function labelOf(text: string): Option.Option<Label> {
  const words = text.trim()
  return Option.map(
    Arr.findFirst(LABELS, ([opener]) => opensWith(words, opener, [" ", ":", "("])),
    ([, state]) => ({ state, mark: SYMBOLS[state], tone: stateTone(state) }),
  )
}

/** The label a block opens with: its source starts with a bold span (`**…**`) whose words are a label. */
export function leadLabel(source: string): Option.Option<Label> {
  if (!source.startsWith("**")) return Option.none()
  const close = source.indexOf("**", 2)
  if (close < 3) return Option.none()
  return labelOf(source.slice(2, close))
}

/** What replaces a stretch of drawn text: a pill's chip, or a label's diamond put in front. */
export type Piece = { readonly kind: "chip"; readonly pill: Pill } | { readonly kind: "mark"; readonly label: Label }

/** A replacement over drawn offsets `[start, end)`; `start === end` puts the piece in front of `start`. */
export interface Edit {
  readonly start: number
  readonly end: number
  readonly piece: Piece
}

/** A pill found in text: where its `[[` opens and its `]]` closes. */
export interface Found {
  readonly start: number
  readonly end: number
  readonly pill: Pill
}

/** Every known pill in `text`, in order. */
export function pillsIn(text: string): ReadonlyArray<Found> {
  return Array.from(text.matchAll(/\[\[([^[\]\n]{1,64})\]\]/g)).flatMap((match) =>
    Option.toArray(Option.map(pillOf(match[1] ?? ""), (pill) => ({ start: match.index, end: match.index + match[0].length, pill }))),
  )
}

/** Whether `[start, end)` meets any of `ranges`. */
const meets = (start: number, end: number, ranges: ReadonlyArray<readonly [number, number]>) =>
  ranges.some(([from, to]) => from < end && start < to)

/** A run of drawn text: what the splitting reads and keeps. */
export interface Run {
  readonly text: string
}

/** A block's source as the final path hands it over: its text, each run's source range, and the ranges of code in it. */
export interface Source {
  readonly content: string
  readonly ranges: ReadonlyArray<{ readonly start: number; readonly end: number }>
  readonly raw: ReadonlyArray<readonly [number, number]>
}

/**
 * Where each source offset is drawn, from runs that each draw their source
 * range one character for one: a run whose text is not as long as its range
 * (a rewritten link, a cut) maps none of its range, so a pill over it is left.
 */
function drawnAt(runs: ReadonlyArray<Run>, ranges: Source["ranges"]) {
  const at = new Map<number, number>()
  const broken: Array<readonly [number, number]> = []
  let drawn = 0
  runs.forEach((run, index) => {
    Option.match(Option.fromNullishOr(ranges[index]), {
      onNone: () => broken.push([0, Number.MAX_SAFE_INTEGER]),
      onSome: (range) => {
        if (run.text.length !== range.end - range.start) broken.push([range.start, range.end])
        else for (let offset = 0; offset < run.text.length; offset++) at.set(range.start + offset, drawn + offset)
      },
    })
    drawn += run.text.length
  })
  return { at, broken }
}

/**
 * The final path's edits: each known pill outside code, over the drawn text
 * its source became (tree-sitter shows `[[Done]]` as `[Done]`, the inner
 * brackets hidden), and the lead label's diamond in front of the block. A
 * pill whose drawn text is not one unbroken stretch is left as typed.
 */
export function finalEdits(runs: ReadonlyArray<Run>, source: Source): ReadonlyArray<Edit> {
  const { at, broken } = drawnAt(runs, source.ranges)
  const chips = pillsIn(source.content).flatMap((found) => {
      if (meets(found.start, found.end, source.raw) || meets(found.start, found.end, broken)) return []
      const drawn = Arr.range(found.start, found.end - 1).flatMap((offset) => Option.toArray(Option.fromNullishOr(at.get(offset))))
      return Option.toArray(
        Option.all([Arr.head(drawn), Arr.last(drawn)]).pipe(
          Option.filter(([first, last]) => last - first + 1 === drawn.length),
          Option.map(([first, last]): Edit => ({ start: first, end: last + 1, piece: { kind: "chip", pill: found.pill } })),
        ),
      )
    })
  return [...leadEdit(runs, leadLabel(source.content)), ...chips]
}

/** The label's diamond, in front of the block's first drawn text. */
const leadEdit = (runs: ReadonlyArray<Run>, label: Option.Option<Label>): ReadonlyArray<Edit> =>
  Option.match(label, {
    onNone: () => [],
    onSome: (found) => Arr.match(runs.filter((run) => run.text !== ""), {
      onEmpty: () => [],
      onNonEmpty: () => [{ start: 0, end: 0, piece: { kind: "mark", label: found } }],
    }),
  })

/**
 * The preview path's edits (streaming and table cells, drawn from marked's
 * tokens): pills found in the drawn text itself, never over a run of code,
 * and `label`'s diamond in front.
 */
export function previewEdits(runs: ReadonlyArray<Run>, code: ReadonlyArray<boolean>, label: Option.Option<Label>): ReadonlyArray<Edit> {
  const raw: Array<readonly [number, number]> = []
  let drawn = 0
  runs.forEach((run, index) => {
    if (code[index] === true) raw.push([drawn, drawn + run.text.length])
    drawn += run.text.length
  })
  const text = runs.map((run) => run.text).join("")
  const chips = pillsIn(text)
    .filter((found) => !meets(found.start, found.end, raw))
    .map((found): Edit => ({ start: found.start, end: found.end, piece: { kind: "chip", pill: found.pill } }))
  return [...leadEdit(runs, label), ...chips]
}

/**
 * The runs with each edit applied: the text an edit covers is replaced by
 * `draw(run, piece)` once, from the run its stretch starts in, and the rest
 * of each run is kept, split where an edit begins or ends.
 */
export function splice<R extends Run>(runs: ReadonlyArray<R>, edits: ReadonlyArray<Edit>, draw: (base: R, piece: Piece) => R): ReadonlyArray<R> {
  const sorted = edits.toSorted((a, b) => a.start - b.start || a.end - b.end)
  const out: Array<R> = []
  let next = 0
  let start = 0
  for (const run of runs) {
    const end = start + run.text.length
    if (run.text === "") out.push(run)
    let cursor = start
    while (next < sorted.length && sorted[next].start < end) {
      const edit = sorted[next]
      if (edit.start > cursor) out.push({ ...run, text: run.text.slice(cursor - start, edit.start - start) })
      if (edit.start >= start) out.push(draw(run, edit.piece))
      cursor = Math.max(cursor, Math.min(end, edit.end))
      if (edit.end > end) break
      next++
    }
    if (cursor < end) out.push({ ...run, text: run.text.slice(cursor - start) })
    start = end
  }
  return out
}

/** The final path in one step: the runs with their pills and lead label drawn by `draw`. */
export const decorate = <R extends Run>(runs: ReadonlyArray<R>, source: Source, draw: (base: R, piece: Piece) => R) =>
  splice(runs, finalEdits(runs, source), draw)

const GROUPS: ReadonlyArray<readonly [Group, string]> = [
  ["evidence", "Evidence, on a claim whose sentence does not already carry it"],
  ["outcome", "Outcome"],
  ["consequence", "Consequence, before the action"],
]

function listed(entry: Word) {
  if (entry.hint === "") return `[[${entry.word}]]`
  return `[[${entry.word}]] (${entry.hint})`
}

/**
 * The prompt section that teaches the chips, built from `WORDS`, so the words
 * taught are the words drawn. Root sessions get it (the server half).
 */
export function guidance(): string {
  const groups = GROUPS.map(
    ([group, title]) => `- ${title}: ${Arr.map(Arr.filter(WORDS, (entry) => entry.group === group), listed).join(", ")}.`,
  )
  return [
    "<reply_style>",
    "This terminal draws [[Word]] in a reply to the user as a coloured chip. Put it beside the claim or item it describes. Use only these words, as written, with short detail if useful ([[Done 12/12]], [[Failed: 3 tests]]):",
    ...groups,
    "A chip names a state, not emphasis: at most one per sentence, bullet or table cell. None in headings, code, commands, paths, or anything another program or agent reads (files, commit messages, tool inputs, prompts and messages to other sessions).",
    "</reply_style>",
  ].join("\n")
}

/** The TUI option `emphasis`: on unless set to `false`, which draws every reply as typed. */
export const emphasisOn = (options: { readonly emphasis?: boolean | string | number }) => options.emphasis !== false
