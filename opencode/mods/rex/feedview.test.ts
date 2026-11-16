// The feed pane's behaviour, step by step: what is shown (the picked post,
// else the newest, else the board), the dot on posts that came since the
// first look, Up and Down through the board and the timeline, `[` and `]`
// through a post's versions (asked for first), a comment typed and sent, the
// keys and clicks each input means, the frame's regions, and the tally the
// board gives.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Action, actionsOf, boardHiddenOf, boardLine, boardMost, drawFeed, Event, type FeedState, feedLayout, feedTally, firstRow, initial, Job, layoutOf, Mode, rowAt, shownOf, step } from "./feedview.ts"
import { report, type Tally } from "./status.ts"
import { Block } from "./surface.ts"
import { Input, Mouse, NO_MODS } from "./live.ts"
import type { Post, Version } from "./service.ts"

const at = (minute: number) => `2026-11-15T10:${String(minute).padStart(2, "0")}:00.000Z`
const post = (id: string, title: string, minute: number, version = 1, markdown = `${title} text`): Post => ({
  id,
  title,
  version,
  createdAt: at(minute),
  updatedAt: at(minute),
  surfaces: [{ kind: "markdown", index: 0, markdown }],
})
const version = (number: number, markdown: string): Version => ({ version: number, title: "notes", at: at(number), surfaces: [{ kind: "markdown", index: 0, markdown }] })

const board = post("b", "Board", 0, 2, "# Shipping the feed\n\n- step two")
const notes = post("n", "notes", 1, 3)
const sketch = post("s", "sketch", 2)

/** A state and the jobs asked on the way to it. */
interface Ran {
  readonly state: FeedState
  readonly jobs: ReadonlyArray<Job>
}

/** The state after `events`, from the start, and every job they asked. */
const run = (events: ReadonlyArray<Event>, from: FeedState = initial) =>
  events.reduce<Ran>(({ state, jobs }, event) => {
    const stepped = step(state, event)
    return { state: stepped.state, jobs: [...jobs, ...stepped.jobs] }
  }, { state: from, jobs: [] })

const key = (action: Action) => Event.Key({ action })
const shownId = (state: FeedState) => Option.map(shownOf(state), (shown) => shown.post.id)

describe("what the view shows", () => {
  test("the newest post, followed as posts come; the board when it is all there is; the picked one once picked", () => {
    expect(shownId(run([Event.Polled({ posts: [board] })]).state)).toEqual(Option.some("b"))
    const followed = run([Event.Polled({ posts: [board, notes] }), Event.Polled({ posts: [board, notes, sketch] })]).state
    expect(shownId(followed)).toEqual(Option.some("s"))
    const picked = run([key(Action.Down())], followed).state
    expect(shownId(picked)).toEqual(Option.some("n"))
    expect(shownId(run([Event.Polled({ posts: [board, notes, sketch, post("x", "later", 3)] })], picked).state)).toEqual(Option.some("n"))
  })

  test("a dot on each post that came after the first look, gone once the view shows it, picked or followed; a pick that went away falls back to the newest", () => {
    const first = run([Event.Polled({ posts: [board, notes] })]).state
    expect([...first.fresh]).toEqual([])
    // Following the newest: the post that came is shown at once, so its dot is gone.
    expect([...run([Event.Polled({ posts: [board, notes, sketch] })], first).state.fresh]).toEqual([])
    // With the board picked, the post that came keeps its dot until the view shows it.
    const pinned = run([key(Action.Board()), Event.Polled({ posts: [board, notes, sketch] })], first).state
    expect(shownId(pinned)).toEqual(Option.some("b"))
    expect([...pinned.fresh]).toEqual(["s"])
    const shown = run([key(Action.Down())], pinned).state
    expect(shownId(shown)).toEqual(Option.some("s"))
    expect([...shown.fresh]).toEqual([])
    const later = run([Event.Polled({ posts: [board, notes, sketch, post("x", "later", 3)] }), key(Action.Down())], pinned).state
    expect(shownId(later)).toEqual(Option.some("x"))
    expect([...later.fresh]).toEqual(["s"])
    const picked = run([key(Action.Down())], first).state
    expect(shownId(run([Event.Polled({ posts: [board] })], picked).state)).toEqual(Option.some("b"))
  })

  test("for any polls and keys, a dot is never on the post the view shows", () => {
    const actions = [Action.Up(), Action.Down(), Action.Board(), Action.Older(), Action.Enter(), Action.Back()]
    for (let seed = 1; seed <= 200; seed++) {
      const draw = (n: number) => Math.floor(Math.abs(Math.sin(seed * 9301 + n * 49297)) * 10_000)
      const posts: Array<Post> = [board]
      const events: Array<Event> = []
      for (let at = 0; at < 30; at++) {
        if (draw(at) % 3 === 0) {
          posts.push(post(`p${at}`, `post ${at}`, at % 60))
          events.push(Event.Polled({ posts: [...posts] }))
        } else events.push(key(actions[draw(at) % actions.length]))
      }
      const state = run(events).state
      const shown = Option.getOrElse(shownId(state), () => "")
      expect({ seed, dotted: state.fresh.has(shown) }).toEqual({ seed, dotted: false })
    }
  })

  test("Up and Down walk the board, then the timeline newest first, held at both ends; b jumps to the board", () => {
    const loaded = run([Event.Polled({ posts: [board, notes, sketch] })]).state
    const walked = [Action.Down(), Action.Down(), Action.Down(), Action.Up(), Action.Up(), Action.Up(), Action.Up()].map((action, index, all) => shownId(run(all.slice(0, index + 1).map(key), loaded).state))
    expect(walked.map((id) => Option.getOrElse(id, () => ""))).toEqual(["n", "n", "n", "s", "b", "b", "b"])
    expect(shownId(run([key(Action.Down()), key(Action.Board())], loaded).state)).toEqual(Option.some("b"))
  })
})

