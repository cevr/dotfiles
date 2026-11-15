#!/usr/bin/env bun
/**
 * rex-show: show work in a pane beside you in Rex. Run it from a terminal
 * Rex opened (an OpenCode tool shell carries its TUI's pane): it finds the
 * pane labeled `showcase` in your session, or splits one off beside your
 * pane, and draws there.
 *
 *   rex-show image FILE                 a PNG, as large as the pane allows
 *   rex-show md FILE                    a Markdown file, as styled text
 *   rex-show url URL [--every S] [--width PX]
 *                                       a web page, shot by a headless Chrome
 *                                       on this host every S seconds (5) at
 *                                       PX pixels wide (1280), redrawn when
 *                                       the shot changes; a page that does
 *                                       not answer shows as an error line
 *   rex-show sideshow [SESSION] [--every S]
 *                                       follow a Sideshow session (default:
 *                                       the one the sideshow CLI publishes to
 *                                       from this shell): its latest post,
 *                                       asked for every S seconds (3), the
 *                                       session's title in the header and the
 *                                       post count as the tally
 *   rex-show tally TEXT [--progress N] [--state working|done|blocked|error|idle]
 *                                       a line in the pane and in Rex's tab
 *                                       header (OSC 7501, record `tally`)
 *   rex-show view --session ID [--spool DIR]
 *                                       the showcase pane's own program
 *
 * It prints the showcase's block id. Exit 2: not in a Rex pane
 * (REX_SESSION and REX_BLOCK unset), or a usage error; exit 1: Rex or the
 * spool failed, or no Sideshow session was named and none found (a page or
 * Sideshow that does not answer is the pane's to show, not an exit). The spool is `$XDG_STATE_HOME/rex-show/<session>/`, and the
 * viewer is told it; the viewer is started as this same program (Bun and
 * this script, so a PATH without rex-show still finds it), or as
 * `$REX_SHOW_BIN view …` when that is set; Rex's tool as
 * `$REX_BIN_DIR/rex` when Rex set it, else `rex`.
 */
import { readFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { basename, join, resolve } from "node:path"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import * as FileSpool from "@dotfiles/opencode-rex/filestore/spool"
import { Content, frame, roomOf } from "@dotfiles/opencode-rex/frame"
import { type Cells, type CellPixels, DEFAULT_CELL } from "@dotfiles/opencode-rex/graphics"
import { Draw, drawOf, FEED_EVERY, FEED_WIDTH, latest, printOf, SETTLE_MS, tallyFor } from "@dotfiles/opencode-rex/feed"
import { isPng } from "@dotfiles/opencode-rex/graphics"
import { setTally, showFile, showLive } from "@dotfiles/opencode-rex/model"
import { type Pane, paneOf } from "@dotfiles/opencode-rex/pane"
import * as ProcessBrowser from "@dotfiles/opencode-rex/process/browser"
import * as ProcessRex from "@dotfiles/opencode-rex/process/rex"
import * as ProcessSideshow from "@dotfiles/opencode-rex/process/sideshow"
import { Browser, type Post, Sideshow, Spool } from "@dotfiles/opencode-rex/service"
import { DEFAULT_EVERY, DEFAULT_WIDTH, due, fingerprint, nameOf, type Taken, viewport } from "@dotfiles/opencode-rex/shots"
import { empty, Feed, Page, Picture, Shown, type Spooled, Url } from "@dotfiles/opencode-rex/spool"
import { TallyState } from "@dotfiles/opencode-rex/status"
import { answered, CELL_QUERIES, cellOf } from "@dotfiles/opencode-rex/terminal"
import { Array as Arr, Clock, Config, Console, Data, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"

/** A refusal with its exit code: 2 for a usage error or no pane, 1 for a failed call. */
export class Refused extends Schema.TaggedError<Refused>()("Refused", { message: Schema.String, code: Schema.Int }) {}

export const USAGE = [
  "usage: rex-show image FILE",
  "       rex-show md FILE",
  "       rex-show url URL [--every SECONDS] [--width PX]",
  "       rex-show sideshow [SESSION] [--every SECONDS]",
  "       rex-show tally TEXT [--progress N] [--state working|done|blocked|error|idle]",
].join("\n")

const usage = (why: string) => new Refused({ message: `rex-show: ${why}\n${USAGE}`, code: 2 })

/** How often the viewer looks at the spool and the pane's size. */
const LOOK_EVERY = "250 millis"

/** This process as it was started: Bun and the script, before the arguments; the showcase's viewer is started the same way. */
const SELF = process.argv.slice(0, 2)

/** A request rex-show understood. */
export type Request = Data.TaggedEnum<{
  Show: { readonly shown: Picture | Page }
  Visit: { readonly page: Url }
  Follow: { readonly session: Option.Option<string>; readonly every: number }
  Tally: { readonly msg: string; readonly progress: Option.Option<number>; readonly state: TallyState }
  View: { readonly session: string; readonly spool: Option.Option<string> }
}>
export const Request = Data.taggedEnum<Request>()

const flag = (args: ReadonlyArray<string>, name: string): Option.Option<string> =>
  Option.flatMap(
    Option.filter(Option.some(args.indexOf(name)), (at) => at >= 0),
    (at) => Arr.get(args, at + 1),
  )

const positional = (args: ReadonlyArray<string>, flags: ReadonlyArray<string>) =>
  args.filter((arg, at) => !flags.includes(arg) && !(at > 0 && flags.includes(args[at - 1])))

/** The one positional argument, or a usage refusal naming what `command` takes. */
const single = (args: ReadonlyArray<string>, command: string, what: string) =>
  Option.match(Option.liftPredicate(args, (all) => all.length === 1), {
    onNone: () => Effect.fail(usage(`${command} takes one ${what}`)),
    onSome: ([only]) => Effect.succeed(only),
  })

const decodeState = Schema.decodeUnknownOption(TallyState)
const decodePercent = Schema.decodeUnknownOption(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })))

