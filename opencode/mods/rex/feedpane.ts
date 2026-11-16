// The feed pane's program: a Sideshow session followed in the showcase pane
// until the spool shows something else or its user quits. It asks for the
// session's posts every few seconds, reads the pane's keys and clicks, and
// steps the feed (feedview.ts) by each; it fetches what the board and the
// view show (a picture from Sideshow, a Mermaid diagram drawn by Pele and
// shot, a page shot, text as it is) in the background and draws again when
// it comes in, and only when the frame changed. Its jobs: a post's versions
// asked for, the post opened in the browser, a comment sent as the user, a
// post's Markdown or diff handed to leaf (by the caller, who writes files).
import { Clock, Effect, Exit, Option, Queue } from "effect"
import { FEED_WIDTH, SETTLE_MS } from "./feed.ts"
import { actionsOf, boardHiddenOf, boardMost, drawFeed, Event, type FeedState, feedLayout, firstRow, type Frame, initial, Job, layoutOf, shownOf, step } from "./feedview.ts"
import { type Cells, type CellPixels, isPng } from "./graphics.ts"
import { parseInput } from "./live.ts"
import { Browser, Diagrams, Opener, type Post, Sideshow, type Surface } from "./service.ts"
import { viewport } from "./shots.ts"
import { type Feed, feedKey, keepsFeed, type Spooled, tallyOf } from "./spool.ts"
import type { Tally } from "./status.ts"
import { Block, renderOf, Render, textBlock } from "./surface.ts"
import { boardOf, versionsOf } from "./timeline.ts"

/** The pane the feed draws in: its size, its cells' size in pixels, and the text it writes. */
export interface FeedScreen {
  readonly size: Effect.Effect<Cells>
  readonly cell: (size: Cells) => Effect.Effect<CellPixels>
  readonly display: (text: string) => Effect.Effect<void>
}

/** How the feed pane ended: its user quit, or the spool shows something else now. */
export type FeedEnded = "quit" | "left"

const QUIT: FeedEnded = "quit"
const LEFT: FeedEnded = "left"

/**
 * What the feed pane is given: its session, the pane, its input (and the
 * start of a sequence read before), the spool as it is now, where its state
 * is kept between its runs, and how to hand a post to leaf.
 */
export interface FeedRun {
  readonly feed: Feed
  readonly screen: FeedScreen
  readonly read: Effect.Effect<string>
  readonly rest: { value: string }
  /** The spool now: the pane leaves once it shows something else, and draws its tally. */
  readonly spooled: Effect.Effect<Spooled>
  /** Each feed's state as its pane last left it, by `feedKey`: a pane on the same feed again goes on from there. */
  readonly kept: Map<string, FeedState>
  /** A post's surfaces handed to leaf in a pane beside; what the pane says it did. */
  readonly leaf: (title: string, surfaces: ReadonlyArray<Surface>) => Effect.Effect<string, { readonly message: string }>
}

/** Whether two tallies say the same. */
const sameTally = (one: Tally, other: Tally): boolean => one.msg === other.msg && one.state === other.state && one.progress === other.progress

/** How often the pane looks whether the spool moved on and its size changed. */
const LOOK_EVERY = "250 millis"

/** What one surface comes to, at `room` cells of `cell` pixels: its text as it is, else fetched; a failure as its red line. */
const blockOf = Effect.fn("Feed.block")(function* (feed: Feed, render: Render, room: Cells, cell: CellPixels) {
  const sideshow = yield* Sideshow
  const browser = yield* Browser
  const diagrams = yield* Diagrams
  const server = sideshow.at(feed.base)
  const picture = (bytes: Uint8Array) => Block.Picture({ bytes })
  const size = viewport(FEED_WIDTH, room, cell)
  const fetched: Effect.Effect<Block, { readonly message: string }> = Option.match(textBlock(render), {
    onSome: Effect.succeed,
    onNone: () =>
      Render.$match(render, {
        Asset: ({ id, url }) =>
          Effect.flatMap(server.asset(id), (bytes) =>
            Option.match(Option.liftPredicate(bytes, isPng), { onSome: (png) => Effect.succeed(picture(png)), onNone: () => Effect.map(browser.shoot({ url, ...size }), picture) }),
          ),
        Diagram: ({ source }) =>
          Effect.flatMap(diagrams.page(source, Math.max(200, room.cols * cell.width)), (page) => Effect.map(browser.shoot({ url: page.url, width: page.width, height: page.height }), picture)),
        Shoot: ({ url }) => Effect.map(browser.shoot({ url, ...size, settle: SETTLE_MS }), picture),
        Flatten: ({ post }) => Effect.map(server.markdown(post), (text) => Block.Markdown({ text })),
        Markdown: ({ text }) => Effect.succeed(Block.Markdown({ text })),
        Diff: ({ patch }) => Effect.succeed(Block.Diff({ patch })),
        Code: ({ code, language }) => Effect.succeed(Block.Code({ code, language })),
        Terminal: ({ text }) => Effect.succeed(Block.Terminal({ text })),
        Json: ({ data }) => Effect.succeed(Block.Json({ data })),
      }),
  })
  return yield* Effect.catch(fetched, (error) => Effect.succeed(Block.Failed({ reason: error.message })))
})

