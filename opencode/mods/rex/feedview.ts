// The feed pane: a Sideshow session as one place that evolves. The board on
// top (the post titled Board, its newest version), the timeline on the left
// (every other post newest first, a dot on those that came since the pane
// first looked), and the view on the right (the post picked, by default the
// newest, each surface drawn). The pane's keys move in the timeline, step
// through a post's versions, open it in the browser or in leaf, and comment
// on it as the user. `step` is the whole of its behaviour: an event in, the
// state after it and the jobs the viewer runs; `drawFeed` is its frame.
import { Array as Arr, Data, Option } from "effect"
import { type Cells, type CellPixels, clearPictures, drawPng, fit, pngSize } from "./graphics.ts"
import { Input, type Mouse } from "./live.ts"
import { visibleWidth } from "./markdown.ts"
import type { Post, Surface, Version } from "./service.ts"
import { Block, clip, linesOf, pad } from "./surface.ts"
import { clearReport, report, type Tally } from "./status.ts"
import { agoOf, BOARD_TITLE, boardOf, millisOf, type Row, rowsOf, stepVersion, timelineOf } from "./timeline.ts"

const ESC = "\u001b"
const sgr = (codes: string) => `${ESC}[${codes}m`
const RESET = sgr("0")
const BOLD = sgr("1")
const DIM = sgr("2")
const REVERSE = sgr("7")
const RED = sgr("31")
const CYAN = sgr("36")
const CLEAR = `${ESC}[H${ESC}[2J${ESC}[3J`
const HIDE_CURSOR = `${ESC}[?25l`
const at = (row: number, col: number) => `${ESC}[${row};${col}H`

/** What the pane's keys do now: move and read, type a comment, or read the keys. */
export type Mode = Data.TaggedEnum<{
  Browse: {}
  Comment: { readonly text: string }
  Help: {}
}>
export const Mode = Data.taggedEnum<Mode>()

/** Which region the arrows move in: the timeline's rows, or the view's lines. */
export type Focus = "timeline" | "view"

/** A post's versions, once asked for. */
export interface Versions {
  readonly id: string
  readonly version: number
  readonly list: ReadonlyArray<Version>
}

/** The feed pane's state between events. */
export interface FeedState {
  readonly posts: ReadonlyArray<Post>
  readonly loaded: boolean
  readonly failure: Option.Option<string>
  /** The post picked; none: the newest, followed as posts come. */
  readonly selected: Option.Option<string>
  /** The version shown of the picked post; none: its newest. */
  readonly version: Option.Option<number>
  readonly versions: Option.Option<Versions>
  /** Posts that came since the pane first looked, not picked yet. */
  readonly fresh: ReadonlySet<string>
  readonly focus: Focus
  readonly mode: Mode
  readonly note: Option.Option<string>
  /** How many lines of the view are scrolled past. */
  readonly scroll: number
}

/** The pane before its first look at the session. */
export const initial: FeedState = {
  posts: [],
  loaded: false,
  failure: Option.none(),
  selected: Option.none(),
  version: Option.none(),
  versions: Option.none(),
  fresh: new Set(),
  focus: "timeline",
  mode: Mode.Browse(),
  note: Option.none(),
  scroll: 0,
}

/** What the pane's user asked. */
export type Action = Data.TaggedEnum<{
  Up: {}
  Down: {}
  Enter: {}
  Back: {}
  Open: {}
  Leaf: {}
  Comment: {}
  Board: {}
  Help: {}
  Quit: {}
  Older: {}
  Newer: {}
  Pick: { readonly row: number }
  Type: { readonly text: string }
  Erase: {}
  ScrollUp: { readonly lines: number }
  ScrollDown: { readonly lines: number }
}>
export const Action = Data.taggedEnum<Action>()

/** What happened to the pane: a look at the session, a post's versions, a key, or a job's outcome. */
export type Event = Data.TaggedEnum<{
  Polled: { readonly posts: ReadonlyArray<Post> }
  PollFailed: { readonly reason: string }
  Versions: { readonly id: string; readonly version: number; readonly list: ReadonlyArray<Version> }
  Key: { readonly action: Action }
  Noted: { readonly text: string }
  /** Something drawn came in (a surface's shot, the pane's new size): the state is as it was. */
  Redraw: {}
}>
export const Event = Data.taggedEnum<Event>()