/** A flag's value decoded, none when the flag is absent, and a usage refusal when it is there but does not decode. */
const decoded = <A>(args: ReadonlyArray<string>, name: string, decode: (text: string) => Option.Option<A>, why: string) =>
  Option.match(flag(args, name), {
    onNone: () => Effect.succeed(Option.none<A>()),
    onSome: (text) =>
      Option.match(decode(text), { onNone: () => Effect.fail(usage(`${name} ${why}`)), onSome: (value) => Effect.succeed(Option.some(value)) }),
  })

const tally = Effect.fn("RexShow.tally")(function* (rest: ReadonlyArray<string>) {
  const msg = yield* single(positional(rest, ["--progress", "--state"]), "tally", "TEXT")
  const progress = yield* decoded(rest, "--progress", (text) => decodePercent(Number(text)), "takes a whole number from 0 to 100")
  const state = yield* decoded(rest, "--state", decodeState, "takes working, done, blocked, error or idle")
  return Request.Tally({ msg, progress, state: Option.getOrElse(state, (): TallyState => "working") })
})

const show = Effect.fn("RexShow.show")(function* (command: "image" | "md", rest: ReadonlyArray<string>) {
  const file = yield* single(rest, command, "FILE")
  const fields = { file: resolve(file), name: basename(file) }
  return Request.Show({ shown: Option.match(Option.liftPredicate(command, (name) => name === "image"), { onSome: () => Picture.make(fields), onNone: () => Page.make(fields) }) })
})

const decodeEvery = Schema.decodeUnknownOption(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 3600 })))
const decodeWidth = Schema.decodeUnknownOption(Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 4096 })))

/** `text` as an http or https URL; none for anything else. */
const webUrl = (text: string) =>
  Option.filter(Option.liftThrowable(() => new URL(text))(), (url) => url.protocol === "http:" || url.protocol === "https:")