describe("a post's versions", () => {
  test("are asked for when a post with more than one is shown, then [ and ] step through them, the view saying which", () => {
    const loaded = run([Event.Polled({ posts: [notes] })])
    expect(loaded.jobs).toEqual([Job.FetchVersions({ id: "n" })])
    const known = run([Event.Versions({ id: "n", version: 3, list: [version(1, "first"), version(2, "second"), version(3, "third")] })], loaded.state).state
    const older = run([key(Action.Older())], known).state
    expect(Option.map(shownOf(older), (shown) => [shown.version, shown.count, shown.surfaces[0]?.markdown])).toEqual(Option.some([2, 3, "second"]))
    const oldest = run([key(Action.Older()), key(Action.Older()), key(Action.Older())], known).state
    expect(Option.map(shownOf(oldest), (shown) => shown.version)).toEqual(Option.some(1))
    expect(Option.map(shownOf(run([key(Action.Newer())], oldest).state), (shown) => shown.version)).toEqual(Option.some(2))
  })

  test("[ before they are known asks for them; a post of one version says so; a newer version of the post drops the old list", () => {
    const loaded = run([Event.Polled({ posts: [notes] })]).state
    expect(run([key(Action.Older())], loaded).jobs).toEqual([Job.FetchVersions({ id: "n" })])
    const single = run([Event.Polled({ posts: [sketch] }), key(Action.Older())]).state
    expect(single.note).toEqual(Option.some("sketch has one version"))
    const known = run([Event.Versions({ id: "n", version: 3, list: [version(1, "a"), version(3, "c")] }), key(Action.Older())], loaded).state
    const revised = run([Event.Polled({ posts: [{ ...notes, version: 4 }] })], known)
    expect(revised.jobs).toEqual([Job.FetchVersions({ id: "n" })])
    expect(Option.map(shownOf(revised.state), (shown) => shown.version)).toEqual(Option.some(4))
  })
})

describe("a comment", () => {
  test("c opens it, text and Backspace edit it, Enter sends it on the shown post as a job, Escape drops it", () => {
    const loaded = run([Event.Polled({ posts: [notes, sketch] })]).state
    const typed = run([key(Action.Comment()), key(Action.Type({ text: "looks goodd" })), key(Action.Erase())], loaded).state
    expect(typed.mode).toEqual(Mode.Comment({ text: "looks good" }))
    const sent = run([key(Action.Enter())], typed)
    expect(sent.jobs).toEqual([Job.SendComment({ id: "s", text: "looks good" })])
    expect(sent.state.mode).toEqual(Mode.Browse())
    expect(run([key(Action.Back())], typed).jobs).toEqual([])
    expect(run([key(Action.Comment()), key(Action.Enter())], loaded).jobs).toEqual([])
  })
})

