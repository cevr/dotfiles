// The feed pane's behaviour, step by step: what is shown (the picked post,
// else the newest, else the board), the dot on posts that came since the
// first look, Up and Down through the board and the timeline, `[` and `]`
// through a post's versions (asked for first), a comment typed and sent, the
// keys and clicks each input means, the frame's regions, and the tally the
// board gives.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Action, actionsOf, boardLine, drawFeed, Event, type FeedState, feedTally, firstRow, initial, Job, layoutOf, Mode, rowAt, shownOf, step } from "./feedview.ts"
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

  test("a dot on each post that came after the first look, gone once it is picked; a pick that went away falls back to the newest", () => {
    const first = run([Event.Polled({ posts: [board, notes] })]).state
    expect([...first.fresh]).toEqual([])
    const came = run([Event.Polled({ posts: [board, notes, sketch] })], first).state
    expect([...came.fresh]).toEqual(["s"])
    const seen = run([key(Action.Up())], came).state
    expect(shownId(seen)).toEqual(Option.some("b"))
    const back = run([key(Action.Down())], seen).state
    expect([...back.fresh]).toEqual([])
    expect(shownId(run([Event.Polled({ posts: [board, notes] })], back).state)).toEqual(Option.some("n"))
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

describe("the frame and the tally", () => {
  test("draws the session's title, the board's version, the timeline newest first, the shown post, and the keys", () => {
    const state = run([Event.Polled({ posts: [board, notes, sketch] })]).state
    const frame = drawFeed({ state, title: "Plan", board: [], view: [], now: Date.UTC(2026, 10, 15, 10, 30), cell: { width: 12, height: 38 } }, { cols: 120, rows: 40 })
    expect(frame).toContain("feed · Plan")
    expect(frame).toContain("◆ Board")
    expect(frame).toContain("v2 · updated 30m ago")
    expect(frame.indexOf("sketch")).toBeLessThan(frame.indexOf("notes"))
    expect(frame).toContain("j/k move")
  })

  test("the tally is the board's headline and the post count, else the count and the newest's title", () => {
    expect(boardLine(board)).toBe("Shipping the feed")
    expect(feedTally([board, notes, sketch]).msg).toBe("Shipping the feed · 2 posts")
    expect(feedTally([notes]).msg).toBe("1 post · notes")
    expect(feedTally([]).msg).toBe("no posts yet")
  })
})