const visit = Effect.fn("RexShow.visit")(function* (rest: ReadonlyArray<string>) {
  const text = yield* single(positional(rest, ["--every", "--width"]), "url", "URL")
  const url = yield* Option.match(webUrl(text), { onNone: () => Effect.fail(usage(`url takes an http or https URL, not ${text}`)), onSome: Effect.succeed })
  const every = yield* decoded(rest, "--every", (value) => decodeEvery(Number(value)), "takes seconds from 1 to 3600")
  const width = yield* decoded(rest, "--width", (value) => decodeWidth(Number(value)), "takes a whole number of pixels from 200 to 4096")
  return Request.Visit({
    page: Url.make({ url: url.href, name: nameOf(url), every: Option.getOrElse(every, () => DEFAULT_EVERY), width: Option.getOrElse(width, () => DEFAULT_WIDTH) }),
  })
})

const follow = Effect.fn("RexShow.followRequest")(function* (rest: ReadonlyArray<string>) {
  const named = positional(rest, ["--every"])
  if (named.length > 1) return yield* usage("sideshow takes at most one SESSION")
  const every = yield* decoded(rest, "--every", (value) => decodeEvery(Number(value)), "takes seconds from 1 to 3600")
  return Request.Follow({ session: Arr.head(named), every: Option.getOrElse(every, () => FEED_EVERY) })
})

const view = Effect.fn("RexShow.viewRequest")(function* (rest: ReadonlyArray<string>) {
  const session = yield* Option.match(flag(rest, "--session"), { onNone: () => Effect.fail(usage("view takes --session ID")), onSome: Effect.succeed })
  return Request.View({ session, spool: flag(rest, "--spool") })
})

/** The request `args` make, or a usage refusal. */
export const parse = Effect.fn("RexShow.parse")(function* (args: ReadonlyArray<string>) {
  const [command, ...rest] = args
  if (command === "image" || command === "md") return yield* show(command, rest)
  if (command === "url") return yield* visit(rest)
  if (command === "sideshow") return yield* follow(rest)
  if (command === "tally") return yield* tally(rest)
  if (command === "view") return yield* view(rest)
  return yield* usage(Option.match(Arr.head(args), { onNone: () => "no command", onSome: (name) => `unknown command ${name}` }))
})

const optional = (name: string) => Config.option(Config.String(name)).pipe(Config.map(Option.filter((value) => value !== "")))

/** The caller's pane, from the variables Rex gives a terminal's programs; refused (exit 2) outside one. */
const callerPane = Effect.gen(function* () {
  const session = yield* optional("REX_SESSION")
  const block = yield* optional("REX_BLOCK")
  return yield* Option.match(paneOf({ REX_SESSION: Option.getOrUndefined(session), REX_BLOCK: Option.getOrUndefined(block) }), {
    onNone: () =>
      Effect.fail(
        new Refused({ message: "rex-show: not in a Rex pane (REX_SESSION and REX_BLOCK are unset); run it from a terminal Rex opened", code: 2 }),
      ),
    onSome: (pane: Pane) => Effect.succeed(pane),
  })
})

const failed = (error: { readonly message: string }) => new Refused({ message: `rex-show: ${error.message}`, code: 1 })

/** What the shown file holds, read for a frame; a file that cannot be read says why. */
const contentOf = (shown: Picture | Page) =>
  Effect.tryPromise({ try: () => readFile(shown.file), catch: (cause) => String(cause) }).pipe(
    Effect.match({
      onSuccess: (bytes) => Content.Bytes({ bytes }),
      onFailure: (reason) => Content.Unreadable({ reason: `cannot read ${shown.name}: ${reason}` }),
    }),
  )

/** The pane the viewer draws in: its size, its cells' size in pixels (asked when its size changes), and the text it writes. */
export interface Screen {
  readonly size: Effect.Effect<Cells>
  readonly cell: (size: Cells) => Effect.Effect<CellPixels>
  readonly display: (text: string) => Effect.Effect<void>
}

/** What a shot of the page holds: its PNG, or the error line, and its fingerprint. */
const shotOf = (result: Exit.Exit<Uint8Array, { readonly message: string }>) =>
  Exit.match(result, {
    onSuccess: (bytes) => ({ content: Content.Bytes({ bytes }), print: fingerprint(bytes) }),
    onFailure: (cause) => {
      const reason = Option.match(Exit.findErrorOption(result), { onNone: () => String(cause), onSome: (error) => error.message })
      return { content: Content.Unreadable({ reason }), print: fingerprint(new TextEncoder().encode(reason)) }
    },
  })