/** What the viewer does for the pane. */
export type Job = Data.TaggedEnum<{
  FetchVersions: { readonly id: string }
  OpenPost: { readonly id: string }
  LeafPost: { readonly title: string; readonly surfaces: ReadonlyArray<Surface> }
  SendComment: { readonly id: string; readonly text: string }
  Quit: {}
}>
export const Job = Data.taggedEnum<Job>()

/** A step's outcome: the state after it, and the jobs it asks. */
export interface Stepped {
  readonly state: FeedState
  readonly jobs: ReadonlyArray<Job>
}

const only = (state: FeedState, jobs: ReadonlyArray<Job> = []): Stepped => ({ state, jobs })

const noted = (state: FeedState, text: string): Stepped => only({ ...state, note: Option.some(text) })

/** The timeline of the state's posts. */
export const timelineFor = (state: FeedState): ReadonlyArray<Post> => timelineOf(state.posts)

/** The post the view shows: the one picked while it is there, else the newest, else the board. */
export const shownPost = (state: FeedState): Option.Option<Post> =>
  Option.firstSomeOf([
    Option.flatMap(state.selected, (id) => Arr.findFirst(state.posts, (post) => post.id === id)),
    Arr.head(timelineFor(state)),
    boardOf(state.posts),
  ])

/** The versions known for `post` at its newest version. */
const versionsFor = (state: FeedState, post: Post): Option.Option<ReadonlyArray<Version>> =>
  Option.map(Option.filter(state.versions, (known) => known.id === post.id && known.version === post.version), (known) => known.list)

/** What the view shows of its post: the version picked, else the newest; its number, title and surfaces, and how many versions there are. */
export interface Shown {
  readonly post: Post
  readonly version: number
  readonly count: number
  readonly title: string
  readonly surfaces: ReadonlyArray<Surface>
  readonly at: string
}

export const shownOf = (state: FeedState): Option.Option<Shown> =>
  Option.map(shownPost(state), (post) => {
    const newest: Shown = { post, version: post.version, count: post.version, title: post.title, surfaces: post.surfaces, at: post.updatedAt }
    return Option.getOrElse(
      Option.flatMap(versionsFor(state, post), (list) =>
        Option.map(
          Arr.findFirst(list, (kept) => Option.contains(state.version, kept.version)),
          (kept) => ({ ...newest, version: kept.version, count: Math.max(post.version, list.length), title: kept.title, surfaces: kept.surfaces, at: kept.at }),
        ),
      ),
      () => newest,
    )
  })

/** The key the view's drawn surfaces are kept under: its post and version. */
export const shownKey = (shown: Shown): string => `${shown.post.id}@${shown.version}`

/** `id` picked: the view on its newest version from the top, its dot gone, its versions asked when it has more than one. */
const pick = (state: FeedState, id: string): Stepped => {
  const fresh = new Set(state.fresh)
  fresh.delete(id)
  const picked: FeedState = { ...state, selected: Option.some(id), version: Option.none(), scroll: 0, fresh, note: Option.none() }
  return only(picked, versionJobs(picked))
}

/** The versions to ask for the shown post: when it has more than one and they are not known at its newest. */
const versionJobs = (state: FeedState): ReadonlyArray<Job> =>
  Option.match(
    Option.filter(shownPost(state), (post) => post.version > 1 && Option.isNone(versionsFor(state, post))),
    { onNone: () => [], onSome: (post) => [Job.FetchVersions({ id: post.id })] },
  )

/** The ids in the order Up and Down walk them: the board first, then the timeline. */
const walk = (state: FeedState): ReadonlyArray<string> => [
  ...Option.toArray(Option.map(boardOf(state.posts), (post) => post.id)),
  ...timelineFor(state).map((post) => post.id),
]

const move = (state: FeedState, steps: number): Stepped => {
  const ids = walk(state)
  const here = Option.getOrElse(
    Option.flatMap(shownPost(state), (post) => Arr.findFirstIndex(ids, (id) => id === post.id)),
    () => 0,
  )
  return Option.match(Arr.get(ids, Math.min(ids.length - 1, Math.max(0, here + steps))), { onNone: () => only(state), onSome: (id) => pick(state, id) })
}

const scrolled = (state: FeedState, lines: number): Stepped => only({ ...state, scroll: Math.max(0, state.scroll + lines) })