describe("the pane's input", () => {
  const size = { cols: 120, rows: 40 }
  const layout = layoutOf(size)
  const actions = (input: Input, mode: Mode = Mode.Browse()) => actionsOf(input, mode, layout, 0)

  test("letters are keys while browsing and text while commenting; arrows, Enter, Escape and Ctrl-C as the pane's own", () => {
    expect(actions(Input.Text({ text: "jk[]bolq?" }))).toEqual([Action.Down(), Action.Up(), Action.Older(), Action.Newer(), Action.Board(), Action.Open(), Action.Leaf(), Action.Quit(), Action.Help()])
    expect(actions(Input.Text({ text: "c" }))).toEqual([Action.Comment()])
    // A quick typist's c and the comment after it, come in one read: the rest is the comment's text.
    expect(actions(Input.Text({ text: "jclooks cool" }))).toEqual([Action.Down(), Action.Comment(), Action.Type({ text: "looks cool" })])
    expect(actions(Input.Text({ text: "jq" }), Mode.Comment({ text: "" }))).toEqual([Action.Type({ text: "jq" })])
    expect(actions(Input.Key({ key: "ArrowDown", mods: NO_MODS }))).toEqual([Action.Down()])
    expect(actions(Input.Key({ key: "Enter", mods: NO_MODS }))).toEqual([Action.Enter()])
    expect(actions(Input.Key({ key: "Backspace", mods: NO_MODS }), Mode.Comment({ text: "a" }))).toEqual([Action.Erase()])
    expect(actions(Input.Quit())).toEqual([Action.Quit()])
    expect(actions(Input.Quit(), Mode.Comment({ text: "a" }))).toEqual([Action.Back()])
  })

  test("a click on a timeline row picks that row; a click elsewhere does nothing; the wheel scrolls the view", () => {
    const row = layout.timeline.top + 3
    expect(actions(Input.Pointer({ mouse: Mouse.Press({ button: "left", col: 2, row, mods: NO_MODS }) }))).toEqual([Action.Pick({ row: 2 })])
    expect(actions(Input.Pointer({ mouse: Mouse.Press({ button: "left", col: layout.view.left + 2, row, mods: NO_MODS }) }))).toEqual([])
    expect(rowAt(layout, { col: 1, row: layout.timeline.top }, 0)).toEqual(Option.none())
    expect(actions(Input.Pointer({ mouse: Mouse.Wheel({ direction: "down", col: 60, row: 30, mods: NO_MODS }) }))).toEqual([Action.ScrollDown({ lines: 3 })])
  })

  test("the regions fit the pane for any size: the board on top, the timeline left of the view, nothing past the edges", () => {
    for (let cols = 20; cols <= 240; cols += 7) {
      for (let rows = 8; rows <= 90; rows += 5) {
        const regions = layoutOf({ cols, rows })
        const fits = regions.view.left + regions.view.cols - 1 <= cols && regions.timeline.top + regions.timeline.rows <= rows && regions.board.top + regions.board.rows < regions.timeline.top
        expect({ cols, rows, fits }).toEqual({ cols, rows, fits: true })
      }
    }
  })

  test("the first timeline row drawn keeps the picked row in sight", () => {
    const posts = Array.from({ length: 50 }, (_, index) => post(`p${index}`, `post ${index}`, index % 60))
    const deep = run([Event.Polled({ posts }), ...Array.from({ length: 45 }, () => key(Action.Down()))]).state
    const small = layoutOf({ cols: 100, rows: 30 })
    const first = firstRow(deep, small)
    expect(first).toBeGreaterThan(0)
    expect(44 - first).toBeLessThan(small.timeline.rows - 1)
  })
})