/** What a followed session shows: its title once known, its post count, and the latest post. */
interface Followed {
  readonly title: Option.Option<string>
  readonly count: number
  readonly post: Option.Option<Post>
}

/** `spooled` as a followed session draws it: named by its title, the post count as the tally. */
const asFollowed = (spooled: Spooled, feed: Feed, followed: Followed): Spooled => ({
  ...spooled,
  shown: Feed.make({ ...feed, name: Option.getOrElse(followed.title, () => feed.name) }),
  tally: tallyFor(followed.count, followed.post),
})

/**
 * The showcase pane's program: draws the session's spool again whenever it
 * or the pane's size changes; a web page it shoots again when due, and
 * draws again only when the shot differs from the last; a Sideshow session
 * it asks for posts when due, and draws again only when its latest post,
 * the post count or the session's title changed.
 */
export const viewer = Effect.fn("RexShow.view")(function* (session: string, screen: Screen) {
  const spool = yield* Spool
  const browser = yield* Browser
  const sideshow = yield* Sideshow
  const drawn = {
    key: "",
    sized: "",
    cell: DEFAULT_CELL,
    taken: Option.none<Taken>(),
    shot: Option.none<Content>(),
    followed: { title: Option.none<string>(), count: 0, post: Option.none<Post>() } satisfies Followed,
    titled: -1,
    post: "",
  }
  /** What `post` draws as, at `room` cells: its picture, Markdown or a shot of its page; why not when Sideshow or the browser fails. */
  const postContent = (feed: Feed, post: Post, room: Cells) => {
    const server = sideshow.at(feed.base)
    const shot = (url: string, settle: Option.Option<number>) =>
      Effect.map(
        browser.shoot({ url, ...viewport(FEED_WIDTH, room, drawn.cell), ...Option.match(settle, { onNone: () => ({}), onSome: (ms) => ({ settle: ms }) }) }),
        (bytes) => Content.Bytes({ bytes }),
      )
    const drawing: Effect.Effect<Content, { readonly message: string }> = Draw.$match(drawOf(post, feed.base), {
      Asset: ({ id, url }) =>
        Effect.flatMap(server.asset(id), (bytes) =>
          Option.match(Option.liftPredicate(bytes, isPng), { onSome: (png) => Effect.succeed(Content.Bytes({ bytes: png })), onNone: () => shot(url, Option.none()) }),
        ),
      Markdown: ({ text }) => Effect.succeed(Content.Text({ text })),
      Shoot: ({ url }) => shot(url, Option.some(SETTLE_MS)),
      Flatten: ({ post: id }) => Effect.map(server.markdown(id), (text) => Content.Text({ text })),
    })
    return Effect.catch(drawing, (error) => Effect.succeed(Content.Unreadable({ reason: error.message })))
  }
  /** The session asked for its posts when due; the latest drawn again when it, the count, the title or the pane's size changed. */
  const look_feed = Effect.fn("RexShow.follow")(function* (feed: Feed, seq: number, room: Cells) {
    const now = yield* Clock.currentTimeMillis
    if (!due(drawn.taken, seq, drawn.sized, now, feed.every * 1000)) return
    const server = sideshow.at(feed.base)
    if (drawn.titled !== seq) {
      // The title is asked once per call; a server down now leaves the session's id in the header.
      drawn.followed = { ...drawn.followed, title: yield* server.title(feed.session).pipe(Effect.orElseSucceed(() => Option.none<string>())) }
      drawn.titled = seq
    }
    const posts = yield* Effect.exit(server.posts(feed.session))
    const post = Exit.match(posts, { onSuccess: latest, onFailure: () => Option.none<Post>() })
    const count = Exit.match(posts, { onSuccess: (all) => all.length, onFailure: () => 0 })
    const which = Exit.match(posts, {
      onSuccess: () => Option.match(post, { onNone: () => "none", onSome: printOf }),
      onFailure: () => Option.match(Exit.findErrorOption(posts), { onNone: () => "failed", onSome: (error) => `failed: ${error.message}` }),
    })
    const print = `${which}|${count}|${Option.getOrElse(drawn.followed.title, () => "")}|${drawn.sized}`
    drawn.followed = { ...drawn.followed, count, post }
    if (print !== drawn.post) {
      drawn.post = print
      drawn.shot = Option.some(
        yield* Exit.match(posts, {
          onFailure: () => Effect.succeed(Content.Unreadable({ reason: which.replace(/^failed: /, "") })),
          onSuccess: () =>
            Option.match(post, {
              onNone: () => Effect.succeed(Content.Text({ text: "_No posts yet._" })),
              onSome: (shown) => postContent(feed, shown, room),
            }),
        }),
      )
    }
    drawn.taken = Option.some({ seq, sized: drawn.sized, at: now, print: fingerprint(new TextEncoder().encode(drawn.post)) })
  })
  /** The page shot again when it is due, its content and fingerprint kept. */
  const shoot = Effect.fn("RexShow.shoot")(function* (page: Url, seq: number, room: Cells) {
    const now = yield* Clock.currentTimeMillis
    if (!due(drawn.taken, seq, drawn.sized, now, page.every * 1000)) return
    const taken = shotOf(yield* Effect.exit(browser.shoot({ url: page.url, ...viewport(page.width, room, drawn.cell) })))
    drawn.taken = Option.some({ seq, sized: drawn.sized, at: now, print: taken.print })
    drawn.shot = Option.some(taken.content)
  })
  const look = Effect.gen(function* () {
    // A spool not written yet, or unreadable for a moment, is drawn as nothing shown; the next look reads it again.
    const spooled = yield* spool.read(session).pipe(Effect.catchTag("SpoolFailed", () => Effect.succeed(empty)))
    const size = yield* screen.size
    const sized = `${size.cols}x${size.rows}`
    if (sized !== drawn.sized) {
      drawn.sized = sized
      drawn.cell = yield* screen.cell(size)
    }
    const shown = Option.fromUndefinedOr(spooled.shown)
    const page = Option.filter(shown, Shown.guards.Url)
    const feed = Option.filter(shown, Shown.guards.Feed)
    yield* Option.match(page, { onNone: () => Effect.void, onSome: (url) => shoot(url, spooled.seq, roomOf(spooled, size)) })
    yield* Option.match(feed, { onNone: () => Effect.void, onSome: (followed) => look_feed(followed, spooled.seq, roomOf(asFollowed(spooled, followed, drawn.followed), size)) })
    const live = Option.isSome(page) || Option.isSome(feed)
    const print = Option.match(Option.filter(drawn.taken, () => live), { onNone: () => "", onSome: (taken) => `:${taken.print}` })
    const key = `${spooled.seq}:${sized}${print}`
    if (key === drawn.key) return
    drawn.key = key
    const content = yield* Option.match(shown, {
      onNone: () => Effect.succeed(Option.none<Content>()),
      onSome: (item) =>
        Shown.match(item, {
          Url: () => Effect.succeed(drawn.shot),
          Feed: () => Effect.succeed(drawn.shot),
          Picture: (picture) => Effect.map(contentOf(picture), Option.some),
          Page: (text) => Effect.map(contentOf(text), Option.some),
        }),
    })
    const shownAs = Option.match(feed, { onNone: () => spooled, onSome: (followed) => asFollowed(spooled, followed, drawn.followed) })
    yield* screen.display(frame(shownAs, content, size, drawn.cell))
  })
  return yield* Effect.forever(Effect.andThen(look, Effect.sleep(LOOK_EVERY)))
})