/** `[` or `]`: the shown post's version `steps` away, once its versions are known. */
const stepped = (state: FeedState, steps: number): Stepped =>
  Option.match(shownPost(state), {
    onNone: () => noted(state, "no post to step through"),
    onSome: (post) =>
      Option.match(Option.liftPredicate(post, (each) => each.version > 1), {
        onNone: () => noted(state, `${post.title} has one version`),
        onSome: () =>
          Option.match(versionsFor(state, post), {
            onNone: () => ({ state: { ...state, note: Option.some("asking for its versions…") }, jobs: [Job.FetchVersions({ id: post.id })] }),
            onSome: (list) => only({ ...state, version: stepVersion(list, state.version, steps), scroll: 0, note: Option.none() }),
          }),
      }),
  })

/** An action while a comment is typed: text and Backspace edit it, Enter sends it, Escape drops it. */
const commenting = (state: FeedState, text: string, action: Action): Stepped =>
  Action.$match(action, {
    Type: (typed) => only({ ...state, mode: Mode.Comment({ text: `${text}${typed.text}` }) }),
    Erase: () => only({ ...state, mode: Mode.Comment({ text: Array.from(text).slice(0, -1).join("") }) }),
    Enter: () =>
      Option.match(Option.all({ post: shownPost(state), text: Option.liftPredicate(text.trim(), (trimmed) => trimmed !== "") }), {
        onNone: () => only({ ...state, mode: Mode.Browse() }),
        onSome: (both) => ({ state: { ...state, mode: Mode.Browse(), note: Option.some("sending the comment…") }, jobs: [Job.SendComment({ id: both.post.id, text: both.text })] }),
      }),
    Back: () => only({ ...state, mode: Mode.Browse(), note: Option.none() }),
    Quit: () => only({ ...state, mode: Mode.Browse(), note: Option.none() }),
    Up: () => only(state),
    Down: () => only(state),
    Open: () => only(state),
    Leaf: () => only(state),
    Comment: () => only(state),
    Board: () => only(state),
    Help: () => only(state),
    Older: () => only(state),
    Newer: () => only(state),
    Pick: () => only(state),
    ScrollUp: () => only(state),
    ScrollDown: () => only(state),
  })

/** A job on the shown post, or a note when there is none. */
const onShown = (state: FeedState, job: (shown: Shown) => Job): Stepped =>
  Option.match(shownOf(state), { onNone: () => noted(state, "no post yet"), onSome: (shown) => ({ state: { ...state, note: Option.none() }, jobs: [job(shown)] }) })

/** Up and Down: the timeline's rows, or the view's lines when it has the focus. */
const vertical = (state: FeedState, steps: number): Stepped =>
  Option.match(Option.liftPredicate(state.focus, (focus) => focus === "view"), { onSome: () => scrolled(state, steps), onNone: () => move(state, steps) })

/** An action while browsing. */
const browsing = (state: FeedState, action: Action): Stepped =>
  Action.$match(action, {
    Up: () => vertical(state, -1),
    Down: () => vertical(state, 1),
    Enter: () => only({ ...state, focus: "view" }),
    Back: () => only({ ...state, focus: "timeline", note: Option.none() }),
    Open: () => onShown(state, (shown) => Job.OpenPost({ id: shown.post.id })),
    Leaf: () => onShown(state, (shown) => Job.LeafPost({ title: shown.title, surfaces: shown.surfaces })),
    Comment: () => Option.match(shownPost(state), { onNone: () => noted(state, "no post to comment on"), onSome: () => only({ ...state, mode: Mode.Comment({ text: "" }), note: Option.none() }) }),
    Board: () => Option.match(boardOf(state.posts), { onNone: () => noted(state, `no post titled ${BOARD_TITLE} yet`), onSome: (board) => pick(state, board.id) }),
    Help: () => only({ ...state, mode: Mode.Help() }),
    Quit: () => ({ state, jobs: [Job.Quit()] }),
    Older: () => stepped(state, -1),
    Newer: () => stepped(state, 1),
    Pick: ({ row }) => Option.match(Arr.get(timelineFor(state), row), { onNone: () => only(state), onSome: (post) => pick({ ...state, focus: "timeline" }, post.id) }),
    Type: () => only(state),
    Erase: () => only(state),
    ScrollUp: ({ lines }) => scrolled(state, -lines),
    ScrollDown: ({ lines }) => scrolled(state, lines),
  })