describe("the board's region", () => {
  const size = { cols: 120, rows: 40 }
  const cell = { width: 12, height: 38 }
  const STYLE = new RegExp(String.raw`\u001b\[[0-9;]*[A-Za-z]`, "g")
  /** A board of `count` checklist lines, as the pane draws it. */
  const lines = (count: number) => Array.from({ length: count }, (_, at) => `- step ${at + 1}`).join("\n")
  const frameOf = (state: FeedState, count: number) => ({ state, title: "Plan", tally: Option.none(), board: [Block.Markdown({ text: lines(count) })], view: [], now: Date.UTC(2026, 10, 15, 10, 30), cell })

  test("is as tall as the board's lines, up to a third of the pane, for any board", () => {
    const state = run([Event.Polled({ posts: [board, notes] })]).state
    for (let count = 0; count <= 40; count++) {
      const layout = feedLayout(frameOf(state, count), size)
      expect({ count, rows: layout.board.rows }).toEqual({ count, rows: Math.min(Math.max(2, 1 + count), boardMost(size)) })
      expect({ count, hidden: boardHiddenOf(frameOf(state, count), size) }).toEqual({ count, hidden: Math.max(0, count - (boardMost(size) - 2)) * Number(count > boardMost(size) - 1) })
    }
    expect(feedLayout(frameOf(run([Event.Polled({ posts: [notes] })]).state, 0), size).board.rows).toBe(2)
  })

  test("a cut board says how many lines are past it; B then j/k scroll it, held at both ends; Enter shows it in the view; esc goes back", () => {
    const polled = run([Event.Polled({ posts: [board, notes] })]).state
    const hidden = boardHiddenOf(frameOf(polled, 30), size)
    expect(hidden).toBe(30 - (boardMost(size) - 2))
    const loaded = run([Event.BoardSized({ hidden })], polled).state
    const plainOf = (state: FeedState) => drawFeed(frameOf(state, 30), size).replace(STYLE, "")
    expect(plainOf(loaded)).toContain(`… ${hidden} more lines (B then j/k scrolls · b shows it all)`)
    expect(plainOf(loaded)).toContain("step 1 ")
    const focused = run([key(Action.FocusBoard())], loaded).state
    expect(focused.focus).toBe("board")
    const down = run([key(Action.Down()), key(Action.Down())], focused).state
    expect(down.boardScroll).toBe(2)
    expect(shownId(down)).toEqual(Option.some("n"))
    expect(plainOf(down)).toContain(`… ${hidden - 2} more lines`)
    expect(plainOf(down)).not.toContain("step 2 ")
    const bottom = run(Array.from({ length: 60 }, () => key(Action.Down())), focused).state
    expect(bottom.boardScroll).toBe(hidden)
    expect(plainOf(bottom)).toContain("step 30")
    expect(plainOf(bottom)).toContain(`↑ ${hidden} lines above`)
    expect(run(Array.from({ length: 60 }, () => key(Action.Up())), bottom).state.boardScroll).toBe(0)
    const viewed = run([key(Action.Enter())], focused).state
    expect([viewed.focus, shownId(viewed)]).toEqual(["view", Option.some("b")])
    expect(run([key(Action.Back())], focused).state.focus).toBe("timeline")
    // A board that shrank pulls the scroll back to what is there.
    expect(run([Event.BoardSized({ hidden: 1 })], bottom).state.boardScroll).toBe(1)
  })

  test("B with no board says so; the wheel over the board scrolls it, elsewhere the view", () => {
    expect(run([Event.Polled({ posts: [notes] }), key(Action.FocusBoard())]).state.note).toEqual(Option.some("no post titled Board yet"))
    const layout = layoutOf(size, 30)
    expect(actionsOf(Input.Text({ text: "B" }), Mode.Browse(), layout, 0)).toEqual([Action.FocusBoard()])
    expect(actionsOf(Input.Pointer({ mouse: Mouse.Wheel({ direction: "down", col: 10, row: layout.board.top + 1, mods: NO_MODS }) }), Mode.Browse(), layout, 0)).toEqual([Action.ScrollBoard({ lines: 3 })])
    expect(actionsOf(Input.Pointer({ mouse: Mouse.Wheel({ direction: "up", col: 10, row: layout.board.top, mods: NO_MODS }) }), Mode.Browse(), layout, 0)).toEqual([Action.ScrollBoard({ lines: -3 })])
    expect(actionsOf(Input.Pointer({ mouse: Mouse.Wheel({ direction: "down", col: 60, row: layout.view.top + 2, mods: NO_MODS }) }), Mode.Browse(), layout, 0)).toEqual([Action.ScrollDown({ lines: 3 })])
  })
})

describe("the frame and the tally", () => {
  test("draws the session's title, the board's version, the timeline newest first, the shown post, and the keys", () => {
    const state = run([Event.Polled({ posts: [board, notes, sketch] })]).state
    const frame = drawFeed({ state, title: "Plan", tally: Option.none(), board: [], view: [], now: Date.UTC(2026, 10, 15, 10, 30), cell: { width: 12, height: 38 } }, { cols: 120, rows: 40 })
    expect(frame).toContain("feed · Plan")
    expect(frame).toContain("◆ Board")
    expect(frame).toContain("v2 · updated 30m ago")
    expect(frame.indexOf("sketch")).toBeLessThan(frame.indexOf("notes"))
    expect(frame).toContain("j/k move")
    expect(frame).toContain(report(feedTally(state.posts)))
  })

  test("an agent's tally is the header's right part and Rex's tab header, in place of the feed's own", () => {
    const state = run([Event.Polled({ posts: [board, notes] })]).state
    const tally: Tally = { msg: "3 of 7 checks green", state: "working", progress: 43 }
    const frame = drawFeed({ state, title: "Plan", tally: Option.some(tally), board: [], view: [], now: Date.UTC(2026, 10, 15, 10, 30), cell: { width: 12, height: 38 } }, { cols: 120, rows: 40 })
    expect(frame.replace(new RegExp(String.raw`\u001b\[[0-9;]*m`, "g"), "")).toContain("feed · Plan   ◆ 3 of 7 checks green · 43%")
    expect(frame).toContain(report(tally))
    expect(frame).not.toContain(report(feedTally(state.posts)))
  })

  test("the tally is the board's headline and the post count, else the count and the newest's title", () => {
    expect(boardLine(board)).toBe("Shipping the feed")
    expect(feedTally([board, notes, sketch]).msg).toBe("Shipping the feed · 2 posts")
    expect(feedTally([notes]).msg).toBe("1 post · notes")
    expect(feedTally([]).msg).toBe("no posts yet")
  })
})