/** Where a run finds Rex's tool and keeps the spool (unless the viewer is told its spool), and how it starts itself again as the viewer. */
export interface Settings {
  readonly rex: string
  readonly spool: string
  readonly self: ReadonlyArray<string>
}

/** The spool a request uses: the viewer's own when it was told one, else the settings'. */
export const spoolOf = (request: Request, settings: Settings): string =>
  Request.$match(request, {
    View: (asked) => Option.getOrElse(asked.spool, () => settings.spool),
    Show: () => settings.spool,
    Visit: () => settings.spool,
    Follow: () => settings.spool,
    Tally: () => settings.spool,
  })

/**
 * `request` with `settings`, drawing on `screen` when it is the viewer; the
 * showcase's block id for a call. The viewer is started with the spool this
 * call writes, so the two agree whatever the pane's environment.
 */
export const run = Effect.fn("RexShow.run")(
  function* (request: Request, screen: Screen, settings: Settings) {
    if (request._tag === "View") return yield* viewer(request.session, screen)
    const pane = yield* callerPane
    const bin = yield* optional("REX_SHOW_BIN")
    const start = Option.match(bin, { onNone: () => settings.self, onSome: (path) => [path] })
    const program = [...start, "view", "--session", pane.session, "--spool", settings.spool]
    if (request._tag === "Show") return yield* showFile(pane, request.shown, program)
    if (request._tag === "Visit") return yield* showLive(pane, request.page, program)
    if (request._tag === "Follow") return yield* showLive(pane, yield* feedOf(request), program)
    return yield* setTally(pane, { msg: request.msg, state: request.state, progress: Option.getOrUndefined(request.progress) }, program)
  },
  Effect.catchTags({
    RexFailed: (error) => Effect.fail(failed(error)),
    SpoolFailed: (error) => Effect.fail(failed(error)),
    SideshowFailed: (error) => Effect.fail(failed(error)),
  }),
)