/** A look at the session: its posts kept, those new since the last look dotted (not on the first), a pick that went away dropped. */
const polled = (state: FeedState, posts: ReadonlyArray<Post>): Stepped => {
  const before = new Set(state.posts.map((post) => post.id))
  const fresh = new Set([...state.fresh].filter((id) => posts.some((post) => post.id === id)))
  if (state.loaded) posts.filter((post) => !before.has(post.id)).forEach((post) => fresh.add(post.id))
  const selected = Option.filter(state.selected, (id) => posts.some((post) => post.id === id))
  const next: FeedState = { ...state, posts, loaded: true, failure: Option.none(), selected, fresh }
  return only(next, versionJobs(next))
}

/** The pane after `event`, and the jobs it asks. */
export const step = (state: FeedState, event: Event): Stepped =>
  Event.$match(event, {
    Polled: ({ posts }) => polled(state, posts),
    PollFailed: ({ reason }) => only({ ...state, failure: Option.some(reason) }),
    Versions: ({ id, version, list }) => only({ ...state, versions: Option.some({ id, version, list }), note: Option.filter(state.note, (text) => text !== "asking for its versions…") }),
    Noted: ({ text }) => noted(state, text),
    Redraw: () => only(state),
    Key: ({ action }) =>
      Mode.$match(state.mode, {
        Comment: ({ text }) => commenting(state, text, action),
        Help: () => only({ ...state, mode: Mode.Browse() }),
        Browse: () => browsing(state, action),
      }),
  })

/** The regions of the pane, in cells: `top` and `left` are 1-based. */
export interface Box {
  readonly top: number
  readonly left: number
  readonly cols: number
  readonly rows: number
}