/**
 * The feed pane on `run.feed` until the spool shows something else or its
 * user quits. It goes on from the state this feed's pane last left (the pick,
 * the version, a comment half typed, the board's scroll, the dots), and
 * leaves its own state for the next.
 */
export const feedPane = Effect.fn("Feed.pane")(
  function* (run: FeedRun) {
    const sideshow = yield* Sideshow
    const opener = yield* Opener
    const server = sideshow.at(run.feed.base)
    const events = yield* Queue.unbounded<Event>()
    const offer = (event: Event) => Queue.offer(events, event)
    const key = feedKey(run.feed)
    const now = {
      state: Option.getOrElse(Option.fromUndefinedOr(run.kept.get(key)), () => initial),
      tally: tallyOf(yield* run.spooled),
      size: yield* run.screen.size,
      cell: { width: 1, height: 2 },
      title: run.feed.name,
      drawn: "",
      /** The regions as last drawn, where a click lands. */
      layout: layoutOf(yield* run.screen.size),
    }
    now.cell = yield* run.screen.cell(now.size)
    /** What each region's post came to, by region, post, version and room; one fetch at a time each. */
    const blocks = new Map<string, ReadonlyArray<Block>>()
    const pending = new Set<string>()
    const scope = yield* Effect.scope

    /** The blocks of `surfaces` (version `version` of post `post`) at `room`: as fetched, else fetched in the background and drawn when they come. */
    const blocksFor = Effect.fn("Feed.blocksFor")(function* (region: string, post: Post, version: number, surfaces: ReadonlyArray<Surface>, room: Cells) {
      const key = `${region}|${post.id}@${version}|${room.cols}x${room.rows}|${now.cell.width}x${now.cell.height}`
      const known = Option.fromUndefinedOr(blocks.get(key))
      if (Option.isSome(known)) return known.value
      if (!pending.has(key)) {
        pending.add(key)
        const cell = now.cell
        const fetch = Effect.forEach(surfaces, (surface) => blockOf(run.feed, renderOf(surface, post.id, version, run.feed.base), room, cell), { concurrency: 2 }).pipe(
          Effect.tap((made) => Effect.sync(() => blocks.set(key, made))),
          Effect.ensuring(Effect.sync(() => pending.delete(key))),
          Effect.andThen(offer(Event.Redraw())),
        )
        yield* Effect.forkIn(fetch, scope)
      }
      return surfaces.map(() => Block.Markdown({ text: "_…_" }))
    })

    const draw = Effect.gen(function* () {
      const state = now.state
      // The board is fetched for the most room it may take; the regions then follow its lines.
      const board = yield* Option.match(boardOf(state.posts), {
        onNone: () => Effect.succeed<ReadonlyArray<Block>>([]),
        onSome: (post) => blocksFor("board", post, post.version, post.surfaces, { cols: now.size.cols, rows: boardMost(now.size) - 1 }),
      })
      const partial: Frame = { state, title: now.title, tally: now.tally, board, view: [], now: yield* Clock.currentTimeMillis, cell: now.cell }
      const layout = feedLayout(partial, now.size)
      now.layout = layout
      const hidden = boardHiddenOf(partial, now.size)
      if (hidden !== state.boardHidden) yield* offer(Event.BoardSized({ hidden }))
      const view = yield* Option.match(shownOf(state), {
        onNone: () => Effect.succeed<ReadonlyArray<Block>>([]),
        onSome: (shown) => blocksFor("view", shown.post, shown.version, shown.surfaces, { cols: layout.view.cols, rows: Math.max(1, layout.view.rows - 1) }),
      })
      const frame = drawFeed({ ...partial, view }, now.size)
      if (frame === now.drawn) return
      now.drawn = frame
      yield* run.screen.display(frame)
    })

    /** A job's outcome as a note, once it is done. */
    const noting = <E extends { readonly message: string }>(job: Effect.Effect<string, E>) =>
      Effect.flatMap(Effect.exit(job), (exit) =>
        offer(Event.Noted({ text: Exit.match(exit, { onSuccess: (text) => text, onFailure: () => Option.match(Exit.findErrorOption(exit), { onNone: () => "✗ failed", onSome: (error) => `✗ ${error.message}` }) }) })),
      )

    const runJob = (job: Job) =>
      Job.$match(job, {
        FetchVersions: ({ id }) =>
          Effect.flatMap(Effect.exit(server.post(id)), (exit) =>
            Exit.match(exit, {
              onSuccess: (detail) => offer(Event.Versions({ id, version: detail.version, list: versionsOf(detail) })),
              onFailure: () => offer(Event.Noted({ text: `✗ no versions of that post: ${Option.match(Exit.findErrorOption(exit), { onNone: () => "Sideshow failed", onSome: (error) => error.message })}` })),
            }),
          ),
        OpenPost: ({ id }) => noting(Effect.as(opener.open(`${run.feed.base}/p/${id}`), "opened in the browser")),
        SendComment: ({ id, text }) => noting(Effect.as(server.comment(id, text), "comment sent: the agent's sideshow wait gets it")),
        LeafPost: ({ title, surfaces }) => noting(run.leaf(title, surfaces)),
        Quit: () => Effect.void,
      })

    /** `event` stepped; its jobs started in the background; true when one is to quit. */
    const handle = (event: Event) =>
      Effect.gen(function* () {
        const stepped = step(now.state, event)
        now.state = stepped.state
        run.kept.set(key, stepped.state)
        const quit = stepped.jobs.some((job) => job._tag === "Quit")
        yield* Effect.forEach(stepped.jobs, (job) => Effect.forkIn(runJob(job), scope), { discard: true })
        return quit
      })

    const polling = Effect.forever(
      Effect.gen(function* () {
        const posts = yield* Effect.exit(server.posts(run.feed.session))
        yield* offer(
          Exit.match(posts, {
            onSuccess: (all) => Event.Polled({ posts: all }),
            onFailure: () => Event.PollFailed({ reason: Option.match(Exit.findErrorOption(posts), { onNone: () => "Sideshow failed", onSome: (error) => error.message }) }),
          }),
        )
        yield* Effect.sleep(`${run.feed.every} seconds`)
      }),
    )

    const typing = Effect.forever(
      Effect.gen(function* () {
        const parsed = parseInput(run.rest.value + (yield* run.read))
        run.rest.value = parsed.rest
        const layout = now.layout
        const first = firstRow(now.state, layout)
        for (const input of parsed.inputs) {
          for (const action of actionsOf(input, now.state.mode, layout, first)) yield* offer(Event.Key({ action }))
        }
      }),
    )

    const watching = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(LOOK_EVERY)
        // A write that keeps this feed (a tally above all) is drawn in place; only another view or feed ends the pane.
        const spooled = yield* run.spooled
        if (!keepsFeed(spooled, run.feed)) return LEFT
        const tally = tallyOf(spooled)
        if (!Option.makeEquivalence(sameTally)(tally, now.tally)) {
          now.tally = tally
          yield* offer(Event.Redraw())
        }
        const size = yield* run.screen.size
        if (size.cols !== now.size.cols || size.rows !== now.size.rows) {
          now.size = size
          now.cell = yield* run.screen.cell(size)
          now.drawn = ""
          yield* offer(Event.Redraw())
        }
      }
    })

    const stepping = Effect.gen(function* () {
      yield* draw
      while (true) {
        const event = yield* Queue.take(events)
        if (yield* handle(event)) return QUIT
        yield* draw
      }
    })

    // The session's title is asked once; a server down now leaves the session's id in the header.
    now.title = Option.getOrElse(yield* server.title(run.feed.session).pipe(Effect.orElseSucceed(() => Option.none<string>())), () => run.feed.name)
    yield* Effect.forkIn(polling, scope)
    yield* Effect.forkIn(typing, scope)
    return yield* Effect.raceFirst(stepping, watching)
  },
  Effect.scoped,
)