/** The Sideshow session a follow request names, else the caller's own; refused (exit 1) when it names none and the caller has none. */
const feedOf = Effect.fn("RexShow.feedOf")(function* (request: { readonly session: Option.Option<string>; readonly every: number }) {
  const sideshow = yield* Sideshow
  const session = yield* Option.match(request.session, { onSome: (named) => Effect.succeed(Option.some(named)), onNone: () => sideshow.mine })
  return yield* Option.match(session, {
    onNone: () =>
      Effect.fail(
        new Refused({
          message: `rex-show: no Sideshow session at ${sideshow.base} for this shell yet: publish a post first, or name one (rex-show sideshow SESSION; sideshow sessions lists them)`,
          code: 1,
        }),
      ),
    onSome: (id) => Effect.succeed(Feed.make({ base: sideshow.base, session: id, name: id, every: request.every })),
  })
})

/**
 * The settings from the environment: Rex's tool beside the Rex that opened
 * this terminal (else `rex` on PATH), the spool under the state directory,
 * and `self`, how this process was started.
 */
export const settingsOf = (self: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const dir = yield* optional("REX_BIN_DIR")
    return {
      rex: Option.match(dir, { onNone: () => "rex", onSome: (path) => `${path}/rex` }),
      spool: `${TuiDirs.dirs().state}/rex-show`,
      self,
    } satisfies Settings
  })

/** The settings `args` run with: the environment's, the spool the viewer was told in place of its own. */
const settingsFor = Effect.fn("RexShow.settingsFor")(function* (args: ReadonlyArray<string>) {
  const settings = yield* settingsOf(SELF)
  const request = yield* parse(args)
  return { ...settings, spool: spoolOf(request, settings) } satisfies Settings
})

/** Where this host's headless browser is looked for: `$REX_SHOW_CHROME`, the host, the home folder and `$PLAYWRIGHT_BROWSERS_PATH`. */
const placesOf = Effect.gen(function* () {
  return {
    chosen: yield* optional("REX_SHOW_CHROME"),
    platform: process.platform,
    home: TuiDirs.dirs().home,
    playwright: yield* optional("PLAYWRIGHT_BROWSERS_PATH"),
  } satisfies ProcessBrowser.Places
})