/** Where each region is drawn. */
export interface FeedLayout {
  readonly board: Box
  readonly timeline: Box
  readonly view: Box
  readonly status: number
  readonly size: Cells
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/** The regions of a pane of `size`: the header on the first row, the board under it, a rule, the timeline left of the view, the status line on the last row. */
export const layoutOf = (size: Cells): FeedLayout => {
  const boardRows = clamp(Math.floor(size.rows * 0.3), 2, 14)
  const bodyTop = 3 + boardRows
  const bodyRows = Math.max(1, size.rows - bodyTop)
  const timelineCols = clamp(Math.floor(size.cols * 0.34), Math.min(18, size.cols), 44)
  return {
    board: { top: 2, left: 1, cols: size.cols, rows: boardRows },
    timeline: { top: bodyTop, left: 1, cols: timelineCols, rows: bodyRows },
    view: { top: bodyTop, left: timelineCols + 2, cols: Math.max(1, size.cols - timelineCols - 1), rows: bodyRows },
    status: size.rows,
    size,
  }
}

/** The timeline row a click at `mouse` lands on (the timeline's first row is its title); none off the rows. */
export const rowAt = (layout: FeedLayout, mouse: { readonly col: number; readonly row: number }, first: number): Option.Option<number> =>
  Option.map(
    Option.liftPredicate(mouse, (point) => point.col >= layout.timeline.left && point.col < layout.timeline.left + layout.timeline.cols && point.row > layout.timeline.top && point.row < layout.timeline.top + layout.timeline.rows),
    (point) => point.row - layout.timeline.top - 1 + first,
  )

/** The keys of each action, while browsing. */
const LETTERS = new Map<string, Action>([
  ["j", Action.Down()],
  ["k", Action.Up()],
  ["o", Action.Open()],
  ["l", Action.Leaf()],
  ["c", Action.Comment()],
  ["b", Action.Board()],
  ["?", Action.Help()],
  ["q", Action.Quit()],
  ["[", Action.Older()],
  ["]", Action.Newer()],
])

const keyAction = (key: string, mode: Mode): Option.Option<Action> => {
  const typing = mode._tag === "Comment"
  if (key === "Enter") return Option.some(Action.Enter())
  if (key === "Escape") return Option.some(Action.Back())
  if (key === "Backspace" || key === "Delete") return Option.some(Option.getOrElse(Option.map(Option.liftPredicate(typing, (yes) => yes), () => Action.Erase()), () => Action.Back()))
  if (key === "ArrowUp") return Option.some(Action.Up())
  if (key === "ArrowDown") return Option.some(Action.Down())
  if (key === "PageUp") return Option.some(Action.ScrollUp({ lines: 10 }))
  if (key === "PageDown") return Option.some(Action.ScrollDown({ lines: 10 }))
  if (key === "ArrowLeft") return Option.some(Action.Back())
  if (key === "ArrowRight") return Option.some(Action.Enter())
  return Option.none()
}

const mouseAction = (mouse: Mouse, layout: FeedLayout, first: number): ReadonlyArray<Action> => {
  if (mouse._tag === "Wheel" && (mouse.direction === "up" || mouse.direction === "down")) {
    return [Option.match(Option.liftPredicate(mouse.direction, (direction) => direction === "up"), { onSome: () => Action.ScrollUp({ lines: 3 }), onNone: () => Action.ScrollDown({ lines: 3 }) })]
  }
  if (mouse._tag !== "Press" || mouse.button !== "left") return []
  return Option.toArray(Option.map(rowAt(layout, mouse, first), (row) => Action.Pick({ row })))
}

/** What an input means in `mode`, laid out as `layout` with the timeline scrolled to `first`: typed text while commenting, else the pane's keys. */
/**
 * The keys typed while browsing, each letter its action; what follows a `c`
 * in the same read is the comment's text, as a quick typist's or a paste's
 * letters come in one read.
 */
const lettersOf = (text: string): ReadonlyArray<Action> => {
  const [head = "", ...after] = text.split("c")
  const keys = Array.from(head).flatMap((char) => Option.toArray(Option.fromUndefinedOr(LETTERS.get(char))))
  if (after.length === 0) return keys
  const rest = after.join("c")
  return [...keys, Action.Comment(), ...Option.toArray(Option.map(Option.liftPredicate(rest, (typed) => typed !== ""), (typed) => Action.Type({ text: typed })))]
}

export const actionsOf = (input: Input, mode: Mode, layout: FeedLayout, first: number): ReadonlyArray<Action> =>
  Input.$match(input, {
    Text: ({ text }) =>
      Option.match(Option.liftPredicate(mode, (now) => now._tag === "Comment"), {
        onSome: () => [Action.Type({ text })],
        onNone: () => lettersOf(text),
      }),
    Key: ({ key }) => Option.toArray(keyAction(key, mode)),
    Pointer: ({ mouse }) => mouseAction(mouse, layout, first),
    Quit: () => [Option.match(Option.liftPredicate(mode, (now) => now._tag === "Comment"), { onSome: () => Action.Back(), onNone: () => Action.Quit() })],
    Control: () => [],
    Cell: () => [],
    Back: () => [Action.Back()],
    Reload: () => [],
  })

/** The first timeline row drawn: the picked row kept in sight. */
export const firstRow = (state: FeedState, layout: FeedLayout): number => {
  const room = Math.max(1, layout.timeline.rows - 1)
  const here = Option.getOrElse(
    Option.flatMap(shownPost(state), (post) => Arr.findFirstIndex(timelineFor(state), (each) => each.id === post.id)),
    () => 0,
  )
  return Math.max(0, here - room + 1)
}

/** The tally a feed reports: the board's first line, else the post count and the newest's title. */
export const feedTally = (posts: ReadonlyArray<Post>): Tally => {
  const count = timelineOf(posts).length
  const counted = `${count} ${Option.match(Option.liftPredicate(count, (n) => n === 1), { onNone: () => "posts", onSome: () => "post" })}`
  return Option.match(boardOf(posts), {
    onNone: () => ({ msg: Option.match(Arr.head(timelineOf(posts)), { onNone: () => "no posts yet", onSome: (newest) => `${counted} · ${newest.title}` }), state: "working" }),
    onSome: (board) => ({ msg: `${boardLine(board)} · ${counted}`, state: "working" }),
  })
}

/** A board's headline: its first Markdown surface's first line of text, else its title. */
export const boardLine = (board: Post): string =>
  Option.getOrElse(
    Option.flatMap(Arr.findFirst(board.surfaces, (surface) => surface.kind === "markdown"), (surface) =>
      Arr.findFirst(
        Option.getOrElse(Option.fromUndefinedOr(surface.markdown), () => "").split(/\r?\n/).map((line) => line.replace(/^\s*(#+|[-*+]|>)\s*/, "").replace(/[*_`]/g, "").trim()),
        (line) => line !== "",
      ),
    ),
    () => board.title,
  )

/** What one frame draws: the state, the session's title, the board's and the view's surfaces as drawn so far, the time, and the cells' pixels. */
export interface Frame {
  readonly state: FeedState
  readonly title: string
  readonly board: ReadonlyArray<Block>
  readonly view: ReadonlyArray<Block>
  readonly now: number
  readonly cell: CellPixels
}

/** Lines written into `box` from its `from`th row, each cut or padded to its width. */
const writeLines = (box: Box, from: number, lines: ReadonlyArray<string>): string =>
  lines
    .slice(0, Math.max(0, box.rows - from))
    .map((line, row) => `${at(box.top + from + row, box.left)}${pad(line, box.cols)}`)
    .join("")

/** Blocks drawn into `box` from row `from`, `skip` lines scrolled past: text line by line, a picture as large as fits what is left (shape kept), a picture scrolled past whole. */
const writeBlocks = (box: Box, from: number, blocks: ReadonlyArray<Block>, skip: number, cell: CellPixels): string => {
  const out: Array<string> = []
  const place = { row: from, skip }
  const separated = blocks.flatMap((block, index) => [...Option.toArray(Option.liftPredicate(Block.Markdown({ text: "" }), () => index > 0)), block])
  for (const block of separated) {
    if (place.row >= box.rows) break
    const room = { cols: box.cols, rows: box.rows - place.row }
    const picture = Option.flatMap(Option.liftPredicate(block, Block.$is("Picture")), (shown) => Option.map(pngSize(shown.bytes), (size) => ({ bytes: shown.bytes, cells: fit(size, room, cell) })))
    if (Option.isSome(picture)) {
      if (place.skip > 0) {
        place.skip = Math.max(0, place.skip - picture.value.cells.rows)
        continue
      }
      out.push(`${at(box.top + place.row, box.left)}${drawPng(picture.value.bytes, picture.value.cells)}`)
      place.row += picture.value.cells.rows
      continue
    }
    const lines = Option.match(Option.liftPredicate(block, Block.$is("Picture")), {
      onNone: () => linesOf(block, box.cols),
      onSome: () => [`${DIM}not a PNG${RESET}`],
    })
    const shown = lines.slice(place.skip)
    place.skip = Math.max(0, place.skip - lines.length)
    out.push(writeLines(box, place.row, shown))
    place.row += shown.length
  }
  return out.join("")
}

const boardRegion = (frame: Frame, box: Box): string =>
  Option.match(boardOf(frame.state.posts), {
    onNone: () => writeLines(box, 0, [`${DIM}No board yet: publish a post titled ${BOARD_TITLE} and keep it current with sideshow update${RESET}`]),
    onSome: (board) => {
      const head = `${BOLD}◆ ${board.title}${RESET}${DIM} · v${board.version} · updated ${agoOf(millisOf(board.updatedAt, frame.now), frame.now)}${RESET}`
      return `${writeLines(box, 0, [head])}${writeBlocks(box, 1, frame.board, 0, frame.cell)}`
    },
  })

const rowLine = (row: Row, cols: number, picked: boolean): string => {
  const mark = Option.match(Option.liftPredicate(row.fresh, (fresh) => fresh), { onNone: () => " ", onSome: () => `${CYAN}●${RESET}` })
  const right = `${row.age}${Option.match(Option.liftPredicate(row.versions, (n) => n > 1), { onNone: () => "", onSome: (n) => ` v${n}` })}`
  const left = clip(`${mark}${row.icons} ${row.title}`, Math.max(1, cols - visibleWidth(right) - 1))
  const line = `${left}${" ".repeat(Math.max(1, cols - visibleWidth(left) - visibleWidth(right)))}${DIM}${right}${RESET}`
  return Option.match(Option.liftPredicate(picked, (yes) => yes), { onNone: () => line, onSome: () => `${REVERSE}${pad(line.replaceAll(RESET, `${RESET}${REVERSE}`), cols)}${RESET}` })
}

const timelineRegion = (frame: Frame, layout: FeedLayout): string => {
  const box = layout.timeline
  const timeline = timelineFor(frame.state)
  const shown = Option.map(shownPost(frame.state), (post) => post.id)
  const first = firstRow(frame.state, layout)
  const rows = rowsOf(timeline, frame.now, frame.state.fresh).slice(first, first + box.rows - 1)
  const head = `${BOLD}Timeline${RESET}${DIM} · ${timeline.length} · newest first${RESET}`
  const empty = Option.match(Option.liftPredicate(frame.state.loaded, (loaded) => loaded), { onNone: () => "asking Sideshow…", onSome: () => "no posts yet" })
  const lines = Option.match(Arr.match(rows, { onEmpty: () => Option.none(), onNonEmpty: Option.some }), {
    onNone: () => [`${DIM}${empty}${RESET}`],
    onSome: (all) => all.map((row) => rowLine(row, box.cols, Option.contains(shown, row.id))),
  })
  return writeLines(box, 0, [head, ...lines])
}

const viewRegion = (frame: Frame, box: Box): string =>
  Option.match(shownOf(frame.state), {
    onNone: () => writeLines(box, 0, [`${DIM}Nothing posted yet: sideshow publish, or the sideshow tools${RESET}`]),
    onSome: (shown) => {
      const focus = Option.match(Option.liftPredicate(frame.state.focus, (focus) => focus === "view"), { onNone: () => "", onSome: () => `${CYAN}▍${RESET}` })
      const versions = Option.match(Option.liftPredicate(shown.count, (n) => n > 1), { onNone: () => "", onSome: (n) => ` · v${shown.version}/${n}` })
      const head = `${focus}${BOLD}${shown.title}${RESET}${DIM}${versions} · ${agoOf(millisOf(shown.at, frame.now), frame.now)}${RESET}`
      return `${writeLines(box, 0, [head])}${writeBlocks(box, 1, frame.view, frame.state.scroll, frame.cell)}`
    },
  })

/** The keys, as the help line and the `?` page list them. */
export const KEYS: ReadonlyArray<readonly [keys: string, what: string]> = [
  ["j k ↑ ↓", "move in the timeline (the view's lines once it has the focus)"],
  ["enter →", "focus the view; esc ← back to the timeline"],
  ["[ ]", "older and newer versions of the post"],
  ["b", "the board"],
  ["c", "comment on the post (sideshow wait gets it)"],
  ["o", "open the post in the browser"],
  ["l", "open its Markdown or diff in leaf, beside"],
  ["click", "a timeline row picks it; the wheel scrolls the view"],
  ["q", "quit"],
]

const statusLine = (frame: Frame, cols: number): string =>
  Mode.$match(frame.state.mode, {
    Comment: ({ text }) => clip(`${BOLD}comment:${RESET} ${text}${REVERSE} ${RESET}${DIM}  enter sends · esc drops${RESET}`, cols),
    Help: () => clip(`${DIM}any key goes back${RESET}`, cols),
    Browse: () =>
      Option.match(Option.orElse(frame.state.note, () => Option.map(frame.state.failure, (reason) => `${RED}✗ ${reason}${RESET}`)), {
        onSome: (note) => clip(note, cols),
        onNone: () => clip(`${DIM}j/k move · enter view · [ ] versions · b board · c comment · o open · l leaf · ? keys · q quit${RESET}`, cols),
      }),
  })

/** The `?` page: each key and what it does. */
const helpPage = (layout: FeedLayout): string =>
  writeLines({ top: layout.board.top, left: 1, cols: layout.size.cols, rows: layout.size.rows - 2 }, 0, [`${BOLD}Keys${RESET}`, "", ...KEYS.map(([keys, what]) => `${CYAN}${keys.padEnd(10)}${RESET}${what}`)])

/** The whole frame of the pane at `size`: the screen cleared, its regions drawn, the tally reported. */
export const drawFeed = (frame: Frame, size: Cells): string => {
  const layout = layoutOf(size)
  const header = `${at(1, 1)}${DIM}${clip(`feed · ${frame.title}`, size.cols)}${RESET}`
  const rule = `${at(layout.board.top + layout.board.rows, 1)}${DIM}${"─".repeat(size.cols)}${RESET}`
  const bar = Arr.makeBy(layout.view.rows, (row) => `${at(layout.view.top + row, layout.view.left - 1)}${DIM}│${RESET}`).join("")
  const regions = Mode.$match(frame.state.mode, {
    Help: () => helpPage(layout),
    Comment: () => `${boardRegion(frame, layout.board)}${rule}${timelineRegion(frame, layout)}${bar}${viewRegion(frame, layout.view)}`,
    Browse: () => `${boardRegion(frame, layout.board)}${rule}${timelineRegion(frame, layout)}${bar}${viewRegion(frame, layout.view)}`,
  })
  const tally = Option.match(Option.liftPredicate(frame.state.loaded, (loaded) => loaded), { onNone: () => clearReport, onSome: () => report(feedTally(frame.state.posts)) })
  return `${HIDE_CURSOR}${clearPictures}${CLEAR}${header}${regions}${at(layout.status, 1)}${statusLine(frame, size.cols)}${tally}`
}