/** Where the `sideshow` CLI's server is, and how it would find this shell's session: `$SIDESHOW_URL`, `$SIDESHOW_TOKEN`, `$SIDESHOW_SESSION`, the agent above this process, the folder and the CLI's state folder. */
const sideshowOf = Effect.gen(function* () {
  return {
    base: Option.getOrElse(yield* optional("SIDESHOW_URL"), () => "http://localhost:8228"),
    token: yield* optional("SIDESHOW_TOKEN"),
    session: yield* optional("SIDESHOW_SESSION"),
    agent: ProcessSideshow.agentOf(process.ppid),
    cwd: process.cwd(),
    stateDir: join(tmpdir(), `sideshow-${userInfo().username}`),
  } satisfies ProcessSideshow.Places
})

/** The live systems `args` run on: Rex's tool, the spool, the browser and Sideshow, as `settingsFor`, `placesOf` and `sideshowOf` find them. */
export const live = (args: ReadonlyArray<string>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const settings = yield* settingsFor(args)
      return Layer.mergeAll(ProcessRex.layer(settings.rex), FileSpool.layer(settings.spool), ProcessBrowser.layer(yield* placesOf), ProcessSideshow.layer(yield* sideshowOf))
    }),
  )

/** rex-show on `args`, needing Rex and the spool. */
export const main = Effect.fn("RexShow.main")(function* (args: ReadonlyArray<string>, screen: Screen) {
  return yield* run(yield* parse(args), screen, yield* settingsFor(args))
})

/** The exit code of a finished run: 0 with the block id printed, else the refusal's after its words. */
export const finish = (exit: Exit.Exit<string, unknown>): Effect.Effect<number> =>
  Exit.match(exit, {
    onSuccess: (block) => Effect.as(Console.log(block), 0),
    onFailure: (cause) =>
      Option.match(Option.filter(Exit.findErrorOption(exit), Schema.is(Refused)), {
        onNone: () => Effect.as(Console.error(`rex-show: ${String(cause)}`), 1),
        onSome: (refused) => Effect.as(Console.error(refused.message), refused.code),
      }),
  })

/** How long the viewer waits for its terminal to say its cells' size. */
const CELL_WAIT_MS = 500

/**
 * This terminal's cell size: the queries written, the replies read from
 * input in raw mode until they are in or the wait is over; the default cell
 * when input is no terminal or nothing came.
 */
const askCell = (size: Cells) =>
  Effect.callback<CellPixels>((resume) => {
    const input = process.stdin
    if (!input.isTTY) return resume(Effect.succeed(DEFAULT_CELL))
    const heard = { text: "", done: false }
    const finish = () => {
      if (heard.done) return
      heard.done = true
      clearTimeout(timer)
      input.off("data", onData)
      input.setRawMode(false)
      input.pause()
      resume(Effect.succeed(Option.getOrElse(cellOf(heard.text, size), () => DEFAULT_CELL)))
    }
    const onData = (chunk: Buffer) => {
      heard.text += chunk.toString("latin1")
      if (answered(heard.text)) finish()
    }
    const timer = setTimeout(finish, CELL_WAIT_MS)
    input.setRawMode(true)
    input.resume()
    input.on("data", onData)
    process.stdout.write(CELL_QUERIES)
  })

/** This process's terminal as the viewer's screen. */
const terminal: Screen = {
  size: Effect.sync(() => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 })),
  cell: askCell,
  display: (text) => Effect.sync(() => void process.stdout.write(text)),
}

const ARGS = process.argv.slice(2)

/** The exit code for a signal that ended the run: 128 and its number, as a shell reports it. */
const SIGNALS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const

if (import.meta.main) {
  // A signal (Ctrl-C, the pane closing) interrupts the run, so its finalizers
  // run: a shot in flight has its browser killed, not left behind.
  const running = Effect.runFork(main(ARGS, terminal).pipe(Effect.provide(live(ARGS)), Effect.exit, Effect.flatMap(finish)))
  for (const [signal, code] of Object.entries(SIGNALS)) {
    process.once(signal, () => {
      process.exitCode = code
      Effect.runFork(Fiber.interrupt(running))
    })
  }
  const exit = await Effect.runPromise(Fiber.await(running))
  if (Exit.isSuccess(exit)) process.exitCode = exit.value
  process.exit()
}
